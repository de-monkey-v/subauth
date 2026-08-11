export { a as AccessGrant, A as AccessSource, C as ChatGPTAuth, b as ChatGPTAuthOptions, c as CodexFetchOptions, d as createChatGPTAuth, e as createCodexFetch } from './codex-fetch-BwMht0DX.js';
import { T as TokenStore, O as OAuthTokens } from './types-MT7M_0Y9.js';
export { A as AuthStatus, C as Clock, D as DeviceAuth, a as DevicePoll, F as FetchLike, b as FetchLikeResponse, L as Logger, S as Sleep } from './types-MT7M_0Y9.js';

/**
 * File-backed token store with owner-only permissions.
 *
 * The caller supplies the path. This package has no default location and reads
 * no environment variable to find one — where credentials live is the
 * application's policy, and the two consumers this was extracted for already
 * disagree about it.
 *
 * `read()` hits the disk every time. That is a contract, not an oversight: the
 * refresh-rotation recovery path re-reads the store precisely to observe what a
 * sibling process wrote, and caching here would disable it.
 */
declare function fileTokenStore(filePath: string): TokenStore;

/**
 * In-process token store. Intended for tests and for consumers that manage
 * persistence themselves.
 *
 * Each instance gets a distinct key so two memory stores are never treated as
 * the same account by the refresh de-duplication map.
 */
declare function memoryTokenStore(initial?: OAuthTokens | null): TokenStore;

/**
 * Generate an RFC 7636 PKCE pair.
 *
 * The verifier is 32 random bytes rendered as base64url, which lands on exactly
 * 43 characters — the RFC's minimum length — drawn from `[A-Za-z0-9-_]`, a
 * subset of the unreserved set the spec allows.
 *
 * This differs from the common `alphabet[byte % alphabet.length]` idiom on
 * purpose. That idiom is only uniform when the alphabet size divides 256, and
 * the full unreserved set is 66 characters (26 + 26 + 10 + `-._~`), so 58 of
 * the 66 characters come up slightly more often. Encoding the bytes directly
 * removes the bias instead of reasoning about whether it matters.
 */
declare function generatePKCE(): {
    verifier: string;
    challenge: string;
};

/**
 * Single place that maps a model id to its provider.
 *
 * Unknown ids return null rather than guessing a default: a caller that cannot
 * identify the provider should say so explicitly instead of routing a typo to
 * whichever backend happens to be first.
 *
 * This union is additive — new providers may appear in a later version. Pin by
 * tag if an exhaustive `switch` over it must stay exhaustive.
 */
type Provider = "openai" | "anthropic" | "google";
declare function providerOf(model: string): Provider | null;

/**
 * Protocol constants tied to the public Codex OAuth client.
 *
 * These are not tuning knobs. `CLIENT_ID` and the `originator` values are bound
 * to one another server-side: the authorize call is accepted for this client id
 * with this originator, and the Codex backend rejects requests (HTTP 400) when
 * the originator header is absent. They are overridable for forward
 * compatibility, but changing them without a matching client id will fail.
 */
/** OpenAI's public Codex OAuth client. */
declare const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
declare const ISSUER = "https://auth.openai.com";
/**
 * The ChatGPT backend — deliberately not `api.openai.com`. Subscription
 * credentials are accepted here and nowhere else.
 */
declare const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** Loopback port the browser login flow listens on for its callback. */
declare const DEFAULT_CALLBACK_PORT = 1455;
/** Originator recorded on the authorize request; bound to `CLIENT_ID`. */
declare const AUTHORIZE_ORIGINATOR = "opencode";
/** Originator header the Codex backend requires on API calls. */
declare const API_ORIGINATOR = "codex_cli_rs";
/** Renew this far before expiry so a token cannot lapse mid-response. */
declare const REFRESH_MARGIN_MS = 60000;
/**
 * The boundary this package is built to respect.
 *
 * A personal ChatGPT subscription is licensed for one person's own use. Routing
 * other people's requests through it — running a shared service on one
 * account — violates the ChatGPT terms. This is not a theoretical line:
 * Anthropic prohibited exactly this pattern for Claude subscription OAuth on
 * 2026-02-20, and third-party tools relying on it stopped working.
 *
 * The API enforces this structurally rather than by warning: there is no user
 * dimension anywhere in it. See docs/personal-use.md.
 */
declare const PERSONAL_USE_NOTICE: string;

/**
 * Typed errors with stable `code` values.
 *
 * The original implementation threw Error with a hardcoded Korean message,
 * which forced consumers to match on message text and made localization a
 * downstream string-replacement problem. Callers should branch on `code`.
 *
 * Every message that embeds remote output goes through `scrubSecrets` at the
 * construction site — see `redact.ts` for why that is not optional here.
 */
declare class SubauthError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/** No token has been stored yet — the user has never logged in, or logged out. */
declare class NotAuthenticatedError extends SubauthError {
    constructor(message?: string);
}
/** A stored session exists but carries no refresh token, so it cannot be renewed. */
declare class RefreshTokenMissingError extends SubauthError {
    constructor(message?: string);
}
/**
 * The refresh token was rejected — typically because it was already rotated and
 * the server revoked the session. Recovery is a fresh login, not a retry.
 */
declare class InvalidGrantError extends SubauthError {
    constructor(message?: string);
}
/** The token endpoint returned a non-OK status that is not `invalid_grant`. */
declare class TokenRequestError extends SubauthError {
    readonly status: number;
    constructor(status: number, message: string);
}
/** The device-authorization endpoint returned a non-OK status. */
declare class DeviceAuthError extends SubauthError {
    readonly status: number;
    constructor(status: number, message: string);
}
/** The browser login callback was malformed, mismatched, or reported an error. */
declare class LoginFailedError extends SubauthError {
    constructor(message: string);
}

export { API_ORIGINATOR, AUTHORIZE_ORIGINATOR, CLIENT_ID, CODEX_BASE_URL, DEFAULT_CALLBACK_PORT, DeviceAuthError, ISSUER, InvalidGrantError, LoginFailedError, NotAuthenticatedError, OAuthTokens, PERSONAL_USE_NOTICE, type Provider, REFRESH_MARGIN_MS, RefreshTokenMissingError, SubauthError, TokenRequestError, TokenStore, fileTokenStore, generatePKCE, memoryTokenStore, providerOf };
