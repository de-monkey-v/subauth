import { randomUUID } from "node:crypto";
import { API_ORIGINATOR } from "./constants";
import type { AccessGrant } from "./auth";

/** The single capability `createCodexFetch` needs — an auth object satisfies it. */
export type AccessSource = {
  getFreshAccess(signal?: AbortSignal): Promise<AccessGrant>;
};

export type CodexFetchOptions = {
  /** Underlying transport. Defaults to the platform `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Session id generator; one fresh id per request by default. */
  sessionId?: () => string;
  /** Originator header value. Bound to the client id — override with care. */
  originator?: string;
};

/**
 * Wrap the platform `fetch` so every request carries current ChatGPT
 * subscription credentials and satisfies the Codex backend's request contract.
 *
 * This is the package's real integration point, and it deliberately touches no
 * AI SDK types: anything that accepts a `fetch` — an SDK, a raw client, a test
 * harness — can use it.
 *
 * What it enforces, and why:
 * - a token read per request, since access tokens expire mid-session;
 * - `originator`, without which the backend answers 400;
 * - `store: false`, which the backend requires on JSON bodies;
 * - dropping `content-length` after rewriting the body, since a stale length
 *   truncates the request.
 */
/**
 * Add `store: false` to a JSON request body.
 *
 * Returns null when the body is not a JSON object — an array or scalar payload
 * would be destroyed by spreading it (`[{a:1}]` becomes `{"0":{a:1}}`), so those
 * pass through untouched.
 */
function withStoreFalse(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), store: false });
}

export function createCodexFetch(
  auth: AccessSource,
  options: CodexFetchOptions = {},
): typeof globalThis.fetch {
  // Resolved per call, not captured at construction: instrumentation that wraps
  // `globalThis.fetch` after this wrapper is built (tracing, mocking, polyfills)
  // must still be seen. An explicitly injected transport is fixed, as intended.
  const transport = () => options.fetch ?? globalThis.fetch;
  const sessionId = options.sessionId ?? randomUUID;
  const originator = options.originator ?? API_ORIGINATOR;

  const codexFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    // Checked on both sides of the token read: refreshing can take a network
    // round trip, and a caller who aborted during it must not reach the API.
    init?.signal?.throwIfAborted();
    const { access, accountId } = await auth.getFreshAccess(init?.signal ?? undefined);
    init?.signal?.throwIfAborted();

    // `fetch(new Request(...))` is a legitimate call for something typed as the
    // platform fetch, so headers and body may arrive on either argument.
    const asRequest =
      typeof Request !== "undefined" && input instanceof Request ? (input as Request) : null;

    // Request headers form the base and `init` overrides them, matching how
    // fetch itself merges the two. Taking `init.headers` wholesale would drop
    // the request's content-type — which then skips the `store: false` rewrite
    // and gets the call rejected — whenever a caller passes any init header.
    const headers = new Headers(asRequest?.headers);
    if (init?.headers) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    headers.set("Authorization", `Bearer ${access}`);
    if (accountId) headers.set("chatgpt-account-id", accountId);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", originator);
    headers.set("session_id", sessionId());

    const nextInit: RequestInit = { ...init, headers };
    const isJson = headers.get("content-type")?.includes("application/json") ?? false;

    // Only JSON bodies are ever read. Decoding an arbitrary body as UTF-8 would
    // corrupt binary payloads, and buffering a stream that needs no rewrite
    // costs memory for nothing.
    let rawBody: string | undefined;
    if (typeof init?.body === "string") {
      rawBody = init.body;
    } else if (init?.body === undefined && isJson && asRequest?.body != null) {
      // Not cloned: `init.body` takes precedence over the input request's body,
      // so the original is never read again — and teeing it would keep a second
      // full copy alive until the caller's Request is collected.
      rawBody = await asRequest.text();
    }

    if (isJson && rawBody !== undefined) {
      const rewritten = withStoreFalse(rawBody);
      if (rewritten !== null) {
        nextInit.body = rewritten;
        // The length changed; a stale content-length truncates the request.
        headers.delete("content-length");
      } else if (rawBody !== init?.body) {
        // Read from the request but not rewritable — it must still be sent,
        // because the request's own body has already been consumed.
        nextInit.body = rawBody;
      }
    }

    return transport()(input, nextInit);
  };

  return codexFetch as typeof globalThis.fetch;
}
