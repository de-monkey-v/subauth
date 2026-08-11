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

export class SubauthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** No token has been stored yet — the user has never logged in, or logged out. */
export class NotAuthenticatedError extends SubauthError {
  constructor(message = "No ChatGPT OAuth token is stored. Run the login flow first.") {
    super("not_authenticated", message);
  }
}

/** A stored session exists but carries no refresh token, so it cannot be renewed. */
export class RefreshTokenMissingError extends SubauthError {
  constructor(message = "The stored session has no refresh token. Log in again.") {
    super("refresh_token_missing", message);
  }
}

/**
 * The refresh token was rejected — typically because it was already rotated and
 * the server revoked the session. Recovery is a fresh login, not a retry.
 */
export class InvalidGrantError extends SubauthError {
  constructor(message = "The refresh token is no longer valid. Log in again.") {
    super("invalid_grant", message);
  }
}

/** The token endpoint returned a non-OK status that is not `invalid_grant`. */
export class TokenRequestError extends SubauthError {
  readonly status: number;

  constructor(status: number, message: string) {
    super("token_request_failed", message);
    this.status = status;
  }
}

/** The device-authorization endpoint returned a non-OK status. */
export class DeviceAuthError extends SubauthError {
  readonly status: number;

  constructor(status: number, message: string) {
    super("device_auth_failed", message);
    this.status = status;
  }
}

/** The browser login callback was malformed, mismatched, or reported an error. */
export class LoginFailedError extends SubauthError {
  constructor(message: string) {
    super("login_failed", message);
  }
}
