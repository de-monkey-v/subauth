/**
 * Pure, dependency-free secret scrubbing for error text.
 *
 * Why this exists at all: the token endpoint is sent the refresh token in the
 * request body, so any endpoint that echoes the request — a misconfigured
 * proxy, a debug gateway, a captive portal — can hand it straight back inside
 * an error body. The original implementation interpolated that body into the
 * thrown message, which put a live refresh token one `console.error` away from
 * a log file. Every message that embeds remote output is scrubbed here first.
 *
 * Conservative by design: over-redacting an error string costs readability,
 * under-redacting costs the account. Order matters — structured `key: value`
 * shapes run before the generic opaque-blob sweep so the key name survives in
 * the output and the message stays diagnosable.
 */

/** Marker inserted in place of a redacted secret. */
export const REDACTED = "[REDACTED]";

/** JSON-ish `"refresh_token": "..."` and bare `refresh_token=...` form fields. */
const CREDENTIAL_FIELD_NAMES =
  "access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge|authorization_code|user_code|device_auth_id|code";

const JSON_CREDENTIAL_FIELD = new RegExp(
  `("(?:${CREDENTIAL_FIELD_NAMES})"\\s*:\\s*)"[^"]*"`,
  "gi",
);

const FORM_CREDENTIAL_FIELD = new RegExp(
  `\\b((?:${CREDENTIAL_FIELD_NAMES})=)[^&\\s"']+`,
  "gi",
);

/** JWTs — access and id tokens are JWTs, and their payload carries account identifiers. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

const BEARER = /\b([Bb]earer)[ \t]+[A-Za-z0-9._~+/=-]{8,}/g;

/** OpenAI-style API keys, in case a consumer routes an apikey transport error through here. */
const OPENAI_KEY = /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g;

/**
 * Long opaque blobs. Refresh tokens are not a documented shape, so this is the
 * backstop that catches whatever the provider actually issues. The 40-character
 * floor keeps ordinary diagnostic text — status words, model ids, timestamps,
 * short hashes — readable.
 */
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{40,}={0,2}/g;

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove values we know are secret, by exact match.
 *
 * Shape-based rules can only guess, and they guess badly at the short end: a
 * bare token under the opaque-blob threshold, sitting in prose rather than in a
 * `key=value` pair, slips through every pattern below. But at the call sites
 * that matter we *sent* the credential, so we know its exact bytes — matching
 * that literal is precise where a pattern is speculative.
 *
 * The 8-character floor keeps a degenerate value (an empty or 2-character
 * token) from redacting unrelated text.
 */
export function scrubKnown(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    }
  }
  return out;
}

/** Redact recognizable credential material from free-form text. */
export function scrubSecrets(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return typeof text === "string" ? text : "";
  }

  let out = text;
  out = out.replace(JSON_CREDENTIAL_FIELD, `$1"${REDACTED}"`);
  out = out.replace(FORM_CREDENTIAL_FIELD, `$1${REDACTED}`);
  out = out.replace(BEARER, `$1 ${REDACTED}`);
  out = out.replace(JWT, REDACTED);
  out = out.replace(OPENAI_KEY, REDACTED);
  out = out.replace(LONG_OPAQUE, REDACTED);
  return out;
}

/**
 * Scrub and truncate a remote response body for inclusion in an error message.
 *
 * `known` carries the credential values this request actually sent, which are
 * removed by exact match before the shape-based rules run — that is what covers
 * a short bare token echoed back in prose. Scrubbing precedes truncation so a
 * token cut in half is still removed.
 */
export function scrubDetail(
  text: string,
  maxLength = 300,
  known: Array<string | undefined> = [],
): string {
  const scrubbed = scrubSecrets(scrubKnown(text, known));
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}…` : scrubbed;
}
