import { PERSONAL_USE_NOTICE } from "./constants";
import { DeviceAuthError, StoreWriteRefusedError } from "./errors";
import { exchangeCode, toTokens, type ProtocolConfig } from "./protocol";
import { scrubSecrets } from "./redact";
import type { Clock, DeviceAuth, DevicePoll, Logger, TokenStore } from "./types";

async function postJson(
  config: ProtocolConfig,
  route: string,
  body: Record<string, unknown>,
) {
  return config.fetch(`${config.issuer}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
    body: JSON.stringify(body),
  });
}

type UserCodeResponse = {
  device_auth_id: string;
  user_code: string;
  interval?: string | number;
  expires_in?: string | number;
  verification_uri?: string;
  verification_uri_complete?: string;
};

/**
 * Begin a device-code login: returns the code and URL to show the person
 * approving on another device. Used for headless hosts and web UIs where the
 * browser-callback flow is not available.
 */
export async function startDeviceAuth(
  config: ProtocolConfig,
  logger: Logger = {},
): Promise<DeviceAuth> {
  logger.warn?.(PERSONAL_USE_NOTICE);

  const response = await postJson(config, "/api/accounts/deviceauth/usercode", {
    client_id: config.clientId,
  });
  if (!response.ok) {
    // The body is not quoted: an endpoint that reflects our request would put
    // credential material in it, and no scrubbing of arbitrary text is reliable.
    throw new DeviceAuthError(response.status, `device authorization failed (${response.status})`);
  }

  let data: UserCodeResponse;
  try {
    data = (await response.json()) as UserCodeResponse;
  } catch {
    // A 200 that is not JSON means something other than the device endpoint
    // answered. A raw SyntaxError here would escape this package's error
    // contract, which callers branch on via `code`.
    throw new DeviceAuthError(response.status, "device authorization returned a non-JSON response");
  }
  if (typeof data?.device_auth_id !== "string" || typeof data?.user_code !== "string") {
    // Without this the missing fields flow on as `undefined` and polling never
    // resolves — the user watches a code that can never be approved.
    throw new DeviceAuthError(response.status, "device authorization response is missing fields");
  }

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl:
      data.verification_uri_complete || data.verification_uri || `${config.issuer}/codex/device`,
    // The server's advisory values are clamped: a zero interval would spin, and
    // a tiny expiry would abandon a login the user is still walking through.
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresIn: Math.max(Number(data.expires_in) || 900, 60),
  };
}

/**
 * Poll once for device approval.
 *
 * Returns `pending` until the user approves — 403/404 are the server's way of
 * saying "not yet", not failures. On approval the authorization code is
 * exchanged and the session is stored.
 */
export async function pollDeviceToken(
  config: ProtocolConfig,
  store: TokenStore,
  now: Clock,
  deviceAuthId: string,
  userCode: string,
): Promise<DevicePoll> {
  const response = await postJson(config, "/api/accounts/deviceauth/token", {
    device_auth_id: deviceAuthId,
    user_code: userCode,
  });

  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) {
    return { status: "error", message: `device token request failed (${response.status})` };
  }

  let data: { authorization_code?: unknown; code_verifier?: unknown };
  try {
    data = (await response.json()) as { authorization_code?: unknown; code_verifier?: unknown };
  } catch {
    // Keep the DevicePoll return contract instead of throwing a SyntaxError.
    return { status: "error", message: "device token endpoint returned a non-JSON response" };
  }
  if (typeof data?.authorization_code !== "string" || typeof data?.code_verifier !== "string") {
    return { status: "error", message: "device token response is missing fields" };
  }

  try {
    const tokens = toTokens(
      await exchangeCode(config, {
        code: data.authorization_code,
        redirectUri: `${config.issuer}/deviceauth/callback`,
        verifier: data.code_verifier,
      }),
      now,
    );
    store.write(tokens);
    return { status: "complete", accountId: tokens.accountId };
  } catch (error) {
    const reason = scrubSecrets(error instanceof Error ? error.message : String(error));
    // A store that refuses this session will refuse it again, so "log in again"
    // would send the user around a loop that cannot terminate. Report what is
    // actually wrong instead.
    if (error instanceof StoreWriteRefusedError) {
      return { status: "error", message: `the session could not be stored: ${reason}` };
    }
    // Otherwise the authorization code is single-use and has now been spent, so
    // this attempt cannot be retried — a new device login is required.
    return { status: "error", message: `token exchange failed, log in again: ${reason.slice(0, 120)}` };
  }
}
