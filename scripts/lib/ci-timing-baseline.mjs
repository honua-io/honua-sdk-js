/**
 * CI timing and billed-minute baseline (honua-io/honua-sdk-js#1286 AC-1, AC-8).
 *
 * "The graph is faster" is not a claim anyone can check without a number to
 * check it against, so the before/after comparison is computed from real run
 * records rather than asserted. Two quantities, deliberately kept apart:
 *
 *   wallClockMinutes   what a reviewer waits: the span from the first job
 *                      starting to the last job finishing.
 *   billedMinutes      what it costs: the sum of every job's own duration,
 *                      because parallel jobs are billed in parallel.
 *
 * Sharding trades the second for the first. Reporting only one of them would
 * let a change look like a win while being a loss.
 *
 * Pure by construction: run records are arguments. scripts/ci-timing-baseline.mjs
 * is the `gh`-shaped shell that fetches them.
 */

const MS_PER_MINUTE = 60_000;

/** Runs that never really executed say nothing about how long execution takes. */
export const REPORTABLE_CONCLUSIONS = Object.freeze(["success", "failure"]);

function durationMinutes(startedAt, completedAt) {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return undefined;
  return (completed - started) / MS_PER_MINUTE;
}

export function summarizeRun(run) {
  const jobs = [];
  for (const job of run?.jobs ?? []) {
    const minutes = durationMinutes(job.startedAt, job.completedAt);
    if (minutes === undefined) continue;
    jobs.push({ name: job.name, conclusion: job.conclusion, minutes });
  }
  if (jobs.length === 0) return undefined;

  const starts = (run.jobs ?? []).map((job) => Date.parse(job.startedAt)).filter(Number.isFinite);
  const ends = (run.jobs ?? []).map((job) => Date.parse(job.completedAt)).filter(Number.isFinite);
  return {
    runId: String(run.runId),
    conclusion: run.conclusion,
    jobs,
    jobCount: jobs.length,
    // Elapsed span of the run. Honest but noisy: a job dispatched or re-run
    // hours later stretches it without anyone having waited, which is why the
    // critical path below is the headline number.
    wallClockMinutes: (Math.max(...ends) - Math.min(...starts)) / MS_PER_MINUTE,
    // The longest single job. This is what sharding actually moves -- splitting
    // a 38-minute job into four 10-minute ones changes this and nothing else --
    // and it is immune to a delayed job inflating the span.
    criticalPathMinutes: Math.max(...jobs.map((job) => job.minutes)),
    billedMinutes: jobs.reduce((total, job) => total + job.minutes, 0),
  };
}

export function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  // Nearest-rank: with 30-ish samples an interpolating estimator invents
  // precision the sample size does not support.
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1];
}

export function summarizeRuns(runs, { conclusions = REPORTABLE_CONCLUSIONS } = {}) {
  const summarized = runs
    .map((run) => summarizeRun(run))
    .filter((summary) => summary !== undefined && conclusions.includes(summary.conclusion));

  const wall = summarized.map((run) => run.wallClockMinutes);
  const critical = summarized.map((run) => run.criticalPathMinutes);
  const billed = summarized.map((run) => run.billedMinutes);

  const perJob = new Map();
  for (const run of summarized) {
    for (const job of run.jobs) {
      if (!perJob.has(job.name)) perJob.set(job.name, []);
      perJob.get(job.name).push(job.minutes);
    }
  }

  return {
    sampleSize: summarized.length,
    criticalPath: { p50: percentile(critical, 0.5), p90: percentile(critical, 0.9), max: percentile(critical, 1) },
    wallClock: { p50: percentile(wall, 0.5), p90: percentile(wall, 0.9), max: percentile(wall, 1) },
    billed: { p50: percentile(billed, 0.5), p90: percentile(billed, 0.9), max: percentile(billed, 1) },
    jobs: [...perJob.entries()]
      .map(([name, values]) => ({
        name,
        runs: values.length,
        p50: percentile(values, 0.5),
        p90: percentile(values, 0.9),
      }))
      .sort((left, right) => right.p90 - left.p90),
    runs: summarized,
  };
}

function round(value) {
  return value === undefined ? "n/a" : value.toFixed(1);
}

export function formatBaselineReport(summary, { title = "CI timing baseline" } = {}) {
  const lines = [
    `# ${title}`,
    "",
    `Sample: ${summary.sampleSize} runs with a terminal conclusion (${REPORTABLE_CONCLUSIONS.join("/")}).`,
    "Cancelled and queued runs are excluded: they measure the queue, not the work.",
    "Critical path is the longest single job -- the quantity sharding moves. Wall clock is the",
    "elapsed span and is inflated on runs where a job was dispatched or re-run much later.",
    "",
    "| Measure | p50 | p90 | max |",
    "| --- | --- | --- | --- |",
    `| Critical path (min) | ${round(summary.criticalPath.p50)} | ${round(summary.criticalPath.p90)} | ${round(summary.criticalPath.max)} |`,
    `| Wall clock (min) | ${round(summary.wallClock.p50)} | ${round(summary.wallClock.p90)} | ${round(summary.wallClock.max)} |`,
    `| Billed (min) | ${round(summary.billed.p50)} | ${round(summary.billed.p90)} | ${round(summary.billed.max)} |`,
    "",
    "| Job | runs | p50 (min) | p90 (min) |",
    "| --- | --- | --- | --- |",
  ];
  for (const job of summary.jobs) {
    lines.push(`| ${job.name} | ${job.runs} | ${round(job.p50)} | ${round(job.p90)} |`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What the same work costs once the longest job is split into independent
 * consumers. `partition` maps a baseline job name to the set of jobs that
 * replace it, each with the share of the original it carries. Wall clock
 * becomes the critical path; billed minutes become the sum, plus one runner
 * setup per new job.
 *
 * This is a projection, not a measurement, and is labelled as such wherever it
 * is rendered: the real post-change number comes from AC-8's 30 hosted runs.
 */
export function projectShardedCost({ baselineJobs, replaced, replacements, setupMinutes = 1.2 }) {
  const kept = baselineJobs.filter((job) => job.name !== replaced);
  const replacedJob = baselineJobs.find((job) => job.name === replaced);
  if (!replacedJob) throw new Error(`No baseline job named ${replaced}`);

  const projected = replacements.map((entry) => ({
    name: entry.name,
    p90: replacedJob.p90 * entry.share + setupMinutes,
  }));
  const all = [...kept.map((job) => ({ name: job.name, p90: job.p90 })), ...projected];
  return {
    jobs: all,
    wallClockMinutes: Math.max(...all.map((job) => job.p90)),
    billedMinutes: all.reduce((total, job) => total + job.p90, 0),
  };
}
