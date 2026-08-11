/**
 * AC5 fixture — a node10/CommonJS consumer without lib.dom.
 *
 * This is the strictest environment subauth claims to support. It exercises the
 * public types, not just the runtime: if any exported signature referenced a
 * DOM-only type, or if the root `types`/`main` fields were dropped in favour of
 * an exports map alone, this file would fail to compile.
 */
import {
  createChatGPTAuth,
  createCodexFetch,
  fileTokenStore,
  memoryTokenStore,
  providerOf,
  NotAuthenticatedError,
  CODEX_BASE_URL,
  type AuthStatus,
  type ChatGPTAuth,
  type FetchLike,
  type OAuthTokens,
  type TokenStore,
} from "subauth";
import { loginWithBrowser } from "subauth/login";
import { createChatGPTOpenAIProvider, type OpenAIFactoryInit } from "subauth/ai-sdk";

const NOW = 1_800_000_000_000;

const tokens: OAuthTokens = {
  access: "access-1",
  refresh: "refresh-1",
  accountId: "acct-1",
  expires: NOW,
};

const store: TokenStore = memoryTokenStore(tokens);

const fetchImpl: FetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 }),
});

const auth: ChatGPTAuth = createChatGPTAuth({
  store,
  fetch: fetchImpl,
  now: () => NOW,
  sleep: async () => {},
});

async function main(): Promise<void> {
  const grant = await auth.getFreshAccess();
  if (grant.access !== "access-2") throw new Error("expected the refreshed access token");

  const status: AuthStatus = auth.status();
  if (!status.exists) throw new Error("expected an existing session");

  // The wrapper's type must be assignable to the platform fetch signature.
  const codexFetch: typeof globalThis.fetch = createCodexFetch(auth);
  if (typeof codexFetch !== "function") throw new Error("expected a fetch function");

  if (providerOf("gpt-5.6-sol") !== "openai") throw new Error("expected openai");
  if (CODEX_BASE_URL.length === 0) throw new Error("expected a base url");
  if (typeof fileTokenStore !== "function") throw new Error("expected fileTokenStore");
  if (typeof loginWithBrowser !== "function") throw new Error("expected loginWithBrowser");

  // The generic must return the caller's own provider type.
  const provider = createChatGPTOpenAIProvider({
    auth,
    createOpenAI: (init: OpenAIFactoryInit) => ({
      responses: (model: string) => ({ model, baseURL: init.baseURL }),
    }),
  });
  if (provider.responses("gpt-5.6-sol").model !== "gpt-5.6-sol") {
    throw new Error("expected the provider factory result to pass through");
  }

  const empty = createChatGPTAuth({ store: memoryTokenStore(null), fetch: fetchImpl });
  try {
    await empty.getFreshAccess();
    throw new Error("expected NotAuthenticatedError");
  } catch (error) {
    if (!(error instanceof NotAuthenticatedError)) throw error;
  }

  console.log("AC5 OK: node10 CommonJS consumer compiled without lib.dom and ran");
}

void main().catch((error: unknown) => {
  console.error("AC5 FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
