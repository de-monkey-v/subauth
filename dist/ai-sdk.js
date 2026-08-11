'use strict';

var crypto = require('crypto');

// src/constants.ts
var CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
var API_ORIGINATOR = "codex_cli_rs";
function withStoreFalse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return JSON.stringify({ ...parsed, store: false });
}
function createCodexFetch(auth, options = {}) {
  const transport = () => options.fetch ?? globalThis.fetch;
  const sessionId = options.sessionId ?? crypto.randomUUID;
  const originator = options.originator ?? API_ORIGINATOR;
  const codexFetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const { access, accountId } = await auth.getFreshAccess(init?.signal ?? void 0);
    init?.signal?.throwIfAborted();
    const asRequest = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const headers = new Headers(asRequest?.headers);
    if (init?.headers) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    headers.set("Authorization", `Bearer ${access}`);
    if (accountId) headers.set("chatgpt-account-id", accountId);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", originator);
    headers.set("session_id", sessionId());
    const nextInit = { ...init, headers };
    const isJson = headers.get("content-type")?.includes("application/json") ?? false;
    let rawBody;
    if (typeof init?.body === "string") {
      rawBody = init.body;
    } else if (init?.body === void 0 && isJson && asRequest?.body != null) {
      rawBody = await asRequest.text();
    }
    if (isJson && rawBody !== void 0) {
      const rewritten = withStoreFalse(rawBody);
      if (rewritten !== null) {
        nextInit.body = rewritten;
        headers.delete("content-length");
      } else if (rawBody !== init?.body) {
        nextInit.body = rawBody;
      }
    }
    return transport()(input, nextInit);
  };
  return codexFetch;
}

// src/ai-sdk.ts
function createChatGPTOpenAIProvider(options) {
  return options.createOpenAI({
    baseURL: options.baseURL ?? CODEX_BASE_URL,
    apiKey: "chatgpt-oauth",
    fetch: createCodexFetch(options.auth, { fetch: options.fetch })
  });
}

exports.createChatGPTOpenAIProvider = createChatGPTOpenAIProvider;
