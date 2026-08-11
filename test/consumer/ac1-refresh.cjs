#!/usr/bin/env node
/**
 * AC1 — a CommonJS consumer refreshes an expiring session through the built
 * package and the renewed token lands on disk with owner-only permissions.
 *
 * Runs in its own process against dist/, not src/, so it exercises what a
 * consumer actually installs.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createChatGPTAuth, fileTokenStore } = require("../../dist/index.js");

const NOW = 1_800_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subauth-ac1-"));
const tokenFile = path.join(dir, "tokens.json");

async function main() {
  // A session that is inside the refresh margin, so a refresh is required.
  fs.writeFileSync(
    tokenFile,
    JSON.stringify({
      access: "access-stale",
      refresh: "refresh-stale",
      accountId: "acct-1",
      expires: NOW,
    }),
  );

  const requests = [];
  const auth = createChatGPTAuth({
    store: fileTokenStore(tokenFile),
    now: () => NOW,
    fetch: async (url, init) => {
      requests.push({ url, body: init.body });
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          access_token: "access-renewed",
          refresh_token: "refresh-renewed",
          expires_in: 3600,
        }),
      };
    },
  });

  const grant = await auth.getFreshAccess();
  assert.equal(grant.access, "access-renewed", "the refreshed access token is returned");
  assert.equal(grant.accountId, "acct-1", "the account id is carried forward");

  assert.equal(requests.length, 1, "exactly one token request was made");
  assert.match(requests[0].url, /\/oauth\/token$/, "the token endpoint was called");
  assert.match(requests[0].body, /grant_type=refresh_token/, "a refresh grant was sent");

  const persisted = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  assert.equal(persisted.access, "access-renewed", "the new access token was persisted");
  assert.equal(persisted.refresh, "refresh-renewed", "the rotated refresh token was persisted");
  assert.equal(persisted.expires, NOW + 3_600_000, "the new expiry was persisted");

  const mode = fs.statSync(tokenFile).mode & 0o777;
  assert.equal(mode, 0o600, `the token file is owner-only (found ${mode.toString(8)})`);

  // A second call inside the new validity window must not hit the network.
  const cached = await auth.getFreshAccess();
  assert.equal(cached.access, "access-renewed");
  assert.equal(requests.length, 1, "a still-valid token is reused without a refresh");

  assert.equal(auth.status().accountId, "acct-1");
  assert.equal(auth.status().access, undefined, "status never carries a token");

  console.log("AC1 OK: cjs consumer refreshed the session and stored it 0600");
}

main()
  .catch((error) => {
    console.error("AC1 FAILED:", error && error.message);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
