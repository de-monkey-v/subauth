import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChatGPTAuth } from "../src/auth";
import { REFRESH_MARGIN_MS } from "../src/constants";
import { InvalidGrantError, NotAuthenticatedError, RefreshTokenMissingError, TokenRequestError } from "../src/errors";
import { memoryTokenStore } from "../src/store-memory";
import type { FetchLike, FetchLikeResponse, Logger, OAuthTokens, TokenStore } from "../src/types";

const NOW = 1_800_000_000_000;

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    access: "access-old",
    refresh: "refresh-old",
    accountId: "acct-1",
    expires: NOW + 3_600_000,
    ...overrides,
  };
}

/** Expired enough that `getFreshAccess` must refresh. */
function expiring(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return tokens({ expires: NOW, ...overrides });
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

/** A fetch double that hands back queued responses and records every call. */
function fakeFetch(...queued: Array<FetchLikeResponse | Error>) {
  const calls: Array<{ url: string; body: string }> = [];
  let index = 0;
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    const next = queued[Math.min(index++, queued.length - 1)];
    if (next instanceof Error) throw next;
    if (!next) throw new Error("fake fetch ran out of responses");
    return next;
  };
  return Object.assign(fn, { calls });
}

const okRefresh = (over: Record<string, unknown> = {}) =>
  response(200, { access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600, ...over });

/** Collects logger output so tests can assert on what was and was not written. */
function recordingLogger() {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m) => lines.push(m),
    info: (m) => lines.push(m),
    warn: (m) => lines.push(m),
  };
  return Object.assign(logger, { lines });
}

const instantSleep = async () => {};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("getFreshAccess — when no refresh is needed", () => {
  it("returns the stored token without any network call", async () => {
    const fetch = fakeFetch();
    const auth = createChatGPTAuth({ store: memoryTokenStore(tokens()), fetch, now: () => NOW });

    await expect(auth.getFreshAccess()).resolves.toEqual({
      access: "access-old",
      accountId: "acct-1",
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("refreshes exactly at the margin boundary, and not one millisecond earlier", async () => {
    const atBoundary = fakeFetch(okRefresh());
    await createChatGPTAuth({
      store: memoryTokenStore(tokens({ expires: NOW + REFRESH_MARGIN_MS })),
      fetch: atBoundary,
      now: () => NOW,
      sleep: instantSleep,
    }).getFreshAccess();
    expect(atBoundary.calls).toHaveLength(1);

    const justInside = fakeFetch(okRefresh());
    await createChatGPTAuth({
      store: memoryTokenStore(tokens({ expires: NOW + REFRESH_MARGIN_MS + 1 })),
      fetch: justInside,
      now: () => NOW,
    }).getFreshAccess();
    expect(justInside.calls).toHaveLength(0);
  });
});

describe("getFreshAccess — refresh", () => {
  it("stores the refreshed session and returns the new access token", async () => {
    const store = memoryTokenStore(expiring());
    const fetch = fakeFetch(okRefresh());
    const auth = createChatGPTAuth({ store, fetch, now: () => NOW, sleep: instantSleep });

    await expect(auth.getFreshAccess()).resolves.toEqual({
      access: "access-new",
      accountId: "acct-1",
    });
    expect(store.read()).toMatchObject({ access: "access-new", refresh: "refresh-new" });
    expect(store.read()?.expires).toBe(NOW + 3_600_000);
  });

  it("keeps the previous refresh token when the response omits one", async () => {
    // Losing the refresh token here would make the *next* refresh impossible —
    // a successful call quietly ending the session.
    const store = memoryTokenStore(expiring());
    const fetch = fakeFetch(response(200, { access_token: "access-new", expires_in: 3600 }));
    await createChatGPTAuth({ store, fetch, now: () => NOW, sleep: instantSleep }).getFreshAccess();

    expect(store.read()).toMatchObject({ access: "access-new", refresh: "refresh-old" });
  });

  it("defaults to a one hour lifetime when expires_in is absent", async () => {
    const store = memoryTokenStore(expiring());
    const fetch = fakeFetch(response(200, { access_token: "a", refresh_token: "r" }));
    await createChatGPTAuth({ store, fetch, now: () => NOW, sleep: instantSleep }).getFreshAccess();

    expect(store.read()?.expires).toBe(NOW + 3_600_000);
  });

  it("throws NotAuthenticatedError when nothing is stored", async () => {
    const auth = createChatGPTAuth({ store: memoryTokenStore(null), fetch: fakeFetch() });
    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("throws RefreshTokenMissingError when the session cannot be renewed", async () => {
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring({ refresh: "" })),
      fetch: fakeFetch(),
      now: () => NOW,
    });
    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(RefreshTokenMissingError);
  });

  it("respects an already-aborted signal before touching the store", async () => {
    const auth = createChatGPTAuth({ store: memoryTokenStore(expiring()), fetch: fakeFetch(), now: () => NOW });
    await expect(auth.getFreshAccess(AbortSignal.abort())).rejects.toThrow();
  });
});

describe("getFreshAccess — concurrency", () => {
  it("collapses concurrent callers into a single refresh", async () => {
    // The server rotates the refresh token, so a second concurrent exchange
    // would invalidate the first and destroy the session.
    const fetch = fakeFetch(okRefresh());
    const auth = createChatGPTAuth({
      store: memoryTokenStore(expiring()),
      fetch,
      now: () => NOW,
      sleep: instantSleep,
    });

    const results = await Promise.all(Array.from({ length: 10 }, () => auth.getFreshAccess()));

    expect(fetch.calls).toHaveLength(1);
    expect(new Set(results.map((r) => r.access))).toEqual(new Set(["access-new"]));
  });

  it("releases the in-flight slot so a later expiry refreshes again", async () => {
    let clock = NOW;
    const store = memoryTokenStore(expiring());
    const fetch = fakeFetch(okRefresh(), okRefresh({ access_token: "access-newer" }));
    const auth = createChatGPTAuth({ store, fetch, now: () => clock, sleep: instantSleep });

    await auth.getFreshAccess();
    clock = NOW + 3_600_000; // the freshly stored token is now itself expiring
    await expect(auth.getFreshAccess()).resolves.toMatchObject({ access: "access-newer" });
    expect(fetch.calls).toHaveLength(2);
  });

  it("keeps two accounts apart", async () => {
    // A module-level in-flight promise with no key would hand the second caller
    // the first account's token.
    const fetchA = fakeFetch(okRefresh({ access_token: "access-A" }));
    const fetchB = fakeFetch(okRefresh({ access_token: "access-B" }));
    const authA = createChatGPTAuth({
      store: memoryTokenStore(expiring({ accountId: "acct-A" })),
      fetch: fetchA,
      now: () => NOW,
      sleep: instantSleep,
    });
    const authB = createChatGPTAuth({
      store: memoryTokenStore(expiring({ accountId: "acct-B" })),
      fetch: fetchB,
      now: () => NOW,
      sleep: instantSleep,
    });

    const [a, b] = await Promise.all([authA.getFreshAccess(), authB.getFreshAccess()]);

    expect(a).toEqual({ access: "access-A", accountId: "acct-A" });
    expect(b).toEqual({ access: "access-B", accountId: "acct-B" });
    expect(fetchA.calls).toHaveLength(1);
    expect(fetchB.calls).toHaveLength(1);
  });

  it("shares one refresh between two auth objects over the same store", async () => {
    // A consumer can construct the auth object twice; an instance field would
    // let both refresh at once and rotate each other out.
    const store = memoryTokenStore(expiring());
    const fetch = fakeFetch(okRefresh());
    const shared = { store, fetch, now: () => NOW, sleep: instantSleep };

    const [a, b] = await Promise.all([
      createChatGPTAuth(shared).getFreshAccess(),
      createChatGPTAuth(shared).getFreshAccess(),
    ]);

    expect(fetch.calls).toHaveLength(1);
    expect(a.access).toBe(b.access);
  });
});

describe("getFreshAccess — rotation loss recovery", () => {
  /** A store whose disk content changes underneath us, as a sibling process would cause. */
  function racingStore(initial: OAuthTokens, appearsAfter: number, winner: OAuthTokens): TokenStore {
    let reads = 0;
    let current = initial;
    return {
      key: "racing",
      read: () => {
        if (++reads > appearsAfter) current = winner;
        return current;
      },
      write: (next) => {
        current = next;
      },
      clear: () => {
        /* observed via the spy in each test */
      },
      exists: () => true,
    };
  }

  it("adopts the token another process just wrote", async () => {
    const store = racingStore(expiring(), 1, tokens({ access: "access-sibling", expires: NOW + 3_600_000 }));
    const clear = vi.spyOn(store, "clear");
    const auth = createChatGPTAuth({
      store,
      fetch: fakeFetch(response(400, { error: "invalid_grant" })),
      now: () => NOW,
      sleep: instantSleep,
    });

    await expect(auth.getFreshAccess()).resolves.toMatchObject({ access: "access-sibling" });
    expect(clear).not.toHaveBeenCalled();
  });

  it("gives up and clears the session when no sibling token appears", async () => {
    const store = memoryTokenStore(expiring());
    const clear = vi.spyOn(store, "clear");
    const auth = createChatGPTAuth({
      store,
      fetch: fakeFetch(response(400, { error: "invalid_grant" })),
      now: () => NOW,
      sleep: instantSleep,
      rotationRetry: { attempts: 3, delayMs: 0 },
    });

    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(InvalidGrantError);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("preserves the stored token when the failure is not invalid_grant", async () => {
    // A 500 or a network blip must not log the user out; only rotation reuse does.
    const store = memoryTokenStore(expiring());
    const clear = vi.spyOn(store, "clear");
    const auth = createChatGPTAuth({
      store,
      fetch: fakeFetch(response(500, "upstream exploded")),
      now: () => NOW,
      sleep: instantSleep,
    });

    await expect(auth.getFreshAccess()).rejects.toBeInstanceOf(TokenRequestError);
    expect(clear).not.toHaveBeenCalled();
    expect(store.read()).not.toBeNull();
  });

  it("survives a store that cannot persist the refreshed token", async () => {
    // The server has already rotated by now, so throwing would turn a disk
    // error into a permanently dead session.
    const store = memoryTokenStore(expiring());
    vi.spyOn(store, "write").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    const logger = recordingLogger();
    const auth = createChatGPTAuth({
      store,
      fetch: fakeFetch(okRefresh()),
      now: () => NOW,
      sleep: instantSleep,
      logger,
    });

    await expect(auth.getFreshAccess()).resolves.toMatchObject({ access: "access-new" });
    expect(logger.lines.some((line) => line.includes("could not be saved"))).toBe(true);
  });
});

describe("status and logout", () => {
  it("reports session metadata without exposing either token", () => {
    const auth = createChatGPTAuth({ store: memoryTokenStore(tokens()), fetch: fakeFetch() });
    const status = auth.status();

    expect(status).toEqual({ exists: true, accountId: "acct-1", expires: NOW + 3_600_000 });
    expect(JSON.stringify(status)).not.toContain("access-old");
    expect(JSON.stringify(status)).not.toContain("refresh-old");
    expect(Object.keys(status)).not.toContain("access");
    expect(Object.keys(status)).not.toContain("refresh");
  });

  it("reports a logged-out session", () => {
    const auth = createChatGPTAuth({ store: memoryTokenStore(null), fetch: fakeFetch() });
    expect(auth.status()).toEqual({ exists: false });
    expect(auth.exists()).toBe(false);
  });

  it("clears the stored session on logout", () => {
    const store = memoryTokenStore(tokens());
    const auth = createChatGPTAuth({ store, fetch: fakeFetch() });
    auth.logout();
    expect(store.read()).toBeNull();
  });
});
