import { AUTHORIZE_ORIGINATOR, CLIENT_ID, ISSUER } from "./constants";
import { InvalidGrantError, TokenRequestError } from "./errors";
import { scrubDetail } from "./redact";
import { extractAccountId } from "./claims";
import type { Clock, FetchLike, FetchLikeResponse, OAuthTokens } from "./types";

/** Raw token endpoint response. */
export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
};

export type ProtocolConfig = {
  fetch: FetchLike;
  userAgent: string;
  clientId: string;
  issuer: string;
};

export const DEFAULT_USER_AGENT = "subauth";

/** Adapt the platform `fetch` to the narrow `FetchLike` this package injects. */
export const globalFetchAdapter: FetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    json: () => response.json(),
  };
};

export function resolveProtocolConfig(partial: Partial<ProtocolConfig> = {}): ProtocolConfig {
  return {
    fetch: partial.fetch ?? globalFetchAdapter,
    userAgent: partial.userAgent ?? DEFAULT_USER_AGENT,
    clientId: partial.clientId ?? CLIENT_ID,
    issuer: partial.issuer ?? ISSUER,
  };
}

/**
 * Build the authorize URL.
 *
 * `originator` and `codex_cli_simplified_flow` are bound to the public Codex
 * client id; the authorize call is rejected without them.
 */
export function buildAuthorizeUrl(
  config: ProtocolConfig,
  params: { redirectUri: string; challenge: string; state: string },
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: params.state,
    originator: AUTHORIZE_ORIGINATOR,
  });
  return `${config.issuer}/oauth/authorize?${query.toString()}`;
}

/** Read an error body defensively — a failed read must not mask the real status. */
async function safeText(response: FetchLikeResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Extract the standard OAuth 2.0 error fields from a response body.
 *
 * Two failures are avoided by parsing rather than pattern-matching the raw text:
 *
 * 1. **Credential echo.** An endpoint that reflects the request — a debug proxy,
 *    a captive portal — puts the refresh token we just sent into the body. Any
 *    scrubbing of arbitrary text is a guess, and it loses outright when the echo
 *    wraps the token across lines: no literal matches, no pattern matches, and
 *    the fragments are still enough to reassemble. Only structured fields are
 *    ever quoted, so an arbitrary body never reaches an error message.
 *
 * 2. **False invalid_grant.** Searching the whole body for "invalid_grant"
 *    fires on an unrelated 400 that merely mentions it in prose, or on a proxy's
 *    HTML page — and the consequence is deleting a working session and forcing a
 *    re-login. The error code is read from the `error` field or not at all.
 */
function parseOAuthError(detail: string): { code?: string; description?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const body = parsed as { error?: unknown; error_description?: unknown };
  return {
    code: typeof body.error === "string" ? body.error : undefined,
    description: typeof body.error_description === "string" ? body.error_description : undefined,
  };
}

/** Build an error summary from structured fields only, never from the raw body. */
function errorSummary(
  status: number,
  detail: string,
  sent: Array<string | undefined>,
): string {
  const { code, description } = parseOAuthError(detail);
  if (!code) {
    // Deliberately says nothing about the body. If it is not a conformant OAuth
    // error, its contents are unknown and may be a reflection of our request.
    return `token request failed (${status}): the response was not a standard OAuth error`;
  }
  const suffix = description ? `: ${scrubDetail(description, 200, sent)}` : "";
  return `token request failed (${status}): ${scrubDetail(code, 80, sent)}${suffix}`;
}

async function tokenRequest(
  config: ProtocolConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  // The exact credential values this request carries. Passed to the scrubber so
  // an echoed body is redacted by literal match rather than by guessing a
  // shape — a short bare token defeats every pattern-based rule.
  const sent = [
    body.get("refresh_token") ?? undefined,
    body.get("code_verifier") ?? undefined,
    body.get("code") ?? undefined,
  ];

  const response = await config.fetch(`${config.issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.userAgent,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const detail = await safeText(response);
    // Only a conformant `{"error":"invalid_grant"}` revokes the session, because
    // the reaction to it is destructive: the stored token is deleted and the
    // user has to log in again.
    if (parseOAuthError(detail).code === "invalid_grant") {
      throw new InvalidGrantError();
    }
    throw new TokenRequestError(response.status, errorSummary(response.status, detail, sent));
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    // A 200 that is not JSON means something answered that is not the token
    // endpoint. Surfacing the raw SyntaxError would escape this package's error
    // contract — callers branch on `code` — and its message quotes the body.
    throw new TokenRequestError(
      response.status,
      `token endpoint returned a non-JSON response: ${scrubDetail(
        error instanceof Error ? error.message : String(error),
        120,
      )}`,
    );
  }

  // A 200 with no access token is not a success. Without this check the caller
  // would store `access: undefined`, overwriting a working session and — since
  // the stored record then fails validation on read — taking the still-valid
  // refresh token down with it.
  const candidate = parsed as Partial<TokenResponse> | null;
  if (!candidate || typeof candidate.access_token !== "string" || candidate.access_token === "") {
    throw new TokenRequestError(
      response.status,
      "token endpoint returned no access token",
    );
  }

  return candidate as TokenResponse;
}

export function exchangeCode(
  config: ProtocolConfig,
  params: { code: string; redirectUri: string; verifier: string },
): Promise<TokenResponse> {
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: config.clientId,
      code_verifier: params.verifier,
    }),
  );
}

export function refreshTokens(config: ProtocolConfig, refresh: string): Promise<TokenResponse> {
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: config.clientId,
    }),
  );
}

/**
 * Fold a token response into stored form.
 *
 * A refresh response does not always return a new refresh token; keeping the
 * previous one prevents a successful refresh from silently destroying the
 * ability to refresh again.
 */
export function toTokens(
  response: TokenResponse,
  now: Clock,
  previous?: OAuthTokens | null,
): OAuthTokens {
  // Every field is validated rather than trusted. A 200 carrying
  // `refresh_token: 12345` or `expires_in: "soon"` used to be written straight
  // to disk, producing a record that fails its own read-back validation — one
  // malformed response destroying a working session.
  const rotated =
    typeof response.refresh_token === "string" && response.refresh_token !== ""
      ? response.refresh_token
      : undefined;

  const seconds = Number(response.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;

  return {
    access: response.access_token,
    refresh: rotated ?? previous?.refresh ?? "",
    accountId: extractAccountId(response) ?? previous?.accountId,
    expires: now() + lifetime * 1000,
  };
}
