#!/usr/bin/env node

/**
 * Look-ahead clock lane for the sample publication contract suite
 * (honua-io/honua-sdk-js#1079).
 *
 * `test/sample-contract.test.ts` builds fixtures from committed evidence files
 * and validates them against a clock. A fixture that inherits a committed
 * attestation's date while deriving the rest of its lane from `now` is valid
 * today and invalid some later morning, with no code change in between -- the
 * calendar alone wedges trunk. That has happened twice (#738, #1078), and both
 * times the first anyone knew of it was an unrelated pull request going red.
 *
 * This lane re-runs that one suite against a forward-shifted *validation clock*
 * (`HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS`, read only by that suite -- never the
 * system clock, never another suite) so an age-coupled fixture fails here, in a
 * lane named for the problem, weeks before it detonates for everyone else.
 *
 * Offsets default to +35d and +95d: the two policy horizons in
 * `samples/contract/v2/migrations/catalog.v1-to-v2.json` are a 31-day executed
 * window and a 90-day non-executed window, and each offset clears one of them
 * regardless of how recently the committed attestations were re-observed.
 *
 * Committed evidence that merely falls due for renewal inside the look-ahead
 * window is *not* a failure here -- that is the renewal automation's job (#979).
 * The suite pins evidence currency to the real clock for exactly that reason;
 * see the header of `test/sample-contract.test.ts`.
 *
 * On failure the lane bisects the offset to the day, so the report names the
 * fixture, the boundary it crossed, and the date it tips:
 *
 *   npm run samples:contract:lookahead
 *   npm run samples:contract:lookahead -- --offsets 35,95,200
 *   npm run samples:contract:lookahead -- --no-bisect
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE = "test/sample-contract.test.ts";
const CLOCK_ENV = "HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS";
const DEFAULT_OFFSETS = [35, 95];
const REPORT_PATH = path.join(PROJECT_ROOT, "test-results", "sample-contract-lookahead.json");
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArguments(argv) {
  const options = { offsets: null, bisect: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--no-bisect") {
      options.bisect = false;
      continue;
    }
    if (argument === "--offsets") {
      options.offsets = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--offsets=")) {
      options.offsets = argument.slice("--offsets=".length);
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

function resolveOffsets(raw) {
  const source = raw ?? process.env.HONUA_SAMPLE_CONTRACT_LOOKAHEAD_OFFSETS ?? "";
  if (!source.trim()) {
    return DEFAULT_OFFSETS;
  }
  const offsets = source
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      const days = Number.parseInt(value, 10);
      if (!Number.isFinite(days) || days <= 0 || String(days) !== value) {
        throw new Error(`look-ahead offsets must be positive whole days, received "${value}"`);
      }
      return days;
    });
  if (offsets.length === 0) {
    throw new Error("look-ahead offsets must not be empty");
  }
  return [...new Set(offsets)].sort((left, right) => left - right);
}

/** Runs the suite once at `days` ahead and returns its failing assertions. */
function runSuite(days, { quiet }) {
  rmSync(REPORT_PATH, { force: true });
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      path.join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      SUITE,
      // The default reporter streams vitest's own expected/received diff, which
      // no JSON field carries; the JSON report is what this lane reads back.
      // Bisection runs are throwaway, so they skip the human output entirely.
      ...(quiet ? [] : ["--reporter=default"]),
      "--reporter=json",
      `--outputFile.json=${REPORT_PATH}`,
      "--silent",
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, [CLOCK_ENV]: String(days) },
      stdio: quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    },
  );
  let report;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  } catch {
    report = null;
  }
  if (report === null) {
    // No machine-readable report means the run died before any test executed
    // (a syntax error, a module resolution failure, a crashed worker). Surface
    // that as its own failure rather than reporting "0 failed" on exit code 1.
    const failures =
      result.status === 0
        ? []
        : [
            {
              title: `${SUITE} (no assertions ran)`,
              message: "vitest produced no JSON report; re-run the command above for the raw output",
              at: null,
            },
          ];
    return { days, passed: result.status === 0, failures, total: 0 };
  }
  const failures = [];
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== "failed") {
        continue;
      }
      const lines = (assertion.failureMessages ?? []).join("\n").split("\n");
      // The first stack frame inside the suite is the fixture that tipped;
      // vitest truncates the assertion summary, so the location is what makes
      // the report actionable on its own (#1079 REQ-002).
      const frame = lines.find((line) => line.includes(SUITE));
      failures.push({
        title: [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean).join(" > "),
        message: lines[0] ?? "(no message)",
        at: frame ? frame.trim().replace(/^at\s+/, "").replace(`${PROJECT_ROOT}/`, "") : null,
      });
    }
  }
  return { days, passed: result.status === 0 && failures.length === 0, failures, total: report.numTotalTests ?? 0 };
}

/**
 * Smallest whole-day offset in [0, ceiling] at which the suite fails.
 *
 * Age coupling is monotonic in the offset -- a fixture that has drifted past a
 * policy window does not drift back inside it -- so a bisection is sound and
 * costs log2(ceiling) runs on the failure path only.
 */
function bisectTippingPoint(ceiling) {
  let low = 0;
  let high = ceiling;
  if (!runSuite(0, { quiet: true }).passed) {
    return 0;
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (runSuite(middle, { quiet: true }).passed) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return high;
}

function formatOffset(days) {
  return `now+${days}d (${new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)})`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const offsets = resolveOffsets(options.offsets);
  console.log(
    `Look-ahead clock lane: ${SUITE} at ${offsets.map((days) => formatOffset(days)).join(", ")}\n` +
      "Committed evidence currency stays pinned to the real clock; renewal is #979's lane, not this one.\n",
  );

  for (const days of offsets) {
    const run = runSuite(days, { quiet: false });
    if (run.passed) {
      console.log(`  ok  ${formatOffset(days)} -- ${run.total} tests`);
      continue;
    }

    console.error(`\nFAIL  ${formatOffset(days)} -- ${run.failures.length} of ${run.total} tests\n`);
    for (const failure of run.failures) {
      console.error(`  ${failure.title}`);
      console.error(`    ${failure.message}`);
      if (failure.at) {
        console.error(`    at ${failure.at}`);
      }
      console.error("");
    }

    if (!options.bisect) {
      process.exitCode = 1;
      return;
    }

    console.error("Bisecting the validation clock to the day this tips...\n");
    const tipping = bisectTippingPoint(days);
    if (tipping === 0) {
      console.error(
        "This suite is already failing at the real clock, so it is not a look-ahead-only\n" +
          "failure: fix it the ordinary way and re-run this lane afterwards.\n",
      );
    } else {
      console.error(
        `Tips at ${formatOffset(tipping)}.\n\n` +
          "That is a calendar time bomb, not a stale attestation: the fixtures above are\n" +
          "valid against today's clock and invalid against that one, with no change to the\n" +
          "committed evidence tree in between. Re-observing an attestation will appear to\n" +
          "fix it and re-arm it a few weeks later -- do not heal it that way.\n\n" +
          "Every date a fixture synthesizes must derive from `validationTime`, and anything\n" +
          "seeded from a committed attestation must go through `readAttestationSeed` so its\n" +
          "observation is re-dated too. See the header of test/sample-contract.test.ts.\n\n" +
          `Reproduce: ${CLOCK_ENV}=${tipping} npx vitest run ${SUITE}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("\nNo calendar time bombs within the look-ahead window.");
}

try {
  main();
} catch (error) {
  console.error(`look-ahead clock lane: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
