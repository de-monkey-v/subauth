#!/usr/bin/env node
/**
 * Banked scenario `session-destroying-200` — a token endpoint answers 200 while
 * returning fields of the wrong shape, and the stored session survives.
 *
 * This was a real defect: `refresh_token: 12345` or `expires_in: "soon"` was
 * written straight to disk, producing a record that failed its own read-back
 * validation. One malformed response ended a working session and took the
 * still-valid refresh token with it.
 *
 * Runs out of process against the built package, on a scratch file.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatGPTAuth, fileTokenStore } = require("../../dist/index.js");

const NOW = 1_800_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subauth-ac10-"));

const MALFORMED = [
  ["refresh_token is empty", { access_token: "a", refresh_token: "", expires_in: 3600 }],
  ["refresh_token is a number", { access_token: "a", refresh_token: 12345, expires_in: 3600 }],
  ["refresh_token is an object", { access_token: "a", refresh_token: {}, expires_in: 3600 }],
  ["refresh_token is an array", { access_token: "a", refresh_token: [], expires_in: 3600 }],
  ["expires_in is not a number", { access_token: "a", refresh_token: "rt", expires_in: "soon" }],
  ["expires_in is null", { access_token: "a", refresh_token: "rt", expires_in: null }],
  ["expires_in is negative", { access_token: "a", refresh_token: "rt", expires_in: -1 }],
];

async function main() {
  for (const [label, body] of MALFORMED) {
    const file = path.join(dir, `${label.replace(/\W+/g, "-")}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ access: "access-old", refresh: "refresh-old", accountId: "acct-1", expires: NOW }),
      { mode: 0o600 },
    );

    const store = fileTokenStore(file);
    const auth = createChatGPTAuth({
      store,
      now: () => NOW,
      sleep: async () => {},
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      }),
    });

    await auth.getFreshAccess().catch(() => undefined);

    const stored = store.read();
    assert.notEqual(stored, null, `${label}: the session is still readable`);
    assert.equal(typeof stored.refresh, "string", `${label}: refresh is a string`);
    assert.ok(stored.refresh.length > 0, `${label}: refresh is not empty`);
    assert.ok(Number.isFinite(stored.expires), `${label}: expiry is a finite number`);
    assert.ok(stored.expires > NOW, `${label}: expiry is in the future`);
    assert.equal(store.exists(), true, `${label}: the store reports a usable session`);
  }

  console.log(`AC10 OK: ${MALFORMED.length} malformed 200 responses left the session usable`);
}

main()
  .catch((error) => {
    console.error("AC10 FAILED:", error && error.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
