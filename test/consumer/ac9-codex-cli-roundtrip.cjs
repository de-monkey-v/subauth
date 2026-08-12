#!/usr/bin/env node
/**
 * AC9 — after this package writes the shared auth file, the Codex CLI still
 * accepts it.
 *
 * The adapter's whole premise is sharing one file with another program, so the
 * only conclusive check is asking that program. Field-preservation assertions
 * (AC8) verify our intent; this verifies the CLI's actual acceptance, which is
 * the thing that breaks if the format drifts.
 *
 * Runs entirely against a copy under a scratch CODEX_HOME. The real credentials
 * are read once and never written.
 *
 * Opt-in via SUBAUTH_LIVE_CODEX=1, and the most invasive check here: it hands a
 * copy of a live session to a real `codex` subprocess. If that subprocess
 * decides to refresh, the server rotates the refresh token and hands the new one
 * to *this copy*, which is then deleted — leaving the original file holding a
 * token the server has already retired. That is exactly the failure the
 * "share the file, never copy it" invariant exists to prevent, so the check
 * refuses to run against a session close enough to expiry for the CLI to
 * refresh it.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { LIVE_ENV, liveCodexEnabled, scratchDir } = require("./_support.cjs");
const { codexAuthStore } = require("../../dist/index.js");

/**
 * How much life the access token must have left before handing the session to
 * the CLI. Generous on purpose: the cost of skipping is an unanswered question,
 * the cost of guessing wrong is the operator's login.
 */
const REFRESH_MARGIN_MS = 60 * 60_000;

function findCodex() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "codex");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Milliseconds until the access token expires, or null if it cannot be read. */
function expiryOf(file) {
  try {
    const tokens = JSON.parse(fs.readFileSync(file, "utf8")).tokens;
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof claims.exp === "number" ? claims.exp * 1000 - Date.now() : null;
  } catch {
    return null;
  }
}

const codex = findCodex();
const source = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

if (!liveCodexEnabled()) {
  console.log(`AC9 SKIPPED: set ${LIVE_ENV}=1 to check against the Codex CLI on this machine`);
  process.exit(0);
}
if (!codex) {
  console.log("AC9 SKIPPED: the codex CLI is not on PATH");
  process.exit(0);
}
if (!fs.existsSync(source)) {
  console.log(`AC9 SKIPPED: no Codex login at ${source}`);
  process.exit(0);
}

const remaining = expiryOf(source);
if (remaining === null) {
  console.log("AC9 SKIPPED: the Codex auth file holds no readable ChatGPT session");
  process.exit(0);
}
if (remaining < REFRESH_MARGIN_MS) {
  const minutes = Math.max(0, Math.round(remaining / 60_000));
  console.log(
    `AC9 SKIPPED: the live session expires in ~${minutes}m, close enough that the CLI ` +
      "could rotate its refresh token and strand the original file",
  );
  process.exit(0);
}

// Not `mkdtempSync`: this directory holds a copy of a live credential, so it has
// to be removed on every exit path, not just the happy one. See `_support.cjs`.
const home = scratchDir("subauth-ac9-");
const copy = path.join(home, "auth.json");

/** The refresh token currently in the copy, or null once it has been cleared. */
function refreshInCopy() {
  try {
    const tokens = JSON.parse(fs.readFileSync(copy, "utf8")).tokens;
    return tokens && typeof tokens.refresh_token === "string" ? tokens.refresh_token : null;
  } catch {
    return null;
  }
}

/**
 * The CLI reports its login state on stderr, so both streams are read. An exit
 * code alone would not distinguish "logged in" from "ran successfully".
 *
 * Every invocation is checked for rotation, not just the first: the CLI could
 * refresh at any point, and the copy is deleted on the way out, so a rotation
 * detected only after the fact would still have stranded the original. The
 * expiry margin above is a precaution, not a guarantee — the CLI's own refresh
 * policy is not ours to predict — which makes this assertion the real safeguard.
 */
let sessionCleared = false;

function loginStatus() {
  const before = refreshInCopy();
  const result = spawnSync(codex, ["login", "status"], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });

  // Before `result.error`, deliberately. A CLI that refreshed and *then* hit the
  // timeout has already rotated the token; reporting that as a timeout would
  // send the operator looking at the wrong thing while the original file sits
  // there holding a retired credential.
  const after = refreshInCopy();
  if (!sessionCleared) {
    assert.equal(
      after,
      before,
      `the CLI rotated or dropped the refresh token; ${source} now holds a retired one ` +
        "and needs `codex login` again",
    );
  }

  if (result.error) throw result.error;
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

try {
  fs.copyFileSync(source, copy);
  fs.chmodSync(copy, 0o600);

  // Baseline: the CLI accepts the untouched copy. `loginStatus` fails the check
  // if this — or any later — invocation rotates the token.
  assert.match(loginStatus(), /Logged in/i, "the CLI accepts the copied file before we touch it");

  // Write through our adapter, exactly as a token refresh would.
  const store = codexAuthStore(copy);
  const session = store.read();
  assert.notEqual(session, null, "the adapter read the copied session");
  store.write(session);

  // The real question: does the CLI still accept what we wrote?
  assert.match(loginStatus(), /Logged in/i, "the CLI still accepts the file after our write");

  assert.equal(
    (fs.statSync(copy).mode & 0o777).toString(8),
    "600",
    "the file we wrote is owner-only",
  );

  // --- clearing the session must not strand the CLI -----------------------
  // An API key alongside the session: after clearing, the CLI should fall back
  // to it. Leaving `auth_mode: "chatgpt"` next to a null token instead makes the
  // CLI report a ChatGPT login whose every request 401s, and hides the key.
  const withKey = JSON.parse(fs.readFileSync(copy, "utf8"));
  withKey.OPENAI_API_KEY = "sk-proj-AC9TESTKEY000000000000000000000000";
  fs.writeFileSync(copy, JSON.stringify(withKey), { mode: 0o600 });

  store.clear();
  // Past this point the copy holds no refresh token, so `loginStatus` has nothing
  // to compare and the rotation check would compare null against null forever.
  sessionCleared = true;

  assert.ok(fs.existsSync(copy), "clearing does not delete a file holding other credentials");
  const cleared = JSON.parse(fs.readFileSync(copy, "utf8"));
  assert.equal(cleared.tokens, null, "the ChatGPT session is gone");
  assert.equal(cleared.OPENAI_API_KEY, withKey.OPENAI_API_KEY, "the API key survived");

  const afterClear = loginStatus();
  assert.match(afterClear, /API key/i, `the CLI falls back to the API key, got: ${afterClear.trim()}`);
  assert.doesNotMatch(
    afterClear,
    /Logged in using ChatGPT/i,
    "the CLI must not report a ChatGPT login after the session was cleared",
  );

  console.log("AC9 OK: the CLI accepts our writes, and falls back to its API key after a clear");
} catch (error) {
  // `message` first and always: it names what failed. Leading with the child's
  // output hides that behind whatever the CLI last printed.
  const detail = [error.message, error.stdout, error.stderr]
    .filter((part) => part && String(part).trim())
    .join("\n---\n");
  console.error("AC9 FAILED:", detail.slice(0, 1500));
  process.exitCode = 1;
}
