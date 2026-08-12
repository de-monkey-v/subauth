#!/usr/bin/env node
/**
 * AC7 — the delivery mechanism itself: installing from a git tag produces a
 * working package with no build step.
 *
 * This is the one check that exercises how consumers actually get this code.
 * Everything else runs against the working tree, where `dist/` exists because
 * the last build left it there. Here the tag is cut, installed into a throwaway
 * project with `--ignore-scripts`, and imported — which is what proves the
 * committed `dist/` is doing its job, since pnpm's build-script policy cannot be
 * relied on to run a `prepare` step.
 *
 * The tag is cut in a throwaway clone, never in the repository under check.
 * `pnpm verify` is the documented entry point for anyone who clones this
 * project, and a check that writes refs into their repository to test itself is
 * not read-only in any sense they would expect.
 *
 * Skipped when the working tree is dirty: an uncommitted change would not be in
 * the tag, so the result would describe something other than what ships.
 */
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { scratchDir } = require("./_support.cjs");

const repo = path.resolve(__dirname, "..", "..");
const TAG = "subauth-install-check";

const work = scratchDir("subauth-ac7-");
const clone = path.join(work, "clone");
const project = path.join(work, "project");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

try {
  const dirty = git(repo, ["status", "--porcelain"]);
  if (dirty) {
    console.log("AC7 SKIPPED: working tree is dirty, so a tag would not describe what ships");
    process.exit(0);
  }

  // `--no-hardlinks` gives the clone its own object store, so nothing this
  // check does — including the tag — can reach back into the source repository.
  execFileSync("git", ["clone", "--no-hardlinks", "--quiet", repo, clone], { encoding: "utf8" });
  // `-f` because a clone copies the source's tags: a leftover scratch tag from
  // an older revision of this check would otherwise make it fail every run.
  git(clone, ["tag", "-f", TAG]);

  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ name: "tag-consumer", private: true, version: "1.0.0" }),
  );

  // --ignore-scripts is the point: nothing may need to build at install time.
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", `git+file://${clone}#${TAG}`],
    { cwd: project, stdio: "pipe", encoding: "utf8", timeout: 180_000 },
  );

  const installed = path.join(project, "node_modules", "subauth");
  assert.ok(fs.existsSync(path.join(installed, "dist", "index.js")), "dist/index.js was installed");
  assert.ok(fs.existsSync(path.join(installed, "dist", "index.mjs")), "dist/index.mjs was installed");
  assert.ok(fs.existsSync(path.join(installed, "dist", "index.d.ts")), "types were installed");
  assert.ok(fs.existsSync(path.join(installed, "login", "package.json")), "node10 shims shipped");

  // The tag has to carry the API the README documents, not merely *an* API.
  // A tag whose `dist/` predates an exported symbol installs cleanly and then
  // hands the reader `undefined` at the first line of the documented example.
  const probe = path.join(project, "probe.cjs");
  fs.writeFileSync(
    probe,
    [
      'const { createChatGPTAuth, memoryTokenStore, createCodexFetch, codexAuthStore } = require("subauth");',
      'const { loginWithBrowser } = require("subauth/login");',
      'const { createChatGPTOpenAIProvider } = require("subauth/ai-sdk");',
      'if (typeof createChatGPTAuth !== "function") throw new Error("root entry broken");',
      'if (typeof codexAuthStore !== "function") throw new Error("codexAuthStore missing from the tag");',
      'if (typeof loginWithBrowser !== "function") throw new Error("login entry broken");',
      'if (typeof createChatGPTOpenAIProvider !== "function") throw new Error("ai-sdk entry broken");',
      "const auth = createChatGPTAuth({ store: memoryTokenStore(null) });",
      'if (auth.status().exists !== false) throw new Error("unexpected session");',
      'if (typeof createCodexFetch(auth) !== "function") throw new Error("codex fetch broken");',
      'console.log("AC7 OK: installed from a git tag with --ignore-scripts and ran");',
    ].join("\n"),
  );

  process.stdout.write(
    execFileSync(process.execPath, [probe], { cwd: project, stdio: "pipe", encoding: "utf8" }),
  );
} catch (error) {
  // `message` first and always: it names the command that failed. Leading with
  // the child's output hides that, and npm writes warnings to stderr on every
  // run, so a failure elsewhere reports itself as a stray deprecation notice.
  const detail = [error.message, error.stdout, error.stderr]
    .filter((part) => part && String(part).trim())
    .join("\n---\n");
  console.error("AC7 FAILED:", detail.slice(0, 2000));
  process.exitCode = 1;
}
