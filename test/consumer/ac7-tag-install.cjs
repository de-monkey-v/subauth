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
 * Skipped when the working tree is dirty: an uncommitted change would not be in
 * the tag, so the result would describe something other than what ships.
 */
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const TAG = "subauth-install-check";

function git(args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", ...options }).trim();
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "subauth-ac7-"));
let tagged = false;

try {
  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    console.log("AC7 SKIPPED: working tree is dirty, so a tag would not describe what ships");
    process.exit(0);
  }

  git(["tag", "-f", TAG]);
  tagged = true;

  fs.writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ name: "tag-consumer", private: true, version: "1.0.0" }),
  );

  // --ignore-scripts is the point: nothing may need to build at install time.
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", `git+file://${repo}#${TAG}`],
    { cwd: work, stdio: "pipe", encoding: "utf8", timeout: 180_000 },
  );

  const installed = path.join(work, "node_modules", "subauth");
  assert.ok(fs.existsSync(path.join(installed, "dist", "index.js")), "dist/index.js was installed");
  assert.ok(fs.existsSync(path.join(installed, "dist", "index.mjs")), "dist/index.mjs was installed");
  assert.ok(fs.existsSync(path.join(installed, "dist", "index.d.ts")), "types were installed");
  assert.ok(fs.existsSync(path.join(installed, "login", "package.json")), "node10 shims shipped");

  const probe = path.join(work, "probe.cjs");
  fs.writeFileSync(
    probe,
    [
      'const { createChatGPTAuth, memoryTokenStore, createCodexFetch } = require("subauth");',
      'const { loginWithBrowser } = require("subauth/login");',
      'const { createChatGPTOpenAIProvider } = require("subauth/ai-sdk");',
      'if (typeof createChatGPTAuth !== "function") throw new Error("root entry broken");',
      'if (typeof loginWithBrowser !== "function") throw new Error("login entry broken");',
      'if (typeof createChatGPTOpenAIProvider !== "function") throw new Error("ai-sdk entry broken");',
      "const auth = createChatGPTAuth({ store: memoryTokenStore(null) });",
      'if (auth.status().exists !== false) throw new Error("unexpected session");',
      'if (typeof createCodexFetch(auth) !== "function") throw new Error("codex fetch broken");',
      'console.log("AC7 OK: installed from a git tag with --ignore-scripts and ran");',
    ].join("\n"),
  );

  process.stdout.write(
    execFileSync(process.execPath, [probe], { cwd: work, stdio: "pipe", encoding: "utf8" }),
  );
} catch (error) {
  const detail = error.stdout || error.stderr || error.message;
  console.error("AC7 FAILED:", String(detail).slice(0, 2000));
  process.exitCode = 1;
} finally {
  if (tagged) {
    try {
      git(["tag", "-d", TAG]);
    } catch {
      // Leaving a scratch tag behind is not worth failing the check over.
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
}
