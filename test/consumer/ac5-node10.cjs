#!/usr/bin/env node
/**
 * AC5 — compile and run a node10/CommonJS consumer against the built package.
 *
 * The fixture is installed the way a real consumer would be (a node_modules
 * entry pointing at the package root) rather than through tsconfig `paths`,
 * because what is under test is precisely whether node10 resolution — which
 * ignores the exports map — finds the package through main/module/types and
 * the subpath directory shims.
 */
"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..", "..");
const fixture = path.join(__dirname, "node10");
const tsc = path.join(packageRoot, "node_modules", ".bin", "tsc");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "subauth-ac5-"));

try {
  assert.ok(fs.existsSync(tsc), "typescript must be installed to run this check");

  fs.copyFileSync(path.join(fixture, "tsconfig.json"), path.join(work, "tsconfig.json"));
  fs.copyFileSync(path.join(fixture, "consumer.ts"), path.join(work, "consumer.ts"));
  fs.writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ name: "node10-consumer", private: true, version: "1.0.0" }),
  );

  fs.mkdirSync(path.join(work, "node_modules"), { recursive: true });
  fs.symlinkSync(packageRoot, path.join(work, "node_modules", "subauth"), "dir");
  // @types/node has to be resolvable from the fixture, as it is for a real consumer.
  fs.symlinkSync(
    path.join(packageRoot, "node_modules", "@types"),
    path.join(work, "node_modules", "@types"),
    "dir",
  );

  execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: work, stdio: "pipe", encoding: "utf8" });

  const output = execFileSync(process.execPath, [path.join(work, "out", "consumer.js")], {
    cwd: work,
    stdio: "pipe",
    encoding: "utf8",
  });

  assert.match(output, /AC5 OK/, "the compiled consumer ran successfully");
  process.stdout.write(output);
} catch (error) {
  const detail = error.stdout || error.stderr || error.message;
  console.error("AC5 FAILED:", String(detail).slice(0, 2000));
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
