#!/usr/bin/env node
// Generates and validates config/component-qualification.v1.json: the
// enforceable production qualification matrix for the Honua custom-element kit
// (honua-io/honua-sdk-js#683, child of epic #678).
//
// The matrix is DERIVED, never hand-padded. Its source of truth is
// src/controls/qualification.ts (built to dist/), which expands the component
// catalog (src/controls/catalog.ts) into one cell per component x gate. This
// script projects that into a versioned JSON manifest, injects a summary table
// into docs/web-components.md, and enforces the invariants that make the matrix
// worth having:
//
//   1. Complete coverage. Every catalog id has exactly one row and every row has
//      exactly one cell per declared gate. A component added to the catalog
//      without a qualification row fails the build -- "unrecorded component" is
//      the failure mode a qualification matrix exists to prevent.
//   2. Closed vocabularies. Statuses and requirement ids must come from the
//      declared sets.
//   3. Evidence must exist. Every file a `passing` cell cites must be present on
//      disk. Deleting the test that backs a gate therefore breaks CI instead of
//      quietly downgrading the claim -- this is the regression gate.
//   4. Claims must be argued. `passing` requires evidence; `failing` and
//      `not-applicable` require a note. `not-applicable` is the only status that
//      removes work, so it is the one that most needs a justification attached.
//   5. Tier agreement, in the one direction that is actually implied. The
//      catalog's supportTier is a FUNCTIONAL maturity claim owned by whichever
//      feature issue raised the component (#680-#683); this matrix is the
//      cross-cutting gate axis. Clearing every gate is the strictly harder bar,
//      so a fully-qualified component MUST be declared production-tier. The
//      reverse does not hold: a production-tier component carries its still-open
//      gates in `openGates`, counted and visible, so the tier can never be
//      mistaken for gate completion.
//
// Usage: node scripts/component-qualification.mjs <write|check>
// npm scripts: qualification:components / qualification:components:check.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "config/component-qualification.v1.json";
const DOC_PATH = "docs/web-components.md";
const TABLE_START = "<!-- component-qualification:start -->";
const TABLE_END = "<!-- component-qualification:end -->";
const CATALOG_MODULE = "dist/src/controls/catalog.js";
const QUALIFICATION_MODULE = "dist/src/controls/qualification.js";

const VALID_STATUSES = new Set(["passing", "failing", "pending", "not-applicable"]);
const VALID_REQUIREMENTS = new Set(["REQ-004", "REQ-005", "NFR-001"]);
const STATUS_SYMBOLS = {
  passing: "pass",
  failing: "FAIL",
  pending: "pending",
  "not-applicable": "n/a",
};

async function loadSourceOfTruth() {
  for (const relative of [CATALOG_MODULE, QUALIFICATION_MODULE]) {
    const absolute = path.join(PROJECT_ROOT, relative);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Missing ${relative}. Run "npm run build" before ${path.basename(process.argv[1])}.`);
    }
  }
  const catalog = await import(pathToFileURL(path.join(PROJECT_ROOT, CATALOG_MODULE)).href);
  const qualification = await import(pathToFileURL(path.join(PROJECT_ROOT, QUALIFICATION_MODULE)).href);
  return { catalog, qualification };
}

/** Builds the manifest body and collects every invariant violation. */
export function buildManifest({ catalog, qualification }, fileExists) {
  const failures = [];
  const invariant = (condition, message) => {
    if (!condition) failures.push(message);
  };

  const entries = catalog.HONUA_COMPONENT_CATALOG;
  const gates = qualification.HONUA_COMPONENT_QUALIFICATION_GATES;
  const rows = qualification.listComponentQualifications();

  invariant(gates.length > 0, "qualification gate list is empty");
  invariant(
    rows.length === entries.length,
    `matrix has ${rows.length} rows for ${entries.length} catalog entries -- every shipped component must be recorded exactly once`,
  );

  const rowIds = new Set(rows.map((row) => row.id));
  for (const entry of entries) {
    invariant(rowIds.has(entry.id), `catalog entry "${entry.id}" has no qualification row (unrecorded component)`);
  }
  for (const row of rows) {
    invariant(
      entries.some((entry) => entry.id === row.id),
      `qualification row "${row.id}" is not in the component catalog (orphaned row)`,
    );
  }
  invariant(new Set(rows.map((row) => row.id)).size === rows.length, "matrix contains duplicate component rows");

  for (const gate of gates) {
    invariant(VALID_REQUIREMENTS.has(gate.requirement), `gate "${gate.id}": unknown requirement ${gate.requirement}`);
    invariant(
      typeof gate.criterion === "string" && gate.criterion.trim().length >= 40,
      `gate "${gate.id}": missing a substantive criterion describing what passing asserts`,
    );
  }

  const gateIds = gates.map((gate) => gate.id);
  for (const row of rows) {
    invariant(
      row.gates.length === gates.length,
      `component "${row.id}" has ${row.gates.length} cells for ${gates.length} gates -- the matrix must be dense`,
    );
    invariant(
      JSON.stringify(row.gates.map((cell) => cell.gate)) === JSON.stringify(gateIds),
      `component "${row.id}": cell order does not match the declared gate order`,
    );
    for (const cell of row.gates) {
      const where = `${row.id}/${cell.gate}`;
      invariant(VALID_STATUSES.has(cell.status), `${where}: unknown status "${cell.status}"`);
      if (cell.status === "passing") {
        invariant(cell.evidence.length > 0, `${where}: "passing" requires at least one evidence file`);
        for (const evidence of cell.evidence) {
          invariant(fileExists(evidence), `${where}: evidence file "${evidence}" does not exist`);
        }
      } else {
        invariant(cell.evidence.length === 0, `${where}: only a "passing" cell may cite evidence`);
      }
      if (cell.status === "failing" || cell.status === "not-applicable") {
        invariant(
          typeof cell.note === "string" && cell.note.trim().length >= 20,
          `${where}: "${cell.status}" requires a note explaining why`,
        );
      }
    }

    const entry = entries.find((candidate) => candidate.id === row.id);
    const qualified = qualification.isComponentProductionQualified(row.id);
    if (entry && qualified) {
      // Only this direction is implied; see the header note on tier agreement.
      invariant(
        entry.supportTier === "production-tier",
        `component "${row.id}" clears every qualification gate but the catalog still declares supportTier "${entry.supportTier}"`,
      );
    }
    invariant(
      qualified === (qualification.listOpenQualificationGates(row.id).length === 0),
      `component "${row.id}": openGates disagrees with its production-qualified verdict`,
    );
  }

  const overall = qualification.summarizeComponentQualification();
  const manifest = {
    $schema: "./component-qualification.schema.json",
    format: "honua.app-platform.component-qualification.v1",
    schemaVersion: 1,
    dataVersion: qualification.HONUA_COMPONENT_QUALIFICATION_DATA_VERSION,
    generatedFrom: ["src/controls/catalog.ts", "src/controls/qualification.ts"],
    statusVocabulary: [...qualification.HONUA_COMPONENT_QUALIFICATION_STATUSES],
    statusMeaning: {
      passing: "An automated gate exists and passes. Every listed evidence file is verified to exist.",
      failing: "The requirement is known not to be met, from a failing gate or a recorded code-level finding.",
      pending: "No automated gate and no established verdict. The honest default.",
      "not-applicable": "The gate cannot apply to this component; the note argues why.",
    },
    gates: gates.map((gate) => ({
      id: gate.id,
      requirement: gate.requirement,
      title: gate.title,
      criterion: gate.criterion,
    })),
    summary: {
      components: rows.length,
      gates: gates.length,
      cells: rows.length * gates.length,
      passing: overall.passing,
      failing: overall.failing,
      pending: overall.pending,
      notApplicable: overall.notApplicable,
      productionQualifiedComponents: rows.filter((row) => qualification.isComponentProductionQualified(row.id)).length,
      productionTierComponents: entries.filter((entry) => entry.supportTier === "production-tier").length,
    },
    components: rows.map((row) => {
      const summary = qualification.summarizeComponentQualification(row.id);
      const entry = entries.find((candidate) => candidate.id === row.id);
      const openGates = qualification.listOpenQualificationGates(row.id);
      return {
        id: row.id,
        tag: row.tag,
        source: row.source,
        // Functional maturity from the catalog, kept next to the gate verdict so
        // the two claims are never read as the same thing.
        supportTier: entry?.supportTier ?? "unknown",
        productionQualified: qualification.isComponentProductionQualified(row.id),
        openGates: [...openGates],
        summary: {
          passing: summary.passing,
          failing: summary.failing,
          pending: summary.pending,
          notApplicable: summary.notApplicable,
        },
        gates: row.gates.map((cell) => ({
          gate: cell.gate,
          requirement: cell.requirement,
          status: cell.status,
          ...(cell.evidence.length > 0 ? { evidence: [...cell.evidence] } : {}),
          ...(cell.note ? { note: cell.note } : {}),
        })),
      };
    }),
  };

  return { manifest, failures };
}

/** The docs table: components down the side, gates across the top. */
export function renderTable(manifest) {
  const lines = [TABLE_START];
  lines.push(
    "<!-- GENERATED by scripts/component-qualification.mjs from src/controls/qualification.ts. Do not edit by hand; run npm run qualification:components. -->",
  );
  lines.push("");
  lines.push(
    `${manifest.summary.cells} cells across ${manifest.summary.components} components x ${manifest.summary.gates} gates: ` +
      `**${manifest.summary.passing} passing**, ${manifest.summary.failing} failing, ${manifest.summary.pending} pending, ` +
      `${manifest.summary.notApplicable} not applicable.`,
  );
  lines.push("");
  lines.push(
    `${manifest.summary.productionQualifiedComponents} of ${manifest.summary.components} components have cleared every ` +
      `gate. That is a different axis from the catalog's \`supportTier\`, which records the functional maturity a feature ` +
      `issue delivered: ${manifest.summary.productionTierComponents} component(s) are \`production-tier\` and still carry ` +
      `open gates, listed per component as \`openGates\` in the manifest.`,
  );
  lines.push("");
  const header = ["Component", "Tier", ...manifest.gates.map((gate) => gate.id)];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const component of manifest.components) {
    const cells = component.gates.map((cell) => STATUS_SYMBOLS[cell.status]);
    const tier = component.supportTier === "production-tier" ? "production" : "survival";
    lines.push(`| \`${component.tag}\` (${component.source}) | ${tier} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("Gate definitions and per-cell evidence and notes live in");
  lines.push(`[\`${MANIFEST_PATH}\`](../${MANIFEST_PATH}).`);
  lines.push(TABLE_END);
  return lines.join("\n");
}

async function main() {
  const command = process.argv[2];
  if (command !== "write" && command !== "check") {
    process.stderr.write("Usage: node scripts/component-qualification.mjs <write|check>\n");
    process.exit(2);
  }

  const source = await loadSourceOfTruth();
  const { manifest, failures } = buildManifest(source, (relative) =>
    fs.existsSync(path.join(PROJECT_ROOT, relative)),
  );

  const manifestFile = path.join(PROJECT_ROOT, MANIFEST_PATH);
  const docFile = path.join(PROJECT_ROOT, DOC_PATH);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const doc = fs.readFileSync(docFile, "utf8");
  const tablePattern = new RegExp(`${TABLE_START}[\\s\\S]*?${TABLE_END}`);
  if (!tablePattern.test(doc)) {
    failures.push(`${DOC_PATH} is missing the ${TABLE_START} / ${TABLE_END} markers`);
  }
  const table = renderTable(manifest);

  if (failures.length > 0) {
    process.stderr.write(
      `Component qualification check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`,
    );
    process.exit(1);
  }

  if (command === "write") {
    fs.writeFileSync(manifestFile, serialized);
    fs.writeFileSync(docFile, doc.replace(tablePattern, table));
  } else {
    const drift = [];
    if (!fs.existsSync(manifestFile) || fs.readFileSync(manifestFile, "utf8") !== serialized) {
      drift.push(`${MANIFEST_PATH} has drifted`);
    }
    if (doc.match(tablePattern)?.[0] !== table) drift.push(`${DOC_PATH} qualification table has drifted`);
    if (drift.length > 0) {
      process.stderr.write(
        `${drift.map((entry) => `- ${entry}`).join("\n")}\nRun npm run qualification:components\n`,
      );
      process.exit(1);
    }
  }

  process.stdout.write(
    `${command === "write" ? "Wrote" : "Verified"} ${MANIFEST_PATH}: ${manifest.summary.components} components x ` +
      `${manifest.summary.gates} gates, ${manifest.summary.passing} passing / ${manifest.summary.failing} failing / ` +
      `${manifest.summary.pending} pending / ${manifest.summary.notApplicable} n/a ` +
      `(data v${manifest.dataVersion}).\n`,
  );
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  await main();
}
