#!/usr/bin/env node
/**
 * AC6 — one process reaching this package through BOTH the CJS and the ESM
 * build still performs a single refresh for a given account.
 *
 * Why this needs its own process: module scope is per-bundle. A registry held
 * in module scope gives `require("subauth")` and `import("subauth")` separate
 * maps, so both refresh concurrently, the second exchange reuses a rotated
 * refresh token, and the server revokes the session. No in-process unit test
 * can see this — both halves of it resolve to the same source module.
 *
 * A mixed codebase reaches this state trivially: one file using require, another
 * using import, or two copies of the package in a dependency tree.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "..", "dist");
const require = createRequire(import.meta.url);

const cjs = require(path.join(dist, "index.js"));
const esm = await import(path.join(dist, "index.mjs"));

assert.notEqual(cjs, esm, "the two builds are distinct module objects");

const NOW = 1_800_000_000_000;

// One account, one token file — reached through both builds.
const tokens = {
  access: "access-old",
  refresh: "refresh-old",
  accountId: "acct-1",
  expires: NOW,
};
let stored = { ...tokens };
const store = {
  key: "/tmp/subauth-dual-instance-fixture",
  read: () => (stored ? { ...stored } : null),
  write: (next) => {
    stored = { ...next };
  },
  clear: () => {
    stored = null;
  },
  exists: () => stored !== null,
};

let exchanges = 0;
let rotatedTokenUsed = null;
const fetchImpl = async (_url, init) => {
  exchanges++;
  const sent = new URLSearchParams(init.body).get("refresh_token");
  // The server revokes the session if a rotated refresh token is presented again.
  if (rotatedTokenUsed !== null && sent === rotatedTokenUsed) {
    return {
      ok: false,
      status: 400,
      text: async () => "invalid_grant: refresh token reuse detected",
      json: async () => ({}),
    };
  }
  rotatedTokenUsed = sent;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    }),
  };
};

const options = { store, fetch: fetchImpl, now: () => NOW, sleep: async () => {} };
const viaCjs = cjs.createChatGPTAuth(options);
const viaEsm = esm.createChatGPTAuth(options);

const [a, b] = await Promise.all([viaCjs.getFreshAccess(), viaEsm.getFreshAccess()]);

assert.equal(exchanges, 1, `expected a single token exchange, saw ${exchanges}`);
assert.equal(a.access, "access-new", "the CJS caller got the refreshed token");
assert.equal(b.access, "access-new", "the ESM caller got the same token");
assert.equal(store.read().refresh, "refresh-new", "the rotated refresh token was stored");
assert.notEqual(store.read(), null, "the session survived");

console.log("AC6 OK: CJS and ESM builds share one in-flight refresh per account");
