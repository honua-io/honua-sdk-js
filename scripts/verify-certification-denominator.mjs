#!/usr/bin/env node

// Certification denominator drift gate (honua-io/honua-sdk-js#39, AC1).
//
// config/certification-denominator.v1.json is frozen: it is what "every
// supported row executes from installed bytes; zero supported rows are skipped"
// is counted against. A frozen number is only meaningful while it still
// describes the manifests, so this gate regenerates the denominator from
// config/support-manifest.v1.json, config/protocol-certification.v1.json,
// config/sdk-coverage-crosswalk.v1.json, config/admin-mcp-coverage.v1.json and
// mcp/release/zero-to-map/journey.v1.json, and fails when the committed
// artifact no longer matches:
//
//   1. An input manifest changed without the denominator being regenerated --
//      reported per input, by digest, before any row diff.
//   2. A `supported` row exists in a manifest and is absent from the frozen
//      denominator. That row would never be certified and the run would still
//      report a full pass.
//   3. A row's tier drifted, or a frozen row no longer corresponds to anything
//      a manifest produces.
//   4. The frozen artifact fails its own invariants -- a hand-edited
//      `beta`/`experimental`/`facade-required`/`deprecated` row flipped to
//      counts:true, or a counting row that permits an environment skip. These
//      run against the committed bytes, not the regenerated ones, so editing
//      the artifact by hand cannot get past this gate.
//
// The counting policy the frozen denominator implies -- which results may
// satisfy which rows -- is evaluateCertificationRun() in
// scripts/certification-denominator.mjs and is covered by
// test/scripts/certification-denominator.test.mjs. Executing #39 itself needs a
// live candidate server and published registry bytes; this gate proves only
// that the denominator it will be scored against is real and current.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCertificationDenominatorInvariants,
  buildCertificationDenominator,
  DENOMINATOR_PATH,
  DENOMINATOR_SCHEMA_PATH,
  evaluateCertificationDenominatorDrift,
  loadCertificationDenominatorInputs,
  PROJECT_ROOT,
  REGENERATE_COMMAND,
  serializeCertificationDenominator,
  validateCertificationDenominatorSchema,
} from "./certification-denominator.mjs";

/**
 * Every failure mode above, evaluated over already-read values so the gate is
 * unit-testable without a checkout.
 *
 * @param {object} options
 * @param {object|null} options.frozen parsed config/certification-denominator.v1.json
 * @param {string|null} options.frozenText its exact bytes, or null when absent
 * @param {object} options.inputs loadCertificationDenominatorInputs() output
 * @returns {{errors: string[], generated: object|null}}
 */
export function evaluateCertificationDenominator({ frozen, frozenText, inputs }) {
  const { denominator: generated, errors: generationErrors } = buildCertificationDenominator(inputs);
  const errors = [...generationErrors];

  if (!frozen) {
    errors.push(`${DENOMINATOR_PATH} is missing; freeze it with ${REGENERATE_COMMAND}`);
    return { errors, generated };
  }

  // The frozen bytes on their own terms first: a hand-promoted tier must fail
  // even if the generator were somehow made to agree with it.
  errors.push(...assertCertificationDenominatorInvariants(frozen));
  errors.push(...evaluateCertificationDenominatorDrift({ frozen, generated }));

  const serialized = serializeCertificationDenominator(generated);
  if (typeof frozenText === "string" && frozenText !== serialized && errors.length === 0) {
    // Content matched row for row but the file is not what the generator emits
    // (ordering, formatting, a stray hand edit outside the row list).
    errors.push(`${DENOMINATOR_PATH} is not byte-identical to its generated form; run ${REGENERATE_COMMAND}`);
  }

  return { errors, generated };
}

function readJsonIfPresent(relativePath, projectRoot = PROJECT_ROOT) {
  const absolute = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolute)) return { parsed: null, text: null };
  const text = fs.readFileSync(absolute, "utf8");
  try {
    return { parsed: JSON.parse(text), text };
  } catch {
    return { parsed: null, text };
  }
}

async function main() {
  const inputs = loadCertificationDenominatorInputs();
  const { parsed: frozen, text: frozenText } = readJsonIfPresent(DENOMINATOR_PATH);
  const { errors } = evaluateCertificationDenominator({ frozen, frozenText, inputs });

  const schemaErrors = frozen
    ? await validateCertificationDenominatorSchema(
        frozen,
        JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, DENOMINATOR_SCHEMA_PATH), "utf8")),
      )
    : [];

  const all = [...schemaErrors, ...errors];
  if (all.length > 0) {
    process.stderr.write(`${DENOMINATOR_PATH} no longer describes the frozen 2026.1 certification denominator:\n`);
    for (const error of all) process.stderr.write(`- ${error}\n`);
    process.stderr.write(
      "\nRemediation: regenerate the denominator with " +
        `${REGENERATE_COMMAND}. Never edit config/certification-denominator.v1.json by hand and never\n` +
        "promote a support tier to make a row count -- the tier lives in config/support-manifest.v1.json,\n" +
        "and a beta, experimental, facade-required or deprecated row may not satisfy a supported pass.\n",
    );
    process.exitCode = 1;
    return;
  }

  const { summary } = frozen;
  const tiers = Object.entries(summary.byTier)
    .map(([tier, count]) => `${tier}=${count}`)
    .join(" ");
  process.stdout.write(
    `${DENOMINATOR_PATH}: ${summary.rows} frozen rows (${tiers}); ` +
      `${summary.counting} must execute from installed bytes, ${summary.visibleNonCounting} are visible and cannot count. No drift.\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
