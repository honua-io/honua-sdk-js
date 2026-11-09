import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflow = parse(readFileSync(path.join(root, ".github/workflows/sdk-verification.yml"), "utf8"));
const fakeTools = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (tool === 'sudo') {
  const result = spawnSync(args[0], args.slice(1), {stdio:'inherit'});
  process.exit(result.status ?? 1);
}
if (tool === 'npx') {
  if (args.includes('--dry-run')) {
    console.log('sh -c "apt-get update && apt-get install -y --no-install-recommends libnss3 libatk-bridge2.0-0"');
  } else if (args.includes('--with-deps')) {
    process.exit(spawnSync('apt-get', ['update'], {stdio:'inherit'}).status ?? 1);
  }
  process.exit(0);
}
if (tool !== 'apt-get') process.exit(0);
fs.appendFileSync(process.env.FAKE_APT_LOG, JSON.stringify(args)+'\n');
const sources = args.find(arg => arg.startsWith('Dir::Etc::sourceparts='))?.split('=').slice(1).join('=');
if (!sources) { console.error('Microsoft vendor feed: 403 Forbidden'); process.exit(100); }
const files = fs.readdirSync(sources);
if (files.length !== 1 || !fs.readFileSync(path.join(sources, files[0]), 'utf8').includes('Signed-By: /ubuntu-keyring')) process.exit(101);
if (!args.some(arg => arg.startsWith('Dir::State::lists='))) process.exit(102);
if (args.includes('update')) {
  const countFile = process.env.FAKE_APT_LOG+'.count';
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile)) : 0;
  fs.writeFileSync(countFile, String(count+1));
  if (process.env.FAKE_APT_MODE === 'down' || (process.env.FAKE_APT_MODE === 'retry' && count === 0)) process.exit(100);
}
`;

function runStep(job, mode = "ok") {
  const directory = mkdtempSync(path.join(tmpdir(), "sdk-browser-apt-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  for (const name of ["sudo", "npx", "apt-get", "dpkg", "sleep"]) {
    writeFileSync(path.join(bin, name), fakeTools, { mode: 0o755 });
  }
  const sources = path.join(directory, "ubuntu.sources");
  writeFileSync(sources, "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main universe\nSigned-By: /ubuntu-keyring\n");
  const log = path.join(directory, "apt.log");
  const name = job === "quickstart-budget" ? "Provision Playwright operating-system dependencies" : "Install Playwright browser";
  const script = workflow.jobs[job].steps.find(step => step.name === name).run;
  try {
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: root, encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HONUA_UBUNTU_APT_SOURCES: sources,
        RUNNER_TEMP: directory, FAKE_APT_LOG: log, FAKE_APT_MODE: mode },
    });
    assert.equal(result.error, undefined, String(result.error));
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    return { result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const job of ["verify-package", "browser", "quickstart-budget"]) {
  test(`${job} provisions browsers without contacting an unrelated failing vendor feed`, () => {
    const { result, calls } = runStep(job);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.some(args => args.includes("install")));
  });
}

test("an Ubuntu mirror failure is retried using the same isolated signed sources", () => {
  const { result, calls } = runStep("verify-package", "retry");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.filter(args => args.includes("update")).length, 2);
});

test("a sustained Ubuntu outage fails closed after three bounded attempts", () => {
  const { result, calls } = runStep("verify-package", "down");
  assert.notEqual(result.status, 0);
  assert.equal(calls.filter(args => args.includes("update")).length, 3);
  assert.equal(calls.some(args => args.includes("install")), false);
});
