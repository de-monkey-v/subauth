#!/usr/bin/env node
/**
 * AC13 — two writers that share a process id must not clobber each other.
 *
 * The atomic write names its temp file after the pid. Worker threads share one,
 * so two workers persisting the same store would write the same temp path: one
 * overwrites the other's bytes, or the second rename finds the file already
 * gone and fails. Either way a rotated refresh token is lost, which costs a
 * login — and pids are the one thing a "unique per writer" scheme cannot lean
 * on inside a single process.
 *
 * Workers rather than child processes on purpose: separate processes have
 * distinct pids and would pass against the very code this checks.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");

const { scratchDir } = require("./_support.cjs");

const work = scratchDir("subauth-ac13-");
const target = path.join(work, "tokens.json");

const WORKERS = 8;
const WRITES = 40;

const body = `
const { workerData, parentPort } = require("node:worker_threads");
const { fileTokenStore } = require(workerData.pkg);
const store = fileTokenStore(workerData.target);
let failures = 0;
for (let i = 0; i < workerData.writes; i++) {
  try {
    store.write({
      access: "access-" + workerData.id + "-" + i,
      refresh: "refresh-" + workerData.id + "-" + i,
      accountId: "acct-1",
      expires: Date.now() + 3600_000,
    });
  } catch (error) {
    failures++;
    parentPort.postMessage({ error: String(error && error.message) });
  }
}
parentPort.postMessage({ done: true, failures });
`;

const runner = path.join(work, "worker.cjs");
fs.writeFileSync(runner, body);

async function main() {
  const pkg = require.resolve("../../dist/index.js");
  const errors = [];

  const results = await Promise.all(
    Array.from({ length: WORKERS }, (_, id) => {
      const worker = new Worker(runner, {
        workerData: { pkg, target, id, writes: WRITES },
      });
      return new Promise((resolve, reject) => {
        worker.on("message", (msg) => {
          if (msg.error) errors.push(msg.error);
          if (msg.done) resolve(msg);
        });
        worker.on("error", reject);
      }).finally(() => worker.terminate());
    }),
  );

  const failures = results.reduce((sum, r) => sum + r.failures, 0);
  assert.equal(
    failures,
    0,
    `every write succeeded; ${failures} failed, first: ${errors[0] || "(none)"}`,
  );

  // The file must still be a complete, readable record — not a half-written one.
  const { fileTokenStore } = require("../../dist/index.js");
  const final = fileTokenStore(target).read();
  assert.notEqual(final, null, "the store is still readable after concurrent writes");
  assert.match(final.access, /^access-\d+-\d+$/, "the surviving record is one writer's, intact");

  const leftovers = fs.readdirSync(work).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], `no temp files survived, found: ${leftovers.join(", ")}`);

  console.log(
    `AC13 OK: ${WORKERS} workers sharing one pid wrote ${WORKERS * WRITES} times with no loss`,
  );
}

main().catch((error) => {
  console.error("AC13 FAILED:", error && error.message);
  process.exitCode = 1;
});
