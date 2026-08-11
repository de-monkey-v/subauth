#!/usr/bin/env node
/**
 * AC2 — an ESM consumer resolves all three entries, and the entry split holds
 * in the built output.
 *
 * The isolation check reads what each bundle imports rather than scanning for
 * the literal string "node:http": esbuild strips the `node:` prefix, so a
 * substring assertion would pass whether or not the module is present.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "..", "dist");

const root = await import(path.join(dist, "index.mjs"));
const login = await import(path.join(dist, "login.mjs"));
const aiSdk = await import(path.join(dist, "ai-sdk.mjs"));

assert.equal(typeof root.createChatGPTAuth, "function", "subauth exposes createChatGPTAuth");
assert.equal(typeof root.createCodexFetch, "function", "subauth exposes createCodexFetch");
assert.equal(typeof root.fileTokenStore, "function", "subauth exposes fileTokenStore");
assert.equal(typeof root.providerOf, "function", "subauth exposes providerOf");
assert.equal(typeof login.loginWithBrowser, "function", "subauth/login exposes loginWithBrowser");
assert.equal(
  typeof aiSdk.createChatGPTOpenAIProvider,
  "function",
  "subauth/ai-sdk exposes createChatGPTOpenAIProvider",
);

function importsOf(file) {
  const source = readFileSync(path.join(dist, file), "utf8");
  const found = new Set();
  for (const pattern of [
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.add(match[1].replace(/^node:/, ""));
  }
  return found;
}

for (const file of ["index.js", "index.mjs"]) {
  const imports = importsOf(file);
  assert.equal(imports.has("http"), false, `${file} must not import http`);
  assert.equal(imports.has("child_process"), false, `${file} must not import child_process`);
  assert.equal(
    readFileSync(path.join(dist, file), "utf8").includes("@ai-sdk"),
    false,
    `${file} must not reference @ai-sdk`,
  );
}

// Negative control: the assertions above must be capable of failing.
for (const file of ["login.js", "login.mjs"]) {
  const imports = importsOf(file);
  assert.equal(imports.has("http"), true, `${file} is expected to import http`);
  assert.equal(imports.has("child_process"), true, `${file} is expected to import child_process`);
}

console.log("AC2 OK: three entries resolved via ESM, root entry free of http/child_process/@ai-sdk");
