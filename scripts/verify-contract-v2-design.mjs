import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const adrPath = resolve(repoRoot, "docs/decisions/vendor-neutral-source-contract-v2.md");
const designRoot = resolve(repoRoot, "test/design/contract-v2");
const evidenceFiles = ["contracts.ts", "fixtures.ts", "positive.ts", "negative.ts", "tsconfig.json"];
const failures = [];

function fail(message) {
  failures.push(message);
}

for (const file of evidenceFiles) {
  if (!existsSync(resolve(designRoot, file))) {
    fail(`missing contract-v2 evidence file: test/design/contract-v2/${file}`);
  }
}

if (!existsSync(adrPath)) {
  fail("missing contract-v2 ADR");
}

const adr = existsSync(adrPath) ? readFileSync(adrPath, "utf8") : "";
const requiredHeadings = [
  "# Vendor-neutral source contract v2",
  "## Decision summary",
  "## Standards baseline",
  "## Representative TypeScript shapes",
  "## Protocol normalization examples",
  "## Cache, plan and realtime invalidation",
  "## Staged migration",
  "## Backlog ownership audit",
  "## Compile evidence",
];

for (const heading of requiredHeadings) {
  if (!adr.split("\n").includes(heading)) {
    fail(`ADR is missing required anchor: ${heading}`);
  }
}

if (!adr.includes("sole complete normative TypeScript proposal")) {
  fail("ADR must identify contracts.ts as the sole complete normative TypeScript proposal");
}

for (const file of evidenceFiles.slice(0, 4)) {
  const link = `../../test/design/contract-v2/${file}`;
  if (!adr.includes(`](${link})`)) {
    fail(`ADR must link normative evidence file: ${link}`);
  }
}

const markdownLinkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
for (const match of adr.matchAll(markdownLinkPattern)) {
  const target = match[1];
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("#") ||
    target.includes("://")
  ) {
    continue;
  }
  const pathOnly = target.split("#", 1)[0];
  if (pathOnly && !existsSync(resolve(dirname(adrPath), pathOnly))) {
    fail(`ADR contains a broken local link: ${target}`);
  }
}

const typescriptFencePattern = /^```(?:ts|typescript)([^\n]*)\n([\s\S]*?)^```\s*$/gm;
let typescriptFenceCount = 0;
let representativeTypeScriptLines = 0;
for (const match of adr.matchAll(typescriptFencePattern)) {
  typescriptFenceCount += 1;
  representativeTypeScriptLines += match[2].split("\n").length;
  const directive = match[1].trim();
  if (!/^doc-test=skip reason="[^"]+"$/.test(directive)) {
    fail(
      `TypeScript fence ${typescriptFenceCount} must declare exactly ` +
        '`doc-test=skip reason="..."`',
    );
  }
}
if (typescriptFenceCount === 0) {
  fail("ADR must retain at least one representative TypeScript fence");
}
if (representativeTypeScriptLines > 800) {
  fail(
    `ADR contains ${representativeTypeScriptLines} representative TypeScript lines; ` +
      "keep the complete contract in contracts.ts and excerpts at or below 800 lines",
  );
}

const jsonFencePattern = /^```json\s*\n([\s\S]*?)^```\s*$/gm;
let jsonFenceCount = 0;
const jsonExamples = [];
for (const match of adr.matchAll(jsonFencePattern)) {
  jsonFenceCount += 1;
  try {
    jsonExamples.push(JSON.parse(match[1]));
  } catch (error) {
    fail(`JSON fence ${jsonFenceCount} is invalid: ${error.message}`);
  }
}
if (jsonFenceCount === 0) {
  fail("ADR must retain machine-checked JSON examples");
}

function validateSpatialExtent(extent, label) {
  if (extent === null || typeof extent !== "object" || Array.isArray(extent)) {
    fail(`${label} must be a spatial extent object`);
    return;
  }
  if (!Array.isArray(extent.provenance) || extent.provenance.length === 0) {
    fail(`${label} must carry non-empty provenance`);
  }
  if (extent.state === "known") {
    if (!Array.isArray(extent.boxes) || extent.boxes.length === 0 || extent.crs === undefined) {
      fail(`${label} known extent must carry boxes and CRS`);
      return;
    }
    for (const [index, box] of extent.boxes.entries()) {
      const expectedLength = box?.layout === "xy" ? 4 : box?.layout === "xyz" ? 6 : undefined;
      if (expectedLength === undefined || !Array.isArray(box.bounds) || box.bounds.length !== expectedLength) {
        fail(`${label} box ${index} must use an explicit xy/xyz layout and matching bounds`);
      }
    }
  } else if (extent.state === "mixed") {
    if (!Array.isArray(extent.extents) || extent.extents.length < 2) {
      fail(`${label} mixed extent must carry at least two component extents`);
    }
  } else if (!new Set(["empty", "unknown", "none"]).has(extent.state)) {
    fail(`${label} has an unsupported spatial extent state`);
  }
}

for (const [index, example] of jsonExamples.entries()) {
  if (example && typeof example === "object" && !Array.isArray(example) && "extent" in example) {
    validateSpatialExtent(example.extent, `JSON fence ${index + 1} .extent`);
  }
  if (
    example &&
    typeof example === "object" &&
    !Array.isArray(example) &&
    (example.kind === "feature-result" || example.kind === "aggregate-result")
  ) {
    const values = example.kind === "feature-result" ? example.features : example.rows;
    if ("totalCount" in example) {
      fail(`JSON fence ${index + 1} must use explicit count state, not legacy totalCount`);
    }
    if (!Array.isArray(values)) {
      fail(`JSON fence ${index + 1} result must carry an array payload`);
    }
    if (
      example.page === null ||
      typeof example.page !== "object" ||
      !Array.isArray(example.page.evidence) ||
      example.page.evidence.length === 0
    ) {
      fail(`JSON fence ${index + 1} result page must carry non-empty evidence`);
    } else if (Array.isArray(values) && example.page.returned !== values.length) {
      fail(`JSON fence ${index + 1} page.returned must equal its result array length`);
    }
    const expectedScope = example.kind === "feature-result" ? "matched-features" : "result-rows";
    if (
      example.count === null ||
      typeof example.count !== "object" ||
      example.count.scope !== expectedScope ||
      !Array.isArray(example.count.evidence) ||
      example.count.evidence.length === 0
    ) {
      fail(`JSON fence ${index + 1} result must carry an evidence-bearing ${expectedScope} count`);
    } else {
      for (const [evidenceIndex, evidence] of example.count.evidence.entries()) {
        if (
          evidence === null ||
          typeof evidence !== "object" ||
          !new Set(["protocol", "computed", "estimate", "unavailable"]).has(evidence.kind) ||
          typeof evidence.reference !== "string" ||
          evidence.reference.length === 0 ||
          /https?:\/\/|[?&](?:api[_-]?key|token|signature|skiptoken)=/i.test(evidence.reference)
        ) {
          fail(`JSON fence ${index + 1} count evidence ${evidenceIndex} is not sanitized`);
        }
      }
    }
    if (example.count?.state === "exact" || example.count?.state === "estimated") {
      if (
        !Number.isSafeInteger(example.count.value) ||
        example.count.value < 0 ||
        (Array.isArray(values) && example.count.value < values.length)
      ) {
        fail(`JSON fence ${index + 1} result count must be a safe total at least as large as the page`);
      }
      if (
        example.count.state === "estimated" &&
        example.count.confidence !== undefined &&
        (typeof example.count.confidence !== "number" ||
          example.count.confidence < 0 ||
          example.count.confidence > 1)
      ) {
        fail(`JSON fence ${index + 1} estimated count confidence must be between zero and one`);
      }
      if (example.count.state === "exact" && example.count.confidence !== undefined) {
        fail(`JSON fence ${index + 1} exact count cannot carry estimate confidence`);
      }
    } else if (example.count?.state === "unknown") {
      if (typeof example.count.reason !== "string" || "value" in example.count || "confidence" in example.count) {
        fail(`JSON fence ${index + 1} unknown count must carry a reason and no value/confidence`);
      }
    } else {
      fail(`JSON fence ${index + 1} result count has an unsupported state`);
    }
  }
}

const labeledSpatialExtentPattern =
  /<!-- contract-example:(spatial-extent-(?:known|unknown|none)) -->\s*```json\s*\n([\s\S]*?)^```\s*$/gm;
const foundSpatialExtentLabels = new Set();
for (const match of adr.matchAll(labeledSpatialExtentPattern)) {
  foundSpatialExtentLabels.add(match[1]);
  try {
    validateSpatialExtent(JSON.parse(match[2]), `contract example ${match[1]}`);
  } catch (error) {
    fail(`contract example ${match[1]} is invalid JSON: ${error.message}`);
  }
}
for (const label of ["spatial-extent-known", "spatial-extent-unknown", "spatial-extent-none"]) {
  if (!foundSpatialExtentLabels.has(label)) {
    fail(`ADR is missing labeled contract example: ${label}`);
  }
}

const labeledJsonPattern = /<!-- contract-example:([a-z0-9-]+) -->\s*```json\s*\n([\s\S]*?)^```\s*$/gm;
const labeledJson = new Map();
for (const match of adr.matchAll(labeledJsonPattern)) {
  if (labeledJson.has(match[1])) {
    fail(`ADR contains duplicate contract-example label: ${match[1]}`);
    continue;
  }
  try {
    labeledJson.set(match[1], JSON.parse(match[2]));
  } catch (error) {
    fail(`contract example ${match[1]} is invalid JSON: ${error.message}`);
  }
}

for (const protocol of ["ogc-tiles", "ogc-maps"]) {
  for (const scope of ["dataset", "collection"]) {
    const label = `${protocol}-${scope}`;
    const locator = labeledJson.get(label);
    if (locator === undefined) {
      fail(`ADR is missing labeled contract example: ${label}`);
    } else if (locator.protocol !== protocol || locator.scope !== scope) {
      fail(`contract example ${label} must preserve protocol and scope discriminants`);
    } else if (scope === "dataset" && "collectionId" in locator) {
      fail(`contract example ${label} must not carry collectionId`);
    } else if (scope === "collection" && (typeof locator.collectionId !== "string" || locator.collectionId.length === 0)) {
      fail(`contract example ${label} must carry non-empty collectionId`);
    }
  }
}

const codedDomain = labeledJson.get("field-domain-coded");
if (codedDomain === undefined) {
  fail("ADR is missing labeled contract example: field-domain-coded");
} else if (
  codedDomain.state !== "coded" ||
  !new Set(["closed", "open", "unknown"]).has(codedDomain.openness) ||
  !Array.isArray(codedDomain.values) ||
  codedDomain.values.length === 0
) {
  fail("contract example field-domain-coded must carry openness and non-empty values");
} else {
  const values = codedDomain.values.map((entry) => JSON.stringify(entry?.value));
  if (new Set(values).size !== values.length) {
    fail("contract example field-domain-coded contains duplicate canonical values");
  }
}

const rangeDomain = labeledJson.get("field-domain-range");
if (rangeDomain === undefined) {
  fail("ADR is missing labeled contract example: field-domain-range");
} else if (
  rangeDomain.state !== "range" ||
  (rangeDomain.minimum === undefined && rangeDomain.maximum === undefined)
) {
  fail("contract example field-domain-range must carry at least one endpoint");
} else {
  for (const endpoint of [rangeDomain.minimum, rangeDomain.maximum]) {
    if (
      endpoint !== undefined &&
      (endpoint === null ||
        typeof endpoint !== "object" ||
        typeof endpoint.inclusive !== "boolean" ||
        !new Set(["string", "number"]).has(typeof endpoint.value) ||
        (typeof endpoint.value === "number" && !Number.isFinite(endpoint.value)))
    ) {
      fail("contract example field-domain-range endpoints must carry value and inclusivity");
    }
  }
}

const tscPath = resolve(repoRoot, "node_modules/typescript/bin/tsc");
if (!existsSync(tscPath)) {
  fail("TypeScript is not installed; run npm ci before contract design verification");
} else {
  const compile = spawnSync(
    process.execPath,
    [tscPath, "-p", "test/design/contract-v2/tsconfig.json", "--noEmit"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (compile.status !== 0) {
    if (compile.stdout) {
      process.stderr.write(compile.stdout);
    }
    if (compile.stderr) {
      process.stderr.write(compile.stderr);
    }
    fail(`contract-v2 declarations failed to compile (exit ${compile.status ?? "unknown"})`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`contract-v2 design verification: ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `Verified contract-v2 design: ${typescriptFenceCount} representative TypeScript blocks, ` +
    `${jsonFenceCount} JSON examples, linked evidence, and compiled declarations.\n`,
);
