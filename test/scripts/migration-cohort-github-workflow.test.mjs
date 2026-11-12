import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN_ENV = "HONUA_MIGRATION_GITHUB_TOKEN";
const TOKEN_VALUE = "${{ github.token }}";
const PACKED_COHORT_STEP = "Verify packed SDK migration cohort with default npm resolution";

function readWorkflow(relativePath) {
  return parseYaml(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

const ci = readWorkflow(".github/workflows/ci.yml");
const graph = readWorkflow(".github/workflows/sdk-verification.yml");
const publish = readWorkflow(".github/workflows/publish-js-sdk.yml");
const pin = readWorkflow(".github/workflows/mcp-pin-live.yml");

function stepRun(step) {
  return typeof step?.run === "string" ? step.run : "";
}

function tokenSteps(document) {
  return Object.values(document.jobs)
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.env?.[TOKEN_ENV] !== undefined);
}

function assertReadOnlyPermissions(permissions, allowedWrite = []) {
  assert.equal(permissions.actions, "read");
  assert.equal(permissions.contents, "read");
  for (const [key, value] of Object.entries(permissions)) {
    if (value !== "write") continue;
    assert.ok(allowedWrite.includes(key), `${key} write is outside the migration read scope`);
  }
}

describe("migration-cohort GitHub reads use a read-only token on that step only", () => {
  it("keeps ci.yml contents-read and grants actions read only on the verifier job", () => {
    assert.equal(ci.permissions.actions, undefined);
    assert.equal(ci.permissions.contents, "read");
    assertReadOnlyPermissions(ci.jobs["js-sdk"].permissions);
    for (const [jobId, job] of Object.entries(ci.jobs)) {
      if (jobId === "js-sdk") continue;
      assert.notEqual(job.permissions?.actions, "read", `${jobId} must not gain actions read for this verifier`);
    }
  });

  it("passes github.token only to the CI packed-cohort step", () => {
    const steps = tokenSteps(ci);
    assert.deepEqual(steps.map((step) => step.name), [PACKED_COHORT_STEP]);
    assert.equal(steps[0].env[TOKEN_ENV], TOKEN_VALUE);
    assert.match(stepRun(steps[0]), /verify:migration-cohort:prepared/u);
  });

  it("keeps the verification graph contents-read and grants actions read only on verify-package", () => {
    assert.equal(graph.permissions.actions, undefined);
    assert.equal(graph.permissions.contents, "read");
    assert.deepEqual(graph.jobs["verify-package"].permissions, { actions: "read", contents: "read" });
    for (const [jobId, job] of Object.entries(graph.jobs)) {
      if (jobId === "verify-package") continue;
      assert.equal(job.permissions, undefined, `${jobId} must not gain actions read for this verifier`);
    }
  });

  it("passes github.token only to the graph packed-cohort step", () => {
    const steps = tokenSteps(graph);
    assert.deepEqual(steps.map((step) => step.name), [PACKED_COHORT_STEP]);
    assert.equal(steps[0].env[TOKEN_ENV], TOKEN_VALUE);
  });

  it("orders the publish cohort ahead of publish and keeps the token off that publish step", () => {
    const publishJob = publish.jobs["publish-js-packages"];
    assertReadOnlyPermissions(publishJob.permissions, ["id-token"]);
    const names = publishJob.steps.map((step) => step.name);
    const prerequisite = names.indexOf("Verify publication prerequisites");
    const cohort = names.indexOf("Verify packed SDK migration cohort");
    const publishStep = names.indexOf("Publish split packages");
    assert.ok(prerequisite >= 0 && prerequisite < cohort && cohort < publishStep);
    assert.equal(publishJob.steps[cohort].env[TOKEN_ENV], TOKEN_VALUE);
    assert.equal(publishJob.steps[publishStep].env?.[TOKEN_ENV], undefined);
    assert.equal(publishJob.steps[publishStep].run.includes("verify:migration-cohort"), false);
    assert.equal(publishJob.steps[prerequisite].env?.[TOKEN_ENV], undefined);
  });

  it("passes github.token only to the published-release cohort step", () => {
    const registryJob = publish.jobs["verify-published-release"];
    assertReadOnlyPermissions(registryJob.permissions);
    const steps = (registryJob.steps ?? []).filter((step) => step.env?.[TOKEN_ENV] !== undefined);
    assert.deepEqual(steps.map((step) => step.name), [
      "Verify installed published migration dependency cohort",
    ]);
    assert.equal(steps[0].env[TOKEN_ENV], TOKEN_VALUE);
    assert.match(stepRun(steps[0]), /verify-migration-cohort\.mjs/u);
  });

  it("passes github.token only to the pin-live registry cohort step", () => {
    assertReadOnlyPermissions(pin.jobs["verify-pin"].permissions);
    const steps = tokenSteps(pin);
    assert.deepEqual(steps.map((step) => step.name), [
      "Verify the published migration cohort and installed forwarding surfaces",
    ]);
    assert.equal(steps[0].env[TOKEN_ENV], TOKEN_VALUE);
    assert.match(stepRun(steps[0]), /verify:migration-cohort:registry/u);
  });

  it("binds every migration token step to github.token and a cohort command", () => {
    const steps = [ci, graph, publish, pin].flatMap((document) => tokenSteps(document));
    for (const step of steps) {
      assert.equal(step.env[TOKEN_ENV], TOKEN_VALUE);
      assert.match(stepRun(step), /migration-cohort/u);
    }
  });

  it("runs from the post-install admission allowlist", () => {
    const steps = graph.jobs.admission.steps;
    const installAt = steps.findIndex((step) => /\bnpm ci\b/u.test(stepRun(step)));
    const policy = steps.find((step) => step.name === "Test verification graph policy");
    assert.ok(policy, "admission must run the verification graph policy suite");
    assert.ok(installAt >= 0 && steps.indexOf(policy) > installAt);
    assert.match(stepRun(policy), /(?:^|\s)test\/scripts\/migration-cohort-github-workflow\.test\.mjs(?:\s|$)/u);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.match(
      manifest.scripts["verify:ci-graph"],
      /(?:^|\s)test\/scripts\/migration-cohort-github-workflow\.test\.mjs(?:\s|$)/u,
    );
  });
});
