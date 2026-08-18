/**
 * Shadow-parity evidence for the reusable-build verification graph
 * (honua-io/honua-sdk-js#1286 AC-7 and AC-8, NFR-004).
 *
 * `.github/workflows/sdk-verification.yml` runs beside `ci.yml` rather than
 * instead of it. Promotion to authoritative is gated on the graph having
 * reached the SAME VERDICT as the authoritative workflow, on the same head, for
 * a stated number of heads -- and on what that cost. Until those two numbers
 * exist, "the graph agrees with ci.yml" is a belief. This module turns it into
 * an observation with a denominator.
 *
 * The unit of comparison is one exact head SHA, never a pull request and never
 * a branch. A pull request accumulates heads; comparing at the pull-request
 * level would silently pair the graph's verdict on one commit with ci.yml's
 * verdict on another, which is precisely the mutable-base defect that closed
 * honua-io/honua-sdk-js#1312 without merge.
 *
 * FAIL CLOSED, IN THE DIRECTION THAT COSTS MINUTES. Everything ambiguous is
 * `not-comparable` and lands outside the denominator: a missing run on either
 * side, a non-terminal verdict, a cancelled lane, a head carrying two distinct
 * runs of the same workflow, or a gate job the authoritative workflow did not
 * publish. A head excluded from the sample delays promotion; a head wrongly
 * counted as agreement promotes a graph nobody measured. The first is a cost,
 * the second is the failure this exists to prevent, so exclusion is always the
 * cheaper mistake and is always the one taken.
 *
 * Pure by construction: run records are arguments. scripts/ci-shadow-parity.mjs
 * is the `gh`-shaped shell that fetches them.
 */

const MS_PER_MINUTE = 60_000;

export const CI_SHADOW_PARITY_FORMAT = "honua.ci-shadow-parity.v1";

/**
 * The graph's single aggregate result. `verified` is the one job a reviewer
 * reads, and it already folds in every other job's conclusion, so comparing it
 * is comparing the whole graph.
 */
export const GRAPH_GATE_JOB = "SDK verified";

/**
 * The authoritative jobs the graph is proposing to replace. Deliberately NOT
 * every job in ci.yml: `PR Fast` and `Deterministic Benchmark Lab` stay in
 * ci.yml after promotion, so including them would compare two different scopes
 * of work and flatter whichever side happened to own more of them.
 */
export const AUTHORITATIVE_GATE_JOBS = Object.freeze(["JS SDK", "MCP SDK"]);

/** Verdicts that mean the lane actually reached a decision. */
export const TERMINAL_CONCLUSIONS = Object.freeze(["success", "failure"]);

/**
 * How many agreeing heads promotion needs (#1286 AC-7). Disagreement is not
 * traded off against volume: one unexplained disagreement blocks promotion no
 * matter how large the agreeing sample is, because the disagreement is the
 * evidence that the graph and ci.yml are not the same gate.
 */
export const PROMOTION_SAMPLE_THRESHOLD = 20;

export const NOT_COMPARABLE_REASONS = Object.freeze([
  "pre-deployment",
  "missing-graph-run",
  "missing-authoritative-run",
  "ambiguous-graph-run",
  "ambiguous-authoritative-run",
  "graph-gate-missing",
  "graph-not-terminal",
  "authoritative-gate-missing",
  "authoritative-not-terminal",
]);

function durationMinutes(startedAt, completedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return undefined;
  return (completed - started) / MS_PER_MINUTE;
}

function jobsByName(run, names) {
  const wanted = new Set(names);
  const found = new Map();
  for (const job of run?.jobs ?? []) {
    if (!wanted.has(job.name)) continue;
    // A re-run publishes the same job name again. The LAST record is the one
    // that decided the head, so a job re-run to green must not be scored
    // against its first red attempt.
    found.set(job.name, job);
  }
  return found;
}

function cost(run, names) {
  const scoped = (run?.jobs ?? []).filter((job) => (names ? names.includes(job.name) : true));
  const minutes = scoped.map((job) => durationMinutes(job.startedAt, job.completedAt)).filter((value) => value !== undefined);
  if (minutes.length === 0) return undefined;
  return {
    jobCount: minutes.length,
    // What it costs. Parallel jobs bill in parallel, so this is a sum.
    billedMinutes: minutes.reduce((total, value) => total + value, 0),
    // What a reviewer waits for. The longest single job, not the elapsed span:
    // a job dispatched much later stretches the span without anyone waiting.
    criticalPathMinutes: Math.max(...minutes),
  };
}

/**
 * One head's observation. `verdict` is `success` or `failure`; anything else is
 * refused rather than coerced, because "cancelled" is not a verdict and a graph
 * that agrees with ci.yml about nothing having run proves nothing.
 */
export function compareHead({ headSha, graphRuns = [], authoritativeRuns = [] }) {
  const base = { headSha };

  const notComparable = (reason, detail) => ({ ...base, comparable: false, reason, detail });

  if (graphRuns.length === 0) return notComparable("missing-graph-run");
  if (authoritativeRuns.length === 0) return notComparable("missing-authoritative-run");
  if (graphRuns.length > 1) {
    return notComparable("ambiguous-graph-run", graphRuns.map((run) => String(run.runId)).join(","));
  }
  if (authoritativeRuns.length > 1) {
    return notComparable("ambiguous-authoritative-run", authoritativeRuns.map((run) => String(run.runId)).join(","));
  }

  const [graphRun] = graphRuns;
  const [authoritativeRun] = authoritativeRuns;

  const graphGate = jobsByName(graphRun, [GRAPH_GATE_JOB]).get(GRAPH_GATE_JOB);
  if (!graphGate) return notComparable("graph-gate-missing", GRAPH_GATE_JOB);
  if (!TERMINAL_CONCLUSIONS.includes(graphGate.conclusion)) {
    return notComparable("graph-not-terminal", graphGate.conclusion ?? "null");
  }

  const authoritativeGates = jobsByName(authoritativeRun, AUTHORITATIVE_GATE_JOBS);
  const missingGate = AUTHORITATIVE_GATE_JOBS.find((name) => !authoritativeGates.has(name));
  if (missingGate) return notComparable("authoritative-gate-missing", missingGate);
  const nonTerminal = AUTHORITATIVE_GATE_JOBS.find(
    (name) => !TERMINAL_CONCLUSIONS.includes(authoritativeGates.get(name).conclusion),
  );
  if (nonTerminal) {
    return notComparable("authoritative-not-terminal", `${nonTerminal}=${authoritativeGates.get(nonTerminal).conclusion ?? "null"}`);
  }

  const graphVerdict = graphGate.conclusion;
  // The authoritative lane passes only if every gate it owns passed, which is
  // the same rule the graph's own aggregate applies to its jobs.
  const authoritativeVerdict = AUTHORITATIVE_GATE_JOBS.every(
    (name) => authoritativeGates.get(name).conclusion === "success",
  )
    ? "success"
    : "failure";

  return {
    ...base,
    comparable: true,
    agrees: graphVerdict === authoritativeVerdict,
    graph: {
      runId: String(graphRun.runId),
      verdict: graphVerdict,
      cost: cost(graphRun),
    },
    authoritative: {
      runId: String(authoritativeRun.runId),
      verdict: authoritativeVerdict,
      jobs: AUTHORITATIVE_GATE_JOBS.map((name) => ({ name, conclusion: authoritativeGates.get(name).conclusion })),
      cost: cost(authoritativeRun, AUTHORITATIVE_GATE_JOBS),
    },
  };
}

/**
 * Joins two run listings by exact head SHA and compares each head.
 *
 * Heads present on only one side still appear, as `not-comparable`. Dropping
 * them would hide the most interesting failure of all -- a graph that never ran
 * on the heads ci.yml was gating -- behind a clean-looking 100% agreement.
 *
 * `observationWindowStart` makes the evidence FORWARD-ONLY, for the same reason
 * honua-io/honua-sdk-js#1312 was closed without merge: a graph run produced
 * before the graph was deployed was produced by a workflow file that was itself
 * the change under review, and it moved between heads. Those runs are real
 * diagnostics and stay visible as `pre-deployment`, but they are not evidence
 * about the deployed graph and must never enter the promotion denominator --
 * in either direction. The six disagreements this collector found on
 * honua-io/honua-sdk-js#1334's own development heads are exactly that shape:
 * the graph failing while it was being written is not a parity finding.
 */
export function compareRuns({ graphRuns = [], authoritativeRuns = [], observationWindowStart } = {}) {
  const windowStart = observationWindowStart === undefined ? undefined : Date.parse(observationWindowStart);
  if (observationWindowStart !== undefined && !Number.isFinite(windowStart)) {
    throw new Error(`observationWindowStart is not an ISO instant: ${String(observationWindowStart)}`);
  }

  const heads = new Map();
  const push = (side, run) => {
    const sha = run?.headSha;
    if (typeof sha !== "string" || sha.length === 0) return;
    if (!heads.has(sha)) heads.set(sha, { graph: [], authoritative: [] });
    heads.get(sha)[side].push(run);
  };
  for (const run of graphRuns) push("graph", run);
  for (const run of authoritativeRuns) push("authoritative", run);

  return [...heads.entries()]
    .map(([headSha, sides]) => {
      if (windowStart !== undefined) {
        const observed = [...sides.graph, ...sides.authoritative]
          .map((run) => Date.parse(run.createdAt))
          .filter(Number.isFinite);
        // Unknown timestamps are treated as outside the window, not inside it:
        // a run we cannot date is a run we cannot vouch for.
        if (observed.length === 0 || Math.min(...observed) < windowStart) {
          return { headSha, comparable: false, reason: "pre-deployment", detail: observationWindowStart };
        }
      }
      return compareHead({ headSha, graphRuns: sides.graph, authoritativeRuns: sides.authoritative });
    })
    .sort((left, right) => left.headSha.localeCompare(right.headSha));
}

function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1];
}

function costSummary(observations, side) {
  const billed = observations.map((observation) => observation[side].cost?.billedMinutes).filter((v) => v !== undefined);
  const critical = observations
    .map((observation) => observation[side].cost?.criticalPathMinutes)
    .filter((v) => v !== undefined);
  return {
    samples: billed.length,
    billed: { p50: percentile(billed, 0.5), p90: percentile(billed, 0.9) },
    criticalPath: { p50: percentile(critical, 0.5), p90: percentile(critical, 0.9) },
  };
}

export function summarizeParity(observations, { threshold = PROMOTION_SAMPLE_THRESHOLD } = {}) {
  const comparable = observations.filter((observation) => observation.comparable);
  const agreed = comparable.filter((observation) => observation.agrees);
  const disagreed = comparable.filter((observation) => !observation.agrees);

  const exclusions = {};
  for (const observation of observations) {
    if (observation.comparable) continue;
    exclusions[observation.reason] = (exclusions[observation.reason] ?? 0) + 1;
  }

  return {
    observed: observations.length,
    comparable: comparable.length,
    agreed: agreed.length,
    disagreed: disagreed.length,
    agreementRate: comparable.length === 0 ? undefined : agreed.length / comparable.length,
    exclusions,
    threshold,
    // Both conditions, never one. A large agreeing sample does not absorb a
    // disagreement, and zero disagreements over three heads is not evidence.
    promotionReady: agreed.length >= threshold && disagreed.length === 0,
    disagreements: disagreed.map((observation) => ({
      headSha: observation.headSha,
      graph: { runId: observation.graph.runId, verdict: observation.graph.verdict },
      authoritative: { runId: observation.authoritative.runId, verdict: observation.authoritative.verdict },
    })),
    cost: {
      graph: costSummary(comparable, "graph"),
      authoritative: costSummary(comparable, "authoritative"),
    },
  };
}

function round(value) {
  return value === undefined ? "n/a" : value.toFixed(1);
}

export function formatParityReport(summary, { title = "SDK verification shadow parity" } = {}) {
  const lines = [
    `# ${title}`,
    "",
    `Heads observed: ${summary.observed}. Comparable: ${summary.comparable}. ` +
      `Agreed: ${summary.agreed}. Disagreed: ${summary.disagreed}.`,
    `Agreement rate: ${summary.agreementRate === undefined ? "n/a" : `${(summary.agreementRate * 100).toFixed(1)}%`}.`,
    `Promotion threshold: ${summary.threshold} agreeing heads and zero disagreements -- ` +
      `${summary.promotionReady ? "MET" : "NOT MET"}.`,
    "",
    "A head counts only when both workflows reached a terminal verdict on that exact SHA,",
    "and only when both ran after the graph was deployed. Every other head is excluded and",
    "listed below rather than assumed to agree.",
    "",
    "| Side | heads | billed p50 | billed p90 | critical path p50 | critical path p90 |",
    "| --- | --- | --- | --- | --- | --- |",
    `| Graph (all jobs) | ${summary.cost.graph.samples} | ${round(summary.cost.graph.billed.p50)} | ` +
      `${round(summary.cost.graph.billed.p90)} | ${round(summary.cost.graph.criticalPath.p50)} | ` +
      `${round(summary.cost.graph.criticalPath.p90)} |`,
    `| ci.yml (${AUTHORITATIVE_GATE_JOBS.join(" + ")}) | ${summary.cost.authoritative.samples} | ` +
      `${round(summary.cost.authoritative.billed.p50)} | ${round(summary.cost.authoritative.billed.p90)} | ` +
      `${round(summary.cost.authoritative.criticalPath.p50)} | ${round(summary.cost.authoritative.criticalPath.p90)} |`,
  ];

  const exclusionEntries = Object.entries(summary.exclusions).sort(([left], [right]) => left.localeCompare(right));
  if (exclusionEntries.length > 0) {
    lines.push("", "| Excluded (not comparable) | heads |", "| --- | --- |");
    for (const [reason, count] of exclusionEntries) lines.push(`| ${reason} | ${count} |`);
  }

  if (summary.disagreements.length > 0) {
    lines.push("", "## Disagreements -- promotion is blocked until each is explained", "");
    for (const disagreement of summary.disagreements) {
      lines.push(
        `- ${disagreement.headSha.slice(0, 12)}: graph run ${disagreement.graph.runId} said ` +
          `${disagreement.graph.verdict}, ci.yml run ${disagreement.authoritative.runId} said ` +
          `${disagreement.authoritative.verdict}.`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
