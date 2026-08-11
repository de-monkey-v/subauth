#!/usr/bin/env node
/**
 * AC3 — the fetch wrapper a consumer builds satisfies the Codex backend's
 * request contract: current credentials, the originator header the backend
 * demands, `store: false` on JSON bodies, and no stale content-length.
 */
"use strict";

const assert = require("node:assert/strict");
const { createCodexFetch } = require("../../dist/index.js");

async function main() {
  const seen = [];
  const fetch = createCodexFetch(
    { getFreshAccess: async () => ({ access: "access-1", accountId: "acct-1" }) },
    {
      sessionId: () => "sess-fixed",
      fetch: async (input, init) => {
        seen.push({ input, init });
        return new Response("ok", { status: 200 });
      },
    },
  );

  await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "999" },
    body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, store: true }),
  });

  assert.equal(seen.length, 1, "the request reached the transport");
  const headers = new Headers(seen[0].init.headers);

  assert.equal(headers.get("authorization"), "Bearer access-1", "credential injected");
  assert.equal(headers.get("chatgpt-account-id"), "acct-1", "account id injected");
  assert.equal(headers.get("originator"), "codex_cli_rs", "originator injected (400 without it)");
  assert.equal(headers.get("session_id"), "sess-fixed", "session id injected");
  assert.equal(headers.get("openai-beta"), "responses=experimental", "responses beta flag set");
  assert.equal(
    headers.has("content-length"),
    false,
    "stale content-length removed after the body was rewritten",
  );

  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.store, false, "store:false forced even though the caller asked for true");
  assert.equal(body.model, "gpt-5.6-sol", "caller fields preserved");
  assert.equal(body.stream, true, "caller fields preserved");

  // A non-JSON body must pass through untouched, content-length included.
  await fetch("https://example.invalid/v1", {
    method: "POST",
    headers: { "content-type": "text/plain", "content-length": "5" },
    body: "hello",
  });
  assert.equal(seen[1].init.body, "hello", "non-JSON body untouched");
  assert.equal(
    new Headers(seen[1].init.headers).get("content-length"),
    "5",
    "content-length preserved when the body was not rewritten",
  );

  console.log("AC3 OK: headers injected, store:false forced, content-length dropped");
}

main().catch((error) => {
  console.error("AC3 FAILED:", error && error.message);
  process.exitCode = 1;
});
