/**
 * Shared contracts. Everything the library needs from the outside world arrives
 * through these types — there is no ambient environment lookup and no default
 * file path anywhere in this package.
 */
/** OAuth material persisted between runs. Never leaves the package except through `getFreshAccess`. */
type OAuthTokens = {
    access: string;
    refresh: string;
    accountId?: string;
    /** Absolute expiry, epoch milliseconds. */
    expires: number;
};
/** What a caller may see about the stored session. Deliberately excludes both tokens. */
type AuthStatus = {
    exists: boolean;
    accountId?: string;
    expires?: number;
};
/**
 * Persistence for one account's tokens.
 *
 * Synchronous on purpose: consumers call `exists()` from synchronous
 * configuration paths, so an async store would not be adoptable there.
 *
 * `read()` MUST be read-through — it has to observe writes made by other
 * processes since the last call. The refresh-rotation recovery path depends on
 * exactly that: when a sibling process rotates the refresh token out from under
 * us, re-reading the store is how we find the token that actually won. A store
 * that caches its last value silently disables that recovery and turns a
 * survivable race into a forced re-login.
 */
interface TokenStore {
    /**
     * Stable identity for the account behind this store; file stores use the
     * absolute path. Concurrent refreshes are de-duplicated per key, so two
     * stores pointing at the same account must produce the same key, and stores
     * for different accounts must not collide.
     */
    readonly key: string;
    read(): OAuthTokens | null;
    write(tokens: OAuthTokens): void;
    clear(): void;
    exists(): boolean;
}
/**
 * Minimal HTTP shape used for the OAuth token and device endpoints.
 *
 * Narrower than global `fetch` on purpose: these are calls this package fully
 * controls, so a test double should not have to imitate the whole `Response`
 * interface. `createCodexFetch` is the exception and keeps the real signature,
 * because an AI SDK passes it arbitrary requests.
 */
type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<FetchLikeResponse>;
type FetchLikeResponse = {
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
};
/** Optional diagnostics sink. Defaults to a no-op — a library should not print. */
type Logger = {
    debug?(message: string): void;
    info?(message: string): void;
    warn?(message: string): void;
};
/** Injectable clock, so expiry-boundary behavior is testable without waiting. */
type Clock = () => number;
/** Injectable delay, so rotation-recovery backoff does not cost real seconds in tests. */
type Sleep = (ms: number) => Promise<void>;
/** Device-code login handle shown to the person approving on another device. */
type DeviceAuth = {
    deviceAuthId: string;
    userCode: string;
    verificationUrl: string;
    /** Seconds between polls, at least 1. */
    interval: number;
    /** Seconds until the code expires, at least 60. */
    expiresIn: number;
};
/** One device-token poll result. `pending` means the user has not approved yet. */
type DevicePoll = {
    status: "pending" | "complete" | "error";
    message?: string;
    accountId?: string;
};

export type { AuthStatus as A, Clock as C, DeviceAuth as D, FetchLike as F, Logger as L, OAuthTokens as O, Sleep as S, TokenStore as T, DevicePoll as a, FetchLikeResponse as b };
