import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatBaselineReport,
  percentile,
  projectShardedCost,
  summarizeRun,
  summarizeRuns,
} from "../../scripts/lib/ci-timing-baseline.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = "docs/evidence/ci-timing-baseline.v1.json";

function job(name, minutes, { startOffset = 0, conclusion = "success" } = {}) {
  const start = Date.UTC(2026, 7, 16, 12, 0, 0) + startOffset * 60_000;
  return {
    name,
    conclusion,
    startedAt: new Date(start).toISOString(),
    completedAt: new Date(start + minutes * 60_000).toISOString(),
  };
}

describe("run summarization", () => {
  it("separates what a reviewer waits for from what the run costs", () => {
    const summary = summarizeRun({
      runId: 1,
      conclusion: "success",
      jobs: [job("JS SDK", 38), job("MCP SDK", 3), job("PR Fast", 2)],
    });
    assert.equal(summary.criticalPathMinutes, 38);
    assert.equal(summary.wallClockMinutes, 38);
    assert.equal(summary.billedMinutes, 43);
  });

  it("does not let a job dispatched hours later masquerade as a slow critical path", () => {
    // The publication job on a trunk run starts long after the rest finish. It
    // stretches the elapsed span without anyone having waited for it, which is
    // exactly why the critical path is the headline number.
    const summary = summarizeRun({
      runId: 2,
      conclusion: "success",
      jobs: [job("JS SDK", 20), job("Publish", 1, { startOffset: 600 })],
    });
    assert.equal(summary.criticalPathMinutes, 20);
    assert.equal(summary.wallClockMinutes, 601);
    assert.equal(summary.billedMinutes, 21);
  });

  it("ignores jobs with no usable timestamps rather than counting them as instant", () => {
    const summary = summarizeRun({
      runId: 3,
      conclusion: "success",
      jobs: [job("JS SDK", 10), { name: "Queued", conclusion: null, startedAt: null, completedAt: null }],
    });
    assert.equal(summary.jobCount, 1);
    assert.equal(summary.billedMinutes, 10);
  });

  it("drops runs that never really executed", () => {
    const summary = summarizeRuns([
      { runId: 1, conclusion: "success", jobs: [job("JS SDK", 10)] },
      { runId: 2, conclusion: "cancelled", jobs: [job("JS SDK", 1)] },
      { runId: 3, conclusion: "failure", jobs: [job("JS SDK", 30)] },
    ]);
    assert.equal(summary.sampleSize, 2);
    assert.deepEqual(
      summary.runs.map((run) => run.runId),
      ["1", "3"],
    );
  });
});

describe("percentiles", () => {
  it("uses nearest rank, so no value is invented between samples", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(values, 0.5), 5);
    assert.equal(percentile(values, 0.9), 9);
    assert.equal(percentile(values, 1), 10);
    assert.equal(percentile([], 0.5), undefined);
    assert.equal(percentile([7], 0.9), 7);
  });
});

describe("sharding projection", () => {
  it("trades billed minutes for critical path and says so in both directions", () => {
    const projected = projectShardedCost({
      baselineJobs: [
        { name: "JS SDK", p90: 38 },
        { name: "MCP SDK", p90: 3 },
      ],
      replaced: "JS SDK",
      replacements: [
        { name: "verify-core", share: 0.4 },
        { name: "verify-package", share: 0.25 },
        { name: "browser-map", share: 0.35 },
      ],
      setupMinutes: 1,
    });
    // Critical path falls to the largest slice; billed minutes rise by one
    // runner setup per added job. A projection that only showed the first half
    // would be an advertisement.
    assert.equal(projected.wallClockMinutes, 38 * 0.4 + 1);
    assert.ok(projected.billedMinutes > 38 + 3);
  });

  it("refuses to project against a job that is not in the baseline", () => {
    assert.throws(
      () => projectShardedCost({ baselineJobs: [{ name: "MCP SDK", p90: 3 }], replaced: "JS SDK", replacements: [] }),
      /No baseline job named JS SDK/,
    );
  });
});

describe("the committed ci.yml baseline", () => {
  const document = JSON.parse(fs.readFileSync(path.join(root, BASELINE_PATH), "utf8"));

  it("is a real sample large enough to compare against", () => {
    assert.equal(document.format, "honua.ci-timing-baseline.v1");
    assert.equal(document.workflow, "ci.yml");
    assert.equal(document.event, "pull_request");
    // AC-1 asks for at least 30 representative pull-request runs.
    assert.ok(document.runs.length >= 30, `expected >= 30 baseline runs, found ${document.runs.length}`);
  });

  it("re-derives the same summary offline, so the report needs no credentials", () => {
    const recomputed = summarizeRuns(document.runs);
    assert.equal(recomputed.sampleSize, document.summary.sampleSize);
    assert.equal(recomputed.criticalPath.p90, document.summary.criticalPath.p90);
    assert.equal(recomputed.billed.p90, document.summary.billed.p90);
    assert.match(formatBaselineReport(recomputed), /\| Critical path \(min\) \|/u);
  });

  it("shows the monolithic JS SDK job dominating the critical path", () => {
    const summary = summarizeRuns(document.runs);
    const [slowest] = summary.jobs;
    assert.equal(slowest.name, "JS SDK");
    // The premise of #1286: one job owns essentially the whole wait, so any
    // late failure in it invalidates everything else.
    assert.ok(
      slowest.p90 >= summary.criticalPath.p90 * 0.95,
      "the JS SDK job should account for the run's critical path",
    );
  });
});
