import { mkdtempSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatGPTAuth } from "../src/auth";
import { InvalidGrantError, NotAuthenticatedError, TokenRequestError } from "../src/errors";
import { REDACTED, scrubDetail } from "../src/redact";
import { fileTokenStore } from "../src/store-file";
import { memoryTokenStore } from "../src/store-memory";
import type { FetchLike, FetchLikeResponse, Logger, OAuthTokens } from "../src/types";

/**
 * Regressions for defects found by independent verification of the built
 * package. Each one failed against the code as committed at 9319cc2.
 */

const NOW = 1_800_000_000_000;

function expiring(over: Partial<OAuthTokens> = {}): OAuthTokens {
  return { access: "access-old", refresh: "refresh-old", accountId: "acct-1", expires: NOW, ...over };
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

function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(m),
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
  };
  return Object.assign(logger, { lines });
}

describe("scrubbing — short bare tokens", () => {
  it("removes a known secret by exact match regardless of length", () => {
    // Pattern rules only catch long blobs or key=value pairs. A short token
    // sitting bare in prose defeats all of them — but we sent it, so we know it.
    const short = "rt_canary_1234";
    const body = `<html>upstream rejected ${short}</html>`;

    expect(scrubDetail(body)).toContain(short);
    expect(scrubDetail(body, 300, [short])).not.toContain(short);
    expect(scrubDetail(body, 300, [short])).toContain(REDACTED);
  });

  it("ignores degenerate secrets that would redact unrelated text", () => {
    expect(scrubDetail("the error is bad", 300, ["bad", "", undefined])).toContain("bad");
  });

  it("scrubs a short refresh token echoed by the token endpoint", async () => {
    const short = "rt_canary_1234";
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring({ refresh: short })),
      fetch: async () => response(500, `<html>upstream rejected ${short}</html>`),
      now: () => NOW,
      sleep: async () => {},
    });

    const error = await auth.getFreshAccess().catch((e: unknown) => e);
    expect(String((error as Error).message)).not.toContain(short);
  });
});

describe("malformed 200 responses must not destroy the session", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["refresh_token is an empty string", { access_token: "a", refresh_token: "", expires_in: 3600 }],
    ["refresh_token is a number", { access_token: "a", refresh_token: 12345, expires_in: 3600 }],
    ["refresh_token is an object", { access_token: "a", refresh_token: {}, expires_in: 3600 }],
    ["expires_in is not a number", { access_token: "a", refresh_token: "rt", expires_in: "soon" }],
    ["expires_in is negative", { access_token: "a", refresh_token: "rt", expires_in: -1 }],
  ];

  for (const [label, body] of cases) {
    it(`survives when ${label}`, async () => {
      const store = memoryTokenStore(expiring());
      const auth = createChatGPTAuth({
        store,
        fetch: async () => response(200, body),
        now: () => NOW,
        sleep: async () => {},
      });

      await auth.getFreshAccess();
      const stored = store.read();

      // Whatever the server sent, what lands on disk must still be a usable
      // session: a rotated-in garbage value used to fail read-back validation
      // and take the still-valid refresh token down with it.
      expect(stored).not.toBeNull();
      expect(typeof stored!.refresh).toBe("string");
      expect(stored!.refresh.length).toBeGreaterThan(0);
      expect(Number.isFinite(stored!.expires)).toBe(true);
      expect(stored!.expires).toBeGreaterThan(NOW);
      expect(store.exists()).toBe(true);
    });
  }
});

describe("refresh must not resurrect or clobber a session", () => {
  it("does not write back a session the user logged out of mid-refresh", async () => {
    let release: (value: FetchLikeResponse) => void = () => {};
    const gate = new Promise<FetchLikeResponse>((resolve) => {
      release = resolve;
    });
    const store = memoryTokenStore(expiring());
    const auth = createChatGPTAuth({
      store,
      fetch: async () => gate,
      now: () => NOW,
      sleep: async () => {},
    });

    const pending = auth.getFreshAccess();
    auth.logout();
    release(response(200, { access_token: "access-new", refresh_token: "r", expires_in: 3600 }));

    await expect(pending).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(store.read()).toBeNull();
  });

  it("does not overwrite a newer session written while it was refreshing", async () => {
    let release: (value: FetchLikeResponse) => void = () => {};
    const gate = new Promise<FetchLikeResponse>((resolve) => {
      release = resolve;
    });
    const store = memoryTokenStore(expiring());
    const auth = createChatGPTAuth({
      store,
      fetch: async () => gate,
      now: () => NOW,
      sleep: async () => {},
    });

    const pending = auth.getFreshAccess();
    // A sibling process finishes first and writes a newer session.
    store.write({ access: "access-sibling", refresh: "refresh-sibling", accountId: "acct-1", expires: NOW + 7_200_000 });
    release(response(200, { access_token: "access-slow", refresh_token: "refresh-slow", expires_in: 3600 }));

    await expect(pending).resolves.toMatchObject({ access: "access-sibling" });
    expect(store.read()).toMatchObject({ access: "access-sibling", refresh: "refresh-sibling" });
  });
});

describe("rotation-recovery backoff", () => {
  it("does not delay a failure that rotation recovery cannot fix", async () => {
    // The backoff exists for invalid_grant. Running it for a 5xx just added
    // latency to an error the caller has to handle anyway.
    const slept: number[] = [];
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch: async () => response(500, "upstream exploded"),
      now: () => NOW,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(TokenRequestError);
    expect(slept).toEqual([]);
  });

  it("still waits out a rotation race before giving up", async () => {
    const slept: number[] = [];
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch: async () => response(400, { error: "invalid_grant" }),
      now: () => NOW,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(InvalidGrantError);
    // Wide enough to outlast a sibling's slow token round-trip.
    expect(slept.length).toBeGreaterThanOrEqual(5);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
  });
});

describe("fileTokenStore — failed writes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "subauth-vf-"));
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves no plaintext temp file behind when the write fails", () => {
    // A failed rename used to strand the refresh token in plaintext under a
    // name nothing would ever clean up.
    const target = path.join(dir, "sub", "tokens.json");
    const store = fileTokenStore(target);
    store.write(expiring());

    // Make the rename fail by turning the destination into a non-empty directory.
    rmSync(target);
    const asDir = path.join(dir, "sub", "tokens.json");
    writeFileSync(path.join(dir, "sub", "blocker"), "x");
    require("node:fs").mkdirSync(asDir);
    writeFileSync(path.join(asDir, "occupied"), "x");

    expect(() => store.write(expiring({ refresh: "SECRET_REFRESH_VALUE" }))).toThrow();

    const leftovers = readdirSync(path.join(dir, "sub")).filter((n) => n.includes(".tmp"));
    expect(leftovers).toEqual([]);
  });
});

describe("in-flight registry survives dual module instances", () => {
  it("is shared through a global symbol rather than module scope", async () => {
    // CJS and ESM builds get separate module scopes. A per-module map means a
    // process reaching this code both ways refreshes twice concurrently, and
    // the server revokes the session for rotation reuse.
    const registry = (globalThis as Record<symbol, unknown>)[
      Symbol.for("subauth.inFlightRefreshes")
    ];
    expect(registry).toBeInstanceOf(Map);

    let release: (value: FetchLikeResponse) => void = () => {};
    const gate = new Promise<FetchLikeResponse>((resolve) => {
      release = resolve;
    });
    const store = memoryTokenStore(expiring());
    const fetch: FetchLike = async () => gate;
    const auth = createChatGPTAuth({ store, fetch, now: () => NOW, sleep: async () => {} });

    const pending = auth.getFreshAccess();
    // While a refresh is in flight the shared registry holds it under the store key.
    expect((registry as Map<string, unknown>).has(store.key)).toBe(true);

    release(response(200, { access_token: "a", refresh_token: "r", expires_in: 3600 }));
    await pending;
    expect((registry as Map<string, unknown>).has(store.key)).toBe(false);
  });
});

describe("logger never receives credential material", () => {
  it("keeps tokens out of the debug line when adopting a sibling's session", async () => {
    const store = memoryTokenStore(expiring());
    const logger = recordingLogger();
    vi.spyOn(store, "read")
      .mockReturnValueOnce(expiring())
      .mockReturnValue({ access: "SIBLING_ACCESS", refresh: "SIBLING_REFRESH", expires: NOW + 7_200_000 });

    const auth = createChatGPTAuth({
      store,
      fetch: async () => response(200, { access_token: "a", refresh_token: "r", expires_in: 3600 }),
      now: () => NOW,
      sleep: async () => {},
      logger,
    });

    await auth.getFreshAccess();
    const logged = logger.lines.join("\n");
    expect(logged).not.toContain("SIBLING_ACCESS");
    expect(logged).not.toContain("SIBLING_REFRESH");
  });
});
