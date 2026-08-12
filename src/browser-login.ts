import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DEFAULT_CALLBACK_PORT, PERSONAL_USE_NOTICE } from "./constants";
import { LoginFailedError } from "./errors";
import { base64url, generatePKCE } from "./pkce";
import { buildAuthorizeUrl, exchangeCode, resolveProtocolConfig, toTokens } from "./protocol";
import type { AuthStatus, Clock, FetchLike, Logger, TokenStore } from "./types";

/**
 * Open a URL in the platform browser. Best effort and dependency-free — when it
 * fails the caller still has the URL from `onVerificationUrl`.
 */
export function openSystemBrowser(url: string): void {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      // On WSL, wslview reaches the Windows browser; elsewhere xdg-open.
      spawn(
        "sh",
        ["-c", 'command -v wslview >/dev/null 2>&1 && wslview "$1" || xdg-open "$1"', "sh", url],
        { stdio: "ignore", detached: true },
      ).unref();
    }
  } catch {
    // Ignored: the URL was already handed to the caller.
  }
}

export type BrowserLoginOptions = {
  store: TokenStore;
  fetch?: FetchLike;
  now?: Clock;
  logger?: Logger;
  userAgent?: string;
  clientId?: string;
  issuer?: string;
  /** Loopback callback port. Must match a redirect URI the client id allows. */
  port?: number;
  /** Browser launcher; pass a no-op to keep a test from spawning anything. */
  openBrowser?: (url: string) => void;
  /** Receives the authorize URL, for callers that print or display it. */
  onVerificationUrl?: (url: string) => void;
  /** Abandon the login after this long. The original flow waited forever. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * Anything interpolated into the callback page comes from the query string of
 * whatever hit the loopback port, which is not necessarily the identity
 * provider. Escaping it keeps a crafted `?error_description=<script>...` from
 * executing on a localhost origin while the listener is open.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">${escapeHtml(
    message,
  )}</body>`;
}

/**
 * Run the loopback PKCE browser login and store the resulting session.
 *
 * Returns status only. The tokens stay inside the store — `getFreshAccess` is
 * the single place in this package's API where a token is handed out, so a
 * login helper has no reason to widen that surface.
 */
export async function loginWithBrowser(options: BrowserLoginOptions): Promise<AuthStatus> {
  const logger = options.logger ?? {};
  logger.warn?.(PERSONAL_USE_NOTICE);

  const config = resolveProtocolConfig(options);
  const now: Clock = options.now ?? Date.now;
  const port = options.port ?? DEFAULT_CALLBACK_PORT;
  const open = options.openBrowser ?? openSystemBrowser;
  const { verifier, challenge } = generatePKCE();
  const state = base64url(randomBytes(32));

  // Resolved once the server is listening rather than from `port`, so port 0
  // (ask the OS for a free one) produces a callback URL that actually matches
  // where we listen. The token exchange must replay the identical value.
  let redirectUri = "";

  // Checked before anything is opened or bound. `addEventListener("abort")`
  // never fires on an already-aborted signal, so without this an aborted
  // controller would launch a browser and then hang forever.
  options.signal?.throwIfAborted();

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const server = createServer((request, response) => {
      // Only the path and query are read; the base exists to satisfy the parser.
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        // Keep listening: browsers ask for /favicon.ico and similar.
        response.writeHead(404).end("Not found");
        return;
      }

      const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      const value = url.searchParams.get("code");

      if (failure) {
        // The provider echoes `state` on failure too, so an error arriving
        // without the one we issued did not come from the flow we started.
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
          new LoginFailedError("invalid oauth callback: state mismatch or missing code"),
        );
        return;
      }
      finish(200, "Login complete — you can close this window.", null, value);

      function finish(status: number, message: string, error: Error | null, codeValue?: string) {
        response
          .writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
          .end(page(message));
        settle(error, codeValue);
      }
    });

    function settle(error: Error | null, value?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      server.close();
      // `close()` only stops new connections. A real browser holds the callback
      // socket open with keep-alive, which would keep the event loop alive for
      // the full keepAliveTimeout and make a CLI look hung after a successful
      // login.
      server.closeAllConnections?.();
      if (error) reject(error);
      else resolve(value as string);
    }

    function onAbort(): void {
      settle(new LoginFailedError("login aborted"));
    }

    const timer = options.timeoutMs
      ? setTimeout(() => settle(new LoginFailedError("login timed out")), options.timeoutMs)
      : undefined;
    timer?.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    server.on("error", (error) => settle(error));
    server.listen(port, "localhost", () => {
      // Consumer callbacks run here. An exception thrown by one of them — a
      // closed stdout while printing the URL, say — would otherwise escape as
      // an uncaught exception and leave this promise pending forever.
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
