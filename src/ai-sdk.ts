/**
 * AI SDK bridge.
 *
 * ⚠️ Personal, single-account use only — see docs/personal-use.md.
 *
 * `createOpenAI` is a parameter rather than an import, which is what keeps this
 * package free of any dependency at all. Provider packages move fast and their
 * spec versions are not interchangeable: pinning one here would force every
 * consumer onto that exact major. Passing the factory in means each consumer
 * uses its own version, and the generic hands back that version's own provider
 * type rather than a lowest-common-denominator shape.
 */
import { CODEX_BASE_URL } from "./constants";
import { createCodexFetch, type AccessSource } from "./codex-fetch";

export type OpenAIFactoryInit = {
  baseURL: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
};

/**
 * Build an OpenAI-compatible provider backed by a ChatGPT subscription.
 *
 * ```ts
 * import { createOpenAI } from "@ai-sdk/openai";
 * const provider = createChatGPTOpenAIProvider({ auth, createOpenAI });
 * const model = provider.responses("gpt-5.6-sol");
 * ```
 *
 * Use `.responses(...)`: the Codex backend serves the Responses API, and it
 * streams only — `generateText`/`generateObject` against it fail with
 * "Stream must be set to true". Reach for `streamText`/`streamObject` instead.
 *
 * The api key is a placeholder. Authentication rides on the fetch wrapper's
 * Authorization header, not on this value, but the SDK requires something here.
 */
export function createChatGPTOpenAIProvider<TProvider>(options: {
  auth: AccessSource;
  createOpenAI: (init: OpenAIFactoryInit) => TProvider;
  baseURL?: string;
  /**
   * Underlying transport, wrapped in the credential layer — the same meaning
   * `fetch` has in `CodexFetchOptions`. Pass a tracing or proxying fetch here
   * and it still receives the Authorization, originator, and `store: false`
   * treatment. It does **not** replace the wrapper; a provider without that
   * wrapper is rejected by the backend.
   */
  fetch?: typeof globalThis.fetch;
}): TProvider {
  return options.createOpenAI({
    baseURL: options.baseURL ?? CODEX_BASE_URL,
    apiKey: "chatgpt-oauth",
    fetch: createCodexFetch(options.auth, { fetch: options.fetch }),
  });
}
