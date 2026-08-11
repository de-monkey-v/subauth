import { REFRESH_MARGIN_MS } from "./constants";
import { pollDeviceToken, startDeviceAuth } from "./device";
import { InvalidGrantError, NotAuthenticatedError, RefreshTokenMissingError } from "./errors";
import { scrubSecrets } from "./redact";
import { refreshTokens, resolveProtocolConfig, toTokens, type ProtocolConfig } from "./protocol";
import type {
  AuthStatus,
  Clock,
  DeviceAuth,
  DevicePoll,
  FetchLike,
  Logger,
  OAuthTokens,
  Sleep,
  TokenStore,
} from "./types";

/** The only value in this package that carries a token out to the caller. */
export type AccessGrant = { access: string; accountId?: string };

export type ChatGPTAuthOptions = {
  /** Where this account's tokens live. Required — the package has no default. */
  store: TokenStore;
  fetch?: FetchLike;
  now?: Clock;
  sleep?: Sleep;
  logger?: Logger;
  userAgent?: string;
  clientId?: string;
  issuer?: string;
  /** Backoff used when recovering from a lost refresh-token rotation race. */
  rotationRetry?: { attempts: number; delayMs: number };
};

export interface ChatGPTAuth {
  /** Valid access token, refreshing first if expiry is near. Throws if not logged in. */
  getFreshAccess(signal?: AbortSignal): Promise<AccessGrant>;
  /** Synchronous existence check, for configuration paths that cannot await. */
  exists(): boolean;
  /** Session state for display. Never includes either token. */
  status(): AuthStatus;
  logout(): void;
  startDeviceAuth(): Promise<DeviceAuth>;
  pollDeviceToken(deviceAuthId: string, userCode: string): Promise<DevicePoll>;
}

/**
 * In-flight refreshes, keyed by store identity.
 *
 * Two properties matter here and they pull in opposite directions. Concurrent
 * callers for one account must share a single refresh, because the server
 * rotates the refresh token and a second concurrent exchange invalidates the
 * first. But callers for *different* accounts must not share anything —
 * otherwise a process holding two sessions could hand account A's access token
 * to a caller asking about account B.
 *
 * Keying by `store.key` satisfies both, and — unlike an instance field — keeps
 * holding when a consumer constructs two auth objects over the same store,
 * which a library cannot prevent.
 *
 * The registry hangs off a global symbol rather than module scope because this
 * package ships dual CJS and ESM builds. Module scope is per-bundle: a process
 * that reaches this code through both `require("subauth")` and
 * `import("subauth")` — trivially possible in a mixed codebase, or via two
 * copies in a dependency tree — would otherwise get two independent maps,
 * refresh twice concurrently, and have the server revoke the session for
 * rotation reuse. `Symbol.for` is the one namespace all of those share.
 */
const REGISTRY_KEY = Symbol.for("subauth.inFlightRefreshes");

type Registry = Map<string, Promise<AccessGrant>>;

function inFlightRegistry(): Registry {
  const host = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  const existing = host[REGISTRY_KEY];
  if (existing) return existing;
  const created: Registry = new Map();
  host[REGISTRY_KEY] = created;
  return created;
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Let a caller that joined an in-flight refresh give up without cancelling it.
 *
 * The shared refresh must keep running for the other joiners, so aborting here
 * detaches this caller rather than killing the exchange.
 */
function detachOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error as Error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return scrubSecrets(error instanceof Error ? error.message : String(error));
}

export function createChatGPTAuth(options: ChatGPTAuthOptions): ChatGPTAuth {
  const { store } = options;
  const now: Clock = options.now ?? Date.now;
  const sleep: Sleep = options.sleep ?? defaultSleep;
  const logger: Logger = options.logger ?? {};
  // Wide enough to outlast a sibling's slow token round-trip: the recovery only
  // runs after an invalid_grant, and giving up early forces a re-login that
  // waiting would have avoided.
  const rotationRetry = options.rotationRetry ?? { attempts: 8, delayMs: 400 };
  const config: ProtocolConfig = resolveProtocolConfig(options);

  function isUsable(tokens: OAuthTokens): boolean {
    return now() < tokens.expires - REFRESH_MARGIN_MS;
  }

  /**
   * Recover from a refresh that failed because another process rotated the
   * token first. Re-reads the store — which is why `TokenStore.read` must be
   * read-through — and adopts a newer session if one appeared.
   */
  async function recoverFromRotation(previous: OAuthTokens): Promise<AccessGrant | null> {
    for (let attempt = 0; attempt < rotationRetry.attempts; attempt++) {
      await sleep(rotationRetry.delayMs);
      const current = store.read();
      if (current && current.access !== previous.access && isUsable(current)) {
        logger.debug?.("adopted a token refreshed by another process");
        return { access: current.access, accountId: current.accountId };
      }
    }
    return null;
  }

  async function refreshOnce(previous: OAuthTokens): Promise<AccessGrant> {
    let next: OAuthTokens;
    try {
      next = toTokens(await refreshTokens(config, previous.refresh), now, previous);
    } catch (error) {
      // Only rotation reuse is recoverable by re-reading; a 5xx or a network
      // blip means nobody else succeeded either, and waiting out the backoff
      // would just add latency to an error the caller has to handle anyway.
      if (error instanceof InvalidGrantError) {
        const recovered = await recoverFromRotation(previous);
        if (recovered) return recovered;
        // The session is revoked server-side. Drop the dead token so the
        // consumer's UI shows "logged out" instead of retrying forever.
        store.clear();
      }
      throw error;
    }

    // Compare-and-swap rather than a blind write. Between starting this refresh
    // and finishing it the store may have been logged out (writing would
    // resurrect a session the user ended) or advanced by another process
    // (writing would replace a newer session with this older one).
    const current = store.read();
    if (current === null) {
      throw new NotAuthenticatedError("The session was logged out while the token was refreshing.");
    }
    if (current.access !== previous.access) {
      logger.debug?.("another process refreshed first; keeping the newer session");
      return { access: current.access, accountId: current.accountId };
    }

    try {
      store.write(next);
    } catch (error) {
      // The server has already rotated the refresh token by this point, so
      // throwing here would turn one disk error into a permanently dead
      // session. The new access token is good for this process's lifetime.
      logger.warn?.(`refreshed token could not be persisted: ${errorText(error)}`);
    }
    return { access: next.access, accountId: next.accountId };
  }

  async function getFreshAccess(signal?: AbortSignal): Promise<AccessGrant> {
    signal?.throwIfAborted();

    const tokens = store.read();
    if (!tokens) throw new NotAuthenticatedError();
    if (isUsable(tokens)) return { access: tokens.access, accountId: tokens.accountId };
    if (!tokens.refresh) throw new RefreshTokenMissingError();

    const inFlight = inFlightRegistry();
    const pending = inFlight.get(store.key);
    if (pending) return signal ? detachOnAbort(pending, signal) : pending;

    const started: Promise<AccessGrant> = refreshOnce(tokens).finally(() => {
      // Only clear our own entry: a later refresh may already have replaced it.
      if (inFlight.get(store.key) === started) inFlight.delete(store.key);
    });
    inFlight.set(store.key, started);
    // Detached the same way a joiner is, so the abort contract does not depend
    // on whether this caller happened to be the one that started the refresh.
    return signal ? detachOnAbort(started, signal) : started;
  }

  return {
    getFreshAccess,
    exists: () => store.exists(),
    status(): AuthStatus {
      const tokens = store.read();
      if (!tokens) return { exists: false };
      return { exists: true, accountId: tokens.accountId, expires: tokens.expires };
    },
    logout: () => store.clear(),
    startDeviceAuth: () => startDeviceAuth(config, logger),
    pollDeviceToken: (deviceAuthId, userCode) =>
      pollDeviceToken(config, store, now, deviceAuthId, userCode),
  };
}
