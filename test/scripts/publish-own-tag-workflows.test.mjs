import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse } from "yaml";

// Merging an own-tag release starts two publish runs for one version: the tag
// push and the release workflow's dispatch. These tests run the real "Publish
// package" shell against an offline npm double and a verifier double, so the
// already-published path is exercised rather than only read.

const workflows = [
  {
    file: "publish-mcp-server.yml",
    job: "publish-mcp-server",
    artifactId: "mcp-server",
    packageName: "@honua/mcp-server",
    workingDirectory: "mcp",
    version: "0.3.2",
  },
  {
    file: "publish-create-honua-app.yml",
    job: "publish-create-honua-app",
    artifactId: "create-honua-app",
    packageName: "create-honua-app",
    workingDirectory: "packages/create-honua-app",
    version: "0.2.4",
  },
];

const npmDouble = `
const fs = require("node:fs");
const [command, target] = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({ tool: "npm", command, target }) + "\\n");
if (command === "view") process.exit(process.env.ALREADY_PUBLISHED === "true" ? 0 : 1);
if (command === "pack") {
  process.stdout.write(JSON.stringify([{ filename: "package.tgz" }]));
  process.exit(0);
}
process.exit(0);
`;

const verifierDouble = `
import fs from "node:fs";
fs.appendFileSync(process.env.CALLS, JSON.stringify({ tool: "verifier", args: process.argv.slice(2) }) + "\\n");
process.exit(process.env.REGISTRY_COPY_MATCHES === "true" ? 0 : 1);
`;

function loadJob(spec) {
  const workflow = parse(fs.readFileSync(new URL(`../../.github/workflows/${spec.file}`, import.meta.url), "utf8"));
  return { workflow, job: workflow.jobs[spec.job] };
}

function runPublishStep(spec, { alreadyPublished, registryCopyMatches }) {
  const { job } = loadJob(spec);
  const step = job.steps.find((candidate) => candidate.name === "Publish package");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-tag-publish-"));
  const packageDir = path.join(root, step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? ".");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: spec.packageName, version: spec.version }),
  );
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "verify-published-release.mjs"), verifierDouble);
  fs.writeFileSync(path.join(root, "npm-double.cjs"), npmDouble);
  const calls = path.join(root, "calls.jsonl");
  const output = path.join(root, "github-output");
  const tag = `${spec.artifactId}-v${spec.version}`;
  const scriptPath = path.join(root, "publish.sh");
  fs.writeFileSync(scriptPath, step.run, { mode: 0o755 });
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", scriptPath], {
    cwd: packageDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CALLS: calls,
      GITHUB_OUTPUT: output,
      GITHUB_REF_NAME: tag,
      GITHUB_SHA: "a".repeat(40),
      RUNNER_TEMP: root,
      DRY_RUN: "false",
      PINNED_NPM: path.join(root, "npm-double.cjs"),
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.invalid",
      ALREADY_PUBLISHED: String(alreadyPublished),
      REGISTRY_COPY_MATCHES: String(registryCopyMatches),
    },
  });
  const recorded = fs.existsSync(calls)
    ? fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  const outputs = fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "";
  fs.rmSync(root, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout, calls: recorded, outputs, tag };
}

for (const spec of workflows) {
  describe(spec.file, () => {
    it("queues publish runs for the same ref together and dry runs apart from them", () => {
      const { workflow, job } = loadJob(spec);
      const dryRun = /^\$\{\{ (.+) \}\}$/u.exec(job.env.DRY_RUN)[1];
      assert.equal(
        workflow.concurrency?.group,
        `\${{ github.workflow }}-\${{ github.ref }}-\${{ (${dryRun}) && 'dry-run' || 'publish' }}`,
      );
      assert.equal(workflow.concurrency?.["cancel-in-progress"], false);
    });

    it("publishes a version the registry does not have yet", () => {
      const run = runPublishStep(spec, { alreadyPublished: false, registryCopyMatches: false });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(run.calls.some((call) => call.tool === "npm" && call.command === "publish"));
      assert.ok(!run.calls.some((call) => call.tool === "verifier"));
      assert.match(run.outputs, /published=true/u);
    });

    it("ends green on an already-published version only after the registry copy verifies", () => {
      const run = runPublishStep(spec, { alreadyPublished: true, registryCopyMatches: true });
      assert.equal(run.status, 0, run.stderr);
      assert.ok(!run.calls.some((call) => call.tool === "npm" && call.command === "publish"));
      const verification = run.calls.find((call) => call.tool === "verifier");
      assert.ok(verification, "the already-published path must verify the registry copy");
      assert.deepEqual(verification.args.slice(0, 6), [
        "--artifact",
        spec.artifactId,
        "--tag",
        run.tag,
        "--commit",
        "a".repeat(40),
      ]);
      assert.doesNotMatch(run.outputs, /published=true/u);
    });

    it("fails an already-published version whose registry copy does not verify", () => {
      const run = runPublishStep(spec, { alreadyPublished: true, registryCopyMatches: false });
      assert.notEqual(run.status, 0);
      assert.ok(!run.calls.some((call) => call.tool === "npm" && call.command === "publish"));
      assert.ok(run.calls.some((call) => call.tool === "verifier"));
    });
  });
}
