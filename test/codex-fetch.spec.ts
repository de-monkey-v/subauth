import { describe, expect, it, vi } from "vitest";
import { createCodexFetch, type AccessSource } from "../src/codex-fetch";
import { API_ORIGINATOR } from "../src/constants";

type Captured = { input: unknown; init: RequestInit | undefined };

/** Records what the wrapper hands to the underlying transport. */
function capturingTransport() {
  const seen: Captured[] = [];
  const transport = vi.fn(async (input: unknown, init?: RequestInit) => {
    seen.push({ input, init });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(transport, { seen });
}

function authStub(
  grant: { access: string; accountId?: string } = { access: "access-1", accountId: "acct-1" },
): AccessSource {
  return { getFreshAccess: vi.fn(async () => grant) };
}

// `HeadersInit` is a DOM lib type and this package compiles without lib.dom —
// the same constraint its strictest consumer has. Use the RequestInit member.
function headersOf(captured: Captured): Headers {
  return new Headers(captured.init?.headers as RequestInit["headers"]);
}

describe("createCodexFetch — headers", () => {
  it("injects the credential and Codex protocol headers", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport, sessionId: () => "sess-1" });

    await fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });

    const headers = headersOf(transport.seen[0]!);
    expect(headers.get("authorization")).toBe("Bearer access-1");
    expect(headers.get("chatgpt-account-id")).toBe("acct-1");
    expect(headers.get("openai-beta")).toBe("responses=experimental");
    expect(headers.get("originator")).toBe(API_ORIGINATOR);
    expect(headers.get("session_id")).toBe("sess-1");
  });

  it("omits chatgpt-account-id when the session has no account id", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub({ access: "a", accountId: undefined }), {
      fetch: transport,
    });

    await fetch("https://example.invalid/v1");

    expect(headersOf(transport.seen[0]!).has("chatgpt-account-id")).toBe(false);
  });

  it("issues a distinct session id per request", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport });

    await fetch("https://example.invalid/v1");
    await fetch("https://example.invalid/v1");

    const [first, second] = transport.seen.map((c) => headersOf(c).get("session_id"));
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("preserves caller headers it does not own", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport });

    await fetch("https://example.invalid/v1", { headers: { "x-trace": "abc" } });

    expect(headersOf(transport.seen[0]!).get("x-trace")).toBe("abc");
  });

  it("reads a fresh token on every request", async () => {
    const auth = authStub();
    const transport = capturingTransport();
    const fetch = createCodexFetch(auth, { fetch: transport });

    await fetch("https://example.invalid/v1");
    await fetch("https://example.invalid/v1");

    expect(auth.getFreshAccess).toHaveBeenCalledTimes(2);
  });
});

describe("createCodexFetch — body rewriting", () => {
  it("forces store:false on JSON bodies", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport });

    await fetch("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
    });

    const body = JSON.parse(transport.seen[0]!.init!.body as string) as Record<string, unknown>;
    expect(body).toEqual({ model: "gpt-5.6-sol", stream: true, store: false });
  });

  it("overrides a caller that asked for store:true", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport });

    await fetch("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ store: true }),
    });

    expect(JSON.parse(transport.seen[0]!.init!.body as string)).toEqual({ store: false });
  });

  it("drops content-length after rewriting, so the body is not truncated", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport });

    await fetch("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: "{}",
    });

    expect(headersOf(transport.seen[0]!).has("content-length")).toBe(false);
  });

  it("leaves non-JSON requests, unparseable bodies, and binary bodies untouched", async () => {
    const transport = capturingTransport();
    const fetch = createCodexFetch(authStub(), { fetch: transport });

    await fetch("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "text/plain", "content-length": "5" },
      body: "hello",
    });
    expect(transport.seen[0]!.init!.body).toBe("hello");
    // Only the JSON rewrite path touches content-length.
    expect(headersOf(transport.seen[0]!).get("content-length")).toBe("5");

    await fetch("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json at all",
    });
    expect(transport.seen[1]!.init!.body).toBe("not json at all");

    const binary = new Uint8Array([1, 2, 3]);
    await fetch("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: binary,
    });
    expect(transport.seen[2]!.init!.body).toBe(binary);
  });
});

describe("createCodexFetch — abort", () => {
  it("does not read a token or call the transport when already aborted", async () => {
    const auth = authStub();
    const transport = capturingTransport();
    const fetch = createCodexFetch(auth, { fetch: transport });

    await expect(fetch("https://example.invalid/v1", { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(auth.getFreshAccess).not.toHaveBeenCalled();
    expect(transport.seen).toHaveLength(0);
  });

  it("does not call the transport when the abort lands during the token refresh", async () => {
    const controller = new AbortController();
    const transport = capturingTransport();
    const auth: AccessSource = {
      getFreshAccess: vi.fn(async () => {
        controller.abort();
        return { access: "a", accountId: undefined };
      }),
    };
    const fetch = createCodexFetch(auth, { fetch: transport });

    await expect(
      fetch("https://example.invalid/v1", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(auth.getFreshAccess).toHaveBeenCalledTimes(1);
    expect(transport.seen).toHaveLength(0);
  });

  it("passes the signal through to the token read so a refresh can be cancelled", async () => {
    const auth = authStub();
    const transport = capturingTransport();
    const controller = new AbortController();
    const fetch = createCodexFetch(auth, { fetch: transport });

    await fetch("https://example.invalid/v1", { signal: controller.signal });

    expect(auth.getFreshAccess).toHaveBeenCalledWith(controller.signal);
  });
});
