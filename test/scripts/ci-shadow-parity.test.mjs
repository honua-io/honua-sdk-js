import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORITATIVE_GATE_JOBS,
  CI_SHADOW_PARITY_FORMAT,
  compareHead,
  compareRuns,
  formatParityReport,
  GRAPH_GATE_JOB,
  NOT_COMPARABLE_REASONS,
  PROMOTION_SAMPLE_THRESHOLD,
  summarizeParity,
} from "../../scripts/lib/ci-shadow-parity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function job(name, conclusion, minutes = 5) {
  const startedAt = "2026-08-17T00:00:00Z";
  const completedAt = new Date(Date.parse(startedAt) + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return { name, conclusion, startedAt, completedAt };
}

function graphRun(conclusion, { runId = 1, headSha = "a".repeat(40), extraJobs = [] } = {}) {
  return {
    runId,
    headSha,
    conclusion,
    jobs: [job("Admission", "success", 0.6), job("SDK build (producer)", "success", 1.4), ...extraJobs, job(GRAPH_GATE_JOB, conclusion, 0.1)],
  };
}

function authoritativeRun(conclusions, { runId = 2, headSha = "a".repeat(40) } = {}) {
  return {
    runId,
    headSha,
    conclusion: Object.values(conclusions).every((value) => value === "success") ? "success" : "failure",
    jobs: [
      job("PR Fast (under 2 minutes)", "success", 1.7),
      job("Deterministic Benchmark Lab", "success", 1.6),
      ...AUTHORITATIVE_GATE_JOBS.map((name) => job(name, conclusions[name], name === "JS SDK" ? 37 : 2.8)),
    ],
  };
}

const bothGreen = { "JS SDK": "success", "MCP SDK": "success" };

describe("a head is comparable only when both workflows decided it", () => {
  it("agrees when both lanes passed the same head", () => {
    const observation = compareHead({
      headSha: "a".repeat(40),
      graphRuns: [graphRun("success")],
      authoritativeRuns: [authoritativeRun(bothGreen)],
    });
    assert.equal(observation.comparable, true);
    assert.equal(observation.agrees, true);
    assert.equal(observation.graph.verdict, "success");
    assert.equal(observation.authoritative.verdict, "success");
  });

  it("agrees when both lanes failed, which is as much parity as both passing", () => {
    const observation = compareHead({
      headSha: "a".repeat(40),
      graphRuns: [graphRun("failure")],
      authoritativeRuns: [authoritativeRun({ "JS SDK": "failure", "MCP SDK": "success" })],
    });
    assert.equal(observation.agrees, true);
  });

  it("records a disagreement when the graph passes a head ci.yml failed", () => {
    const observation = compareHead({
      headSha: "a".repeat(40),
      graphRuns: [graphRun("success")],
      authoritativeRuns: [authoritativeRun({ "JS SDK": "failure", "MCP SDK": "success" })],
    });
    assert.equal(observation.comparable, true);
    assert.equal(observation.agrees, false);
  });

  // A green MCP lane must not mask a red JS lane. The authoritative side is an
  // AND across the jobs the graph proposes to replace, matching the rule the
  // graph's own aggregate applies.
  it("fails the authoritative side when any replaced gate failed", () => {
    const observation = compareHead({
      headSha: "a".repeat(40),
      graphRuns: [graphRun("failure")],
      authoritativeRuns: [authoritativeRun({ "JS SDK": "success", "MCP SDK": "failure" })],
    });
    assert.equal(observation.authoritative.verdict, "failure");
    assert.equal(observation.agrees, true);
  });
});

describe("everything ambiguous is excluded rather than assumed to agree", () => {
  const cases = [
    ["missing-graph-run", { graphRuns: [], authoritativeRuns: [authoritativeRun(bothGreen)] }],
    ["missing-authoritative-run", { graphRuns: [graphRun("success")], authoritativeRuns: [] }],
    [
      "ambiguous-graph-run",
      {
        graphRuns: [graphRun("success", { runId: 1 }), graphRun("failure", { runId: 9 })],
        authoritativeRuns: [authoritativeRun(bothGreen)],
      },
    ],
    [
      "ambiguous-authoritative-run",
      {
        graphRuns: [graphRun("success")],
        authoritativeRuns: [authoritativeRun(bothGreen, { runId: 2 }), authoritativeRun(bothGreen, { runId: 3 })],
      },
    ],
    [
      "graph-gate-missing",
      {
        graphRuns: [{ runId: 1, headSha: "a".repeat(40), conclusion: "success", jobs: [job("Admission", "success")] }],
        authoritativeRuns: [authoritativeRun(bothGreen)],
      },
    ],
    [
      "graph-not-terminal",
      {
        graphRuns: [{ ...graphRun("failure"), jobs: [job(GRAPH_GATE_JOB, "cancelled")] }],
        authoritativeRuns: [authoritativeRun(bothGreen)],
      },
    ],
    [
      "graph-run-cancelled",
      {
        graphRuns: [{ ...graphRun("failure"), conclusion: "cancelled" }],
        authoritativeRuns: [authoritativeRun(bothGreen)],
      },
    ],
    [
      "authoritative-run-cancelled",
      {
        graphRuns: [graphRun("success")],
        authoritativeRuns: [{ ...authoritativeRun(bothGreen), conclusion: "cancelled" }],
      },
    ],
    [
      "authoritative-gate-missing",
      {
        graphRuns: [graphRun("success")],
        authoritativeRuns: [
          { runId: 2, headSha: "a".repeat(40), conclusion: "success", jobs: [job("JS SDK", "success")] },
        ],
      },
    ],
    [
      "authoritative-not-terminal",
      {
        graphRuns: [graphRun("success")],
        authoritativeRuns: [authoritativeRun({ "JS SDK": "success", "MCP SDK": "cancelled" })],
      },
    ],
  ];

  for (const [reason, input] of cases) {
    it(`refuses a head with ${reason}`, () => {
      const observation = compareHead({ headSha: "a".repeat(40), ...input });
      assert.equal(observation.comparable, false, `${reason} must not be comparable`);
      assert.equal(observation.reason, reason);
      assert.ok(NOT_COMPARABLE_REASONS.includes(observation.reason));
    });
  }

  // A cancelled graph run is the routine shape: `cancel-in-progress` cancels
  // every superseded head. Counting it as agreement would let a graph that
  // never ran accumulate a promotion sample out of thin air.
  it("never counts a cancelled head toward the promotion denominator", () => {
    const summary = summarizeParity([
      compareHead({
        headSha: "a".repeat(40),
        graphRuns: [graphRun("cancelled")],
        authoritativeRuns: [authoritativeRun(bothGreen)],
      }),
    ]);
    assert.equal(summary.comparable, 0);
    assert.equal(summary.agreed, 0);
    assert.equal(summary.exclusions["graph-run-cancelled"], 1);
  });

  it("does not convert a cancelled run into a disagreement when its always aggregate failed", () => {
    const observation = compareHead({
      headSha: "a".repeat(40),
      graphRuns: [{ ...graphRun("failure"), conclusion: "cancelled" }],
      authoritativeRuns: [authoritativeRun(bothGreen)],
    });
    assert.equal(observation.comparable, false);
    assert.equal(observation.reason, "graph-run-cancelled");
  });
});

describe("heads are joined by exact SHA, never by pull request or branch", () => {
  it("does not pair the graph's verdict on one head with ci.yml's on another", () => {
    const observations = compareRuns({
      graphRuns: [graphRun("success", { runId: 1, headSha: "a".repeat(40) })],
      authoritativeRuns: [authoritativeRun(bothGreen, { runId: 2, headSha: "b".repeat(40) })],
    });
    assert.equal(observations.length, 2);
    assert.deepEqual(
      observations.map((observation) => observation.reason).sort(),
      ["missing-authoritative-run", "missing-graph-run"],
    );
  });

  it("keeps a head the graph never ran visible instead of dropping it", () => {
    const observations = compareRuns({
      graphRuns: [],
      authoritativeRuns: [authoritativeRun(bothGreen, { headSha: "c".repeat(40) })],
    });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].reason, "missing-graph-run");
  });

  it("excludes heads decided before the graph was deployed, in either direction", () => {
    const stale = "d".repeat(40);
    const fresh = "e".repeat(40);
    const dated = (run, createdAt) => ({ ...run, createdAt });
    const observations = compareRuns({
      observationWindowStart: "2026-08-16T23:50:35Z",
      graphRuns: [
        dated(graphRun("failure", { runId: 1, headSha: stale }), "2026-08-16T20:00:00Z"),
        dated(graphRun("success", { runId: 3, headSha: fresh }), "2026-08-17T04:00:00Z"),
      ],
      authoritativeRuns: [
        dated(authoritativeRun(bothGreen, { runId: 2, headSha: stale }), "2026-08-16T20:00:00Z"),
        dated(authoritativeRun(bothGreen, { runId: 4, headSha: fresh }), "2026-08-17T04:00:00Z"),
      ],
    });
    const byHead = new Map(observations.map((observation) => [observation.headSha, observation]));
    // The stale head is a genuine disagreement; it is still excluded, because a
    // graph that was mid-authoring is not the graph being measured.
    assert.equal(byHead.get(stale).comparable, false);
    assert.equal(byHead.get(stale).reason, "pre-deployment");
    assert.equal(byHead.get(fresh).comparable, true);
    assert.equal(byHead.get(fresh).agrees, true);
  });

  it("treats an undatable run as outside the window rather than inside it", () => {
    const observations = compareRuns({
      observationWindowStart: "2026-08-16T23:50:35Z",
      graphRuns: [graphRun("success")],
      authoritativeRuns: [authoritativeRun(bothGreen)],
    });
    assert.equal(observations[0].reason, "pre-deployment");
  });

  it("refuses an observation window that is not an ISO instant", () => {
    assert.throws(() => compareRuns({ observationWindowStart: "last tuesday" }), /not an ISO instant/u);
  });

  // A re-run publishes the job name again; the last record decided the head.
  it("scores a re-run job by its final conclusion, not its first attempt", () => {
    const run = graphRun("success");
    run.jobs = [job(GRAPH_GATE_JOB, "failure", 0.1), ...run.jobs];
    const observation = compareHead({
      headSha: "a".repeat(40),
      graphRuns: [run],
      authoritativeRuns: [authoritativeRun(bothGreen)],
    });
    assert.equal(observation.graph.verdict, "success");
  });
});

describe("promotion needs both a sample and zero disagreements", () => {
  function agreeingHeads(count) {
    return Array.from({ length: count }, (_unused, index) => {
      const headSha = String(index).padStart(40, "0");
      return compareHead({
        headSha,
        graphRuns: [graphRun("success", { runId: index * 2, headSha })],
        authoritativeRuns: [authoritativeRun(bothGreen, { runId: index * 2 + 1, headSha })],
      });
    });
  }

  it("is not ready below the threshold even with a perfect agreement rate", () => {
    const summary = summarizeParity(agreeingHeads(PROMOTION_SAMPLE_THRESHOLD - 1));
    assert.equal(summary.agreementRate, 1);
    assert.equal(summary.promotionReady, false);
  });

  it("is ready at the threshold with no disagreement", () => {
    const summary = summarizeParity(agreeingHeads(PROMOTION_SAMPLE_THRESHOLD));
    assert.equal(summary.promotionReady, true);
  });

  it("is blocked by one disagreement no matter how large the agreeing sample", () => {
    const headSha = "f".repeat(40);
    const summary = summarizeParity([
      ...agreeingHeads(PROMOTION_SAMPLE_THRESHOLD * 5),
      compareHead({
        headSha,
        graphRuns: [graphRun("success", { runId: 900, headSha })],
        authoritativeRuns: [authoritativeRun({ "JS SDK": "failure", "MCP SDK": "success" }, { runId: 901, headSha })],
      }),
    ]);
    assert.equal(summary.disagreed, 1);
    assert.equal(summary.promotionReady, false);
    assert.equal(summary.disagreements[0].headSha, headSha);
  });

  it("reports both sides' cost so a wall-clock win cannot hide a billing loss", () => {
    const summary = summarizeParity(agreeingHeads(3));
    // The graph bills more jobs; ci.yml's replaced scope has the longer single
    // job. Both must be visible, which is the whole point of reporting two
    // numbers rather than one.
    assert.ok(summary.cost.graph.billed.p50 !== undefined);
    assert.ok(summary.cost.authoritative.billed.p50 !== undefined);
    assert.ok(summary.cost.authoritative.criticalPath.p50 > summary.cost.graph.criticalPath.p50);
  });

  it("renders a report that states the verdict rather than only the numbers", () => {
    const report = formatParityReport(summarizeParity(agreeingHeads(2)));
    assert.match(report, /NOT MET/u);
    assert.match(report, /Agreement rate: 100\.0%/u);
  });
});

describe("the committed observation set is a real, re-checkable document", () => {
  const file = path.join(root, "docs/evidence/ci-shadow-parity.v1.json");

  it("is committed, so promotion readiness is auditable without credentials", () => {
    assert.ok(fs.existsSync(file), "docs/evidence/ci-shadow-parity.v1.json must be committed");
  });

  it("declares the format the offline reporter accepts", () => {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(document.format, CI_SHADOW_PARITY_FORMAT);
    assert.equal(document.graphWorkflow, "sdk-verification.yml");
    assert.equal(document.authoritativeWorkflow, "ci.yml");
    assert.equal(document.threshold, PROMOTION_SAMPLE_THRESHOLD);
    assert.ok(Array.isArray(document.observations));
  });

  // Without a stated window, a reader cannot tell whether an agreement was
  // observed against the deployed graph or against a draft of it.
  it("states the observation window it was collected under", () => {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.match(document.observationWindowStart, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  // The stored summary is a rendering of the stored observations. If they can
  // drift, the committed headline number stops being evidence about the
  // committed data.
  it("stores a summary that recomputes from its own observations", () => {
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    const recomputed = summarizeParity(document.observations, { threshold: document.threshold });
    assert.equal(recomputed.comparable, document.summary.comparable);
    assert.equal(recomputed.agreed, document.summary.agreed);
    assert.equal(recomputed.disagreed, document.summary.disagreed);
    assert.equal(recomputed.promotionReady, document.summary.promotionReady);
  });
});
