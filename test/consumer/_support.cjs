"use strict";
/**
 * Shared support for the consumer checks that touch real credentials.
 *
 * Two of these checks (AC8, AC9) read the Codex CLI's live `auth.json`, so they
 * need guarantees the others do not: nothing runs against a real session unless
 * it was asked for, and no copy of that session outlives the process.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Set to `1` to let AC8/AC9 run against the Codex login on this machine. */
const LIVE_ENV = "SUBAUTH_LIVE_CODEX";

/**
 * True only when the operator opted in explicitly.
 *
 * The default has to be "skip". `pnpm verify` is the documented entry point for
 * anyone who clones this repository, and a stranger running it must not have
 * their own ChatGPT session read, copied, or handed to a `codex` subprocess.
 */
function liveCodexEnabled() {
  return process.env[LIVE_ENV] === "1";
}

/**
 * A temp directory that no ordinary exit path can leak.
 *
 * These checks copy live credentials, so a leaked directory is a leaked token.
 * `finally` does not cover `process.exit()` — it skips the block outright — and
 * it never runs for a signal, which terminates the process without unwinding.
 * Registering on `exit` covers both, once each signal is turned into a normal
 * exit.
 *
 * SIGKILL and `process.abort()` remain uncoverable by any handler — neither can
 * be trapped, and both were observed leaving the copy behind. That residual gap
 * is the second reason the checks that copy credentials are opt-in.
 */
function scratchDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  const remove = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // An exit handler that throws would replace the real failure with this one.
    }
  };

  process.on("exit", remove);
  // 128 + signal number, the conventional exit code for a signalled process.
  // SIGQUIT is here because Ctrl-\ is a key a person can actually hit, and its
  // default action dumps core without unwinding — leaving the credential copy
  // behind exactly like SIGKILL, but for a reason that is trivially preventable.
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  process.on("SIGHUP", () => process.exit(129));
  process.on("SIGQUIT", () => process.exit(131));

  return dir;
}

module.exports = { LIVE_ENV, liveCodexEnabled, scratchDir };
