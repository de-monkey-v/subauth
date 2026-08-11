#!/usr/bin/env node
/**
 * AC8 — the Codex CLI's real `auth.json` is usable without re-authenticating,
 * and stays usable by the CLI after we write to it.
 *
 * Runs against a *copy*. The real file backs a live session, and this check
 * rotates nothing — but it writes, and writing to the original would be
 * meddling with credentials the CLI is currently using.
 *
 * When no Codex login exists on this machine the check reports that and exits
 * successfully: the adapter's behaviour is covered by unit tests against
 * synthetic files, and this one exists to confirm the *real* shape still
 * matches. A machine without the CLI cannot answer that question either way.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { codexAuthStore, createChatGPTAuth } = require("../../dist/index.js");

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const original = path.join(codexHome, "auth.json");

if (!fs.existsSync(original)) {
  console.log(`AC8 SKIPPED: no Codex login at ${original}`);
  process.exit(0);
}

// Snapshot the real file up front. The final assertion compares against these
// bytes — reading the same file twice at the end would pass no matter what
// happened to it in between.
const originalBytes = fs.readFileSync(original);
const originalMode = fs.statSync(original).mode;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "subauth-ac8-"));
const copy = path.join(work, "auth.json");

try {
  fs.copyFileSync(original, copy);
  fs.chmodSync(copy, 0o600);

  const before = JSON.parse(fs.readFileSync(copy, "utf8"));

  // An API-key login writes this same file with `tokens: null`. There is no
  // ChatGPT session to adapt there, so the question this check asks does not
  // apply — that is a skip, not a failure.
  if (!before.tokens || typeof before.tokens !== "object" || !before.tokens.access_token) {
    console.log("AC8 SKIPPED: the Codex auth file holds no ChatGPT session (API-key mode)");
    process.exit(0);
  }

  const store = codexAuthStore(copy);

  // --- read: the existing session is usable as-is -------------------------
  const session = store.read();
  assert.notEqual(session, null, "the real Codex auth.json was readable");
  assert.equal(typeof session.access, "string", "access token read");
  assert.equal(typeof session.refresh, "string", "refresh token read");
  assert.equal(
    session.access,
    before.tokens.access_token,
    "access token came from tokens.access_token",
  );
  assert.equal(
    session.refresh,
    before.tokens.refresh_token,
    "refresh token came from tokens.refresh_token",
  );
  if (before.tokens.account_id) {
    assert.equal(session.accountId, before.tokens.account_id, "account id read");
  }

  // The expiry has to come from the access token itself; this format has none.
  const claims = JSON.parse(
    Buffer.from(session.access.split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal(session.expires, claims.exp * 1000, "expiry derived from the JWT exp claim");
  assert.equal(store.exists(), true, "the store reports a usable session");

  // --- the auth object accepts it without a login -------------------------
  const auth = createChatGPTAuth({ store });
  assert.equal(auth.exists(), true, "createChatGPTAuth sees an existing session");
  const status = auth.status();
  assert.equal(status.exists, true, "status reports a session");
  assert.equal(
    JSON.stringify(status).includes(session.refresh),
    false,
    "status still does not expose a token",
  );

  // --- write: the CLI's own fields survive --------------------------------
  store.write({
    access: session.access,
    refresh: session.refresh,
    accountId: session.accountId,
    expires: session.expires,
  });

  const after = JSON.parse(fs.readFileSync(copy, "utf8"));
  for (const key of Object.keys(before)) {
    assert.ok(key in after, `top-level field "${key}" survived the write`);
  }
  for (const key of Object.keys(before.tokens)) {
    assert.ok(key in after.tokens, `tokens.${key} survived the write`);
  }
  assert.equal(after.auth_mode, before.auth_mode, "auth_mode preserved");
  assert.equal(after.tokens.id_token, before.tokens.id_token, "id_token preserved");
  assert.notEqual(after.last_refresh, undefined, "last_refresh recorded");
  assert.equal((fs.statSync(copy).mode & 0o777).toString(8), "600", "file stays owner-only");

  // Re-readable by our own adapter, which is the CLI's contract too.
  assert.notEqual(codexAuthStore(copy).read(), null, "the file is still a valid Codex auth.json");

  // --- the original was never touched -------------------------------------
  assert.ok(
    fs.readFileSync(original).equals(originalBytes),
    "the real credential file is byte-identical to the snapshot taken at start",
  );
  assert.equal(fs.statSync(original).mode, originalMode, "the real file's mode is unchanged");

  console.log("AC8 OK: existing Codex login read without re-auth; CLI fields preserved on write");
} catch (error) {
  console.error("AC8 FAILED:", error && error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
