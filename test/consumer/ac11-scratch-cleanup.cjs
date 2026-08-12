#!/usr/bin/env node
/**
 * AC11 — a check that copies a credential cannot leak it, however it dies.
 *
 * AC8/AC9 copy the live Codex session into a temp directory, so their cleanup is
 * a credential boundary rather than tidiness. `finally` covers neither
 * `process.exit()` (which skips the block outright) nor a signal (which
 * terminates without unwinding), and both had leaked in practice: an early
 * return inside AC8's `try` left a copy of `auth.json` under /tmp on every
 * API-key-mode run.
 *
 * Each exit path runs in a child process, which is the only way to observe what
 * survives the process that created it. The last case is a negative control: the
 * same code with a plain `mkdtempSync` must leak, or this check proves nothing.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const support = require.resolve("./_support.cjs");

/**
 * Runs `body` in a child that first creates a scratch directory and prints it.
 * Returns the directory, so the parent can ask whether it outlived the child.
 */
function childLeaves(body, { guarded = true } = {}) {
  const setup = guarded
    ? `const { scratchDir } = require(${JSON.stringify(support)});
       const dir = scratchDir("subauth-ac11-");`
    : `const os = require("node:os"), p = require("node:path");
       const dir = fs.mkdtempSync(p.join(os.tmpdir(), "subauth-ac11-"));`;

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       ${setup}
       fs.writeFileSync(dir + "/credential", "a-live-token");
       // writeSync, not console.log: a pipe write can be asynchronous, and every
       // case below exits or signals immediately after this line.
       fs.writeSync(1, dir + "\\n");
       try { ${body} } finally { fs.rmSync(dir, { recursive: true, force: true }); }`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );

  const dir = (result.stdout || "").trim().split("\n").pop();
  assert.ok(dir && dir.startsWith("/"), `the child reported its scratch dir, got: ${result.stderr}`);
  return dir;
}

try {
  // 1. Early exit. `finally` is skipped entirely by `process.exit`.
  let dir = childLeaves("process.exit(0);");
  assert.equal(fs.existsSync(dir), false, "an early process.exit() left the credential copy behind");

  // 2. Signals. The default action terminates without unwinding, so only a
  //    handler that converts each into an exit can clean up. SIGQUIT is in the
  //    list because Ctrl-\ is a key a person can actually hit; independent
  //    verification found it leaking while SIGINT and SIGTERM were covered.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
    dir = childLeaves(`process.kill(process.pid, "${signal}");\nsetTimeout(() => {}, 5000);`);
    assert.equal(fs.existsSync(dir), false, `a ${signal} left the credential copy behind`);
  }

  // 3. Uncaught throw. Here `finally` does run, so this asserts the exit handler
  //    does not somehow interfere with the ordinary path.
  dir = childLeaves('throw new Error("boom");');
  assert.equal(fs.existsSync(dir), false, "an uncaught throw left the credential copy behind");

  // 4. Negative control. Without `scratchDir` the same early exit must leak —
  //    otherwise the three assertions above would pass on any implementation.
  dir = childLeaves("process.exit(0);", { guarded: false });
  assert.equal(
    fs.existsSync(dir),
    true,
    "the unguarded control did not leak, so this check cannot detect a regression",
  );
  fs.rmSync(dir, { recursive: true, force: true });

  console.log("AC11 OK: scratch dirs survive no exit path, and the unguarded control still leaks");
} catch (error) {
  console.error("AC11 FAILED:", error && error.message);
  process.exitCode = 1;
}
