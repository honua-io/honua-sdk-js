import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import { parse } from "yaml";

const workflow = parse(fs.readFileSync(new URL("../../.github/workflows/publish-js-sdk.yml", import.meta.url), "utf8"));
const steps = workflow.jobs["publish-js-packages"].steps;
const publish = steps.find((step) => step.name === "Publish split packages").run;
const summary = steps.find((step) => step.name === "Publish summary").run;
const packages = ["honua-sdk", "honua-sdk-esri-compat", "honua-react", "honua-geometry", "honua-app-platform"];

// Execute the actual workflow shell with an offline npm double. Model the two
// destructive operations that caused the regression, and reject missing inputs
// at pack/publish time instead of merely asserting command order in the YAML.
const npmDouble = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [command, target, ...args] = process.argv.slice(2);
const packages = ${JSON.stringify(packages)};
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const manifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
fs.appendFileSync('calls.jsonl', JSON.stringify({command, target, args}) + '\\n');
if (command === 'run') {
  switch (target) {
    case 'security:binary-artifacts': break;
    case 'verify:client-pair':
      fs.rmSync('dist', { recursive: true, force: true });
      if (process.env.FAIL_CLIENT_PAIR === 'true') process.exit(1);
      break;
    case 'verify:migration-cohort:prepared':
      if (process.env.FAIL_MIGRATION_COHORT === 'true') process.exit(1);
      break;
    case 'build:split-packages:prepared':
      fs.rmSync('dist', { recursive: true, force: true });
      for (const name of packages) {
        write('dist/packages/' + name + '/package.json', JSON.stringify({name, version: '0.1.0-beta.0'}));
      }
      break;
    case 'verify:browser:prepared': write('dist/browser/index.js', '// browser'); break;
    case 'verify:runtime-tarball':
      assert.ok(fs.existsSync('dist/browser/index.js'));
      for (const name of packages) manifest('dist/packages/' + name);
      if (process.env.FAIL_RUNTIME_TARBALL === 'true') process.exit(1);
      break;
    case 'verify:publish-surface':
    case 'verify:packed-sdk':
      assert.ok(fs.existsSync('dist/browser/index.js'));
      for (const name of packages) manifest('dist/packages/' + name);
      break;
    default: throw new Error('Unexpected script: ' + target);
  }
} else if (command === 'pack') {
  const pkg = manifest(target);
  const filename = pkg.name + '.tgz';
  const destination = args[args.indexOf('--pack-destination') + 1];
  write(path.join(destination, filename), JSON.stringify(pkg));
  console.log(JSON.stringify([{ filename }]));
} else if (command === 'view') {
  process.exit(1); // Unpublished version: exercise the real publish branch.
} else if (command === 'publish') {
  assert.equal(args.includes('--dry-run'), process.env.DRY_RUN === 'true');
  assert.ok(path.isAbsolute(target), 'every publish must use a preserved tarball (the attested subject)');
  const published = JSON.parse(fs.readFileSync(target)).name;
  if (published === '@honua/sdk-js') {
    assert.ok(fs.existsSync('dist/browser/index.js'));
    fs.rmSync('dist/packages', { recursive: true, force: true });
  } else {
    assert.ok(packages.includes(published));
  }
} else throw new Error('Unexpected command: ' + command);
`;

for (const dryRun of [true, false]) {
  it(`publishes all split tarballs after dist cleanup (dry run: ${dryRun})`, (t) => {
    const { run, calls, root: fixtureRoot } = fixture(t, dryRun);
    const result = run(publish);
    assert.equal(result.status, 0, result.stderr);
    const recorded = calls();
    const runtimeChecks = recorded.filter((call) => call.command === "run" && call.target === "verify:runtime-tarball");
    assert.equal(runtimeChecks.length, 1, "runtime tarball verification must run exactly once");
    assert.ok(recorded.indexOf(runtimeChecks[0]) < recorded.findIndex((call) => call.command === "publish"));
    assert.deepEqual(calls().filter((call) => call.command === "publish").map((call) => path.basename(call.target)),
      ["sdk-js.tgz", ...packages.map((name) => `${name}.tgz`)]);
    // The root tarball is packed after the browser bundle is rebuilt, so it
    // carries the same files the old directory publish did.
    const rootPack = recorded.findIndex((call) => call.command === "pack" && call.target === ".");
    assert.ok(rootPack > recorded.findIndex((call) => call.command === "run" && call.target === "verify:packed-sdk"));
    const published = path.join(fixtureRoot(), "runner temp", "published-npm");
    if (dryRun) {
      assert.equal(fs.readFileSync(path.join(published, "published.tsv"), "utf8"), "");
    } else {
      const rows = fs.readFileSync(path.join(published, "published.tsv"), "utf8").trim().split("\n").map((row) => row.split("\t"));
      assert.deepEqual(rows.map(([name]) => name), ["@honua/sdk-js", ...packages]);
      for (const [, version, file] of rows) {
        assert.equal(version, "0.1.0-beta.0");
        assert.ok(fs.existsSync(path.join(published, file)), `${file} must be retained for attestation`);
      }
    }
    if (dryRun) {
      // GitHub starts a new shell for the summary; only RUNNER_TEMP persists.
      const result = run(summary);
      assert.equal(result.status, 0, result.stderr);
      for (const name of packages) assert.ok(result.stdout.includes(`${name}.tgz`));
    }
  });
}

it("stops before publishing when client-pair verification fails", (t) => {
  const { run, calls } = fixture(t, false, true);
  assert.notEqual(run(publish).status, 0);
  assert.equal(calls().some((call) => call.command === "publish"), false);
});

it("stops before any package publication when migration cohort verification fails", (t) => {
  const { run, calls } = fixture(t, false, false, false, true);
  assert.notEqual(run(publish).status, 0);
  assert.equal(calls().filter((call) => call.target === "verify:migration-cohort:prepared").length, 1);
  assert.equal(calls().some((call) => call.command === "publish"), false);
});

for (const dryRun of [true, false]) {
  it(`stops before publishing when runtime tarball verification fails (dry run: ${dryRun})`, (t) => {
    const { run, calls } = fixture(t, dryRun, false, true);
    assert.notEqual(run(publish).status, 0);
    const recorded = calls();
    assert.equal(recorded.filter((call) => call.command === "run" && call.target === "verify:runtime-tarball").length, 1);
    assert.equal(recorded.some((call) => call.command === "publish"), false);
    assert.equal(recorded.some((call) => call.command === "run" && call.target === "verify:packed-sdk"), false);
  });
}

function fixture(t, dryRun, failClientPair = false, failRuntimeTarball = false, failMigrationCohort = false) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publish-sdk-workflow-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixtureRoot, "bin"));
  fs.mkdirSync(path.join(fixtureRoot, "scripts"));
  fs.writeFileSync(path.join(fixtureRoot, "scripts/sample-contract.mjs"), "");
  fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "@honua/sdk-js", version: "0.1.0-beta.0" }));
  const npm = path.join(fixtureRoot, "bin/npm");
  const scriptPath = path.join(fixtureRoot, "workflow.sh");
  fs.writeFileSync(scriptPath, "", { mode: 0o755 });
  fs.writeFileSync(npm, `#!/usr/bin/env node\n${npmDouble}`, { mode: 0o755 });
  return {
    run: (script) => {
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${path.join(fixtureRoot, "bin")}${path.delimiter}${process.env.PATH}`,
        PINNED_NPM: npm,
        RUNNER_TEMP: path.join(fixtureRoot, "runner temp"),
        DRY_RUN: String(dryRun),
        FAIL_CLIENT_PAIR: String(failClientPair),
        FAIL_RUNTIME_TARBALL: String(failRuntimeTarball),
        FAIL_MIGRATION_COHORT: String(failMigrationCohort),
        ACTIONS_ID_TOKEN_REQUEST_URL: "offline-fixture",
      },
      });
    },
    calls: () => fs.readFileSync(path.join(fixtureRoot, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
    root: () => fixtureRoot,
  };
}

for (const availableAfter of [17 * 60, Infinity]) {
  it(`registry verification waits for propagation and fails closed (available after ${availableAfter}s)`, () => {
    const verify = workflow.jobs["verify-published-release"].steps
      .find((step) => step.name === "Verify registry versions, integrity, provenance, and source SHA").run;
    const clock = `
      SECONDS=0
      calls=0
      node() { calls=$((calls + 1)); (( SECONDS >= ${Number.isFinite(availableAfter) ? availableAfter : 99999} )); }
      sleep() { SECONDS=$((SECONDS + $1)); }
      trap 'echo "clock=$SECONDS calls=$calls"' EXIT
    `;
    // Write the clock stub and the workflow step to a script file. A dynamic
    // `bash -c` string is rejected by the test-build owner: it cannot prove the
    // command does not compile the SDK. The file launch is the same shape the
    // publish fixture above already uses.
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-registry-verify-"));
    const scriptPath = path.join(scriptDir, "verify.sh");
    fs.writeFileSync(scriptPath, clock + verify, { mode: 0o755 });
    let result;
    try {
      result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
        encoding: "utf8", env: { ...process.env, RELEASE_TAG: "js-sdk-v0.1.14", SEALED_COMMIT: "a".repeat(40), PUBLISH_REF: "refs/tags/js-sdk-v0.1.14" },
      });
    } finally {
      fs.rmSync(scriptDir, { recursive: true, force: true });
    }
    assert.equal(result.status, Number.isFinite(availableAfter) ? 0 : 1, result.stderr);
    const elapsed = Number(/clock=([0-9]+)/u.exec(result.stdout)[1]);
    assert.ok(elapsed >= (Number.isFinite(availableAfter) ? availableAfter : 45 * 60));
    assert.ok(elapsed <= 45 * 60);
  });
}

it("attests every package this workflow publishes, from this workflow's own identity", () => {
  const job = workflow.jobs["attest-published-packages"];
  assert.deepEqual(job.needs, "publish-js-packages");
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write", attestations: "write" });
  // The collector names publish-js-sdk.yml as the exact signer workflow, so the
  // attestation must be produced inline (a composite action), never through a
  // reusable workflow whose own path would become the signer identity.
  assert.equal(job.uses, undefined);
  assert.deepEqual(job.strategy.matrix.package, ["@honua/sdk-js", ...packages.map((name) => `@honua/${name.replace(/^honua-/u, "")}`)]);
  const attest = job.steps.find((step) => step.uses === "./.github/actions/attest-npm-tarball");
  assert.equal(attest.if, "steps.select.outputs.published == 'true'");
  const upload = steps.find((step) => step.name === "Upload the exact published tarballs for attestation");
  assert.equal(upload.with.name, job.steps.find((step) => step.name === "Download the published tarballs").with.name);

  const action = parse(fs.readFileSync(new URL("../../.github/actions/attest-npm-tarball/action.yml", import.meta.url), "utf8"));
  const uses = action.runs.steps.map((step) => step.uses).filter(Boolean);
  for (const ref of uses) assert.match(ref, /@[0-9a-f]{40}$/u, `${ref} must be pinned by SHA`);
  assert.ok(uses.some((ref) => ref.startsWith("actions/attest-build-provenance@")));
  assert.ok(uses.some((ref) => ref.startsWith("actions/attest-sbom@")));
  const sbom = action.runs.steps.find((step) => step.uses?.startsWith("anchore/sbom-action@"));
  // actions/attest types SPDX as .../Document/v2.3, which the collector does not accept.
  assert.equal(sbom.with.format, "cyclonedx-json");
  const verify = action.runs.steps.findIndex((step) => step.name === "Verify the registry serves these exact bytes");
  assert.ok(verify >= 0 && verify < action.runs.steps.findIndex((step) => step.uses?.startsWith("actions/attest-build-provenance@")));
});
