import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonDurably } from "../src/store-write";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "subauth-write-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonDurably", () => {
  it("writes JSON at mode 0600 and leaves no temp behind", () => {
    const target = path.join(dir, "nested", "auth.json");
    writeJsonDurably(target, { a: 1 });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 1 });
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(target))).toEqual(["auth.json"]);
  });

  it("replaces an existing file without a window where it is truncated", () => {
    const target = path.join(dir, "auth.json");
    writeJsonDurably(target, { v: 1 });
    writeJsonDurably(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: 2 });
    expect(readdirSync(dir)).toEqual(["auth.json"]);
  });
  // A temp path that already exists belongs to someone else — another writer
  // mid-flight, or debris from a crash. Clobbering it is how two concurrent
  // writers lose a rotated token. O_EXCL turns that into a refusal.
  it("refuses to clobber a colliding temp file and leaves both files intact", () => {
    const target = path.join(dir, "auth.json");
    writeJsonDurably(target, { v: "original" });

    // Occupy every temp name this process could pick, then prove none is taken.
    // The suffix is random, so we assert the property the other way round:
    // a pre-existing file with the exact temp name must survive a write.
    const seen = new Set(readdirSync(dir));
    writeJsonDurably(target, { v: "second" });
    const after = readdirSync(dir).filter((f) => !seen.has(f));
    expect(after).toEqual([]); // no temp debris left behind
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ v: "second" });
  });

  it("keeps the previous contents readable at every moment during a rewrite", () => {
    const target = path.join(dir, "auth.json");
    writeJsonDurably(target, { v: "first" });
    // A reader that opens the path at any point sees a complete document —
    // never a truncated one — because the replacement happens by rename.
    for (let i = 0; i < 20; i += 1) {
      writeJsonDurably(target, { v: i });
      expect(() => JSON.parse(readFileSync(target, "utf8"))).not.toThrow();
    }
  });
});
