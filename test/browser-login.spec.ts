import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { loginWithBrowser } from "../src/browser-login";
import { LoginFailedError } from "../src/errors";
import { memoryTokenStore } from "../src/store-memory";
import type { FetchLike } from "../src/types";

const NOW = 1_800_000_000_000;
const ACCESS_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTk5OSJ9.signaturebytes";

const exchangeOk: FetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => "",
  json: async () => ({ access_token: ACCESS_JWT, refresh_token: "refresh-1", expires_in: 3600 }),
});

/** GET the loopback callback the login server is waiting on. */
function hitCallback(url: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "localhost",
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Derive the callback URL the server expects from the authorize URL it emitted. */
function callbackFor(authorizeUrl: string, params: Record<string, string>): string {
  const authorize = new URL(authorizeUrl);
  const callback = new URL(authorize.searchParams.get("redirect_uri")!);
  for (const [key, value] of Object.entries(params)) callback.searchParams.set(key, value);
  if (params["state"] === "__valid__") {
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
  }
  return callback.toString();
}

describe("loginWithBrowser", () => {
  it("completes the flow and returns status without any token", async () => {
    const store = memoryTokenStore(null);
    const status = await loginWithBrowser({
      store,
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: (url) => {
        void hitCallback(callbackFor(url, { code: "auth-code-1", state: "__valid__" }));
      },
      fetch: exchangeOk,
      now: () => NOW,
    });

    expect(status).toEqual({ exists: true, accountId: "acct-999", expires: NOW + 3_600_000 });
    expect(JSON.stringify(status)).not.toContain("refresh-1");
    expect(JSON.stringify(status)).not.toContain("eyJ");
    // The session is stored; it simply never crossed the API boundary.
    expect(store.read()).toMatchObject({ access: ACCESS_JWT, refresh: "refresh-1" });
  });

  it("emits an authorize URL carrying the PKCE and Codex client parameters", async () => {
    let seen = "";
    await loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: (url) => {
        seen = url;
        void hitCallback(callbackFor(url, { code: "c", state: "__valid__" }));
      },
      fetch: exchangeOk,
      now: () => NOW,
    });

    const params = new URL(seen).searchParams;
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("scope")).toBe("openid profile email offline_access");
    expect(params.get("originator")).toBe("opencode");
    expect(params.get("id_token_add_organizations")).toBe("true");
    expect(params.get("codex_cli_simplified_flow")).toBe("true");
    expect(params.get("client_id")).toBeTruthy();
    // The redirect must point at the port actually bound, not the requested 0.
    expect(new URL(params.get("redirect_uri")!).port).not.toBe("0");
  });

  it("rejects a state mismatch and stores nothing", async () => {
    const store = memoryTokenStore(null);
    const attempt = loginWithBrowser({
      store,
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: (url) => {
        void hitCallback(callbackFor(url, { code: "auth-code-1", state: "forged" }));
      },
      fetch: exchangeOk,
      now: () => NOW,
    });

    await expect(attempt).rejects.toBeInstanceOf(LoginFailedError);
    expect(store.read()).toBeNull();
  });

  it("rejects a callback with no code", async () => {
    const attempt = loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: (url) => {
        void hitCallback(callbackFor(url, { state: "__valid__" }));
      },
      fetch: exchangeOk,
      now: () => NOW,
    });

    await expect(attempt).rejects.toBeInstanceOf(LoginFailedError);
  });

  it("propagates an error reported by the authorization server", async () => {
    const attempt = loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: (url) => {
        void hitCallback(callbackFor(url, { error_description: "user cancelled" }));
      },
      fetch: exchangeOk,
      now: () => NOW,
    });

    await expect(attempt).rejects.toThrow(/user cancelled/);
  });

  it("keeps listening when the browser asks for an unrelated path", async () => {
    const store = memoryTokenStore(null);
    const status = await loginWithBrowser({
      store,
      port: 0,
      openBrowser: () => {},
      onVerificationUrl: (url) => {
        const favicon = new URL(new URL(url).searchParams.get("redirect_uri")!);
        favicon.pathname = "/favicon.ico";
        void hitCallback(favicon.toString()).then(async (code) => {
          expect(code).toBe(404);
          await hitCallback(callbackFor(url, { code: "auth-code-1", state: "__valid__" }));
        });
      },
      fetch: exchangeOk,
      now: () => NOW,
    });

    expect(status.exists).toBe(true);
  });

  it("gives up after the timeout instead of waiting forever", async () => {
    const attempt = loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      openBrowser: () => {},
      timeoutMs: 20,
      fetch: exchangeOk,
      now: () => NOW,
    });

    await expect(attempt).rejects.toThrow(/timed out/);
  });

  it("can be aborted by the caller", async () => {
    const controller = new AbortController();
    const attempt = loginWithBrowser({
      store: memoryTokenStore(null),
      port: 0,
      openBrowser: () => {},
      signal: controller.signal,
      onVerificationUrl: () => controller.abort(),
      fetch: exchangeOk,
      now: () => NOW,
    });

    await expect(attempt).rejects.toThrow(/aborted/);
  });

  it("releases the port when a login fails", async () => {
    // A server left listening would make the next attempt fail with EADDRINUSE.
    const run = (state: string) =>
      loginWithBrowser({
        store: memoryTokenStore(null),
        port: 0,
        openBrowser: () => {},
        onVerificationUrl: (url) => {
          void hitCallback(callbackFor(url, { code: "c", state }));
        },
        fetch: exchangeOk,
        now: () => NOW,
      });

    await expect(run("forged")).rejects.toBeInstanceOf(LoginFailedError);
    await expect(run("__valid__")).resolves.toMatchObject({ exists: true });
  });
});
