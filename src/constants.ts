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
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const ISSUER = "https://auth.openai.com";

/**
 * The ChatGPT backend — deliberately not `api.openai.com`. Subscription
 * credentials are accepted here and nowhere else.
 */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Loopback port the browser login flow listens on for its callback. */
export const DEFAULT_CALLBACK_PORT = 1455;

/** Originator recorded on the authorize request; bound to `CLIENT_ID`. */
export const AUTHORIZE_ORIGINATOR = "opencode";

/** Originator header the Codex backend requires on API calls. */
export const API_ORIGINATOR = "codex_cli_rs";

/** Renew this far before expiry so a token cannot lapse mid-response. */
export const REFRESH_MARGIN_MS = 60_000;

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
export const PERSONAL_USE_NOTICE =
  "subauth uses a personal ChatGPT subscription and is licensed for one person's own use. " +
  "Serving other users' requests through one subscription violates the ChatGPT terms.";
