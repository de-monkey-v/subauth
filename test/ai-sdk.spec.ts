import { describe, expect, it, vi } from "vitest";
import { createChatGPTOpenAIProvider, type OpenAIFactoryInit } from "../src/ai-sdk";
import { CODEX_BASE_URL } from "../src/constants";
import type { AccessSource } from "../src/codex-fetch";

const auth: AccessSource = {
  getFreshAccess: async () => ({ access: "access-1", accountId: "acct-1" }),
};

/** Stands in for `createOpenAI` from whichever @ai-sdk/openai the consumer has. */
function fakeFactory() {
  const seen: OpenAIFactoryInit[] = [];
  const factory = vi.fn((init: OpenAIFactoryInit) => {
    seen.push(init);
    return { responses: (model: string) => ({ model }) };
  });
  return Object.assign(factory, { seen });
}

describe("createChatGPTOpenAIProvider", () => {
  it("points the provider at the Codex backend with a credential-bearing fetch", async () => {
    const createOpenAI = fakeFactory();

    createChatGPTOpenAIProvider({ auth, createOpenAI });

    const init = createOpenAI.seen[0]!;
    expect(init.baseURL).toBe(CODEX_BASE_URL);
    expect(init.apiKey).toBe("chatgpt-oauth");
    expect(typeof init.fetch).toBe("function");
  });

  it("hands back exactly what the consumer's factory returned", () => {
    // The generic exists so a consumer keeps its own provider type rather than
    // a lowest-common-denominator shape from this package.
    const provider = createChatGPTOpenAIProvider({ auth, createOpenAI: fakeFactory() });
    expect(provider.responses("gpt-5.6-sol")).toEqual({ model: "gpt-5.6-sol" });
  });

  it("honours an overridden base url", () => {
    const createOpenAI = fakeFactory();
    createChatGPTOpenAIProvider({ auth, createOpenAI, baseURL: "http://127.0.0.1:10531/v1" });
    expect(createOpenAI.seen[0]!.baseURL).toBe("http://127.0.0.1:10531/v1");
  });

  it("wraps an injected fetch rather than replacing the credential layer", async () => {
    // `fetch` means the same thing here as in CodexFetchOptions: the underlying
    // transport, inside the wrapper. Handing it straight to the provider would
    // silently produce unauthenticated requests for anyone passing a tracing or
    // proxying fetch.
    const createOpenAI = fakeFactory();
    const seen: Array<Record<string, string>> = [];
    const custom = (async (_input: unknown, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init?.headers as RequestInit["headers"])));
      return new Response("ok");
    }) as typeof globalThis.fetch;

    createChatGPTOpenAIProvider({ auth, createOpenAI, fetch: custom });
    expect(createOpenAI.seen[0]!.fetch).not.toBe(custom);

    await createOpenAI.seen[0]!.fetch("https://example.invalid/v1");

    expect(seen[0]!["authorization"]).toBe("Bearer access-1");
    expect(seen[0]!["originator"]).toBe("codex_cli_rs");
  });

  it("builds a fetch that actually injects the credential", async () => {
    const createOpenAI = fakeFactory();
    createChatGPTOpenAIProvider({ auth, createOpenAI });

    let seenAuth: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seenAuth = new Headers(init?.headers as RequestInit["headers"]).get("authorization");
      return new Response("ok");
    }) as typeof globalThis.fetch;
    try {
      await createOpenAI.seen[0]!.fetch("https://example.invalid/v1");
    } finally {
      globalThis.fetch = original;
    }

    expect(seenAuth).toBe("Bearer access-1");
  });
});
