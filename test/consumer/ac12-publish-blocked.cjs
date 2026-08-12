#!/usr/bin/env node
/**
 * AC12 — publishing to a registry is blocked, and nothing reaches the network.
 *
 * "Not published to npm, by design" was enforced by nothing but the absence of
 * npm credentials on one machine. Publishing is the one mistake here that cannot
 * be undone: npm's unpublish window is 72 hours, and a package that hands
 * strangers a one-line way to route requests through a personal subscription is
 * the pattern providers act against first.
 *
 * Two guards, because each covers the other's gap:
 *   - `private: true` — npm refuses before the upload, and neither `--force` nor
 *     `--ignore-scripts` skips the check. It is not evaluated by `--dry-run`.
 *   - a failing `prepublishOnly` — refuses `--dry-run` too, but is skippable
 *     with `--ignore-scripts`.
 *
 * Each is therefore isolated, not just exercised together: npm runs the hook
 * first, so a run with both present says nothing about `private`.
 *
 * Two oracles, because either alone can be satisfied by a broken harness. The
 * registry's own record of PUT requests carries the real claim — nothing left
 * the machine, which only the receiving end can attest — but zero PUTs is also
 * what a publish that died of a bad auth flag looks like, so each case also
 * names the refusal it expects. The negative control publishes the same package
 * with both guards removed and requires the upload to arrive.
 *
 * The registry runs in a *separate process* on purpose. `execFileSync` blocks
 * the calling thread's event loop, so a server hosted in this process could
 * never answer the packument lookup npm makes before uploading, and npm would
 * hang until its own timeout rather than reaching either guard.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { scratchDir } = require("./_support.cjs");

const repo = path.resolve(__dirname, "..", "..");
const work = scratchDir("subauth-ac12-");

/** Blocks without a busy loop; the harness has nothing else to do meanwhile. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const server = path.join(work, "registry.cjs");
fs.writeFileSync(
  server,
  `"use strict";
const http = require("node:http"), fs = require("node:fs");
const state = process.argv[2];
let puts = 0;
http.createServer((req, res) => {
  if (req.method === "PUT") fs.writeFileSync(state + ".puts", String(++puts));
  req.resume();
  req.on("end", () => {
    // 404 on a packument lookup is "no such package yet", which lets npm proceed
    // to the upload it is about to be refused for.
    if (req.method === "GET") { res.writeHead(404, {"content-type":"application/json"}); res.end("{}"); }
    else { res.writeHead(201, {"content-type":"application/json"}); res.end("{}"); }
  });
}).listen(0, "127.0.0.1", function () {
  fs.writeFileSync(state + ".port", String(this.address().port));
});`,
);

const state = path.join(work, "registry");
const child = spawn(process.execPath, [server, state], { stdio: "ignore", detached: true });
child.unref();

/** A publishable copy of this package, with `mutate` applied to its manifest. */
function stage(name, mutate) {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  mutate(manifest);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, "dist", "index.js"), "module.exports = {};\n");
  return dir;
}

function puts() {
  const file = `${state}.puts`;
  return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
}

try {
  let port;
  for (let waited = 0; waited < 10_000 && !port; waited += 50) {
    if (fs.existsSync(`${state}.port`)) port = fs.readFileSync(`${state}.port`, "utf8").trim();
    else sleepSync(50);
  }
  assert.ok(port, "the throwaway registry started");

  const registry = `http://127.0.0.1:${port}/`;
  const publish = (dir, extra = []) =>
    spawnSync(
      "npm",
      [
        "publish",
        dir,
        "--registry",
        registry,
        `--//127.0.0.1:${port}/:_authToken=ac12-unused`,
        "--fetch-retries=0",
        ...extra,
      ],
      { encoding: "utf8", stdio: "pipe", timeout: 120_000 },
    );

  const real = stage("guarded", (m) => {
    assert.equal(m.private, true, "package.json carries private: true");
    assert.ok(m.scripts.prepublishOnly, "package.json defines a prepublishOnly guard");
  });

  // Each case names the refusal it expects. "exited non-zero" would pass for a
  // publish that died of a bad auth flag before reaching either guard, which is
  // exactly how a silently dead guard would look.
  const refusals = [
    ["the manifest as shipped", real, [], /EPRIVATE|never published to a registry/i],
    // `--ignore-scripts` skips the hook, so this isolates `private`.
    ["with the hook skipped", real, ["--ignore-scripts"], /EPRIVATE/],
    // `private` is not evaluated for a dry run in npm 11.6.2 — the check lives
    // inside `libnpmpublish`, which a dry run does not call — so this is the
    // hook's case. The regex still admits EPRIVATE because that placement is
    // npm's private business and case 4 isolates the hook without relying on it.
    ["as a dry run", real, ["--dry-run"], /EPRIVATE|never published to a registry/i],
    // And this isolates the hook again, with `private` deleted outright.
    [
      "without the private field",
      stage("hook-only", (m) => {
        delete m.private;
        m.name = "subauth-ac12-hook-only";
      }),
      [],
      /never published to a registry/i,
    ],
  ];

  for (const [label, dir, extra, expected] of refusals) {
    const attempt = publish(dir, extra);
    const said = `${attempt.stdout || ""}${attempt.stderr || ""}`;
    assert.notEqual(attempt.status, 0, `publishing ${label} was refused`);
    assert.match(said, expected, `publishing ${label} was refused for the right reason`);
    assert.equal(puts(), 0, `nothing was uploaded when publishing ${label}`);
  }

  // --- negative control: with both guards gone, the upload must arrive ------
  const control = publish(stage("control", (m) => {
    delete m.private;
    delete m.scripts.prepublishOnly;
    m.name = "subauth-ac12-control";
  }));
  assert.equal(
    puts(),
    1,
    `the unguarded control never uploaded, so this check proves nothing: ` +
      `${(control.stderr || "").slice(-300)}`,
  );

  console.log("AC12 OK: both guards refuse and no upload leaves the machine; the control uploads");
} catch (error) {
  console.error("AC12 FAILED:", error && error.message);
  process.exitCode = 1;
} finally {
  try {
    process.kill(child.pid);
  } catch {
    // The registry is a detached child of a process that is exiting anyway.
  }
}
