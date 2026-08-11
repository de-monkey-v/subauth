import { A as AuthStatus, D as DeviceAuth, a as DevicePoll, T as TokenStore, F as FetchLike, C as Clock, S as Sleep, L as Logger } from './types-DNqSt5Ln.js';

/** The only value in this package that carries a token out to the caller. */
type AccessGrant = {
    access: string;
    accountId?: string;
};
type ChatGPTAuthOptions = {
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
    rotationRetry?: {
        attempts: number;
        delayMs: number;
    };
};
interface ChatGPTAuth {
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
declare function createChatGPTAuth(options: ChatGPTAuthOptions): ChatGPTAuth;

/** The single capability `createCodexFetch` needs — an auth object satisfies it. */
type AccessSource = {
    getFreshAccess(signal?: AbortSignal): Promise<AccessGrant>;
};
type CodexFetchOptions = {
    /** Underlying transport. Defaults to the platform `fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Session id generator; one fresh id per request by default. */
    sessionId?: () => string;
    /** Originator header value. Bound to the client id — override with care. */
    originator?: string;
};
declare function createCodexFetch(auth: AccessSource, options?: CodexFetchOptions): typeof globalThis.fetch;

export { type AccessSource as A, type ChatGPTAuth as C, type AccessGrant as a, type ChatGPTAuthOptions as b, type CodexFetchOptions as c, createChatGPTAuth as d, createCodexFetch as e };
