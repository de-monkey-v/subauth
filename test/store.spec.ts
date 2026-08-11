import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTokenStore } from "../src/store-file";
import { memoryTokenStore } from "../src/store-memory";
import type { OAuthTokens } from "../src/types";

const TOKENS: OAuthTokens = {
  access: "access-1",
  refresh: "refresh-1",
  accountId: "acct-1",
  expires: 1_800_000_000_000,
};

describe("memoryTokenStore", () => {
  it("round-trips tokens and reports existence", () => {
    const store = memoryTokenStore();
    expect(store.exists()).toBe(false);
    expect(store.read()).toBeNull();

    store.write(TOKENS);
    expect(store.exists()).toBe(true);
    expect(store.read()).toEqual(TOKENS);

    store.clear();
    expect(store.exists()).toBe(false);
    expect(store.read()).toBeNull();
  });

  it("gives every instance a distinct key so accounts are not conflated", () => {
    expect(memoryTokenStore().key).not.toBe(memoryTokenStore().key);
  });
});

describe("fileTokenStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "subauth-store-"));
    file = path.join(dir, "tokens.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses the resolved absolute path as its key", () => {
    expect(fileTokenStore(file).key).toBe(path.resolve(file));
  });

  it("round-trips tokens", () => {
    const store = fileTokenStore(file);
    expect(store.exists()).toBe(false);
    store.write(TOKENS);
    expect(store.exists()).toBe(true);
    expect(store.read()).toEqual(TOKENS);
  });

  it("writes the file owner-only", () => {
    fileTokenStore(file).write(TOKENS);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind, and names temps per pid", () => {
    fileTokenStore(file).write(TOKENS);
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    expect(leftovers).toEqual([]);
    // The temp name is derived from the pid so two processes never collide.
    expect(`${path.resolve(file)}.${process.pid}.tmp`).toContain(String(process.pid));
  });

  it("reads through to disk so a sibling process's write is observed", () => {
    // This is the contract the refresh-rotation recovery path depends on: a
    // caching store would keep returning the stale token and force a re-login.
    const store = fileTokenStore(file);
    store.write(TOKENS);
    expect(store.read()?.access).toBe("access-1");

    writeFileSync(file, JSON.stringify({ ...TOKENS, access: "written-by-sibling" }));
    expect(store.read()?.access).toBe("written-by-sibling");
  });

  it("treats a corrupt file as logged-out instead of throwing", () => {
    const store = fileTokenStore(file);
    for (const corrupt of ["", "not json", '{"access":"a"}', "[]", "null"]) {
      writeFileSync(file, corrupt);
      expect(() => store.read()).not.toThrow();
      expect(store.read()).toBeNull();
      // `exists` answers "is there a usable session", not "is there a file" —
      // otherwise a consumer would render a logged-in UI over a broken store
      // and fail on the first request.
      expect(store.exists()).toBe(false);
    }
  });

  it("keeps its functions working when destructured off the store", () => {
    // Consumers import these individually, so a `this`-dependent method would
    // break at the call site rather than here.
    const { read, write, exists, clear } = fileTokenStore(file);
    write(TOKENS);
    expect(exists()).toBe(true);
    expect(read()).toEqual(TOKENS);
    clear();
    expect(exists()).toBe(false);
  });

  it("clears idempotently", () => {
    const store = fileTokenStore(file);
    store.write(TOKENS);
    store.clear();
    expect(store.exists()).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });
});
