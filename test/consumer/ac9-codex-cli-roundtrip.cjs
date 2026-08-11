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
 * Skipped when the CLI is absent or no login exists — a machine without either
 * cannot answer the question.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { codexAuthStore } = require("../../dist/index.js");

function findCodex() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "codex");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const codex = findCodex();
const source = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "auth.json");

if (!codex) {
  console.log("AC9 SKIPPED: the codex CLI is not on PATH");
  process.exit(0);
}
if (!fs.existsSync(source)) {
  console.log(`AC9 SKIPPED: no Codex login at ${source}`);
  process.exit(0);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "subauth-ac9-"));
const copy = path.join(home, "auth.json");

/**
 * The CLI reports its login state on stderr, so both streams are read. An exit
 * code alone would not distinguish "logged in" from "ran successfully".
 */
function loginStatus() {
  const result = spawnSync(codex, ["login", "status"], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

try {
  fs.copyFileSync(source, copy);
  fs.chmodSync(copy, 0o600);

  // Baseline: the CLI accepts the untouched copy.
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
  const detail = error.stdout || error.stderr || error.message;
  console.error("AC9 FAILED:", String(detail).slice(0, 1500));
  process.exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
