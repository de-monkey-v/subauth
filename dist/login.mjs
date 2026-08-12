import { spawn } from 'child_process';
import { randomBytes, createHash } from 'crypto';
import { createServer } from 'http';

// src/browser-login.ts

// src/constants.ts
var CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
var ISSUER = "https://auth.openai.com";
var DEFAULT_CALLBACK_PORT = 1455;
var AUTHORIZE_ORIGINATOR = "opencode";
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
var LoginFailedError = class extends SubauthError {
  constructor(message) {
    super("login_failed", message);
  }
};
function base64url(buf) {
  return buf.toString("base64url");
}
function generatePKCE() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

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
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded : void 0;
  } catch {
    return void 0;
  }
}
function isParseableJwt(token) {
  if (typeof token !== "string") return false;
  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) return false;
  if (!BASE64URL.test(segments[1])) return false;
  return decodeClaims(token) !== void 0;
}
var BASE64URL = /^[A-Za-z0-9_-]+$/;
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
var DEFAULT_TIMEOUT_MS = 1e4;
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
    issuer: partial.issuer ?? ISSUER,
    timeoutMs: partial.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
}
function buildAuthorizeUrl(config, params) {
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
    originator: AUTHORIZE_ORIGINATOR
  });
  return `${config.issuer}/oauth/authorize?${query.toString()}`;
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
    body: body.toString(),
    signal: AbortSignal.timeout(config.timeoutMs)
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
      // `sent` here too: a decoder error quotes the bytes it choked on, and a
      // proxy that echoed our request body puts the refresh token among them.
      `token endpoint returned a non-JSON response: ${scrubDetail(
        error instanceof Error ? error.message : String(error),
        120,
        sent
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
function toTokens(response, now, previous) {
  const rotated = typeof response.refresh_token === "string" && response.refresh_token !== "" ? response.refresh_token : void 0;
  const seconds = Number(response.expires_in);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  const accountId = extractAccountId(response) ?? previous?.accountId;
  const idToken = isParseableJwt(response.id_token) ? response.id_token : previous?.idToken ;
  return {
    access: response.access_token,
    refresh: rotated ?? previous?.refresh ?? "",
    ...accountId ? { accountId } : {},
    ...idToken ? { idToken } : {},
    expires: now() + lifetime * 1e3
  };
}

// src/browser-login.ts
function openSystemBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn(
        "sh",
        ["-c", 'command -v wslview >/dev/null 2>&1 && wslview "$1" || xdg-open "$1"', "sh", url],
        { stdio: "ignore", detached: true }
      ).unref();
    }
  } catch {
  }
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function page(message) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">${escapeHtml(
    message
  )}</body>`;
}
async function loginWithBrowser(options) {
  const logger = options.logger ?? {};
  logger.warn?.(PERSONAL_USE_NOTICE);
  const config = resolveProtocolConfig(options);
  const now = options.now ?? Date.now;
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const open = options.openBrowser ?? openSystemBrowser;
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(32));
  let redirectUri = "";
  options.signal?.throwIfAborted();
  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const value = url.searchParams.get("code");
      if (failure) {
        if (url.searchParams.get("state") !== state) {
          response.writeHead(400).end("Not found");
          return;
        }
        finish(400, `Login failed: ${failure}`, new LoginFailedError(`login failed: ${failure}`));
        return;
      }
      if (!value || url.searchParams.get("state") !== state) {
        finish(
          400,
          "Invalid callback (state mismatch or missing code).",
          new LoginFailedError("invalid oauth callback: state mismatch or missing code")
        );
        return;
      }
      finish(200, "Login complete \u2014 you can close this window.", null, value);
      function finish(status, message, error, codeValue) {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(page(message));
        settle(error, codeValue);
      }
    });
    function settle(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      server.close();
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(value);
    }
    function onAbort() {
      settle(new LoginFailedError("login aborted"));
    }
    const timer = options.timeoutMs ? setTimeout(() => settle(new LoginFailedError("login timed out")), options.timeoutMs) : void 0;
    timer?.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    server.on("error", (error) => settle(error));
    server.listen(port, "localhost", () => {
      try {
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        redirectUri = `http://localhost:${boundPort}/auth/callback`;
        const authorizeUrl = buildAuthorizeUrl(config, { redirectUri, challenge, state });
        options.onVerificationUrl?.(authorizeUrl);
        open(authorizeUrl);
      } catch (error) {
        settle(error instanceof Error ? error : new LoginFailedError(String(error)));
      }
    });
  });
  const tokens = toTokens(await exchangeCode(config, { code, redirectUri, verifier }), now);
  options.store.write(tokens);
  return { exists: true, accountId: tokens.accountId, expires: tokens.expires };
}

export { loginWithBrowser, openSystemBrowser };
