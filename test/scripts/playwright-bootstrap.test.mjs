import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const readWorkflow = name => parse(readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const workflow = readWorkflow("sdk-verification.yml");
const ciWorkflow = readWorkflow("ci.yml");
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
    const packages = args.includes('webkit') ? 'libwoff1 libgstreamer1.0-0' : 'libnss3 libatk-bridge2.0-0';
    console.log('sh -c "apt-get update && apt-get install -y --no-install-recommends ' + packages + '"');
  }
  process.exit(0);
}
if (tool !== 'apt-get') process.exit(0);
fs.appendFileSync(process.env.FAKE_APT_LOG, JSON.stringify(args)+'\n');
const sources = args.find(arg => arg.startsWith('Dir::Etc::sourceparts='))?.split('=').slice(1).join('=');
if (!sources || !args.includes('Dir::Etc::sourcelist=/dev/null')) { console.error('Microsoft vendor feed: 403 Forbidden'); process.exit(100); }
if (process.env.FAKE_APT_MODE === 'private-temp') {
  for (let directory = sources; ; directory = path.dirname(directory)) {
    if ((fs.statSync(directory).mode & 0o001) === 0) {
      console.error('Downloading mirror file failed: directory is not searchable by _apt');
      process.exit(100);
    }
    if (directory === path.dirname(directory)) break;
  }
}
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

function verificationStep(job) {
  const name = job === "quickstart-budget" ? "Provision Playwright operating-system dependencies" : "Install Playwright browser";
  const expected = ["scripts/ci/provision-playwright-deps.sh"];
  if (job !== "quickstart-budget") expected.push("npx playwright install chromium");
  return { run: workflow.jobs[job].steps.find(step => step.name === name).run, expected, browser: [] };
}

function firstMapWebKitStep() {
  const run = ciWorkflow.jobs["first-map-webkit"].steps.find(step => step.name === "Install Playwright browser")?.run ?? "";
  const expected = ["scripts/ci/provision-playwright-deps.sh webkit", "npx playwright install webkit"];
  return { run, expected, browser: ["webkit"] };
}

function runStep(step, mode = "ok") {
  const directory = mkdtempSync(path.join(tmpdir(), "sdk-browser-apt-"));
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  for (const name of ["sudo", "npx", "apt-get", "dpkg", "sleep"]) {
    writeFileSync(path.join(bin, name), fakeTools, { mode: 0o755 });
  }
  const sources = path.join(directory, "ubuntu.sources");
  writeFileSync(sources, "Types: deb\nURIs: https://archive.ubuntu.com/ubuntu\nSuites: noble\nComponents: main universe\nSigned-By: /ubuntu-keyring\n");
  const log = path.join(directory, "apt.log");
  try {
    assert.deepEqual(step.run.trim().split("\n").map(line => line.trim()).filter(Boolean), step.expected);
    const result = spawnSync("bash", ["scripts/ci/provision-playwright-deps.sh", ...step.browser], {
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
    const { result, calls } = runStep(verificationStep(job));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.some(args => args.includes("install")));
  });
}

test("First Map WebKit provisions WebKit's own libraries through the bounded Ubuntu installer", () => {
  const { result, calls } = runStep(firstMapWebKitStep());
  assert.equal(result.status, 0, result.stderr);
  assert.ok(calls.some(args => args.includes("install") && args.includes("libwoff1")));
});

test("First Map WebKit outlives three bounded dependency attempts before its journey runs", () => {
  const minutes = ciWorkflow.jobs["first-map-webkit"]["timeout-minutes"];
  assert.ok(minutes >= 30, `timeout-minutes ${minutes} cancels the job inside the provisioning retries`);
});

test("an Ubuntu mirror failure is retried using the same isolated signed sources", () => {
  const { result, calls } = runStep(verificationStep("verify-package"), "retry");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls.filter(args => args.includes("update")).length, 2);
  assert.match(result.stdout, /attempt 1 failed with status 100/);
});

test("a cold package index is given longer than the minute that dies on its last file", () => {
  const script = readFileSync(path.join(root, "scripts/ci/provision-playwright-deps.sh"), "utf8");
  const update = script.match(/timeout --kill-after=10s (\d+)s apt-get "\$\{apt_options\[@\]\}" update/);
  assert.ok(update, "apt-get update must stay under the root timeout");
  assert.ok(Number(update[1]) >= 90, `update timeout ${update[1]}s ends before a cold index finishes`);
});

test("a sustained Ubuntu outage fails closed after three bounded attempts", () => {
  const { result, calls } = runStep(verificationStep("verify-package"), "down");
  assert.notEqual(result.status, 0);
  assert.equal(calls.filter(args => args.includes("update")).length, 3);
  assert.equal(calls.some(args => args.includes("install")), false);
});

test("apt's sandbox can traverse its state beneath a private runner temporary directory", () => {
  const { result } = runStep(verificationStep("verify-package"), "private-temp");
  assert.equal(result.status, 0, result.stderr);
});
