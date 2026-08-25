#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_PATH = "config/app-platform-reference-evidence.v1.json";
const MATURITY_PATH = "config/component-qualification.v1.json";
const BUDGET_PATH = "bundle-budgets.json";
const OUTPUT_PATH = "config/app-platform-reference-qualification.v1.json";
const DOC_PATH = "docs/application-components-reference.md";
const DOC_START = "<!-- app-platform-reference-qualification:start -->";
const DOC_END = "<!-- app-platform-reference-qualification:end -->";
const SCHEMA_PATH = "config/app-platform-reference-qualification.schema.json";

const require = createRequire(import.meta.url);
const Ajv = require("ajv").default;
const addFormats = require("ajv-formats").default;

const REQUIRED_JOURNEY = ["connect", "map", "inspect", "filter", "edit", "table", "export"];
const REQUIRED_STATES = ["locale", "rtl", "csp", "auth-change", "error", "offline", "realtime"];
const REQUIRED_BUDGETS = [
  "first-use",
  "interaction",
  "retained-heap",
  "listener-delta",
  "dom-nodes",
  "bundle-gzip",
];
const REQUIRED_LANES = ["direct-custom-element", "react-host"];
const REQUIRED_COMPONENT_GATES = [
  "unit-contract",
  "browser-functional",
  "packed-journey",
  "automated-axe",
  "manual-screen-reader",
  "deterministic-disposal",
  "duplicate-listener",
  "memory-leak",
];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameMembers(left, right) {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function safeEvidencePath(relative) {
  return (
    typeof relative === "string" &&
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    !relative.split(/[\\/]/u).includes("..")
  );
}

function collectEvidencePaths(evidence) {
  return [
    evidence.workbench,
    ...(evidence.lanes ?? []).flatMap((lane) => lane.evidence ?? []),
    ...(evidence.browsers ?? []).flatMap((browser) => browser.evidence ?? []),
    ...Object.values(evidence.states ?? {}).flat(),
    ...(evidence.budgets ?? []).flatMap((budget) => budget.evidence ?? []),
    ...(evidence.components ?? []).flatMap((component) => [
      ...(component.unit ?? []),
      ...(component.browser ?? []),
      ...(component.journey ?? []),
      ...Object.values(component.gateEvidence ?? {}).flat(),
    ]),
    ...(evidence.live?.evidence ?? []),
  ];
}

/** Build the derived matrix and return every contradiction instead of failing at the first one. */
export function buildAppPlatformReferenceQualification(
  inputs,
  options = {},
) {
  const evidence = structuredClone(inputs.evidence);
  const maturity = structuredClone(inputs.maturity);
  const bundleBudgets = structuredClone(inputs.bundleBudgets);
  const now = options.now ?? Date.now();
  const fileExists = options.fileExists ?? (() => true);
  const readText = options.readText ?? (() => "");
  const failures = [];
  const invariant = (condition, message) => {
    if (!condition) failures.push(message);
  };

  invariant(evidence.format === "honua.app-platform.reference-evidence.v1", "evidence format must be v1");
  invariant(evidence.schemaVersion === 1, "evidence schemaVersion must be 1");
  invariant(maturity.format === "honua.app-platform.component-qualification.v1", "maturity matrix format must be v1");
  invariant(evidence.packageMode === "packed", "reference workbench must run in packed package mode");
  invariant(evidence.zeroEgress === true, "reference workbench must declare deterministic zero-egress execution");
  invariant(JSON.stringify(evidence.journey) === JSON.stringify(REQUIRED_JOURNEY), "reference journey is incomplete or reordered");

  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  invariant(Number.isFinite(observedAt), "evidence observedAt is invalid");
  invariant(Number.isFinite(expiresAt), "evidence expiresAt is invalid");
  invariant(observedAt <= now + 5 * 60_000, "evidence is future-dated");
  invariant(expiresAt > observedAt, "evidence expiry must follow observation");
  invariant(expiresAt - observedAt <= 95 * 24 * 60 * 60_000, "evidence validity exceeds 95 days");
  invariant(now <= expiresAt, "reference qualification evidence is stale");

  const laneIds = (evidence.lanes ?? []).map((lane) => lane.id);
  invariant(new Set(laneIds).size === laneIds.length, "reference lanes contain duplicates");
  invariant(sameMembers(laneIds, REQUIRED_LANES), "reference lanes must cover direct custom elements and React hosting");
  const browserIds = (evidence.browsers ?? []).filter((browser) => browser.status === "automated").map((browser) => browser.id);
  invariant(browserIds.includes("chromium"), "the supported Chromium browser lane lacks automated evidence");
  invariant(sameMembers(Object.keys(evidence.states ?? {}), REQUIRED_STATES), "state evidence is incomplete or contradictory");
  const budgetIds = (evidence.budgets ?? []).map((budget) => budget.id);
  invariant(new Set(budgetIds).size === budgetIds.length, "budget evidence contains duplicate ids");
  invariant(sameMembers(budgetIds, REQUIRED_BUDGETS), "first-use, interaction, memory, listener, DOM, and bundle budgets are required");
  for (const budget of evidence.budgets ?? []) {
    invariant(
      budget.status === "verified" || budget.status === "open",
      `budget ${budget.id} must declare verified or open status`,
    );
    invariant(
      budget.status !== "verified" || (budget.evidence?.length ?? 0) > 0,
      `verified budget ${budget.id} has no evidence`,
    );
    invariant(
      budget.status !== "open" || (budget.evidence?.length ?? 0) === 0,
      `open budget ${budget.id} must not cite evidence as if it passed`,
    );
  }

  const bundleBudget = (evidence.budgets ?? []).find((budget) => budget.id === "bundle-gzip");
  invariant(
    bundleBudget?.limit === bundleBudgets.entrypoints?.["/web-components"]?.gzip,
    "bundle budget contradicts bundle-budgets.json /web-components gzip ceiling",
  );

  const maturityById = new Map((maturity.components ?? []).map((component) => [component.id, component]));
  const evidenceById = new Map();
  for (const component of evidence.components ?? []) {
    invariant(!evidenceById.has(component.id), `component evidence contains duplicate id ${component.id}`);
    evidenceById.set(component.id, component);
    const metadata = maturityById.get(component.id);
    invariant(Boolean(metadata), `component evidence ${component.id} is orphaned from maturity metadata`);
    invariant(
      metadata?.supportTier === component.maturity,
      `component evidence ${component.id} maturity contradicts component qualification metadata`,
    );
    const gateIds = Object.keys(component.gateEvidence ?? {});
    invariant(
      gateIds.every((gate) => REQUIRED_COMPONENT_GATES.includes(gate)),
      `component evidence ${component.id} declares an unknown reference gate`,
    );
    for (const [gate, paths] of Object.entries(component.gateEvidence ?? {})) {
      invariant(paths.length > 0, `component evidence ${component.id} gate ${gate} has no evidence`);
    }
  }

  const supported = (maturity.components ?? []).filter((component) => component.supportTier === "production-tier");
  for (const component of supported) {
    const recorded = evidenceById.get(component.id);
    invariant(Boolean(recorded), `supported component ${component.id} has no reference evidence`);
    invariant((recorded?.unit?.length ?? 0) > 0, `supported component ${component.id} has no unit/contract evidence`);
    invariant((recorded?.browser?.length ?? 0) > 0, `supported component ${component.id} has no browser evidence`);
    invariant((recorded?.journey?.length ?? 0) > 0, `supported component ${component.id} has no packed journey evidence`);
  }
  for (const id of evidenceById.keys()) {
    invariant(
      supported.some((component) => component.id === id),
      `component ${id} claims supported reference evidence while maturity is not production-tier`,
    );
  }

  const evidencePaths = sortedUnique(collectEvidencePaths(evidence));
  for (const relative of evidencePaths) {
    invariant(safeEvidencePath(relative), `unsafe evidence path: ${relative}`);
    invariant(fileExists(relative), `evidence file does not exist: ${relative}`);
  }
  if (safeEvidencePath(evidence.workbench) && fileExists(evidence.workbench)) {
    const workbench = readText(evidence.workbench);
    invariant(!workbench.includes("../src/"), "packed workbench imports source-only modules");
    invariant(!workbench.includes("@honua/sdk-js"), "packed workbench imports the deprecated source package");
    invariant(workbench.includes("egressAttempts"), "packed workbench lacks an executable zero-egress guard");
    invariant(workbench.includes("mountHonuaApplication"), "packed workbench bypasses the production application owner");
  }

  if (evidence.live?.status === "recorded") {
    invariant((evidence.live.evidence ?? []).length > 0, "recorded live evidence has no receipt");
    invariant(typeof evidence.live.endpoint === "string", "recorded live evidence has no endpoint");
    invariant(typeof evidence.live.version === "string", "recorded live evidence has no version");
    invariant(typeof evidence.live.authMode === "string", "recorded live evidence has no auth mode");
    invariant(Number.isFinite(Date.parse(evidence.live.observedAt)), "recorded live evidence has no observation date");
    invariant(Number.isFinite(Date.parse(evidence.live.expiresAt)), "recorded live evidence has no freshness expiry");
  } else {
    invariant(
      (evidence.live?.evidence ?? []).length === 0,
      "unrecorded live lane must not carry evidence that could be mistaken for a passing claim",
    );
  }

  const components = supported.map((metadata) => {
    const recorded = evidenceById.get(metadata.id);
    const qualifiedGates = REQUIRED_COMPONENT_GATES.filter(
      (gate) => (recorded?.gateEvidence?.[gate]?.length ?? 0) > 0,
    );
    const openGates = sortedUnique([
      ...metadata.openGates,
      ...REQUIRED_COMPONENT_GATES.filter((gate) => !qualifiedGates.includes(gate)).map(
        (gate) => `reference.${gate}`,
      ),
    ]);
    return {
      id: metadata.id,
      tag: metadata.tag,
      maturity: metadata.supportTier,
      productionQualified: metadata.productionQualified,
      qualifiedGates,
      openGates,
      gateEvidence: recorded?.gateEvidence ?? {},
      unit: recorded?.unit ?? [],
      browser: recorded?.browser ?? [],
      journey: recorded?.journey ?? [],
    };
  });
  const matrix = {
    $schema: "./app-platform-reference-qualification.schema.json",
    format: "honua.app-platform.reference-qualification.v1",
    schemaVersion: 1,
    observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt,
    packageMode: evidence.packageMode,
    zeroEgress: evidence.zeroEgress,
    evidenceDigest: digest(evidence),
    maturityDigest: digest(maturity),
    workbench: evidence.workbench,
    journey: evidence.journey,
    lanes: evidence.lanes,
    browsers: evidence.browsers,
    states: evidence.states,
    budgets: evidence.budgets,
    components,
    live: evidence.live,
    summary: {
      supportedComponents: supported.length,
      componentsWithUnitEvidence: components.filter((component) => component.unit.length > 0).length,
      componentsWithBrowserEvidence: components.filter((component) => component.browser.length > 0).length,
      componentsWithPackedJourneyEvidence: components.filter((component) => component.journey.length > 0).length,
      openQualificationGates: components.reduce((count, component) => count + component.openGates.length, 0),
      openBudgetGates: evidence.budgets.filter((budget) => budget.status === "open").length,
    },
  };
  return { matrix, failures };
}

export function renderAppPlatformReferenceTable(matrix) {
  const lines = [
    DOC_START,
    "",
    "| Supported component | Maturity | Unit / contract | Browser artifact | Packed journey | Open gates |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const component of matrix.components) {
    const open =
      component.openGates.length === 0
        ? "0"
        : `${component.openGates.length} (${component.openGates.map((gate) => `\`${gate}\``).join(", ")})`;
    lines.push(
      `| \`${component.tag}\` | \`${component.maturity}\` | ${component.unit.length} | ${component.browser.length} | ${component.journey.length} | ${open} |`,
    );
  }
  lines.push(
    "",
    `Evidence observed **${matrix.observedAt}** and expires **${matrix.expiresAt}**. ` +
      `The fixture is \`${matrix.packageMode}\` and zero-egress is \`${matrix.zeroEgress}\`.`,
    "",
    `Live lane: \`${matrix.live.status}\` (gate: \`${matrix.live.enabledBy}\`).`,
    `Open budget gates: **${matrix.summary.openBudgetGates}**.`,
    "",
    "Reference gates close only through their explicit `gateEvidence` mapping; generic file presence is not treated as proof.",
    "",
    `[Machine-readable matrix](../${OUTPUT_PATH}) · [Executable packed workbench](../${matrix.workbench})`,
    "",
    DOC_END,
  );
  return lines.join("\n");
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relative), "utf8"));
}

function loadInputs() {
  return {
    evidence: readJson(EVIDENCE_PATH),
    maturity: readJson(MATURITY_PATH),
    bundleBudgets: readJson(BUDGET_PATH),
  };
}

async function main() {
  const command = process.argv[2];
  if (command !== "write" && command !== "check") {
    process.stderr.write("Usage: node scripts/app-platform-reference-qualification.mjs <write|check>\n");
    process.exit(2);
  }
  const nowOverride = process.env.HONUA_APP_PLATFORM_QUALIFICATION_NOW;
  const now = nowOverride ? Date.parse(nowOverride) : Date.now();
  const { matrix, failures } = buildAppPlatformReferenceQualification(loadInputs(), {
    now,
    fileExists: (relative) => fs.existsSync(path.join(PROJECT_ROOT, relative)),
    readText: (relative) => fs.readFileSync(path.join(PROJECT_ROOT, relative), "utf8"),
  });
  if (!fs.existsSync(path.join(PROJECT_ROOT, SCHEMA_PATH))) {
    failures.push(`${SCHEMA_PATH} does not exist`);
  } else {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(readJson(SCHEMA_PATH));
    if (!validate(matrix)) {
      failures.push(`generated matrix violates ${SCHEMA_PATH}: ${ajv.errorsText(validate.errors)}`);
    }
  }
  const serialized = `${JSON.stringify(matrix, null, 2)}\n`;
  const output = path.join(PROJECT_ROOT, OUTPUT_PATH);
  const docPath = path.join(PROJECT_ROOT, DOC_PATH);
  const doc = fs.readFileSync(docPath, "utf8");
  const pattern = new RegExp(`${DOC_START}[\\s\\S]*?${DOC_END}`);
  if (!pattern.test(doc)) failures.push(`${DOC_PATH} is missing generated matrix markers`);
  const table = renderAppPlatformReferenceTable(matrix);
  if (failures.length > 0) {
    process.stderr.write(`App-platform reference qualification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
    process.exit(1);
  }
  if (command === "write") {
    fs.writeFileSync(output, serialized);
    fs.writeFileSync(docPath, doc.replace(pattern, table));
  } else {
    const drift = [];
    if (!fs.existsSync(output) || fs.readFileSync(output, "utf8") !== serialized) drift.push(`${OUTPUT_PATH} has drifted`);
    if (doc.match(pattern)?.[0] !== table) drift.push(`${DOC_PATH} reference table has drifted`);
    if (drift.length > 0) {
      process.stderr.write(`${drift.map((entry) => `- ${entry}`).join("\n")}\nRun npm run qualification:app-platform\n`);
      process.exit(1);
    }
  }
  process.stdout.write(
    `${command === "write" ? "Wrote" : "Verified"} ${OUTPUT_PATH}: ${matrix.summary.supportedComponents} supported components, ` +
      `${matrix.summary.openQualificationGates} open component gates, ${matrix.summary.openBudgetGates} open budget gates, ` +
      `evidence expires ${matrix.expiresAt}.\n`,
  );
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) await main();
