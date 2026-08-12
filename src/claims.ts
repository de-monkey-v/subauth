/**
 * Account-id extraction from OAuth token claims.
 *
 * The ChatGPT backend needs a `chatgpt-account-id` header, and the only place
 * that value is published is inside the JWT payload. Nothing here verifies the
 * signature: this is the client reading its own token to find out which account
 * it just authenticated as, not a server making a trust decision.
 */

type TokenClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: { chatgpt_account_id?: string };
  /** Standard JWT expiry, seconds since the epoch. */
  exp?: number;
};

/** Decode a JWT payload segment. Returns undefined for anything unparseable. */
function decodeClaims(token?: string): TokenClaims | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    // An array is a JSON object to `typeof` but not to a typed deserializer, and
    // `isParseableJwt` speaks for one of those.
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as TokenClaims)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a value is a JWT strict enough for a consumer that *parses* it.
 *
 * `decodeClaims` is deliberately forgiving because a missing account id is not
 * an error. This is the opposite question, asked on behalf of another program:
 * the Codex CLI deserializes `id_token` into a typed field that is neither
 * optional nor defaulted, so a value it cannot parse does not degrade its login
 * — it makes the whole auth file unreadable, API key and all. Three non-empty
 * segments with a base64url JSON payload is what that parse requires.
 */
export function isParseableJwt(token?: unknown): token is string {
  if (typeof token !== "string") return false;
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) return false;
  // `Buffer.from(x, "base64url")` also accepts standard base64 — `=` padding,
  // `+`, `/` — and decodes it without complaint. A strict decoder rejects those,
  // so accepting them here is how a file this package considers fine becomes one
  // the CLI cannot read at all. Observed: a payload with `=` makes
  // `codex login status` fail with "Invalid padding" and lose the API key
  // sitting in the same file. Only the payload is checked because that is the
  // segment the CLI decodes; padding elsewhere does not bother it.
  if (!BASE64URL.test(segments[1] as string)) return false;
  return decodeClaims(token) !== undefined;
}

/** The base64url alphabet: no `=` padding, no `+`, no `/`. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Read a JWT's expiry as epoch milliseconds.
 *
 * Needed by stores whose on-disk format records no expiry of its own — the
 * token itself is then the only place the deadline exists.
 */
export function expiryOf(token?: string): number | undefined {
  const exp = decodeClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function accountIdFrom(token?: string): string | undefined {
  const claims = decodeClaims(token);
  if (!claims) return undefined;
  return (
    claims.chatgpt_account_id ??
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
    claims.organizations?.[0]?.id
  );
}

/**
 * Find the ChatGPT account id, preferring the id token. Falls back to the
 * access token because a refresh response does not always return an id token.
 */
export function extractAccountId(tokens: {
  id_token?: string | undefined;
  access_token?: string | undefined;
}): string | undefined {
  return accountIdFrom(tokens.id_token) ?? accountIdFrom(tokens.access_token);
}
