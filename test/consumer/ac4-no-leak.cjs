#!/usr/bin/env node
/**
 * AC4 — a consumer that hits an endpoint echoing its own request body back
 * never sees the refresh token in the resulting error.
 *
 * This is the hostile case the scrubbing exists for: the token endpoint is sent
 * the refresh token, so an echoing proxy hands a live credential to the error
 * path, from where it would reach logs and bug reports.
 */
"use strict";

const assert = require("node:assert/strict");
const { createChatGPTAuth, memoryTokenStore } = require("../../dist/index.js");

const NOW = 1_800_000_000_000;
const REFRESH = "rt_SUPERSECRET_9fJk2LmNpQrStUvWxYz0123456789AbCdEfGh";
const ACCESS_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEyMyJ9.signaturebytes";

function assertClean(label, text) {
  for (const secret of [REFRESH, REFRESH.slice(0, 16), ACCESS_JWT, "SUPERSECRET", "eyJ"]) {
    assert.equal(
      text.includes(secret),
      false,
      `${label} leaked ${JSON.stringify(secret.slice(0, 20))}`,
    );
  }
}

async function main() {
  const logged = [];
  const auth = createChatGPTAuth({
    store: memoryTokenStore({
      access: ACCESS_JWT,
      refresh: REFRESH,
      accountId: "acct-1",
      expires: NOW,
    }),
    now: () => NOW,
    sleep: async () => {},
    logger: { debug: (m) => logged.push(m), info: (m) => logged.push(m), warn: (m) => logged.push(m) },
    fetch: async () => ({
      ok: false,
      status: 500,
      // The endpoint reflects the request it received, refresh token included.
      text: async () =>
        `upstream error; request was grant_type=refresh_token&refresh_token=${REFRESH}`,
      json: async () => ({}),
    }),
  });

  let thrown;
  try {
    await auth.getFreshAccess();
    assert.fail("the refresh should have failed");
  } catch (error) {
    thrown = error;
  }

  assertClean("error.message", String(thrown.message));
  assertClean("error.stack", String(thrown.stack));
  assertClean("JSON.stringify(error)", JSON.stringify(thrown));
  assertClean("spread serialization", JSON.stringify({ ...thrown }));
  assertClean("logger output", logged.join("\n"));
  assertClean("status()", JSON.stringify(auth.status()));

  // The message must still be diagnosable after scrubbing.
  assert.match(thrown.message, /500/, "the status survives scrubbing");
  assert.equal(thrown.code, "token_request_failed", "the error carries a stable code");

  console.log("AC4 OK: no credential material in the error, stack, serialization, or logs");
}

main().catch((error) => {
  console.error("AC4 FAILED:", error && error.message);
  process.exitCode = 1;
});
