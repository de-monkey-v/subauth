import { chmodSync, existsSync, readFileSync } from "node:fs";
import { expiryOf, extractAccountId, isParseableJwt } from "./claims";
import { StoreWriteRefusedError } from "./errors";
import { resolveStorePath } from "./store-path";
import { writeJsonDurably } from "./store-write";
import type { Clock, OAuthTokens, TokenStore } from "./types";

/**
 * The file the official Codex CLI writes at `$CODEX_HOME/auth.json`.
 *
 * It holds more than one kind of credential — an API key and other providers'
 * material live alongside the ChatGPT session — so everything outside `tokens`
 * belongs to someone else and is preserved verbatim.
 */
type CodexAuthFile = {
  auth_mode?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  } | null;
  last_refresh?: string;
  [extra: string]: unknown;
};

/**
 * Why this is not just `CodexAuthFile | null`.
 *
 * "No file", "cannot read the file", and "the file is not JSON" are three
 * different situations, and a writer has to tell them apart. Collapsing them
 * loses the one case where the file's *contents* are intact and this process
 * simply cannot see them — a `sudo codex` run leaving root-owned credentials,
 * an ACL, a transient I/O error. Treating that as "nothing here" and writing
 * anyway drops every field this store does not own, including the API key,
 * because the rename succeeds regardless of the old file's permissions.
 */
type ReadOutcome =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "invalid" }
  | { kind: "ok"; file: CodexAuthFile };

function readOutcome(resolved: string): ReadOutcome {
  if (!existsSync(resolved)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { kind: "ok", file: parsed as CodexAuthFile }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function readFile(resolved: string): CodexAuthFile | null {
  const outcome = readOutcome(resolved);
  return outcome.kind === "ok" ? outcome.file : null;
}

function writeAtomic(resolved: string, content: CodexAuthFile): void {
  writeJsonDurably(resolved, content);
  try {
    chmodSync(resolved, 0o600);
  } catch {
    // Best effort — platforms without POSIX modes still get the rename.
  }
}

/**
 * Token store backed by the Codex CLI's own `auth.json`.
 *
 * The point is to reuse an existing login instead of asking for another one —
 * and, more importantly, to share the *same file* with the CLI rather than
 * copying the credentials somewhere else.
 *
 * Copying would look simpler and be worse: OAuth refresh tokens rotate, so two
 * files holding the same account's credentials each invalidate the other the
 * first time either one refreshes. Sharing the file means both sides observe
 * each rotation, which is exactly what the read-through contract and the
 * rotation-recovery path in `createChatGPTAuth` are built on.
 *
 * ```ts
 * const store = codexAuthStore(path.join(os.homedir(), ".codex", "auth.json"));
 * ```
 *
 * **Direction matters: run `codex login` first.** This adapts a session the CLI
 * created and updates it in place. It will not create one from nothing —
 * `id_token` is a required field of the CLI's record and a login response does
 * not always carry one, so a write without it is refused rather than producing
 * a file the CLI cannot parse. To hold a session this package logs into itself,
 * use `fileTokenStore` with a path of your own.
 *
 * The format records no expiry, so the deadline comes from the access token's
 * own `exp` claim; a token that is not a decodable JWT is treated as logged out
 * rather than assumed fresh, and refused on write for the same reason.
 *
 * Read and write accept exactly the same files, deliberately. A session read
 * from a file that could not be written back would refresh successfully — the
 * server rotating its refresh token — and then fail to persist it, leaving the
 * disk holding a token the server has already retired.
 *
 * Concurrency: writes are atomic, but a read-modify-write cannot be atomic
 * against another process without a lock. If the CLI writes between this
 * store's read and its rename, the CLI's write is the one that loses. Measured
 * at roughly 0.25% of writes under deliberate contention; both sides re-read on
 * the next refresh, so the loser recovers rather than breaking.
 */
export function codexAuthStore(filePath: string, options: { now?: Clock } = {}): TokenStore {
  const resolved = resolveStorePath(filePath);
  const now: Clock = options.now ?? Date.now;

  function read(): OAuthTokens | null {
    const file = readFile(resolved);
    const tokens = file?.tokens;
    if (!tokens || typeof tokens !== "object") return null;

    const { access_token: access, refresh_token: refresh, id_token: idToken } = tokens;
    if (typeof access !== "string" || access === "") return null;
    if (typeof refresh !== "string" || refresh === "") return null;

    const expires = expiryOf(access);
    // No decodable expiry means we cannot tell whether this token is live.
    // Reporting "logged out" sends the caller to a login it can complete;
    // guessing an expiry sends it to an API call that may fail cryptically.
    if (expires === undefined) return null;

    // Read and write have to agree on what this file format accepts. A refresh
    // response does not always carry a new id token, so the one on disk is what
    // gets written back — and `write` refuses an id token the CLI cannot parse.
    // Returning a session from such a file would refresh successfully, rotate
    // the token server-side, then fail to persist it: the rotation is lost and
    // the disk still holds the retired token, which is worse than logged out.
    // The file is already unreadable to the CLI at this point; saying so sends
    // the caller to a login that repairs it.
    if (!isParseableJwt(idToken)) return null;

    const stored = tokens.account_id;
    const accountId =
      typeof stored === "string" && stored !== ""
        ? stored
        : // Older files omit the field; the claim is authoritative anyway, and
          // without an account id the backend rejects the request with no clue why.
          extractAccountId({ id_token: idToken, access_token: access });

    return {
      access,
      refresh,
      ...(accountId ? { accountId } : {}),
      idToken,
      expires,
    };
  }

  return {
    // Same identity rule as fileTokenStore, so opening one path through both
    // stores still de-duplicates concurrent refreshes.
    key: resolved,

    read,

    write(next: OAuthTokens): void {
      // Refuse rather than corrupt, again. A file we cannot read is not an
      // absent one: its other credentials are still in there, and a write built
      // on `{}` would drop every one of them. `writeAtomic` renames over the
      // target, so the old file's permissions do not stop it.
      const outcome = readOutcome(resolved);
      if (outcome.kind !== "ok" && outcome.kind !== "missing") {
        const why =
          outcome.kind === "unreadable"
            ? "it exists but could not be read"
            : "it exists but is not valid JSON — possibly a truncated or partially written file";
        throw new StoreWriteRefusedError(
          `Refusing to write ${resolved}: ${why}, so the fields this store does not own — an ` +
            "API key, another provider's credentials — cannot be preserved and would be dropped. " +
            "Fix the file's ownership or permissions, restore it, or delete it if you are sure " +
            "it holds nothing else. `fileTokenStore` with a path of your own avoids sharing " +
            "entirely.",
        );
      }
      const existing = outcome.kind === "ok" ? outcome.file : {};
      const previous = (existing.tokens ?? undefined) || undefined;

      // Never persist a value `read()` would reject. `toTokens` can produce an
      // empty refresh when a token endpoint omits the field on a login, and
      // writing that would overwrite the CLI's live refresh token with nothing —
      // logging both programs out with no way back.
      const refresh = next.refresh || previous?.refresh_token;
      const accountId = next.accountId ?? previous?.account_id;

      // The id token identifies the account, so it travels with the credentials
      // rather than being preserved blindly: keeping the old one beside a new
      // account's tokens makes the CLI report the wrong identity.
      const sameAccount =
        previous?.account_id === undefined ||
        accountId === undefined ||
        previous.account_id === accountId;
      const idToken = next.idToken ?? (sameAccount ? previous?.id_token : undefined);

      // Refuse rather than corrupt. `id_token` is a required field of the CLI's
      // own record, and typed: a missing one fails to parse, so does one of the
      // wrong type, and so does a string that is not a JWT — the CLI decodes the
      // field rather than storing it opaquely. Any of the three fails the same
      // way, and the failure is not "logged out" but a hard error that also
      // takes down the API key and every other credential in the file. A refused
      // write leaves a working file behind.
      if (!isParseableJwt(idToken)) {
        throw new StoreWriteRefusedError(
          "Refusing to write a Codex auth.json without a parseable id token: the Codex CLI " +
            "requires that field to decode as a JWT and would fail to read the file, including " +
            "any other credentials in it. Run `codex login` first, or use fileTokenStore with " +
            "a path of your own.",
        );
      }
      if (typeof refresh !== "string" || refresh === "") {
        throw new StoreWriteRefusedError(
          "Refusing to write a Codex auth.json without a refresh token: the session would be " +
            "unusable and the previous refresh token would be lost.",
        );
      }

      // This format stores no expiry, so `read` recovers it from the access
      // token's own `exp` claim and reports "logged out" when it cannot. Writing
      // an access token without a decodable expiry would therefore overwrite a
      // working file with one this store immediately rejects — the same trap the
      // id token guard above exists for, on the other credential.
      if (expiryOf(next.access) === undefined) {
        throw new StoreWriteRefusedError(
          "Refusing to write a Codex auth.json whose access token carries no decodable expiry: " +
            "this format records no expiry of its own, so the file would read back as logged out.",
        );
      }

      writeAtomic(resolved, {
        ...existing,
        auth_mode: existing.auth_mode ?? "chatgpt",
        tokens: {
          // Spread first so fields the CLI adds in a later version survive; the
          // ones this package owns are then written over them.
          ...previous,
          id_token: idToken,
          access_token: next.access,
          refresh_token: refresh,
          ...(accountId ? { account_id: accountId } : {}),
        },
        last_refresh: new Date(now()).toISOString(),
      });
    },

    clear(): void {
      // Best effort. This runs automatically when a refresh token turns out to
      // be revoked, from a path that is already handling one failure — throwing
      // here would replace `invalid_grant` with a filesystem error and break the
      // `code` a consumer branches on.
      try {
        const existing = readFile(resolved);
        if (!existing) return;

        // Only the ChatGPT session is ours. This file also carries an API key
        // and other providers' credentials, so deleting it would destroy
        // material this package never touched.
        //
        // `auth_mode` goes with the session, not with the file: leaving
        // `"chatgpt"` next to `tokens: null` makes the CLI report a login it
        // cannot use — every request 401s — and stops it falling back to the
        // API key sitting in the same file.
        const { tokens: _tokens, last_refresh: _lastRefresh, auth_mode: _authMode, ...rest } = existing;
        writeAtomic(resolved, { ...rest, tokens: null });
      } catch {
        // A session that cannot be cleared is reported by `read()` as unusable
        // anyway; failing loudly here would only mask the original error.
      }
    },

    exists(): boolean {
      return read() !== null;
    },
  };
}
