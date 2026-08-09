import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DERIVED_ARTIFACT_REGEN_MARKER,
  evaluateDerivedArtifactTip,
} from "../../scripts/lib/derived-artifact-loop-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function graph(commits) {
  return (revision) => commits.get(revision);
}

describe("derived-artifact loop guard", () => {
  it("regenerates a flattened marker commit because it has no second-parent chain", () => {
    const decision = evaluateDerivedArtifactTip({
      firstParent: "base",
      secondParent: "",
      readCommit: graph(new Map()),
    });

    assert.equal(decision.skip, false);
    assert.match(decision.reason, /not an ancestry-preserving regeneration merge/u);
  });

  it("skips a clean merge whose generated chain is based on its first parent", () => {
    const commits = new Map([
      ["generated-2", { subject: `${DERIVED_ARTIFACT_REGEN_MARKER} (evidence)`, parent: "generated-1" }],
      ["generated-1", { subject: `${DERIVED_ARTIFACT_REGEN_MARKER} for base`, parent: "base" }],
      ["base", { subject: "feat: source change", parent: "older" }],
    ]);
    const decision = evaluateDerivedArtifactTip({
      firstParent: "base",
      secondParent: "generated-2",
      readCommit: graph(commits),
    });

    assert.equal(decision.skip, true);
    assert.match(decision.reason, /2-commit regeneration chain/u);
  });

  it("regenerates when the generated chain was cut from an older trunk tip", () => {
    const commits = new Map([
      ["generated", { subject: `${DERIVED_ARTIFACT_REGEN_MARKER} for old-base`, parent: "old-base" }],
      ["old-base", { subject: "feat: older source", parent: "root" }],
    ]);
    const decision = evaluateDerivedArtifactTip({
      firstParent: "new-base",
      secondParent: "generated",
      readCommit: graph(commits),
    });

    assert.equal(decision.skip, false);
    assert.match(decision.reason, /older trunk tip/u);
  });

  it("always regenerates when a release-matrix receipt is supplied", () => {
    const decision = evaluateDerivedArtifactTip({
      releaseMatrixReceiptRunId: "30717444073",
      firstParent: "base",
      secondParent: "generated",
      readCommit: () => ({ subject: DERIVED_ARTIFACT_REGEN_MARKER, parent: "base" }),
    });

    assert.equal(decision.skip, false);
    assert.match(decision.reason, /release-matrix receipt/u);
  });

  it("wires the tested guard into the regeneration workflow", () => {
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows/regenerate-derived-artifacts.yml"),
      "utf8",
    );

    assert.match(workflow, /node scripts\/check-derived-artifact-tip\.mjs/u);
    assert.doesNotMatch(workflow, /subject="\$\(git log -1 --format=%s\)"/u);
  });

  it("stages and publishes every current sample projection atomically", () => {
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows/regenerate-derived-artifacts.yml"),
      "utf8",
    );
    const stage = workflow.slice(
      workflow.indexOf("- name: Stage and commit resealed evidence locally"),
      workflow.indexOf("- name: Verify regenerated artifacts strictly"),
    );
    const publish = workflow.slice(
      workflow.indexOf("- name: Validate and publish regeneration commits"),
      workflow.indexOf("- name: Dispatch strict CI for regeneration PR"),
    );

    for (const generatedPath of [
      "docs/generated/sample-catalog.md",
      "samples/contract/v2/consumer-fixtures/honua-site-consumer.v4.json",
    ]) {
      assert.match(stage, new RegExp(generatedPath.replaceAll(".", "\\."), "u"));
      assert.match(publish, new RegExp(generatedPath.replaceAll(".", "\\."), "u"));
    }
  });

  it("prunes superseded runs after projection generation and before strict staging", () => {
    const workflow = fs.readFileSync(
      path.join(root, ".github/workflows/regenerate-derived-artifacts.yml"),
      "utf8",
    );
    const generate = workflow.indexOf("- name: Regenerate sample dist projections");
    const prune = workflow.indexOf(
      "- name: Prune superseded golden evidence runs after projection rollover",
    );
    const stage = workflow.indexOf("- name: Stage and commit resealed evidence locally");

    assert.ok(generate >= 0 && generate < prune && prune < stage);
    assert.match(workflow.slice(prune, stage), /pruneUnreferencedEvidenceRuns/u);
    assert.match(workflow.slice(prune, stage), /journey\.status === "qualified"/u);
  });
});
