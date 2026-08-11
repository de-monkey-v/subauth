import { describe, expect, it, vi } from "vitest";
import { createChatGPTAuth } from "../src/auth";
import { PERSONAL_USE_NOTICE } from "../src/constants";
import { DeviceAuthError } from "../src/errors";
import { memoryTokenStore } from "../src/store-memory";
import type { FetchLike, FetchLikeResponse, Logger, TokenStore } from "../src/types";

const NOW = 1_800_000_000_000;

function response(status: number, body: unknown): FetchLikeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

/** Routes by URL so a poll and its follow-up token exchange can differ. */
function routedFetch(routes: Array<[RegExp, FetchLikeResponse]>) {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const match = routes.find(([pattern]) => pattern.test(url));
    if (!match) throw new Error(`unexpected request: ${url}`);
    return match[1];
  };
  return Object.assign(fn, { calls });
}

function authFor(fetch: FetchLike, store: TokenStore = memoryTokenStore(null), logger?: Logger) {
  return createChatGPTAuth({ store, fetch, now: () => NOW, logger });
}

describe("startDeviceAuth", () => {
  it("maps the response and clamps the server's advisory values", async () => {
    const fetch = routedFetch([
      [
        /usercode/,
        response(200, {
          device_auth_id: "dev-1",
          user_code: "ABCD-EFGH",
          interval: "0",
          expires_in: "5",
          verification_uri_complete: "https://auth.openai.com/codex/device?code=ABCD-EFGH",
        }),
      ],
    ]);

    const result = await authFor(fetch).startDeviceAuth();

    expect(result).toEqual({
      deviceAuthId: "dev-1",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device?code=ABCD-EFGH",
      // A zero interval is indistinguishable from "absent" and falls back to 5
      // rather than spinning; a 5-second expiry is raised to the 60s floor so a
      // login the user is still walking through is not abandoned.
      interval: 5,
      expiresIn: 60,
    });
  });

  it("floors a small but positive interval at 1 second", async () => {
    const fetch = routedFetch([
      [/usercode/, response(200, { device_auth_id: "d", user_code: "u", interval: 0.2 })],
    ]);
    expect((await authFor(fetch).startDeviceAuth()).interval).toBe(1);
  });

  it("prefers the complete verification uri, then the plain one, then a default", async () => {
    const withPlain = routedFetch([
      [
        /usercode/,
        response(200, {
          device_auth_id: "d",
          user_code: "u",
          verification_uri: "https://auth.openai.com/plain",
        }),
      ],
    ]);
    expect((await authFor(withPlain).startDeviceAuth()).verificationUrl).toBe(
      "https://auth.openai.com/plain",
    );

    const withNeither = routedFetch([
      [/usercode/, response(200, { device_auth_id: "d", user_code: "u" })],
    ]);
    expect((await authFor(withNeither).startDeviceAuth()).verificationUrl).toBe(
      "https://auth.openai.com/codex/device",
    );
  });

  it("warns about the personal-use boundary before starting a login", async () => {
    const lines: string[] = [];
    const fetch = routedFetch([
      [/usercode/, response(200, { device_auth_id: "d", user_code: "u" })],
    ]);

    await authFor(fetch, memoryTokenStore(null), { warn: (m) => lines.push(m) }).startDeviceAuth();

    expect(lines).toContain(PERSONAL_USE_NOTICE);
  });

  it("throws DeviceAuthError on a failed start", async () => {
    const fetch = routedFetch([[/usercode/, response(503, "unavailable")]]);
    await expect(authFor(fetch).startDeviceAuth()).rejects.toBeInstanceOf(DeviceAuthError);
  });
});

describe("pollDeviceToken", () => {
  it("reports pending without writing anything while approval is outstanding", async () => {
    for (const status of [403, 404]) {
      const store = memoryTokenStore(null);
      const write = vi.spyOn(store, "write");
      const fetch = routedFetch([[/deviceauth\/token/, response(status, "")]]);

      await expect(authFor(fetch, store).pollDeviceToken("dev-1", "CODE")).resolves.toEqual({
        status: "pending",
      });
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("exchanges the code and stores the session once approved", async () => {
    const store = memoryTokenStore(null);
    const fetch = routedFetch([
      [
        /deviceauth\/token/,
        response(200, { authorization_code: "auth-code", code_verifier: "verifier" }),
      ],
      [
        /oauth\/token/,
        response(200, {
          access_token: "access-1",
          refresh_token: "refresh-1",
          id_token: `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
            JSON.stringify({ chatgpt_account_id: "acct-7" }),
          ).toString("base64url")}.sig`,
          expires_in: 3600,
        }),
      ],
    ]);

    await expect(authFor(fetch, store).pollDeviceToken("dev-1", "CODE")).resolves.toEqual({
      status: "complete",
      accountId: "acct-7",
    });
    expect(store.read()).toMatchObject({ access: "access-1", refresh: "refresh-1" });
    // The device callback redirect must be replayed on the exchange.
    expect(fetch.calls.some((url) => url.includes("/oauth/token"))).toBe(true);
  });

  it("reports an error and leaves the store untouched when the exchange fails", async () => {
    // The authorization code is single-use and has now been spent.
    const store = memoryTokenStore(null);
    const fetch = routedFetch([
      [
        /deviceauth\/token/,
        response(200, { authorization_code: "auth-code", code_verifier: "verifier" }),
      ],
      [/oauth\/token/, response(400, { error: "invalid_grant" })],
    ]);

    const result = await authFor(fetch, store).pollDeviceToken("dev-1", "CODE");

    expect(result.status).toBe("error");
    expect(result.message).toMatch(/log in again/);
    expect(store.read()).toBeNull();
  });

  it("reports a transport-level error status", async () => {
    const fetch = routedFetch([[/deviceauth\/token/, response(500, "boom")]]);
    const result = await authFor(fetch).pollDeviceToken("dev-1", "CODE");
    expect(result.status).toBe("error");
    expect(result.message).toContain("500");
  });
});
