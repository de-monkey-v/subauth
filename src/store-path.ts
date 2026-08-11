import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve a store path to the file that will actually be written.
 *
 * Symlinks are followed. These stores write by renaming a temp file over the
 * target, and a rename replaces a symlink with a regular file — so without this
 * a store pointed at a linked credential file would quietly stop updating the
 * real one and start keeping a second copy beside it. Two files holding one
 * account's rotating tokens is exactly the split these stores exist to avoid.
 *
 * The resolved path is also the store's identity key, so following links here
 * additionally makes two stores that reach the same file through different
 * paths agree that they are the same account.
 */
export function resolveStorePath(filePath: string): string {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}
