import { unlinkSync, mkdirSync, writeFileSync, renameSync, chmodSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { randomUUID, randomBytes, createHash } from 'crypto';

// src/constants.ts
var CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var ISSUER = "https://auth.openai.com";
var CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
var DEFAULT_CALLBACK_PORT = 1455;
var AUTHORIZE_ORIGINATOR = "opencode";
var API_ORIGINATOR = "codex_cli_rs";
var REFRESH_MARGIN_MS = 6e4;
var PERSONAL_USE_NOTICE = "subauth uses a personal ChatGPT subscription and is licensed for one person's own use. Serving other users' requests through one subscription violates the ChatGPT terms.";

// src/errors.ts
var SubauthError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
};
var NotAuthenticatedError = class extends SubauthError {
  constructor(message = "No ChatGPT OAuth token is stored. Run the login flow first.") {
    super("not_authenticated", message);
  }
};
var RefreshTokenMissingError = class extends SubauthError {
  constructor(message = "The stored session has no refresh token. Log in again.") {
    super("refresh_token_missing", message);
  }
};
var InvalidGrantError = class extends SubauthError {
  constructor(message = "The refresh token is no longer valid. Log in again.") {
    super("invalid_grant", message);
  }
};
var TokenRequestError = class extends SubauthError {
  status;
  constructor(status, message) {
    super("token_request_failed", message);
    this.status = status;
  }
};
var DeviceAuthError = class extends SubauthError {
  status;
  constructor(status, message) {
    super("device_auth_failed", message);
    this.status = status;
  }
};
var LoginFailedError = class extends SubauthError {
  constructor(message) {
    super("login_failed", message);
  }
};

// src/redact.ts
var REDACTED = "[REDACTED]";
var CREDENTIAL_FIELD_NAMES = "access_token|refresh_token|id_token|client_secret|code_verifier|code_challenge|authorization_code|user_code|device_auth_id|code";
var JSON_CREDENTIAL_FIELD = new RegExp(
  `("(?:${CREDENTIAL_FIELD_NAMES})"\\s*:\\s*)"[^"]*"`,
  "gi"
);
var FORM_CREDENTIAL_FIELD = new RegExp(
  `\\b((?:${CREDENTIAL_FIELD_NAMES})=)[^&\\s"']+`,
  "gi"
);
var JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
var BEARER = /\b([Bb]earer)[ \t]+[A-Za-z0-9._~+/=-]{8,}/g;
var OPENAI_KEY = /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g;
var LONG_OPAQUE = /\b[A-Za-z0-9_-]{40,}={0,2}/g;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function scrubKnown(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
    }
  }
  return out;
}
function scrubSecrets(text) {
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
function scrubDetail(text, maxLength = 300, known = []) {
  const scrubbed = scrubSecrets(scrubKnown(text, known));
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength)}\u2026` : scrubbed;
}

// src/claims.ts
function decodeClaims(token) {
  const payload = token?.split(".")[1];
  if (!payload) return void 0;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return void 0;
  }
}
function accountIdFrom(token) {
  const claims = decodeClaims(token);
  if (!claims) return void 0;
  return claims.chatgpt_account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? claims.organizations?.[0]?.id;
}
function extractAccountId(tokens) {
  return accountIdFrom(tokens.id_token) ?? accountIdFrom(tokens.access_token);
}

// src/protocol.ts
var DEFAULT_USER_AGENT = "subauth";
var globalFetchAdapter = async (url, init) => {
  const response = await globalThis.fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    json: () => response.json()
  };
};
function resolveProtocolConfig(partial = {}) {
  return {
    fetch: partial.fetch ?? globalFetchAdapter,
    userAgent: partial.userAgent ?? DEFAULT_USER_AGENT,
    clientId: partial.clientId ?? CLIENT_ID,
    issuer: partial.issuer ?? ISSUER
  };
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function parseOAuthError(detail) {
  let parsed;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const body = parsed;
  return {
    code: typeof body.error === "string" ? body.error : void 0,
    description: typeof body.error_description === "string" ? body.error_description : void 0
  };
}
function errorSummary(status, detail, sent) {
  const { code, description } = parseOAuthError(detail);
  if (!code) {
    return `token request failed (${status}): the response was not a standard OAuth error`;
  }
  const suffix = description ? `: ${scrubDetail(description, 200, sent)}` : "";
  return `token request failed (${status}): ${scrubDetail(code, 80, sent)}${suffix}`;
}
async function tokenRequest(config, body) {
  const sent = [
    body.get("refresh_token") ?? void 0,
    body.get("code_verifier") ?? void 0,
    body.get("code") ?? void 0
  ];
  const response = await config.fetch(`${config.issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": config.userAgent
    },
    body: body.toString()
  });
  if (!response.ok) {
    const detail = await safeText(response);
    if (parseOAuthError(detail).code === "invalid_grant") {
      throw new InvalidGrantError();
    }
    throw new TokenRequestError(response.status, errorSummary(response.status, detail, sent));
  }
  let parsed;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new TokenRequestError(
      response.status,
      `token endpoint returned a non-JSON response: ${scrubDetail(
        error instanceof Error ? error.message : String(error),
        120
      )}`
    );
  }
  const candidate = parsed;
  if (!candidate || typeof candidate.access_token !== "string" || candidate.access_token === "") {
    throw new TokenRequestError(
      response.status,
      "token endpoint returned no access token"
    );
  }
  return candidate;
}
function exchangeCode(config, params) {
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: config.clientId,
      code_verifier: params.verifier
    })
  );
}
function refreshTokens(config, refresh) {
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: config.clientId
    })
  );
}
function toTokens(response, now, previous) {
  const rotated = typeof response.refresh_token === "string" && response.refresh_token !== "" ? response.refresh_token : void 0;
  const seconds = Number(response.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  return {
    access: response.access_token,
    refresh: rotated ?? previous?.refresh ?? "",
    accountId: extractAccountId(response) ?? previous?.accountId,
    expires: now() + lifetime * 1e3
  };
}

// src/device.ts
async function postJson(config, route, body) {
  return config.fetch(`${config.issuer}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
    body: JSON.stringify(body)
  });
}
async function startDeviceAuth(config, logger = {}) {
  logger.warn?.(PERSONAL_USE_NOTICE);
  const response = await postJson(config, "/api/accounts/deviceauth/usercode", {
    client_id: config.clientId
  });
  if (!response.ok) {
    throw new DeviceAuthError(response.status, `device authorization failed (${response.status})`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new DeviceAuthError(response.status, "device authorization returned a non-JSON response");
  }
  if (typeof data?.device_auth_id !== "string" || typeof data?.user_code !== "string") {
    throw new DeviceAuthError(response.status, "device authorization response is missing fields");
  }
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: data.verification_uri_complete || data.verification_uri || `${config.issuer}/codex/device`,
    // The server's advisory values are clamped: a zero interval would spin, and
    // a tiny expiry would abandon a login the user is still walking through.
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresIn: Math.max(Number(data.expires_in) || 900, 60)
  };
}
async function pollDeviceToken(config, store, now, deviceAuthId, userCode) {
  const response = await postJson(config, "/api/accounts/deviceauth/token", {
    device_auth_id: deviceAuthId,
    user_code: userCode
  });
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  if (!response.ok) {
    return { status: "error", message: `device token request failed (${response.status})` };
  }
  let data;
  try {
    data = await response.json();
  } catch {
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
        verifier: data.code_verifier
      }),
      now
    );
    store.write(tokens);
    return { status: "complete", accountId: tokens.accountId };
  } catch (error) {
    const reason = scrubSecrets(error instanceof Error ? error.message : String(error));
    return { status: "error", message: `token exchange failed, log in again: ${reason.slice(0, 120)}` };
  }
}

// src/auth.ts
var REGISTRY_KEY = Symbol.for("subauth.inFlightRefreshes");
function inFlightRegistry() {
  const host = globalThis;
  const existing = host[REGISTRY_KEY];
  if (existing) return existing;
  const created = /* @__PURE__ */ new Map();
  host[REGISTRY_KEY] = created;
  return created;
}
var defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function detachOnAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
function errorText(error) {
  return scrubSecrets(error instanceof Error ? error.message : String(error));
}
function createChatGPTAuth(options) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger ?? {};
  const rotationRetry = options.rotationRetry ?? { attempts: 8, delayMs: 400 };
  const config = resolveProtocolConfig(options);
  function isUsable(tokens) {
    return now() < tokens.expires - REFRESH_MARGIN_MS;
  }
  async function recoverFromRotation(previous) {
    for (let attempt = 0; attempt < rotationRetry.attempts; attempt++) {
      await sleep(rotationRetry.delayMs);
      const current = store.read();
      if (current && current.access !== previous.access && isUsable(current)) {
        logger.debug?.("adopted a token refreshed by another process");
        return { access: current.access, accountId: current.accountId };
      }
    }
    return null;
  }
  async function refreshOnce(previous) {
    let next;
    try {
      next = toTokens(await refreshTokens(config, previous.refresh), now, previous);
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        const recovered = await recoverFromRotation(previous);
        if (recovered) return recovered;
        store.clear();
      }
      throw error;
    }
    const current = store.read();
    if (current === null) {
      throw new NotAuthenticatedError("The session was logged out while the token was refreshing.");
    }
    if (current.access !== previous.access) {
      logger.debug?.("another process refreshed first; keeping the newer session");
      return { access: current.access, accountId: current.accountId };
    }
    try {
      store.write(next);
    } catch (error) {
      logger.warn?.(`refreshed token could not be persisted: ${errorText(error)}`);
    }
    return { access: next.access, accountId: next.accountId };
  }
  async function getFreshAccess(signal) {
    signal?.throwIfAborted();
    const tokens = store.read();
    if (!tokens) throw new NotAuthenticatedError();
    if (isUsable(tokens)) return { access: tokens.access, accountId: tokens.accountId };
    if (!tokens.refresh) throw new RefreshTokenMissingError();
    const inFlight = inFlightRegistry();
    const pending = inFlight.get(store.key);
    if (pending) return signal ? detachOnAbort(pending, signal) : pending;
    const started = refreshOnce(tokens).finally(() => {
      if (inFlight.get(store.key) === started) inFlight.delete(store.key);
    });
    inFlight.set(store.key, started);
    return signal ? detachOnAbort(started, signal) : started;
  }
  return {
    getFreshAccess,
    exists: () => store.exists(),
    status() {
      const tokens = store.read();
      if (!tokens) return { exists: false };
      return { exists: true, accountId: tokens.accountId, expires: tokens.expires };
    },
    logout: () => store.clear(),
    startDeviceAuth: () => startDeviceAuth(config, logger),
    pollDeviceToken: (deviceAuthId, userCode) => pollDeviceToken(config, store, now, deviceAuthId, userCode)
  };
}
function isTokens(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return typeof candidate.access === "string" && typeof candidate.refresh === "string" && typeof candidate.expires === "number";
}
function fileTokenStore(filePath) {
  const resolved = path.resolve(filePath);
  function read() {
    if (!existsSync(resolved)) return null;
    try {
      const parsed = JSON.parse(readFileSync(resolved, "utf8"));
      return isTokens(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return {
    key: resolved,
    read,
    write(tokens) {
      mkdirSync(path.dirname(resolved), { recursive: true, mode: 448 });
      const tmp = `${resolved}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 384 });
        renameSync(tmp, resolved);
      } catch (error) {
        try {
          unlinkSync(tmp);
        } catch {
        }
        throw error;
      }
      try {
        chmodSync(resolved, 384);
      } catch {
      }
    },
    clear() {
      try {
        unlinkSync(resolved);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    exists() {
      return read() !== null;
    }
  };
}

// src/store-memory.ts
var counter = 0;
function memoryTokenStore(initial = null) {
  let tokens = initial;
  const key = `memory:${++counter}`;
  return {
    key,
    read: () => tokens,
    write: (next) => {
      tokens = next;
    },
    clear: () => {
      tokens = null;
    },
    exists: () => tokens !== null
  };
}
function withStoreFalse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return JSON.stringify({ ...parsed, store: false });
}
function createCodexFetch(auth, options = {}) {
  const transport = () => options.fetch ?? globalThis.fetch;
  const sessionId = options.sessionId ?? randomUUID;
  const originator = options.originator ?? API_ORIGINATOR;
  const codexFetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const { access, accountId } = await auth.getFreshAccess(init?.signal ?? void 0);
    init?.signal?.throwIfAborted();
    const asRequest = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const headers = new Headers(asRequest?.headers);
    if (init?.headers) {
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
    }
    headers.set("Authorization", `Bearer ${access}`);
    if (accountId) headers.set("chatgpt-account-id", accountId);
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", originator);
    headers.set("session_id", sessionId());
    const nextInit = { ...init, headers };
    const isJson = headers.get("content-type")?.includes("application/json") ?? false;
    let rawBody;
    if (typeof init?.body === "string") {
      rawBody = init.body;
    } else if (init?.body === void 0 && isJson && asRequest?.body != null) {
      rawBody = await asRequest.text();
    }
    if (isJson && rawBody !== void 0) {
      const rewritten = withStoreFalse(rawBody);
      if (rewritten !== null) {
        nextInit.body = rewritten;
        headers.delete("content-length");
      } else if (rawBody !== init?.body) {
        nextInit.body = rawBody;
      }
    }
    return transport()(input, nextInit);
  };
  return codexFetch;
}
function base64url(buf) {
  return buf.toString("base64url");
}
function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// src/model-id.ts
function providerOf(model) {
  if (!model) return null;
  const id = model.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (/^(gpt|o\d)/.test(id)) return "openai";
  if (id.startsWith("gemini")) return "google";
  return null;
}

export { API_ORIGINATOR, AUTHORIZE_ORIGINATOR, CLIENT_ID, CODEX_BASE_URL, DEFAULT_CALLBACK_PORT, DeviceAuthError, ISSUER, InvalidGrantError, LoginFailedError, NotAuthenticatedError, PERSONAL_USE_NOTICE, REFRESH_MARGIN_MS, RefreshTokenMissingError, SubauthError, TokenRequestError, createChatGPTAuth, createCodexFetch, fileTokenStore, generatePKCE, memoryTokenStore, providerOf };
