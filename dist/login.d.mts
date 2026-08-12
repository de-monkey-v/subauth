import { T as TokenStore, F as FetchLike, C as Clock, L as Logger, A as AuthStatus } from './types-zJpjsZ_O.mjs';

/**
 * Open a URL in the platform browser. Best effort and dependency-free — when it
 * fails the caller still has the URL from `onVerificationUrl`.
 */
declare function openSystemBrowser(url: string): void;
type BrowserLoginOptions = {
    store: TokenStore;
    fetch?: FetchLike;
    now?: Clock;
    logger?: Logger;
    userAgent?: string;
    clientId?: string;
    issuer?: string;
    /** Loopback callback port. Must match a redirect URI the client id allows. */
    port?: number;
    /** Browser launcher; pass a no-op to keep a test from spawning anything. */
    openBrowser?: (url: string) => void;
    /** Receives the authorize URL, for callers that print or display it. */
    onVerificationUrl?: (url: string) => void;
    /** Abandon the login after this long. The original flow waited forever. */
    timeoutMs?: number;
    signal?: AbortSignal;
};
/**
 * Run the loopback PKCE browser login and store the resulting session.
 *
 * Returns status only. The tokens stay inside the store — `getFreshAccess` is
 * the single place in this package's API where a token is handed out, so a
 * login helper has no reason to widen that surface.
 */
declare function loginWithBrowser(options: BrowserLoginOptions): Promise<AuthStatus>;

export { type BrowserLoginOptions, loginWithBrowser, openSystemBrowser };
