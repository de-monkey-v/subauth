import { describe, expect, it, vi } from "vitest";
import { createChatGPTAuth } from "../src/auth";
import { memoryTokenStore } from "../src/store-memory";
import type { FetchLike, FetchLikeResponse, Logger, OAuthTokens } from "../src/types";

/**
 * The failure this file exists for.
 *
 * The token endpoint is sent the refresh token in the request body. Any
 * endpoint that echoes the request back — a debug proxy, a captive portal, a
 * misconfigured gateway — hands that live credential to the error path. If the
 * error message interpolates the response body, the token lands in logs, in a
 * database, or in a bug report.
 */

const NOW = 1_800_000_000_000;
const REFRESH = "rt_SUPERSECRET_9fJk2LmNpQrStUvWxYz0123456789AbCdEfGh";
const ACCESS_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0LTEyMyJ9.signaturebytes";

function expiring(): OAuthTokens {
  return { access: ACCESS_JWT, refresh: REFRESH, accountId: "acct-1", expires: NOW };
}

/** Everything a leak could ride out on: message, stack, serialization, logs. */
function exposedText(error: unknown, logLines: string[]): string {
  const err = error as Error;
  return [err?.message, err?.stack, JSON.stringify(err), JSON.stringify({ ...(err as object) }), ...logLines].join(
    "\n",
  );
}

function assertNoSecrets(text: string): void {
  expect(text).not.toContain(REFRESH);
  expect(text).not.toContain(REFRESH.slice(0, 16));
  expect(text).not.toContain(ACCESS_JWT);
  expect(text).not.toContain("eyJ");
  expect(text).not.toContain("SUPERSECRET");
}

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(m),
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
  };
  return Object.assign(logger, { lines });
}

function respondingWith(status: number, body: string): FetchLike {
  return async (): Promise<FetchLikeResponse> => ({
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  });
}

describe("token leakage", () => {
  it("does not leak the refresh token when the endpoint echoes the request body", async () => {
    const logger = recordingLogger();
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      // The hostile case: a 500 whose body contains the request it received.
      fetch: respondingWith(
        500,
        `upstream rejected: grant_type=refresh_token&refresh_token=${REFRESH}&client_id=app_x`,
      ),
      now: () => NOW,
      sleep: async () => {},
      logger,
    });

    const error = await auth.getFreshAccess().catch((e: unknown) => e);
    assertNoSecrets(exposedText(error, logger.lines));
  });

  it("does not leak a JSON-shaped echo of the token", async () => {
    const logger = recordingLogger();
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch: respondingWith(502, `{"error":"bad gateway","echo":{"refresh_token":"${REFRESH}"}}`),
      now: () => NOW,
      sleep: async () => {},
      logger,
    });

    const error = await auth.getFreshAccess().catch((e: unknown) => e);
    assertNoSecrets(exposedText(error, logger.lines));
  });

  it("does not leak the access JWT when persistence fails", async () => {
    const store = memoryTokenStore(expiring());
    vi.spyOn(store, "write").mockImplementation(() => {
      throw new Error(`cannot persist ${ACCESS_JWT}`);
    });
    const logger = recordingLogger();
    const auth = createChatGPTAuth({
      store,
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({ access_token: ACCESS_JWT, refresh_token: REFRESH, expires_in: 3600 }),
      }),
      now: () => NOW,
      sleep: async () => {},
      logger,
    });

    await auth.getFreshAccess();
    assertNoSecrets(logger.lines.join("\n"));
    expect(logger.lines.some((l) => l.includes("could not be saved"))).toBe(true);
  });

  it("does not leak tokens through a device poll error", async () => {
    const auth = createChatGPTAuth({
      store: memoryTokenStore(null),
      fetch: respondingWith(500, `device failed for refresh_token=${REFRESH}`),
      now: () => NOW,
    });

    const result = await auth.pollDeviceToken("dev-1", "CODE-1");
    expect(result.status).toBe("error");
    assertNoSecrets(result.message ?? "");
  });

  it("does not leak tokens through a device-start error", async () => {
    const auth = createChatGPTAuth({
      store: memoryTokenStore(null),
      fetch: respondingWith(503, `unavailable: ${ACCESS_JWT}`),
      now: () => NOW,
    });

    const error = await auth.startDeviceAuth().catch((e: unknown) => e);
    assertNoSecrets(exposedText(error, []));
  });

  it("never returns a token from status(), only metadata", () => {
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch: async () => {
        throw new Error("unused");
      },
      now: () => NOW,
    });

    assertNoSecrets(JSON.stringify(auth.status()));
  });

});
