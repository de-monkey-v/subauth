import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatGPTAuth } from "../src/auth";
import { loginWithBrowser } from "../src/browser-login";
import { createCodexFetch, type AccessSource } from "../src/codex-fetch";
import { TokenRequestError } from "../src/errors";
import { fileTokenStore } from "../src/store-file";
import { memoryTokenStore } from "../src/store-memory";
import type { FetchLike, FetchLikeResponse, OAuthTokens } from "../src/types";

/**
 * Regressions for defects found in review. Each test fails against the code as
 * it stood before the corresponding fix.
 */

const NOW = 1_800_000_000_000;

function expiring(): OAuthTokens {
  return { access: "access-old", refresh: "refresh-old", accountId: "acct-1", expires: NOW };
}

function response(status: number, body: unknown): FetchLikeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

describe("loginWithBrowser — abort before start", () => {
  it("rejects immediately without opening a browser", async () => {
    // `addEventListener("abort")` never fires on an already-aborted signal, so
    // the flow used to bind a port, launch a browser, and hang forever.
    let opened = 0;
    const attempt = loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      signal: AbortSignal.abort(),
      openBrowser: () => {
        opened++;
      },
      fetch: async () => response(200, {}),
      now: () => NOW,
    });

    await expect(attempt).rejects.toThrow();
    expect(opened).toBe(0);
  });

  it("rejects rather than hanging when a consumer callback throws", async () => {
    const attempt = loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: () => {
        throw new Error("EPIPE: stdout closed");
      },
      fetch: async () => response(200, {}),
      now: () => NOW,
    });

    await expect(attempt).rejects.toThrow(/EPIPE/);
  });
});

describe("fileTokenStore — first write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "subauth-fix-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates missing parent directories", () => {
    // The login path calls write() *after* spending its single-use
    // authorization code, so an ENOENT here costs the whole login.
    const nested = path.join(dir, "config", "myapp", "tokens.json");
    const store = fileTokenStore(nested);

    expect(() => store.write(expiring())).not.toThrow();
    expect(store.read()).toMatchObject({ access: "access-old" });
    expect(statSync(nested).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
  });

  it("treats an already-deleted file as a successful clear", () => {
    const store = fileTokenStore(path.join(dir, "tokens.json"));
    store.write(expiring());
    rmSync(path.join(dir, "tokens.json"));
    // Racing a sibling process's logout must not throw.
    expect(() => store.clear()).not.toThrow();
    expect(existsSync(path.join(dir, "tokens.json"))).toBe(false);
  });
});

describe("token endpoint — malformed success responses", () => {
  it("rejects a 200 that is not JSON with a coded error", async () => {
    const store = memoryTokenStore(expiring());
    const auth = createChatGPTAuth({
      store,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => "<html>gateway</html>",
        json: async () => JSON.parse("<html>gateway</html>") as unknown,
      }),
      now: () => NOW,
      sleep: async () => {},
    });

    const error = await auth.getFreshAccess().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenRequestError);
    // A raw SyntaxError would escape the package's error contract.
    expect((error as TokenRequestError).code).toBe("token_request_failed");
    expect(store.read()).toMatchObject({ access: "access-old" });
  });

  it("rejects a 200 with no access token instead of destroying the session", async () => {
    // Storing `access: undefined` would overwrite a working session, and the
    // record then fails validation on read — taking the refresh token with it.
    const store = memoryTokenStore(expiring());
    const write = vi.spyOn(store, "write");
    const auth = createChatGPTAuth({
      store,
      fetch: async () => response(200, { refresh_token: "refresh-new", expires_in: 3600 }),
      now: () => NOW,
      sleep: async () => {},
    });

    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(TokenRequestError);
    expect(write).not.toHaveBeenCalled();
    expect(store.read()).toMatchObject({ access: "access-old", refresh: "refresh-old" });
  });
});

describe("createCodexFetch — Request input", () => {
  it("preserves headers and rewrites the body when called with a Request", async () => {
    // Typed as the platform fetch, so `fetch(new Request(...))` is legitimate.
    // Reading only from `init` dropped the content-type, which skipped the
    // store:false rewrite and got the call rejected by the backend.
    const seen: Array<{ headers: Headers; body: unknown }> = [];
    const auth: AccessSource = {
      getFreshAccess: async () => ({ access: "access-1", accountId: "acct-1" }),
    };
    const fetch = createCodexFetch(auth, {
      fetch: (async (_input: unknown, init?: RequestInit) => {
        seen.push({
          headers: new Headers(init?.headers as RequestInit["headers"]),
          body: init?.body,
        });
        return new Response("ok");
      }) as typeof globalThis.fetch,
    });

    await fetch(
      new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", store: true }),
      }),
    );

    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer access-1");
    expect(JSON.parse(seen[0]!.body as string)).toEqual({ model: "gpt-5.6-sol", store: false });
  });
});

describe("createCodexFetch — second review round", () => {
  const auth: AccessSource = {
    getFreshAccess: async () => ({ access: "access-1", accountId: "acct-1" }),
  };

  function capturing() {
    const seen: Array<{ headers: Headers; body: unknown }> = [];
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push({
        headers: new Headers(init?.headers as RequestInit["headers"]),
        body: init?.body,
      });
      return new Response("ok");
    }) as typeof globalThis.fetch;
    return { seen, fetch };
  }

  it("merges Request headers under init headers instead of discarding them", async () => {
    // Taking init.headers wholesale dropped the request's content-type, which
    // skipped the store:false rewrite — the exact failure the Request handling
    // was added to prevent.
    const { seen, fetch: transport } = capturing();
    const fetch = createCodexFetch(auth, { fetch: transport });

    await fetch(
      new Request("https://example.invalid/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
      { headers: { "x-trace": "1" } },
    );

    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(seen[0]!.headers.get("x-trace")).toBe("1");
    expect(JSON.parse(seen[0]!.body as string)).toEqual({ a: 1, store: false });
  });

  it("lets init headers win over the request's", async () => {
    const { seen, fetch: transport } = capturing();
    const fetch = createCodexFetch(auth, { fetch: transport });

    await fetch(new Request("https://example.invalid/v1", { headers: { "x-mode": "from-request" } }), {
      headers: { "x-mode": "from-init" },
    });

    expect(seen[0]!.headers.get("x-mode")).toBe("from-init");
  });

  it("never reads or decodes a binary Request body", async () => {
    // Reading an arbitrary body as UTF-8 replaced non-text bytes with U+FFFD,
    // silently corrupting file and audio uploads.
    const { seen, fetch: transport } = capturing();
    const fetch = createCodexFetch(auth, { fetch: transport });

    const request = new Request("https://example.invalid/v1", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([0xff, 0x00, 0x41, 0xfe]),
    });
    await fetch(request);

    // Asserting on bodyUsed, not just the forwarded init: consuming the stream
    // and then discarding the result would leave the request unsendable while
    // still producing an undefined init.body.
    expect(request.bodyUsed).toBe(false);
    expect(seen[0]!.body).toBeUndefined();
  });

  it("leaves non-object JSON payloads intact", async () => {
    // Spreading an array turned `[{a:1}]` into `{"0":{a:1}}`, and a scalar body
    // disappeared entirely.
    const { seen, fetch: transport } = capturing();
    const fetch = createCodexFetch(auth, { fetch: transport });

    for (const payload of ['[{"a":1}]', "123", "null", '"text"']) {
      await fetch("https://example.invalid/v1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
    }

    expect(seen.map((call) => call.body)).toEqual(['[{"a":1}]', "123", "null", '"text"']);
  });
});

describe("device flow — malformed 200 responses", () => {
  function auth200(body: string) {
    return createChatGPTAuth({
      store: memoryTokenStore(null),
      now: () => NOW,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown,
      }),
    });
  }

  it("reports a non-JSON device start as a coded error", async () => {
    const error = await auth200("<html>portal</html>")
      .startDeviceAuth()
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("device_auth_failed");
  });

  it("rejects a device start missing its fields rather than polling forever", async () => {
    const error = await auth200('{"interval":5}')
      .startDeviceAuth()
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("device_auth_failed");
  });

  it("keeps the DevicePoll contract when the poll response is not JSON", async () => {
    // A raw SyntaxError here would break the documented return type.
    await expect(auth200("<html>portal</html>").pollDeviceToken("d", "c")).resolves.toMatchObject({
      status: "error",
    });
  });

  it("keeps the DevicePoll contract when the poll response omits its fields", async () => {
    // Asserting the specific reason, because a missing-field response also
    // fails later at the token exchange — which would make this test pass
    // without the device-level validation actually existing.
    await expect(auth200('{"ok":true}').pollDeviceToken("d", "c")).resolves.toEqual({
      status: "error",
      message: "device token response is missing fields",
    });
  });
});

describe("getFreshAccess — joining an in-flight refresh", () => {
  it("lets a joiner abort without cancelling the shared refresh", async () => {
    let release: (value: FetchLikeResponse) => void = () => {};
    const gate = new Promise<FetchLikeResponse>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(url);
      return gate;
    };
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch,
      now: () => NOW,
      sleep: async () => {},
    });

    const first = auth.getFreshAccess();
    const controller = new AbortController();
    const joiner = auth.getFreshAccess(controller.signal);

    controller.abort();
    await expect(joiner).rejects.toThrow();

    // The shared refresh is still running for the original caller.
    release(response(200, { access_token: "access-new", refresh_token: "r", expires_in: 3600 }));
    await expect(first).resolves.toMatchObject({ access: "access-new" });
    expect(calls).toHaveLength(1);
  });

  it("honours the initiator's signal too, not just a joiner's", async () => {
    // The abort contract should not depend on which caller happened to start
    // the refresh.
    let release: (value: FetchLikeResponse) => void = () => {};
    const gate = new Promise<FetchLikeResponse>((resolve) => {
      release = resolve;
    });
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch: async () => gate,
      now: () => NOW,
      sleep: async () => {},
    });

    const controller = new AbortController();
    const initiator = auth.getFreshAccess(controller.signal);
    controller.abort();

    await expect(initiator).rejects.toThrow();
    release(response(200, { access_token: "access-new", refresh_token: "r", expires_in: 3600 }));
  });
});
