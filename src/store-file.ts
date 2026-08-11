import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveStorePath } from "./store-path";
import type { OAuthTokens, TokenStore } from "./types";

function isTokens(value: unknown): value is OAuthTokens {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OAuthTokens>;
  return (
    typeof candidate.access === "string" &&
    typeof candidate.refresh === "string" &&
    typeof candidate.expires === "number" &&
    Number.isFinite(candidate.expires)
  );
}

/**
 * File-backed token store with owner-only permissions.
 *
 * The caller supplies the path. This package has no default location and reads
 * no environment variable to find one — where credentials live is the
 * application's policy, and the two consumers this was extracted for already
 * disagree about it.
 *
 * `read()` hits the disk every time. That is a contract, not an oversight: the
 * refresh-rotation recovery path re-reads the store precisely to observe what a
 * sibling process wrote, and caching here would disable it.
 */
export function fileTokenStore(filePath: string): TokenStore {
  const resolved = resolveStorePath(filePath);

  // Defined as a closure rather than a method so the returned functions survive
  // being destructured off the store — the way consumers import them.
  function read(): OAuthTokens | null {
    if (!existsSync(resolved)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolved, "utf8"));
      // A corrupt or truncated file is treated as "not logged in" rather than
      // throwing, so a bad write cannot lock the user out of the login UI.
      return isTokens(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return {
    key: resolved,

    read,

    write(tokens: OAuthTokens): void {
      // The directory usually does not exist on first login — an application
      // config dir nobody has created yet. Failing here would be expensive:
      // the caller has already spent its single-use authorization code, so an
      // ENOENT costs the whole login rather than a retry.
      mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });

      // Write to a pid-suffixed temp file and rename: concurrent writers never
      // share a temp path, and readers only ever see a complete file.
      const tmp = `${resolved}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        renameSync(tmp, resolved);
      } catch (error) {
        // A failed rename leaves the temp file holding a live refresh token in
        // plaintext, under a name nothing will ever clean up.
        try {
          unlinkSync(tmp);
        } catch {
          // Nothing further to do; the original failure is what matters.
        }
        throw error;
      }
      try {
        chmodSync(resolved, 0o600);
      } catch {
        // Best effort — platforms without POSIX modes still get the rename.
      }
    },

    clear(): void {
      try {
        unlinkSync(resolved);
      } catch (error) {
        // Already gone is success. Checking existence first would still race:
        // this store is explicitly shared between processes, so a sibling
        // logging out concurrently could unlink between the check and the call.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },

    exists(): boolean {
      // Deliberately "is there a usable session", not "is there a file".
      // Consumers use this from synchronous paths to decide whether the user is
      // logged in; reporting true for a corrupt file would show a logged-in UI
      // that fails on the first request.
      return read() !== null;
    },
  };
}
