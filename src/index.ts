/**
 * subauth — use a personal ChatGPT subscription as an OpenAI-compatible credential.
 *
 * ⚠️ Personal, single-account use only. A ChatGPT subscription is licensed for
 * one person's own use; routing other people's requests through it violates the
 * ChatGPT terms. This API has no user dimension, by design — see
 * docs/personal-use.md.
 *
 * The browser login flow lives in `subauth/login` so this entry stays free of
 * `node:http` and `node:child_process`.
 */

export { createChatGPTAuth } from "./auth";
export type { AccessGrant, ChatGPTAuth, ChatGPTAuthOptions } from "./auth";

export { fileTokenStore } from "./store-file";
export { memoryTokenStore } from "./store-memory";

export { createCodexFetch } from "./codex-fetch";
export type { AccessSource, CodexFetchOptions } from "./codex-fetch";

export { generatePKCE } from "./pkce";
export { providerOf } from "./model-id";
export type { Provider } from "./model-id";

export {
  API_ORIGINATOR,
  AUTHORIZE_ORIGINATOR,
  CLIENT_ID,
  CODEX_BASE_URL,
  DEFAULT_CALLBACK_PORT,
  ISSUER,
  PERSONAL_USE_NOTICE,
  REFRESH_MARGIN_MS,
} from "./constants";

export {
  DeviceAuthError,
  InvalidGrantError,
  LoginFailedError,
  NotAuthenticatedError,
  RefreshTokenMissingError,
  SubauthError,
  TokenRequestError,
} from "./errors";

export type {
  AuthStatus,
  Clock,
  DeviceAuth,
  DevicePoll,
  FetchLike,
  FetchLikeResponse,
  Logger,
  OAuthTokens,
  Sleep,
  TokenStore,
} from "./types";
