import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Consumption smoke tests, run against the built output rather than src.
 *
 * These cover what the source tests structurally cannot: whether the package
 * actually resolves for the two module systems it claims to support, and
 * whether the entry split held through bundling. Requires `pnpm build` first —
 * `dist/` is committed, so a stale build failing here is the point.
 */

const dist = path.resolve(__dirname, "..", "dist");
const requireFromHere = createRequire(__filename);
const read = (file: string) => readFileSync(path.join(dist, file), "utf8");

describe("built output — module formats", () => {
  it("loads through require()", () => {
    const mod = requireFromHere(path.join(dist, "index.js")) as Record<string, unknown>;
    expect(typeof mod["createChatGPTAuth"]).toBe("function");
    expect(typeof mod["createCodexFetch"]).toBe("function");
    expect(typeof mod["fileTokenStore"]).toBe("function");
  });

  it("loads through import()", async () => {
    const mod = (await import(path.join(dist, "index.mjs"))) as Record<string, unknown>;
    expect(typeof mod["createChatGPTAuth"]).toBe("function");
  });

  it("exposes the login and ai-sdk entries in both formats", async () => {
    const loginCjs = requireFromHere(path.join(dist, "login.js")) as Record<string, unknown>;
    expect(typeof loginCjs["loginWithBrowser"]).toBe("function");

    const aiSdkCjs = requireFromHere(path.join(dist, "ai-sdk.js")) as Record<string, unknown>;
    expect(typeof aiSdkCjs["createChatGPTOpenAIProvider"]).toBe("function");

    const loginEsm = (await import(path.join(dist, "login.mjs"))) as Record<string, unknown>;
    expect(typeof loginEsm["loginWithBrowser"]).toBe("function");
  });

  it("ships type declarations for every entry, in both module views", () => {
    for (const name of ["index", "login", "ai-sdk"]) {
      expect(read(`${name}.d.ts`)).toContain("export");
      expect(read(`${name}.d.mts`)).toContain("export");
    }
  });
});

/**
 * Extract what a bundle actually imports.
 *
 * Scanning for the literal string "node:http" would be worthless here: esbuild
 * strips the `node:` prefix, so that assertion passes whether or not the module
 * is imported. Both spellings are normalized and compared as a set.
 */
function importsOf(file: string): Set<string> {
  const source = read(file);
  const found = new Set<string>();
  const patterns = [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]!.replace(/^node:/, ""));
    }
  }
  return found;
}

describe("built output — entry isolation", () => {
  it("keeps the loopback server and process spawning out of the root entry", () => {
    // The split exists so a consumer that only refreshes tokens does not drag
    // an HTTP server and child-process spawning into its bundle.
    for (const file of ["index.js", "index.mjs"]) {
      const imports = importsOf(file);
      expect([...imports].sort()).toEqual(["crypto", "fs", "path"]);
      expect(imports.has("http")).toBe(false);
      expect(imports.has("child_process")).toBe(false);
    }
  });

  it("does put the browser dependencies in the login entry", () => {
    // Negative control for the assertion above: it must be capable of failing.
    for (const file of ["login.js", "login.mjs"]) {
      const imports = importsOf(file);
      expect(imports.has("http")).toBe(true);
      expect(imports.has("child_process")).toBe(true);
    }
  });

  it("imports nothing outside the node builtins it declares", () => {
    // The package has no dependencies at all; the ai-sdk entry takes the
    // provider factory as a parameter rather than importing one.
    const builtins = new Set(["crypto", "fs", "path", "http", "child_process"]);
    for (const file of ["index.js", "index.mjs", "login.js", "login.mjs", "ai-sdk.js", "ai-sdk.mjs"]) {
      for (const specifier of importsOf(file)) {
        expect(builtins.has(specifier), `${file} imports ${specifier}`).toBe(true);
      }
      expect(read(file)).not.toContain("@ai-sdk");
    }
  });
});

describe("published package metadata", () => {
  const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    main: string;
    module: string;
    types: string;
    exports: Record<string, unknown>;
  };

  it("declares no runtime dependencies", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it("keeps the legacy fields node10 consumers resolve through", () => {
    // pr-review-bot compiles with moduleResolution:Node, which never reads
    // `exports`. Dropping these would break it silently.
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.module).toBe("./dist/index.mjs");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(Object.keys(pkg.exports)).toContain("./login");
    expect(Object.keys(pkg.exports)).toContain("./ai-sdk");
  });

  it("ships subpath shims for node10 resolution", () => {
    for (const entry of ["login", "ai-sdk"]) {
      const shim = JSON.parse(
        readFileSync(path.resolve(__dirname, "..", entry, "package.json"), "utf8"),
      ) as { main: string; types: string };
      expect(shim.main).toBe(`../dist/${entry}.js`);
      expect(shim.types).toBe(`../dist/${entry}.d.ts`);
    }
  });
});
