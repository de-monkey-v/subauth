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
};

/** Decode a JWT payload segment. Returns undefined for anything unparseable. */
function decodeClaims(token?: string): TokenClaims | undefined {
  const payload = token?.split(".")[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return undefined;
  }
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
  id_token?: string;
  access_token?: string;
}): string | undefined {
  return accountIdFrom(tokens.id_token) ?? accountIdFrom(tokens.access_token);
}
