import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Write JSON to `resolved` so a reader never observes a partial file, and so a
 * crash or power loss cannot leave the token file empty.
 *
 * Three properties, each earning its cost on a file that holds a live
 * credential shared in-place with the Codex CLI:
 *
 * 1. **`O_EXCL` on the temp file.** A temp path that already exists belongs to
 *    someone else — another writer mid-flight, or debris from a crash. Opening
 *    it with `wx` refuses instead of clobbering it. The random suffix makes a
 *    collision unlikely; `O_EXCL` makes acting on one impossible.
 * 2. **`fsync` before the rename.** `writeFile` returning only means the bytes
 *    reached the page cache. Renaming an unsynced temp file can publish a name
 *    that resolves to zero bytes after a crash — the rename is durable while
 *    its contents are not, which is exactly the ordering that loses a token.
 * 3. **`fsync` on the parent directory after the rename.** The rename itself
 *    lives in the directory, not the file, and needs its own flush.
 * 4. **`fsync` on each directory the first login had to create.** A directory
 *    is named by its parent, so a brand-new subtree needs every level flushed
 *    in the level above it. Flushing only the deepest one leaves the subtree —
 *    and the token inside it — nameless after a power cut, on the one write the
 *    caller cannot retry.
 *
 * Synchronous throughout: `TokenStore` is a synchronous contract and rotation
 * recovery depends on another process observing a completed write.
 */
export function writeJsonDurably(resolved: string, value: unknown): void {
  // The directory usually does not exist on first login — an application config
  // dir nobody has created yet. Failing here would be expensive: the caller has
  // already spent its single-use authorization code, so an ENOENT costs the
  // whole login rather than a retry.
  const dir = path.dirname(resolved);
  // `recursive` returns the first path it had to create, so everything from
  // there down is new and unflushed; `undefined` means the tree already existed.
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });

  // PID alone is not unique: worker threads share it, and two workers writing
  // the same path would collide. A random suffix separates them.
  const tmp = `${resolved}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    // `writeFileSync` on a descriptor writes everything: a UTF-8 string takes
    // the binding's own write-all path, and the fallback loops on a short
    // return. A bare `writeSync` does neither — it may return having written
    // part of the buffer, and that partial write would be fsynced and renamed
    // into place, publishing a truncated credential. That is the exact failure
    // this function exists to prevent, so the difference is not stylistic.
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, resolved);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    // A failed rename leaves the temp file holding a live refresh token in
    // plaintext, under a name nothing will ever clean up. Never remove a temp
    // we did not create: `O_EXCL` failing means the path is someone else's.
    if (!isAlreadyExists(error)) {
      try {
        unlinkSync(tmp);
      } catch {
        // Nothing further to do; the original failure is what matters.
      }
    }
    throw error;
  }

  syncDirectory(dir);
  syncNewDirectories(created, dir);
}

/**
 * Flush the directory entries naming a subtree `mkdirSync` just created, from
 * the deepest new level up to the parent of the first one.
 */
function syncNewDirectories(created: string | undefined, dir: string): void {
  if (created === undefined) return;
  let entry = dir;
  for (;;) {
    const parent = path.dirname(entry);
    syncDirectory(parent);
    // `path.dirname` is its own fixed point at the root, which would loop.
    if (entry === created || parent === entry) return;
    entry = parent;
  }
}

/**
 * Remove `resolved` and flush the removal.
 *
 * The counterpart to `writeJsonDurably`: a login that survives a crash and a
 * logout that does not is not a coherent guarantee. Unlinking a token file
 * without flushing the directory can bring the credential back after a power
 * loss — a file the user asked to be gone, holding a refresh token.
 */
export function unlinkDurably(resolved: string): void {
  try {
    unlinkSync(resolved);
  } catch (error) {
    // Already gone is success. Checking existence first would still race: these
    // stores are explicitly shared between processes, so a sibling logging out
    // concurrently could unlink between the check and the call.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  syncDirectory(path.dirname(resolved));
}

/** Best effort: platforms that refuse to open a directory still got the rename. */
function syncDirectory(dir: string): void {
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Windows rejects opening a directory; the rename is still atomic there.
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}
