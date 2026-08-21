#!/usr/bin/env node
/**
 * AC14 — the token file reaches the disk, not just the page cache.
 *
 * `writeFileSync` returning means the bytes are in the page cache; renaming an
 * unsynced temp file can publish a name that resolves to zero bytes after a
 * crash. `codexAuthStore` writes the file the Codex CLI is *also* using, so a
 * truncated write takes the CLI's login — and any API key sharing that file —
 * down with the app's. No unit test can see this.
 *
 * Both stores are checked. `fileTokenStore` owns its file; `codexAuthStore`
 * shares one. The shared one is the reason this property matters, so a check
 * that only drives the private store would stay green through exactly the
 * regression worth catching.
 *
 * Two parts per store, because the interesting observable needs a tracer that
 * not every machine has:
 *
 *   Part 1 always runs. Pure Node: a colliding temp path must be refused
 *   (O_EXCL), the published file must round-trip at mode 0600, and no temp may
 *   be left holding a plaintext token. If `dist/` is missing or the write
 *   throws, this fails — the check can never report "not observable" for a
 *   reason that is actually a broken build.
 *
 *   Part 2 needs `strace`: openat(tmp,…O_EXCL…,0600) -> fsync(tmp) -> rename
 *   -> fsync(dir). Skipped only when strace itself could not run, which is
 *   decided by strace's own diagnostics *and* an empty trace — strace reports
 *   the tracee's exit code, so a status alone says nothing.
 *
 * Every step is matched by path, not by shape: "an fsync of something ending
 * in .tmp" and "an fsync after the rename" are both satisfiable by an
 * unrelated process, and an fsync of the *renamed file* is not an fsync of the
 * directory that now holds its name. strace prints path arguments as the
 * program passed them and `-y` annotations resolved, so both spellings of the
 * directory are accepted.
 */
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { scratchDir } = require("./_support.cjs");

const DIST = path.resolve(__dirname, "../../dist/index.js");
const scratch = scratchDir("ac14-");
// A tracer must not measure a process someone else preloaded into.
const CLEAN_ENV = { ...process.env, NODE_OPTIONS: "" };

const partial = [];
let tracedCalls = 0;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (p) => `${b64({ alg: "none" })}.${b64(p)}.signature`;
const EXP = Math.floor(Date.now() / 1000) + 3600;

const STORES = [
  {
    name: "fileTokenStore",
    factory: "fileTokenStore",
    tokens: { access: "a", refresh: "r", expires: EXP * 1000 },
    // The private store writes the token record verbatim.
    check: (file, t) => assert.deepEqual(JSON.parse(file), t, "the published file is not what was written"),
    // This store's `clear()` removes the file rather than rewriting it, so its
    // durable step is the directory flush *after* the unlink. Without that
    // flush a logout the user watched succeed can come back after a power cut,
    // resurrecting a refresh token they revoked on purpose. A store whose
    // write survives a crash and whose logout does not is not one guarantee.
    // The first login has no previous record to carry forward, so the store's
    // own reader cannot stand in for the format: it would accept a file the
    // CLI rejects.
    firstCheck: (file, t) => assert.deepEqual(JSON.parse(file), t, "the first login did not write the token record"),
    clearSteps: ["unlink", "fsync-dir"],
    clearCheck: (target, dir, name) => {
      assert.equal(fs.existsSync(target), false, `${name}: clear() left the token file behind`);
      assert.deepEqual(fs.readdirSync(dir), [], `${name}: clear() left debris behind`);
    },
    // A prior record, so `write()` and `clear()` both run against an existing
    // session instead of the empty-directory branch.
    seed: { access: "old-a", refresh: "old-r", expires: (EXP - 1) * 1000 },
  },
  {
    name: "codexAuthStore",
    factory: "codexAuthStore",
    tokens: {
      access: jwt({ exp: EXP, chatgpt_account_id: "acct" }),
      refresh: "r",
      // A real exchange fills this in from the response's own claims
      // (`src/protocol.ts`), and the first login has no previous record to fall
      // back on — a fixture without it would let the store drop account_id on
      // exactly the write that cannot be retried.
      accountId: "acct",
      idToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
      expires: EXP * 1000,
    },
    // The shared store writes the CLI's own shape and must keep fields it does
    // not own — that is what "in-place" means.
    check: (file, t) => {
      const parsed = JSON.parse(file);
      assert.equal(parsed.auth_mode, "chatgpt", "the CLI's auth_mode was not written");
      assert.equal(parsed.tokens.access_token, t.access, "the access token did not round-trip");
      assert.equal(parsed.tokens.refresh_token, t.refresh, "the refresh token did not round-trip");
      assert.equal(parsed.OPENAI_API_KEY, "sk-foreign", "a top-level field the store does not own was dropped");
      assert.equal(parsed.tokens.unknown_cli_field, "keep-me", "a field inside `tokens` that the store does not own was dropped");
      assert.equal(parsed.tokens.account_id, "acct", "the CLI's account_id was dropped");
      assert.equal(parsed.tokens.id_token, t.idToken, "the id_token did not round-trip");
      assert.equal(typeof parsed.last_refresh, "string", "last_refresh was not written");
    },
    // `clear()` rewrites the same shared file, so it needs the same durability.
    // It runs automatically when a refresh token turns out to be revoked —
    // dying midway there would truncate the CLI's login and the API key beside
    // it, from a path that is already handling a failure.
    // `read()` recovers account_id from a JWT claim and never looks at
    // auth_mode, so the store's own reader accepts a first login the CLI cannot
    // use. This file's format belongs to the CLI, not to us.
    firstCheck: (file, t) => {
      const parsed = JSON.parse(file);
      assert.equal(parsed.auth_mode, "chatgpt", "the first login did not write auth_mode — the CLI would not see a ChatGPT session");
      assert.equal(parsed.tokens.account_id, "acct", "the first login did not write the CLI's account_id");
      assert.equal(parsed.tokens.access_token, t.access, "the first login's access token did not round-trip");
      assert.equal(parsed.tokens.refresh_token, t.refresh, "the first login's refresh token did not round-trip");
      assert.equal(parsed.tokens.id_token, t.idToken, "the first login's id_token did not round-trip");
      assert.equal(typeof parsed.last_refresh, "string", "the first login did not write last_refresh");
    },
    clearSteps: ["open-tmp", "fsync-file", "rename", "fsync-dir"],
    clearCheck: (target, dir, name) => {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
      assert.equal(parsed.tokens, null, `${name}: clear() did not drop the session`);
      assert.equal(parsed.OPENAI_API_KEY, "sk-foreign", `${name}: clear() dropped a field the store does not own`);
      assert.equal(parsed.auth_mode, undefined, `${name}: clear() left auth_mode next to a null session`);
      assert.equal(fs.statSync(target).mode & 0o777, 0o600, `${name}: clear() left the file at the wrong mode`);
      assert.deepEqual(fs.readdirSync(dir), ["auth.json"], `${name}: clear() left temp debris`);
    },
    // The shape the CLI actually writes, plus fields nothing here owns. A seed
    // without `tokens` would take the "file exists but holds no session" branch
    // and skip the one that runs on every refresh: rewriting a live session in
    // place while carrying the rest of the record forward.
    seed: {
      auth_mode: "chatgpt",
      last_refresh: "2020-01-01T00:00:00.000Z",
      OPENAI_API_KEY: "sk-foreign",
      tokens: {
        access_token: jwt({ exp: EXP - 1, chatgpt_account_id: "acct" }),
        refresh_token: "old-refresh",
        id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }),
        account_id: "acct",
        unknown_cli_field: "keep-me",
      },
    },
  },
];

const escape = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function runNode(file, args = []) {
  return spawnSync(process.execPath, [file, ...args], { encoding: "utf8", env: CLEAN_ENV });
}

// strace prints an argument path as the program spelled it and a `-y` fd
// annotation resolved, so the same directory arrives under two names. Compare
// ancestors by identity, not by spelling.
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function runner(body) {
  const file = path.join(scratch, `r-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(file, body);
  return file;
}

for (const store of STORES) {
  // ------------------------------------------------------------- Part 1
  // Observe the open flags directly. Asserting EEXIST on a pre-created temp
  // path would really be asserting *how the temp name is derived* — a probe
  // that fails on a `randomUUID` refactor, and that would freeze "refuse on
  // collision" as the only allowed behaviour if someone later added a retry.
  // The property is O_EXCL; interposing on `fs.openSync` observes it.
  const flagDir = path.join(scratch, `${store.name}-flags`);
  const flagTarget = path.join(flagDir, "auth.json");
  fs.mkdirSync(flagDir, { recursive: true, mode: 0o700 });
  if (store.seed) fs.writeFileSync(flagTarget, JSON.stringify(store.seed), { mode: 0o600 });

  const flags = runNode(
    runner(
      `const fs = require("node:fs");
       const realOpen = fs.openSync, realRename = fs.renameSync;
       const opens = [], renames = [];
       fs.openSync = (p, f, m) => { if (String(p).endsWith(".tmp")) opens.push({ p: String(p), f, m }); return realOpen(p, f, m); };
       fs.renameSync = (a, b) => { renames.push({ from: String(a), to: String(b) }); return realRename(a, b); };
       const { ${store.factory} } = require(${JSON.stringify(DIST)});
       ${store.factory}(${JSON.stringify(flagTarget)}).write(${JSON.stringify(store.tokens)});
       console.log(JSON.stringify({ opens, renames }));`,
    ),
  );
  assert.equal(flags.status, 0, `${store.name}: the flag probe did not run: ${flags.stderr || flags.error}`);
  const { opens, renames } = JSON.parse(flags.stdout.trim().split("\n").pop());
  assert.ok(opens.length > 0, `${store.name}: no temp file was opened — the write did not go through a temp+rename`);
  for (const { f, m } of opens) {
    // "wx" is the string form of O_WRONLY|O_CREAT|O_EXCL; a numeric flag is
    // accepted too so a refactor to constants does not fail for being tidy.
    const exclusive = typeof f === "string" ? /x/.test(f) : Boolean(f & fs.constants.O_EXCL);
    assert.ok(exclusive, `${store.name}: the temp file was opened without O_EXCL (flags ${JSON.stringify(f)})`);
    assert.equal(m, 0o600, `${store.name}: the temp file was not created at mode 0600 (got ${m})`);
  }
  // Observing an exclusive open somewhere is not the property. The file that
  // gets published has to be *that* file, arriving by rename — otherwise a
  // decoy temp beside a plain in-place write satisfies every flag assertion
  // while the shared credential is still overwritten in place.
  const realFlagTarget = fs.realpathSync(flagTarget);
  const published = renames.find((r) => r.to === flagTarget || r.to === realFlagTarget);
  assert.ok(
    published,
    `${store.name}: nothing was renamed onto the target — the write did not publish atomically (renames: ${JSON.stringify(renames)})`,
  );
  const exclusiveTemps = new Set(opens.map((o) => o.p));
  assert.ok(
    exclusiveTemps.has(published.from),
    `${store.name}: the published file did not come from the exclusively-created temp (renamed ${published.from}, opened ${[...exclusiveTemps].join(", ")})`,
  );
  // The name the store actually chose — so the collision probe below occupies
  // the real path instead of assuming how it is derived.
  const observedTemp = published.from;

  // Separately: a temp path that already exists must not be disturbed, and a
  // failed write must leave the target as it was. This is about not damaging
  // someone else's in-flight write — a different property from O_EXCL, and one
  // that stays true whether the store refuses or retries.
  const dir = path.join(scratch, `${store.name}-collide`);
  const target = path.join(dir, "auth.json");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (store.seed) fs.writeFileSync(target, JSON.stringify(store.seed), { mode: 0o600 });

  const collided = runNode(
    runner(
      `const crypto = require("node:crypto");
       const fixed = Buffer.alloc(8, 0xab);
       crypto.randomBytes = () => fixed;
       const fs = require("node:fs");
       const { ${store.factory} } = require(${JSON.stringify(DIST)});
       const store = ${store.factory}(${JSON.stringify(target)});
       store.write(${JSON.stringify(store.tokens)});
       const tmp = ${JSON.stringify(target)} + "." + process.pid + "." + fixed.toString("hex") + ".tmp";
       // Report whether the store actually chose this name, so "the probe could
       // not construct a collision" is distinguishable from "the store did not
       // detect one".
       const before = fs.readFileSync(${JSON.stringify(target)}, "utf8");
       fs.writeFileSync(tmp, "someone else's in-flight write", { mode: 0o600 });
       const realOpen2 = fs.openSync;
       let chosen = null;
       fs.openSync = (p, f, m) => { if (String(p).endsWith(".tmp")) chosen = String(p); return realOpen2(p, f, m); };
       let code = null;
       try { store.write(${JSON.stringify(store.tokens)}); } catch (e) { code = (e && e.code) || "threw"; }
       console.log(JSON.stringify({
         code,
         collisionConstructed: chosen === tmp || code !== null,
         foreign: fs.existsSync(tmp) ? fs.readFileSync(tmp, "utf8") : null,
         targetIntact: fs.readFileSync(${JSON.stringify(target)}, "utf8") === before,
       }));`,
    ),
  );
  assert.equal(collided.status, 0, `${store.name}: the collision probe did not run: ${collided.stderr || collided.error}`);
  const seen = JSON.parse(collided.stdout.trim().split("\n").pop());
  // Distinguish "the probe could not construct a collision" from "the store
  // mishandled one" — the temp naming scheme is the probe's assumption, not
  // the store's contract.
  assert.ok(
    seen.collisionConstructed,
    `${store.name}: the probe never collided with the store's temp path (it chose a different name) — this says nothing about the store, but the collision assertions below did not run`,
  );
  assert.equal(seen.foreign, "someone else's in-flight write", `${store.name}: the other writer's temp file was modified`);
  if (seen.code !== null) {
    assert.equal(seen.targetIntact, true, `${store.name}: the write failed but the target changed anyway`);
  }

  // A plain write must round-trip, land at 0600, and leave nothing behind.
  const plainDir = path.join(scratch, `${store.name}-store`);
  const plainTarget = path.join(plainDir, "auth.json");
  if (store.seed) {
    fs.mkdirSync(plainDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(plainTarget, JSON.stringify(store.seed), { mode: 0o600 });
  }
  const plain = runNode(
    runner(
      `const { ${store.factory} } = require(${JSON.stringify(DIST)});\n` +
        `${store.factory}(${JSON.stringify(plainTarget)}).write(${JSON.stringify(store.tokens)});\n`,
    ),
  );
  assert.equal(plain.status, 0, `${store.name}: the write did not run: ${plain.stderr || plain.error}`);
  store.check(fs.readFileSync(plainTarget, "utf8"), store.tokens);
  // The stores guard "read accepts exactly what write produced" in three
  // places; checking raw JSON fields alone would not notice them drifting.
  const roundTrip = runNode(
    runner(
      `const { ${store.factory} } = require(${JSON.stringify(DIST)});\n` +
        `const s = ${store.factory}(${JSON.stringify(plainTarget)});\n` +
        `console.log(JSON.stringify({ exists: s.exists(), access: (s.read() || {}).access }));\n`,
    ),
  );
  assert.equal(roundTrip.status, 0, `${store.name}: the read-back probe did not run: ${roundTrip.stderr}`);
  const back = JSON.parse(roundTrip.stdout.trim().split("\n").pop());
  assert.equal(back.exists, true, `${store.name}: the store does not consider its own write a usable session`);
  assert.equal(back.access, store.tokens.access, `${store.name}: read() did not return what write() stored`);
  assert.equal(fs.statSync(plainTarget).mode & 0o777, 0o600, `${store.name}: the published file is not 0600`);
  assert.deepEqual(fs.readdirSync(plainDir), ["auth.json"], `${store.name}: temp debris was left behind`);

  // The first login writes into a directory that does not exist yet. Every
  // other case here starts from a seeded file, so without this one nothing
  // exercises the mkdir — and by the time it runs the caller has already spent
  // its single-use authorization code, so an ENOENT costs the whole login
  // rather than a retry. The oracle is the store's own `read()`, not `check`,
  // because `check` asserts fields that only a seeded file carries.
  const freshTarget = path.join(scratch, `${store.name}-first`, "nested", "auth.json");
  const first = runNode(
    runner(
      `const { ${store.factory} } = require(${JSON.stringify(DIST)});\n` +
        `const s = ${store.factory}(${JSON.stringify(freshTarget)});\n` +
        `s.write(${JSON.stringify(store.tokens)});\n` +
        `console.log(JSON.stringify({ exists: s.exists(), access: (s.read() || {}).access }));\n`,
    ),
  );
  assert.equal(
    first.status,
    0,
    `${store.name}: the first login into a directory that does not exist failed: ${first.stderr || first.error}`,
  );
  store.firstCheck(fs.readFileSync(freshTarget, "utf8"), store.tokens);
  const firstSeen = JSON.parse(first.stdout.trim().split("\n").pop());
  assert.equal(firstSeen.exists, true, `${store.name}: the first login did not produce a usable session`);
  assert.equal(firstSeen.access, store.tokens.access, `${store.name}: the first login's access token did not round-trip`);
  assert.equal(
    fs.statSync(freshTarget).mode & 0o777,
    0o600,
    `${store.name}: the first login left the file readable by others`,
  );
  assert.equal(
    fs.statSync(path.dirname(freshTarget)).mode & 0o777,
    0o700,
    `${store.name}: the directory the first login created is readable by others`,
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(freshTarget)),
    ["auth.json"],
    `${store.name}: the first login left temp debris behind`,
  );

  // `clear()` rewrites the same shared file — it runs automatically when a
  // refresh token turns out to be revoked, so a half-written clear truncates
  // the CLI's login and the API key beside it. Everything that needs no tracer
  // is checked here, before any strace runs.
  let clearCase = null;
  if (store.clearCheck) {
    const clearDir = path.join(scratch, `${store.name}-clear`);
    const clearTarget = path.join(clearDir, "auth.json");
    fs.mkdirSync(clearDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(clearTarget, JSON.stringify(store.seed), { mode: 0o600 });
    const cleared = runNode(
      runner(
        `const { ${store.factory} } = require(${JSON.stringify(DIST)});\n` +
          `${store.factory}(${JSON.stringify(clearTarget)}).clear();\n`,
      ),
    );
    assert.equal(cleared.status, 0, `${store.name}: clear() did not run: ${cleared.stderr || cleared.error}`);
    store.clearCheck(clearTarget, clearDir, store.name);
    clearCase = { label: "clear", dir: `${store.name}-clear-traced`, call: `.clear()`, steps: store.clearSteps };
  }

  // ------------------------------------------------------------- Part 2
  // One traced pipeline, used for every call that rewrites the file. Having a
  // second, looser oracle for `clear()` is how the ordering requirement — the
  // whole point — went unchecked there while `write()` looked strict.
  const cases = [
    {
      label: "write",
      dir: `${store.name}-traced`,
      call: `.write(${JSON.stringify(store.tokens)})`,
      steps: ["open-tmp", "fsync-file", "rename", "fsync-dir"],
    },
    {
      // A directory is named by its parent, so a new subtree needs every level
      // flushed in the level above it. Two levels are created here, so two
      // ancestor flushes follow the one on the directory holding the file.
      label: "first-login",
      dir: path.join(`${store.name}-first-traced`, "nested"),
      call: `.write(${JSON.stringify(store.tokens)})`,
      seedless: true,
      steps: ["open-tmp", "fsync-file", "rename", "fsync-dir"],
      // Named, not counted. Flushing the top of the subtree twice and the
      // directory that names the token's own directory never would produce the
      // same *number* of ancestor flushes as doing it right.
      ancestorDirs: [`${store.name}-first-traced`, "."],
    },
  ];
  if (clearCase) cases.push(clearCase);

  for (const c of cases) {
    tracedCalls += 1;
    const caseDir = path.join(scratch, c.dir);
    const caseTarget = path.join(caseDir, "auth.json");
    if (store.seed && !c.seedless) {
      fs.mkdirSync(caseDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(caseTarget, JSON.stringify(store.seed), { mode: 0o600 });
    }
    const traceFile = path.join(scratch, `${store.name}-${c.label}-trace.txt`);
    const tracedRunner = runner(
      `const { ${store.factory} } = require(${JSON.stringify(DIST)});\n` +
        `${store.factory}(${JSON.stringify(caseTarget)})${c.call};\n`,
    );

    // `-e trace=` validates names per architecture, so a name this machine does
    // not have rejects the whole filter and Part 2 vanishes into PARTIAL. arm64
    // has neither `rename` nor `unlink` — glibc issues `renameat2`/`unlinkat`
    // there — so every name that is not universal carries `?`. `openat` and
    // `fsync` stay bare because they exist on every Linux architecture, and a
    // rejection of either means the filter is wrong — the check below fails on
    // that instead of reporting it as an untraceable environment.
    const traced = spawnSync(
      "strace",
      ["-f", "-y", "-e", "trace=openat,fsync,?rename,?renameat,?renameat2,?unlink,?unlinkat", "-o", traceFile, process.execPath, tracedRunner],
      { encoding: "utf8", env: CLEAN_ENV },
    );

    const raw = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
    // strace reports the tracee's exit code, so a status alone says nothing
    // about whether tracing worked. Its own failures happen before the tracee
    // runs, leaving the trace empty; requiring both keeps a tracee that merely
    // prints "strace:" from being mistaken for a tracer that could not start.
    const tracedNothing = !/\b(openat|fsync|rename|unlink)/.test(raw);
    const stderr = (traced.stderr || "").trim();
    const straceComplained =
      Boolean(traced.error) || stderr.split("\n").some((line) => line.startsWith("strace:"));

    // A name this strace rejects satisfies "complained and traced nothing"
    // exactly like a missing tracer does, so a filter we got wrong would take
    // all of Part 2 with it and report PARTIAL. That is this check's bug, not
    // the machine's limitation — split it out before the skip.
    assert.ok(
      !/invalid system call/.test(stderr),
      `${store.name}/${c.label}: strace rejected the syscall filter — the filter is wrong, this is not an untraceable environment: ${stderr}`,
    );
    if (straceComplained && tracedNothing) {
      const why = traced.error ? traced.error.message : stderr.split("\n").find((l) => l.startsWith("strace:"));
      partial.push(`${store.name}/${c.label}: ${why}`);
      continue;
    }
    assert.equal(traced.status, 0, `${store.name}/${c.label}: the traced call failed: ${stderr}`);

    // strace splits a call across a context switch into "<unfinished ...>" and
    // a later "<... name resumed>" on the same pid, sometimes hundreds of lines
    // apart. The halves have to be paired by pid and syscall name; deleting the
    // markers would join unrelated lines instead.
    const pending = new Map();
    const merged = [];
    for (const line of raw.split("\n")) {
      const suspended = /^(\d+)\s+(\w+)\((.*?)\s*<unfinished \.\.\.>$/.exec(line);
      if (suspended) {
        pending.set(`${suspended[1]}:${suspended[2]}`, `${suspended[1]} ${suspended[2]}(${suspended[3]}`);
        continue;
      }
      const resumed = /^(\d+)\s+<\.\.\. (\w+) resumed>(.*)$/.exec(line);
      if (resumed) {
        const head = pending.get(`${resumed[1]}:${resumed[2]}`);
        if (head !== undefined) {
          pending.delete(`${resumed[1]}:${resumed[2]}`);
          merged.push(head + resumed[3]);
        }
        continue;
      }
      merged.push(line);
    }

    // strace prints path *arguments* as the program passed them and `-y` fd
    // annotations resolved, so a symlinked TMPDIR yields both spellings.
    const realDir = fs.realpathSync(caseDir);
    const prefixes = [`${path.join(caseDir, "auth.json")}.`, `${path.join(realDir, "auth.json")}.`];
    const dirs = new Set([caseDir, realDir]);
    const realScratch = fs.realpathSync(scratch);
    const ancestors = new Set();
    for (const base of [caseDir, realDir]) {
      let current = path.dirname(base);
      while (current !== path.dirname(current)) {
        ancestors.add(current);
        if (current === scratch || current === realScratch) break;
        current = path.dirname(current);
      }
    }
    const isOurTemp = (q) => prefixes.some((r) => q.startsWith(r)) && q.endsWith(".tmp");
    const isOurTarget = (q) => dirs.has(path.dirname(q)) && path.basename(q) === "auth.json";

    const steps = [];
    for (const line of merged) {
      const opened = /openat\([^"]*"((?:[^"\\]|\\.)*)"/.exec(line);
      const fsynced = /fsync\(\d+<(.*?)>\)/.exec(line);
      const renamed = /\brename(?:at2?)?\((?:.*?)"((?:[^"\\]|\\.)*)"(?:.*?)"((?:[^"\\]|\\.)*)"/.exec(line);
      const unlinked = /\bunlink(?:at)?\((?:.*?)"((?:[^"\\]|\\.)*)"/.exec(line);

      if (opened && isOurTemp(opened[1])) {
        assert.match(line, /O_EXCL/, `${store.name}/${c.label}: the temp file was not created exclusively`);
        assert.match(line, /0600/, `${store.name}/${c.label}: the temp file was not created at mode 0600`);
        steps.push("open-tmp");
      } else if (fsynced && isOurTemp(fsynced[1])) steps.push("fsync-file");
      else if (renamed && isOurTemp(renamed[1]) && isOurTarget(renamed[2])) steps.push("rename");
      else if (unlinked && isOurTarget(unlinked[1])) steps.push("unlink");
      else if (fsynced && dirs.has(fsynced[1])) steps.push("fsync-dir");
      else if (fsynced && ancestors.has(fsynced[1])) steps.push(`fsync-ancestor:${canonical(fsynced[1])}`);
    }

    const expected = [
      ...c.steps,
      ...(c.ancestorDirs || []).map((d) => `fsync-ancestor:${canonical(path.join(scratch, d))}`),
    ];
    assert.deepEqual(
      steps,
      expected,
      `${store.name}/${c.label}: syscall order was ${JSON.stringify(steps)}`,
    );
  }
}

// Claiming a step that was never observed is the failure this check exists to
// prevent, so the summary names only what ran and never drops a reason: one
// unobservable call out of four is a different fact from four out of four.
if (partial.length === tracedCalls) {
  console.log(
    `AC14 PARTIAL: for both stores, write() published by rename from an exclusively-created 0600 temp, the first login ` +
      `wrote the CLI's format into a 0700 directory it created, and clear() left the expected post-state; ` +
      `syscall order not observable here (${partial.join("; ")})`,
  );
} else if (partial.length > 0) {
  console.log(
    `AC14 PARTIAL: syscall order verified for ${tracedCalls - partial.length}/${tracedCalls} traced calls; ` +
      `not observable for ${partial.join("; ")}`,
  );
} else {
  console.log(
    "AC14 OK: both stores — write(), first login and clear(). O_EXCL temp, fsync before rename, fsync on the parent " +
      "directory after it; the first login also flushes every directory it created; fileTokenStore.clear() unlinks " +
      "and then flushes the directory",
  );
}
