#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { expectedGateCommand } from "./lib/sample-gates.mjs";
import { validateQualificationReceiptSet } from "./sample-gate-receipt.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const ts = require("typescript");
const CATALOG_PATH = "samples/catalog.v2.json";
const V1_CATALOG_PATH = "samples/catalog.v1.json";
const V1_MIGRATION_PATH = "samples/contract/v2/migrations/catalog.v1-to-v2.json";
const CATALOG_SCHEMA_PATH = "samples/contract/v2/schemas/sample-catalog.schema.json";
const MIGRATION_SCHEMA_PATH = "samples/contract/v2/schemas/catalog-migration.schema.json";
const GENERATED_CATALOG_PATH = "docs/generated/sample-catalog.md";
const SITE_PROJECTION_PATH = "samples/dist/honua-site-samples.v2.json";
const SITE_PROJECTION_SCHEMA_PATH = "samples/contract/v2/schemas/site-projection.schema.json";
const CI_SELECTION_PATH = "samples/dist/sample-ci-selection.v2.json";
const CI_SELECTION_SCHEMA_PATH = "samples/contract/v2/schemas/sample-ci-selection.schema.json";
const SITE_CONSUMER_FIXTURE_PATH = "samples/contract/v2/consumer-fixtures/honua-site-consumer.v2.json";
const FIXTURE_BUILD_ENVIRONMENT_HELPER = "../../scripts/lib/fixture-build-environment.mjs";
const REVIEWED_FIXTURE_HARNESS_IMPORTS = new Set([
  FIXTURE_BUILD_ENVIRONMENT_HELPER,
  "../../samples/scenarios/index.mjs",
]);
const EXPECTED_FIXTURE_BUILD_HARNESSES = new Map([
  ["examples/ai-spatial-app-builder/mock-server.mjs", "demo:ai-spatial-builder:build"],
  ["examples/app-bootstrap-basic/mock-server.mjs", "demo:app-bootstrap:build"],
  ["examples/edit-workflow-demo/mock-server.mjs", "demo:edit-workflow:build"],
  ["examples/geocoding-quickstart/mock-server.mjs", "demo:geocoding:build"],
  ["examples/geoprocessing-job-runner/mock-server.mjs", "demo:gp-runner:build"],
  ["examples/imagery-cog-quickstart/mock-server.mjs", "demo:imagery-cog:build"],
  ["examples/maplibre-quickstart/mock-server.mjs", "demo:quickstart:build"],
  ["examples/mcp-gis-assistant/mock-server.mjs", "demo:mcp-gis-assistant:build"],
  ["examples/migration-workbench/mock-server.mjs", "demo:migration-workbench:build"],
  ["examples/oauth-signin/mock-server.mjs", "demo:oauth-signin:build"],
  ["examples/overture-geoparquet/mock-server.mjs", "demo:overture:build:offline"],
  ["examples/planning-permitting-workbench/mock-server.mjs", "demo:planning-workbench:build"],
  ["examples/pmtiles-static/mock-server.mjs", "demo:pmtiles-static:build"],
  ["examples/react-quickstart/mock-server.mjs", "demo:react-quickstart:build"],
  ["examples/realtime-incident-dashboard/mock-server.mjs", "demo:incident:build"],
  ["examples/runtime-parity-showcase/mock-server.mjs", "demo:runtime-parity:build"],
  ["examples/service-explorer/mock-server.mjs", "demo:service-explorer:build"],
  ["examples/sketch-editing/mock-server.mjs", "demo:sketch-editing:build"],
  ["examples/spatial-analytics-workbench/mock-server.mjs", "demo:spatial-analytics:build"],
  ["examples/stac-imagery-browser/mock-server.mjs", "demo:stac-browser:build"],
  ["examples/storytelling-25d-map/mock-server.mjs", "demo:25d:build"],
  ["examples/terrain-rgb-elevation/mock-server.mjs", "demo:terrain-elevation:build"],
  ["examples/unified-ops-workspace/mock-server.mjs", "demo:unified-ops:build"],
  ["examples/web-components-basic/mock-server.mjs", "demo:web-components:build"],
]);
const CHILD_PROCESS_LAUNCH_APIS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);
const REVIEWED_NON_BUILD_CHILD_LAUNCHES = new Set([
  "git\0rev-parse\0--show-toplevel",
  "git\0rev-parse\0HEAD",
  "git\0status",
  "git\0status\0--short",
]);
const README_START = "<!-- sample-catalog:start -->";
const README_END = "<!-- sample-catalog:end -->";
const RESERVED_GOLDEN_JOURNEY_IDS = [
  "first-map",
  "service-explorer",
  "planning-permitting",
  "incident-operations",
  "imagery-terrain",
  "cloud-native-analysis",
  "arcgis-migration",
];
const SAMPLE_SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".ts", ".tsx"]);
const CONFIGURATION_NAME_PATTERN = /^(?:HONUA|STANDALONE|VITE)_[A-Z0-9_]+$/;
const STANDARD_CONFIGURATION_EXEMPTIONS = new Map([
  ["GITHUB_SHA", "github-actions"],
  ["MODE", "vite"],
]);
const CREDENTIAL_QUERY_PARAMETER_SET = new Set([
  "access_key",
  "access_key_id",
  "access_token",
  "api_key",
  "apikey",
  "auth_token",
  "authorization",
  "aws_access_key_id",
  "awsaccesskeyid",
  "bearer_token",
  "client_secret",
  "credential",
  "id_token",
  "key",
  "password",
  "private_key",
  "refresh_token",
  "sas",
  "secret",
  "sig",
  "signature",
  "subscription_key",
  "token",
  "x_amz_credential",
  "x_amz_signature",
  "x_api_key",
  "x_goog_signature",
]);
const CREDENTIAL_QUERY_PARAMETERS = [...CREDENTIAL_QUERY_PARAMETER_SET].sort();
const ABSOLUTE_URL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`\\]+/gu;
const AWS_ACCESS_KEY_ID_PATTERN = /\bAKIA[0-9A-Z]{16}\b/u;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const BEARER_VALUE_PATTERN = /\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)/giu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /(?:^|[\s"'({,;?&#])(?:access[_-]?key(?:[_-]?id)?|access[_-]?token|api[_-]?key|auth[_-]?token|authorization|bearer[_-]?token|client[_-]?secret|credential|id[_-]?token|password|private[_-]?key|refresh[_-]?token|secret|sig(?:nature)?|subscription[_-]?key|token)\s*[:=]\s*["']?([A-Za-z0-9._~+/-]{8,}=*)/giu;
const SAFE_CREDENTIAL_PLACEHOLDER_PATTERN =
  /^(?:allowed|auth(?:entication|orization)?|config(?:uration|ured)?|credentials?|denied|disabled|documentation|enabled|env(?:ironment)?|example|external|granted|host-mediated|missing|none|not-applicable|not-required|null|omitted|optional|placeholder|present|redacted|rejected|required|runtime|unavailable|undefined|unknown)(?:[-_.].*)?$/iu;
const CREDENTIAL_CONFIGURATION_NAME_PATTERN =
  /(?:^|_)(?:ACCESS_KEY|API_KEY|BEARER_TOKEN|CLIENT_SECRET|CREDENTIAL|PASSWORD|PRIVATE_KEY|REFRESH_TOKEN|SECRET|TOKEN)(?:_|$)/u;
const MAX_SENSITIVE_METADATA_DEPTH = 64;
const MAX_SENSITIVE_METADATA_NODES = 50_000;
const REVIEWED_LIVE_PRODUCERS = new Map([
  [
    "bench:live",
    {
      definition: "node scripts/live-benchmark-evidence.mjs --output test-results/live-benchmark-evidence.json",
      generatorPath: "scripts/live-benchmark-evidence.mjs",
    },
  ],
  [
    "demo:ai-spatial-builder:live-evidence",
    {
      definition: "node examples/ai-spatial-app-builder/live-evidence.mjs",
      generatorPath: "examples/ai-spatial-app-builder/live-evidence.mjs",
    },
  ],
  [
    "demo:spatial-analytics:live-evidence",
    {
      definition: "npm run build --silent && node examples/spatial-analytics-workbench/live-evidence.mjs",
      generatorPath: "examples/spatial-analytics-workbench/live-evidence.mjs",
      dependencies: {
        build: "node scripts/prepare-sdk-test-artifacts.mjs --force-build",
        clean: "rm -rf dist",
        compile: "npm run clean --silent && tsc -p tsconfig.json",
      },
    },
  ],
  [
    "evidence:first-map:live",
    {
      definition: "node scripts/first-map-live-evidence.mjs --output examples/maplibre-quickstart/evidence/live.v1.json",
      generatorPath: "scripts/first-map-live-evidence.mjs",
      sampleId: "maplibre-quickstart",
      operation: "first-map-anonymous-public-endpoint",
    },
  ],
  [
    "evidence:overture:live",
    {
      definition: "node scripts/overture-live-evidence.mjs --output test-results/overture-live-evidence.json",
      generatorPath: "scripts/overture-live-evidence.mjs",
    },
  ],
  [
    "evidence:cog:live",
    {
      definition: "npm run build --silent && node scripts/cog-live-evidence.mjs --output test-results/cog-live-evidence.json --strict",
      generatorPath: "scripts/cog-live-evidence.mjs",
      dependencies: {
        build: "node scripts/prepare-sdk-test-artifacts.mjs --force-build",
        clean: "rm -rf dist",
        compile: "npm run clean --silent && tsc -p tsconfig.json",
      },
    },
  ],
]);
const REVIEWED_BUILD_TYPECHECK_DEMOS = [
  "25d",
  "ai-spatial-builder",
  "app-bootstrap",
  "edit-workflow",
  "geocoding",
  "gp-runner",
  "imagery-cog",
  "incident",
  "mcp-gis-assistant",
  "migration-workbench",
  "nl-map-control",
  "oauth-signin",
  "overture",
  "planning-workbench",
  "pmtiles-static",
  "quickstart",
  "react-quickstart",
  "runtime-parity",
  "service-explorer",
  "sketch-editing",
  "spatial-analytics",
  "stac-browser",
  "temporal-playback",
  "terrain-elevation",
  "unified-ops",
  "web-components",
];
const REVIEWED_VALIDATION_SCRIPTS = new Set([
  ...REVIEWED_BUILD_TYPECHECK_DEMOS.flatMap((name) => [`demo:${name}:build`, `demo:${name}:typecheck`]),
  "demo:ai-spatial-builder:evidence",
  "demo:kepler:build",
  "demo:kepler:smoke",
  "demo:node-backend:smoke",
  "demo:node-backend:typecheck",
  "demo:overture:build:offline",
  "demo:overture:prepare",
  "demo:spatial-analytics:evidence",
  "test:migration:real-samples",
  "test:playwright:ai-spatial-builder",
  "test:playwright:imagery-cog",
  "test:playwright:incident",
  "test:playwright:migration-workbench",
  "test:playwright:overture",
  "test:playwright:quickstart",
  "test:playwright:service-explorer",
  "test:playwright:sketch-editing",
  "test:playwright:spatial-analytics",
]);
const BOUNDED_VALIDATION_SEGMENTS = [
  /^npm --prefix examples\/kepler-analytics run build$/,
  /^npm run build --silent$/,
  /^node examples\/(?:ai-spatial-app-builder|spatial-analytics-workbench)\/evidence-check\.mjs$/,
  /^node examples\/node-backend-quickstart\/dist\/smoke\.js$/,
  /^node examples\/overture-geoparquet\/prepare-duckdb-extension\.mjs$/,
  /^node scripts\/ensure-kepler-demo-deps\.mjs$/,
  /^playwright test test\/playwright\/[a-z0-9.-]+\.spec\.mjs$/,
  /^playwright test --config playwright\.first-map\.config\.mjs test\/playwright\/quickstart-map\.spec\.mjs$/,
  /^tsc -p examples\/[a-z0-9-]+\/tsconfig(?:\.build)?\.json(?: --noEmit)?$/,
  /^vite build --config examples\/[a-z0-9-]+\/vite\.config\.ts$/,
  /^vitest run(?: test\/[a-z0-9.-]+\.test\.ts)+$/,
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedUnique(values, label) {
  invariant(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  const sorted = [...values].sort();
  invariant(new Set(values).size === values.length, `${label} contains duplicates`);
  invariant(JSON.stringify(values) === JSON.stringify(sorted), `${label} must be sorted`);
}

function assertRelativePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty path`);
  invariant(!path.isAbsolute(value) && !value.includes(".."), `${label} must stay inside the repository`);
}

export function parseJsonDocument(source, label = "JSON document") {
  invariant(typeof source === "string", `${label} must be text`);
  const value = JSON.parse(source);
  const sourceFile = ts.parseJsonText(label, source);
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Map();
      for (const property of node.properties) {
        const key = propertyName(property.name);
        if (key === undefined) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile));
        const firstLine = seen.get(key);
        invariant(
          firstLine === undefined,
          `${label}:${line + 1}: duplicate JSON property "${key}" (first declared at line ${firstLine})`,
        );
        seen.set(key, line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return value;
}

async function readJson(relativePath) {
  return parseJsonDocument(await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"), relativePath);
}

async function validateJsonSchema(value, schemaPath) {
  const schema = await readJson(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(value)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error(`${schemaPath}: JSON Schema validation failed: ${details}`);
}

function parseDateTime(value, label) {
  invariant(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
    `${label} must be an RFC 3339 date-time`,
  );
  return Date.parse(value);
}

function parseRelease(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version ?? "");
  invariant(match, `${label} must be a semantic release`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

export function compareReleases(left, right) {
  const leftRelease = parseRelease(left, "package version");
  const rightRelease = parseRelease(right, "target release");
  for (let index = 0; index < leftRelease.core.length; index += 1) {
    if (leftRelease.core[index] !== rightRelease.core[index]) {
      return leftRelease.core[index] - rightRelease.core[index];
    }
  }
  if (leftRelease.prerelease.length === 0) return rightRelease.prerelease.length === 0 ? 0 : 1;
  if (rightRelease.prerelease.length === 0) return -1;
  const length = Math.max(leftRelease.prerelease.length, rightRelease.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftRelease.prerelease[index];
    const rightPart = rightRelease.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

async function pathExists(relativePath) {
  try {
    await stat(path.join(PROJECT_ROOT, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseCatalogCommand(command) {
  invariant(typeof command === "string", "catalog commands must be strings");
  const npm = /^npm run ([a-z0-9][a-z0-9:_-]*)$/.exec(command);
  if (npm) return { runner: "npm", script: npm[1] };

  const npx = /^npx (playwright test|vitest run) ([A-Za-z0-9][A-Za-z0-9._/-]*)$/.exec(command);
  invariant(npx, `unsafe or unsupported catalog command: ${command}`);
  const target = npx[2];
  assertRelativePath(target, `catalog command target ${target}`);
  if (npx[1] === "playwright test") {
    invariant(/\.spec\.mjs$/.test(target), `Playwright catalog commands must target one .spec.mjs file: ${command}`);
    return { runner: "playwright", target };
  }
  invariant(/\.test\.(?:mjs|ts)$/.test(target), `Vitest catalog commands must target one test file: ${command}`);
  return { runner: "vitest", target };
}

async function validateCatalogCommand(command, sampleId, packageJson) {
  const parsed = parseCatalogCommand(command);
  if (parsed.runner === "npm") {
    invariant(packageJson.scripts?.[parsed.script], `${sampleId}: unknown package script ${parsed.script}`);
    return parsed;
  }
  const dependency = parsed.runner === "playwright" ? "@playwright/test" : "vitest";
  invariant(packageJson.devDependencies?.[dependency], `${sampleId}: ${dependency} must be installed by the repository`);
  invariant(await pathExists(parsed.target), `${sampleId}: catalog command target does not exist: ${parsed.target}`);
  return parsed;
}

function isBoundedLiveCommand(parsed, packageJson) {
  if (parsed.runner !== "npm") return false;
  const producer = REVIEWED_LIVE_PRODUCERS.get(parsed.script);
  if (!producer || producer.definition !== packageJson.scripts?.[parsed.script]) return false;
  const reviewed = { [parsed.script]: producer.definition, ...(producer.dependencies ?? {}) };
  return Object.entries(reviewed).every(
    ([script, definition]) =>
      packageJson.scripts?.[script] === definition &&
      !Object.hasOwn(packageJson.scripts ?? {}, `pre${script}`) &&
      !Object.hasOwn(packageJson.scripts ?? {}, `post${script}`),
  );
}

function isBoundedValidationCommand(parsed, packageJson) {
  if (parsed.runner !== "npm") return true;
  if (!REVIEWED_VALIDATION_SCRIPTS.has(parsed.script)) return false;
  const definition = packageJson.scripts?.[parsed.script];
  if (typeof definition !== "string") return false;
  const segments = definition.split("&&").map((segment) => segment.trim());
  return (
    segments.length > 0 &&
    segments.every((segment) => BOUNDED_VALIDATION_SEGMENTS.some((pattern) => pattern.test(segment)))
  );
}

function normalizeCredentialQueryParameter(name) {
  return name
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isCredentialQueryParameter(name) {
  const normalized = normalizeCredentialQueryParameter(name);
  return [...CREDENTIAL_QUERY_PARAMETER_SET].some(
    (candidate) => normalized === candidate || normalized.endsWith(`_${candidate}`),
  );
}

function isSafeCredentialPlaceholder(value) {
  return SAFE_CREDENTIAL_PLACEHOLDER_PATTERN.test(value);
}

function isCredentialConfigurationReference(value) {
  let name = value;
  if (name.startsWith("${") && name.endsWith("}")) name = name.slice(2, -1);
  for (const prefix of ["process.env.", "import.meta.env."]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  return /^[A-Z][A-Z0-9_]+$/.test(name) && CREDENTIAL_CONFIGURATION_NAME_PATTERN.test(name);
}

function containsCredentialValue(value) {
  if (
    AWS_ACCESS_KEY_ID_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value)
  ) {
    return true;
  }
  for (const match of value.matchAll(BEARER_VALUE_PATTERN)) {
    if (!isSafeCredentialPlaceholder(match[1])) return true;
  }
  for (const match of value.matchAll(CREDENTIAL_ASSIGNMENT_PATTERN)) {
    if (!isSafeCredentialPlaceholder(match[1])) return true;
  }
  return false;
}

function validateSensitiveString(value, label) {
  for (const match of value.matchAll(ABSOLUTE_URL_PATTERN)) {
    let url;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    invariant(!url.username && !url.password, `${label} URL must not contain embedded credentials`);
    for (const parameter of url.searchParams.keys()) {
      invariant(
        !isCredentialQueryParameter(parameter),
        `${label} URL contains forbidden credential query parameter ${parameter}`,
      );
    }
  }
  invariant(!containsCredentialValue(value), `${label} contains a credential value`);
}

function validateSensitiveMetadata(value, label) {
  const activeObjects = new WeakSet();
  let nodeCount = 0;
  const countNode = (location) => {
    nodeCount += 1;
    invariant(
      nodeCount <= MAX_SENSITIVE_METADATA_NODES,
      `${label}${location} exceeds the ${MAX_SENSITIVE_METADATA_NODES}-node metadata limit`,
    );
  };
  const visit = (current, location, depth, sensitiveContext = false) => {
    invariant(
      depth <= MAX_SENSITIVE_METADATA_DEPTH,
      `${label}${location} exceeds the metadata depth limit of ${MAX_SENSITIVE_METADATA_DEPTH}`,
    );
    countNode(location);
    if (typeof current === "string") {
      validateSensitiveString(current, `${label}${location}`);
      if (sensitiveContext) {
        invariant(
          isSafeCredentialPlaceholder(current) || isCredentialConfigurationReference(current),
          `${label}${location} contains a credential value under a sensitive property name`,
        );
      }
      return;
    }
    if (!current || typeof current !== "object") {
      if (sensitiveContext && current !== null && current !== undefined && typeof current !== "boolean") {
        throw new Error(`${label}${location} contains a credential value under a sensitive property name`);
      }
      return;
    }
    invariant(!activeObjects.has(current), `${label}${location} contains a cyclic metadata reference`);
    activeObjects.add(current);
    try {
      if (Array.isArray(current)) {
        current.forEach((entry, index) => visit(entry, `${location}[${index}]`, depth + 1, sensitiveContext));
        return;
      }
      for (const [key, entry] of Object.entries(current)) {
        countNode(`${location}.${key}#key`);
        validateSensitiveString(key, `${label}${location} property name`);
        visit(entry, `${location}.${key}`, depth + 1, sensitiveContext || isCredentialQueryParameter(key));
      }
    } finally {
      activeObjects.delete(current);
    }
  };
  visit(value, "$", 0);
}

export function classifyConfigurationName(name) {
  const isCredential =
    name !== "VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN" &&
    name !== "HONUA_SERVICE_ACCOUNT_TOKEN_TTL_MS" &&
    /(?:^|_)(?:ACCESS_KEY|API_KEY|BEARER_TOKEN|CLIENT_SECRET|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/.test(name);
  return {
    name,
    exposure: name.startsWith("VITE_") ? "browser-public" : "server-only",
    valueKind: isCredential ? "credential" : "non-secret",
    ...(isCredential
      ? { credentialScope: name === "VITE_MAPBOX_TOKEN" ? "public-token" : "secret" }
      : {}),
  };
}

function stringLiteralValue(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return undefined;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return undefined;
}

function analyzeConfigurationSource(sourceFile, file) {
  const names = new Set();
  const wholeEnvironmentEscapes = [];
  const declarations = [];
  const calls = [];
  const lexicalValueDeclarations = [];
  const functionInfoByNode = new Map();

  const collect = (node) => {
    if (ts.isVariableDeclaration(node)) {
      declarations.push(node);
    }
    if (ts.isCallExpression(node)) calls.push(node);
    if (
      (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      lexicalValueDeclarations.push(node);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      lexicalValueDeclarations.push(node.variableDeclaration);
    }
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const name = functionName(node);
      const info = {
        name,
        node,
      };
      functionInfoByNode.set(node, info);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const enclosingFunction = (node) => {
    let current = node.parent;
    while (current) {
      const info = functionInfoByNode.get(current);
      if (info) return info;
      current = current.parent;
    }
    return undefined;
  };
  const isLexicalScope = (node) =>
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node);
  const variableScope = (declaration) => {
    const declarationList = declaration.parent;
    let current = declaration.parent;
    if (
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      while (current && !ts.isSourceFile(current) && !functionInfoByNode.has(current)) {
        current = current.parent;
      }
      return current;
    }
    while (current && !isLexicalScope(current)) {
      current = current.parent;
    }
    return current;
  };
  const lexicalBindingsByName = new Map();
  const addLexicalBinding = (scope, name, node) => {
    if (!scope) return;
    if (!lexicalBindingsByName.has(name)) lexicalBindingsByName.set(name, []);
    lexicalBindingsByName.get(name).push({ scope, node });
  };
  const declarationScope = (node) => {
    let current = node.parent;
    while (current && !isLexicalScope(current) && !functionInfoByNode.has(current)) {
      current = current.parent;
    }
    return current;
  };
  const addBindingName = (scope, name, binding) => {
    if (ts.isIdentifier(name)) {
      addLexicalBinding(scope, name.text, binding);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingName(scope, element.name, element);
    }
  };
  for (const info of functionInfoByNode.values()) {
    for (const parameter of info.node.parameters) {
      addBindingName(info.node, parameter.name, parameter);
    }
  }
  for (const declaration of declarations) {
    addBindingName(variableScope(declaration), declaration.name, declaration);
  }
  for (const declaration of lexicalValueDeclarations) {
    if (ts.isVariableDeclaration(declaration)) {
      addBindingName(declaration.parent, declaration.name, declaration);
    } else {
      addLexicalBinding(declarationScope(declaration), declaration.name.text, declaration);
    }
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const { importClause } = statement;
    if (importClause.name) addLexicalBinding(sourceFile, importClause.name.text, importClause);
    if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
      addLexicalBinding(sourceFile, importClause.namedBindings.name.text, importClause.namedBindings);
    }
    if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const element of importClause.namedBindings.elements) {
        addLexicalBinding(sourceFile, element.name.text, element);
      }
    }
  }

  const lexicalScopeChain = (node) => {
    const scopes = [];
    let current = node.parent;
    while (current) {
      if (isLexicalScope(current) || functionInfoByNode.has(current)) scopes.push(current);
      current = current.parent;
    }
    return scopes;
  };
  const resolveLexicalBinding = (identifier) => {
    const bindings = lexicalBindingsByName.get(identifier.text) ?? [];
    const visible = [];
    let ambiguous = false;
    for (const scope of lexicalScopeChain(identifier)) {
      const scoped = bindings.filter((binding) => binding.scope === scope);
      if (scoped.length > 1) ambiguous = true;
      if (scoped.length > 0) visible.push(...scoped);
    }
    return {
      binding: visible[0]?.node,
      ambiguous,
      shadowed: visible.length > 1,
    };
  };

  const functionInfoByBinding = new Map();
  for (const info of functionInfoByNode.values()) {
    let binding;
    if (ts.isFunctionDeclaration(info.node) && info.node.name) {
      binding = info.node;
      addLexicalBinding(declarationScope(info.node), info.node.name.text, binding);
    } else if (ts.isVariableDeclaration(info.node.parent) && ts.isIdentifier(info.node.parent.name)) {
      binding = info.node.parent;
    } else if (ts.isFunctionExpression(info.node) && info.node.name) {
      binding = info.node;
    }
    info.binding = binding;
    if (binding && (!ts.isFunctionDeclaration(info.node) || info.node.body)) {
      functionInfoByBinding.set(binding, info);
    }
    if (ts.isFunctionExpression(info.node) && info.node.name) {
      addLexicalBinding(info.node, info.node.name.text, info.node);
      functionInfoByBinding.set(info.node, info);
    }
  }

  const carrierKinds = new Map();
  const environmentHostKindsByBinding = new Map();
  const processModuleLoaderFactoryBindings = new Set();
  const processModuleLoaderBindings = new Set();
  const mergeKinds = (map, binding, kinds) => {
    if (!binding || kinds.size === 0) return false;
    if (!map.has(binding)) map.set(binding, new Set());
    const current = map.get(binding);
    const size = current.size;
    for (const kind of kinds) current.add(kind);
    return current.size !== size;
  };
  const mergeCarrierKinds = (binding, kinds) => mergeKinds(carrierKinds, binding, kinds);
  const mergeEnvironmentHostKinds = (binding, kinds) =>
    mergeKinds(environmentHostKindsByBinding, binding, kinds);
  const staticMemberName = (node) => {
    const expression = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression)) {
      return stringLiteralValue(unwrapExpression(expression.argumentExpression));
    }
    return undefined;
  };
  const isProcessModuleDynamicImport = (node) => {
    const expression = unwrapExpression(node);
    if (!ts.isCallExpression(expression) || expression.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
    const moduleName = expression.arguments[0] ? stringLiteralValue(expression.arguments[0]) : undefined;
    return moduleName === "node:process" || moduleName === "process";
  };
  const processModuleLoadKinds = (node) => {
    if (!node) return new Set();
    const expression = unwrapExpression(node);
    if (ts.isAwaitExpression(expression)) {
      return isProcessModuleDynamicImport(expression.expression)
        ? new Set(["process.env"])
        : processModuleLoadKinds(expression.expression);
    }
    if (ts.isCallExpression(expression)) {
      const moduleName = expression.arguments[0] ? stringLiteralValue(expression.arguments[0]) : undefined;
      if (moduleName !== "node:process" && moduleName !== "process") return new Set();
      if (expression.expression.kind === ts.SyntaxKind.ImportKeyword) return new Set();
      const target = unwrapExpression(expression.expression);
      if (ts.isIdentifier(target)) {
        const resolution = resolveLexicalBinding(target);
        if (!resolution.ambiguous && processModuleLoaderBindings.has(resolution.binding)) {
          return new Set(["process.env"]);
        }
      }
      return new Set();
    }
    if (staticMemberName(expression) === "default") {
      return processModuleLoadKinds(expression.expression);
    }
    return new Set();
  };
  const environmentHostKinds = (node) => {
    if (!node) return new Set();
    const expression = unwrapExpression(node);
    const loadedKinds = processModuleLoadKinds(expression);
    if (loadedKinds.size > 0) return loadedKinds;
    if (staticMemberName(expression) === "default") {
      const namespaceKinds = environmentHostKinds(expression.expression);
      if (namespaceKinds.size > 0) return namespaceKinds;
    }
    if (ts.isMetaProperty(expression) && expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      return new Set(["import.meta.env"]);
    }
    if (ts.isIdentifier(expression)) {
      const resolution = resolveLexicalBinding(expression);
      if (resolution.ambiguous) return new Set();
      if (resolution.binding) {
        return new Set(environmentHostKindsByBinding.get(resolution.binding) ?? []);
      }
      return expression.text === "process" ? new Set(["process.env"]) : new Set();
    }
    if (staticMemberName(expression) !== "process") return new Set();
    const container = unwrapExpression(expression.expression);
    if (!ts.isIdentifier(container) || !["global", "globalThis"].includes(container.text)) return new Set();
    const resolution = resolveLexicalBinding(container);
    return !resolution.ambiguous && !resolution.binding ? new Set(["process.env"]) : new Set();
  };
  const environmentKinds = (node) => {
    if (!node) return new Set();
    const expression = unwrapExpression(node);
    if (
      (ts.isPropertyAccessExpression(expression) && expression.name.text === "env") ||
      (ts.isElementAccessExpression(expression) &&
        stringLiteralValue(unwrapExpression(expression.argumentExpression)) === "env")
    ) {
      return environmentHostKinds(expression.expression);
    }
    if (!ts.isIdentifier(expression)) return new Set();
    const resolution = resolveLexicalBinding(expression);
    if (resolution.ambiguous) return new Set();
    return new Set(carrierKinds.get(resolution.binding) ?? []);
  };
  const localFunctionForCall = (call) => {
    const target = unwrapExpression(call.expression);
    if (!ts.isIdentifier(target)) return undefined;
    const resolution = resolveLexicalBinding(target);
    if (resolution.ambiguous || !resolution.binding) return undefined;
    const info = functionInfoByBinding.get(resolution.binding);
    if (!info || !ts.isVariableDeclaration(resolution.binding)) return info;
    const declarationList = resolution.binding.parent;
    return ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0
      ? info
      : undefined;
  };
  const assertConstEnvironmentAlias = (declaration) => {
    const declarationList = declaration.parent;
    invariant(
      ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0,
      `${file}: environment aliases must be const`,
    );
  };
  const projectEnvironmentHostPattern = (pattern, kinds) => {
    let changed = false;
    for (const element of pattern.elements) {
      invariant(!element.dotDotDotToken, `${file}: environment host rest destructuring is not statically bounded`);
      const name = element.propertyName
        ? propertyName(element.propertyName)
        : ts.isIdentifier(element.name)
          ? element.name.text
          : undefined;
      if (name !== "env") continue;
      invariant(ts.isIdentifier(element.name), `${file}: nested environment host destructuring is not supported`);
      if (mergeCarrierKinds(element, kinds)) changed = true;
    }
    return changed;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const moduleName = stringLiteralValue(statement.moduleSpecifier);
    const { importClause } = statement;
    if ((moduleName === "node:module" || moduleName === "module") && importClause.namedBindings) {
      if (ts.isNamedImports(importClause.namedBindings)) {
        for (const element of importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "createRequire") processModuleLoaderFactoryBindings.add(element);
        }
      }
      continue;
    }
    if (moduleName !== "node:process" && moduleName !== "process") continue;
    if (importClause.name) {
      mergeEnvironmentHostKinds(importClause, new Set(["process.env"]));
    }
    if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
      mergeEnvironmentHostKinds(importClause.namedBindings, new Set(["process.env"]));
    }
    if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
      for (const element of importClause.namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "env") mergeCarrierKinds(element, new Set(["process.env"]));
        if (importedName === "default") {
          mergeEnvironmentHostKinds(element, new Set(["process.env"]));
        }
      }
    }
  }
  for (const declaration of declarations) {
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    const initializer = unwrapExpression(declaration.initializer);
    if (!ts.isCallExpression(initializer)) continue;
    const target = unwrapExpression(initializer.expression);
    if (!ts.isIdentifier(target)) continue;
    const resolution = resolveLexicalBinding(target);
    if (resolution.ambiguous || !processModuleLoaderFactoryBindings.has(resolution.binding)) continue;
    assertConstEnvironmentAlias(declaration);
    processModuleLoaderBindings.add(declaration);
  }

  let carriersChanged = true;
  while (carriersChanged) {
    carriersChanged = false;
    for (const info of functionInfoByNode.values()) {
      for (const parameter of info.node.parameters) {
        if (parameter.initializer && mergeCarrierKinds(parameter, environmentKinds(parameter.initializer))) {
          carriersChanged = true;
        }
        if (
          parameter.initializer &&
          mergeEnvironmentHostKinds(parameter, environmentHostKinds(parameter.initializer))
        ) {
          carriersChanged = true;
        }
        const hostKinds = environmentHostKindsByBinding.get(parameter) ?? new Set();
        if (
          hostKinds.size > 0 &&
          ts.isObjectBindingPattern(parameter.name) &&
          projectEnvironmentHostPattern(parameter.name, hostKinds)
        ) {
          carriersChanged = true;
        }
      }
    }
    for (const declaration of declarations) {
      if (!declaration.initializer) continue;
      const hostKinds = environmentHostKinds(declaration.initializer);
      if (hostKinds.size > 0) {
        assertConstEnvironmentAlias(declaration);
        if (ts.isIdentifier(declaration.name)) {
          if (mergeEnvironmentHostKinds(declaration, hostKinds)) carriersChanged = true;
        } else if (
          ts.isObjectBindingPattern(declaration.name) &&
          projectEnvironmentHostPattern(declaration.name, hostKinds)
        ) {
          carriersChanged = true;
        }
      }
      const kinds = environmentKinds(declaration.initializer);
      if (kinds.size === 0 || !ts.isIdentifier(declaration.name)) continue;
      assertConstEnvironmentAlias(declaration);
      if (mergeCarrierKinds(declaration, kinds)) carriersChanged = true;
    }
    for (const call of calls) {
      const target = localFunctionForCall(call);
      if (!target) continue;
      for (let index = 0; index < call.arguments.length; index += 1) {
        const parameter = target.node.parameters[index];
        if (parameter && mergeCarrierKinds(parameter, environmentKinds(call.arguments[index]))) {
          carriersChanged = true;
        }
        if (parameter && mergeEnvironmentHostKinds(parameter, environmentHostKinds(call.arguments[index]))) {
          carriersChanged = true;
        }
      }
    }
  }

  const isEnvironmentObject = (node) => environmentKinds(node).size > 0;

  const inventoryObjectBinding = (pattern) => {
    for (const element of pattern.elements) {
      invariant(!element.dotDotDotToken, `${file}: environment rest destructuring is not statically bounded`);
      invariant(ts.isIdentifier(element.name), `${file}: nested environment destructuring is not supported`);
      const name = element.propertyName ? propertyName(element.propertyName) : element.name.text;
      invariant(name && /^[A-Z][A-Z0-9_]+$/.test(name), `${file}: environment destructuring key is not static`);
      names.add(name);
    }
  };

  for (const declaration of declarations) {
    if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) continue;
    if (!isEnvironmentObject(declaration.initializer)) continue;
    inventoryObjectBinding(declaration.name);
  }
  for (const info of functionInfoByNode.values()) {
    for (const parameter of info.node.parameters) {
      if (ts.isObjectBindingPattern(parameter.name) && carrierKinds.has(parameter)) {
        inventoryObjectBinding(parameter.name);
      }
    }
  }

  const isAssignmentOperator = (kind) =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const isWriteReference = (identifier) => {
    let expression = identifier;
    let parent = expression.parent;
    while (parent) {
      if (
        (ts.isParenthesizedExpression(parent) ||
          ts.isAsExpression(parent) ||
          ts.isTypeAssertionExpression(parent) ||
          ts.isNonNullExpression(parent)) &&
        parent.expression === expression
      ) {
        expression = parent;
        parent = parent.parent;
        continue;
      }
      if (
        (ts.isArrayLiteralExpression(parent) && parent.elements.includes(expression)) ||
        (ts.isPropertyAssignment(parent) && parent.initializer === expression) ||
        (ts.isShorthandPropertyAssignment(parent) && parent.name === expression) ||
        (ts.isSpreadAssignment(parent) && parent.expression === expression) ||
        (ts.isObjectLiteralExpression(parent) && parent.properties.includes(expression))
      ) {
        expression = parent;
        parent = parent.parent;
        continue;
      }
      break;
    }
    if (ts.isBinaryExpression(parent) && parent.left === expression) {
      return isAssignmentOperator(parent.operatorToken.kind);
    }
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
      return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
    }
    return (
      (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === expression
    );
  };
  const bindingWriteCache = new Map();
  const bindingHasWrites = (binding) => {
    if (bindingWriteCache.has(binding)) return bindingWriteCache.get(binding);
    let assigned = false;
    const visit = (node) => {
      if (assigned) return;
      if (ts.isIdentifier(node) && node.text === binding.name.text && isWriteReference(node)) {
        if (resolveLexicalBinding(node).binding === binding) {
          assigned = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    bindingWriteCache.set(binding, assigned);
    return assigned;
  };

  const resolveFiniteNames = (node, seenBindings = new Set()) => {
    if (!node) return undefined;
    const expression = unwrapExpression(node);
    const literal = stringLiteralValue(expression);
    if (literal && /^[A-Z][A-Z0-9_]+$/.test(literal)) return [literal];
    if (ts.isIdentifier(expression)) {
      const resolution = resolveLexicalBinding(expression);
      invariant(!resolution.ambiguous, `${file}: ambiguous finite environment key ${expression.text}`);
      invariant(!resolution.shadowed, `${file}: shadowed finite environment key ${expression.text}`);
      const binding = resolution.binding;
      if (!binding || ts.isParameter(binding)) return undefined;
      invariant(ts.isVariableDeclaration(binding), `${file}: unsupported environment key binding ${expression.text}`);
      const declarationList = binding.parent;
      invariant(
        ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0,
        `${file}: finite environment key binding ${expression.text} must be const`,
      );
      invariant(
        !bindingHasWrites(binding),
        `${file}: finite environment key binding ${expression.text} must not be assigned`,
      );
      invariant(!seenBindings.has(binding), `${file}: cyclic finite environment key binding ${expression.text}`);
      if (!binding.initializer) return undefined;
      const nextSeen = new Set(seenBindings);
      nextSeen.add(binding);
      return resolveFiniteNames(binding.initializer, nextSeen);
    }
    return undefined;
  };

  const sinkParameters = new Map();
  const addSinkParameter = (info, index) => {
    invariant(info, `${file}: unresolved dynamic environment read outside a named function`);
    if (!sinkParameters.has(info)) sinkParameters.set(info, new Set());
    const parameters = sinkParameters.get(info);
    const size = parameters.size;
    parameters.add(index);
    return parameters.size !== size;
  };

  const outerExpression = (node) => {
    let current = node;
    while (
      current.parent &&
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isNonNullExpression(current.parent) ||
        (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current.parent))) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    return current;
  };

  const isIdentifierReference = (node) => {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
    if (ts.isParameter(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return false;
    if (ts.isImportClause(parent) && parent.name === node) return false;
    if (ts.isNamespaceImport(parent) && parent.name === node) return false;
    if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return false;
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isClassExpression(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isModuleDeclaration(parent)) &&
      parent.name === node
    ) {
      return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isMethodDeclaration(parent) && parent.name === node) return false;
    return true;
  };
  const hasExportModifier = (node) =>
    node?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;

  const safeWholeEnvironmentUse = (node) => {
    const outer = outerExpression(node);
    const parent = outer.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === outer) return true;
    if (ts.isElementAccessExpression(parent) && parent.expression === outer) return true;
    if (environmentKinds(node).has("import.meta.env")) return false;
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      return ts.isObjectBindingPattern(parent.name) || carrierKinds.has(parent);
    }
    if (ts.isParameter(parent) && parent.initializer === outer) return carrierKinds.has(parent);
    if (ts.isCallExpression(parent)) {
      const argumentIndex = parent.arguments.indexOf(outer);
      if (argumentIndex < 0) return false;
      const target = localFunctionForCall(parent);
      return Boolean(target && carrierKinds.has(target.node.parameters[argumentIndex]));
    }
    return false;
  };
  const outerEnvironmentHostExpression = (node) => {
    let current = node;
    while (current.parent) {
      const parent = current.parent;
      if (
        ((ts.isParenthesizedExpression(parent) ||
          ts.isAsExpression(parent) ||
          ts.isTypeAssertionExpression(parent) ||
          ts.isNonNullExpression(parent) ||
          (ts.isSatisfiesExpression && ts.isSatisfiesExpression(parent)) ||
          ts.isAwaitExpression(parent)) &&
          parent.expression === current) ||
        ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === current &&
          staticMemberName(parent) === "default" &&
          environmentHostKinds(parent).size > 0)
      ) {
        current = parent;
        continue;
      }
      break;
    }
    return current;
  };
  const safeEnvironmentHostUse = (node) => {
    const outer = outerEnvironmentHostExpression(node);
    const parent = outer.parent;
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === outer &&
      staticMemberName(parent) !== undefined
    ) {
      return true;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      if (ts.isObjectBindingPattern(parent.name)) return true;
      if (!ts.isIdentifier(parent.name) || !environmentHostKindsByBinding.has(parent)) return false;
      const declarationList = parent.parent;
      const statement = ts.isVariableDeclarationList(declarationList) ? declarationList.parent : undefined;
      return !(ts.isVariableStatement(statement) && hasExportModifier(statement));
    }
    if (ts.isParameter(parent) && parent.initializer === outer) {
      return environmentHostKindsByBinding.has(parent);
    }
    if (ts.isCallExpression(parent)) {
      const argumentIndex = parent.arguments.indexOf(outer);
      if (argumentIndex < 0) return false;
      const target = localFunctionForCall(parent);
      return Boolean(target && environmentHostKindsByBinding.has(target.node.parameters[argumentIndex]));
    }
    return false;
  };

  const escapeReason = (node) => {
    const parent = outerExpression(node).parent;
    if (ts.isCallExpression(parent)) {
      return localFunctionForCall(parent) ? "passed whole to a local call" : "passed to an untraceable call";
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      return "embedded in an object";
    }
    if (ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)) return "spread as a whole object";
    if (ts.isReturnStatement(parent)) return "returned as a whole object";
    return "used as a whole object";
  };

  const recordWholeEnvironmentEscape = (node) => {
    const kinds = environmentKinds(node);
    if (kinds.size === 0 || safeWholeEnvironmentUse(node)) return;
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    wholeEnvironmentEscapes.push({
      file,
      line: start.line + 1,
      column: start.character + 1,
      roots: [...kinds].sort(),
      reason: escapeReason(node),
    });
  };
  const recordEnvironmentHostEscape = (node) => {
    const kinds = environmentHostKinds(node);
    if (kinds.size === 0 || safeEnvironmentHostUse(node)) return;
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    wholeEnvironmentEscapes.push({
      file,
      line: start.line + 1,
      column: start.character + 1,
      roots: [...kinds].sort(),
      reason: escapeReason(node),
    });
  };
  const isUnresolvedEnvironmentRoot = (node) => {
    const expression = unwrapExpression(node);
    if (!ts.isElementAccessExpression(expression)) return false;
    if (stringLiteralValue(unwrapExpression(expression.argumentExpression)) !== undefined) return false;
    return environmentHostKinds(expression.expression).size > 0;
  };
  const isUnawaitedProcessModuleImport = (node) => {
    if (!isProcessModuleDynamicImport(node)) return false;
    let current = node;
    while (
      current.parent &&
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isNonNullExpression(current.parent)) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    return !(ts.isAwaitExpression(current.parent) && current.parent.expression === current);
  };

  const scan = (node) => {
    invariant(!isUnresolvedEnvironmentRoot(node), `${file}: unresolved dynamic environment root`);
    invariant(
      !isUnawaitedProcessModuleImport(node),
      `${file}: node:process dynamic imports must be awaited before environment access`,
    );
    if (ts.isPropertyAccessExpression(node) && isEnvironmentObject(node.expression)) {
      names.add(node.name.text);
    }
    if (ts.isElementAccessExpression(node) && isEnvironmentObject(node.expression)) {
      const finiteNames = resolveFiniteNames(node.argumentExpression);
      if (finiteNames) {
        for (const name of finiteNames) names.add(name);
      } else {
        const info = enclosingFunction(node);
        const argument = unwrapExpression(node.argumentExpression);
        const parameterIndex =
          info && ts.isIdentifier(argument)
            ? info.node.parameters.findIndex(
                (parameter) => resolveLexicalBinding(argument).binding === parameter,
              )
            : -1;
        invariant(parameterIndex >= 0, `${file}: unresolved dynamic environment read`);
        addSinkParameter(info, parameterIndex);
      }
    }
    if (ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        const name = stringLiteralValue(argument);
        if (name && CONFIGURATION_NAME_PATTERN.test(name)) names.add(name);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /(?:ENV|TOKEN_OPT_IN)/.test(node.name.text)) {
      const name = node.initializer ? stringLiteralValue(node.initializer) : undefined;
      if (name && CONFIGURATION_NAME_PATTERN.test(name)) names.add(name);
    }
    const environmentExpression = unwrapExpression(node);
    if (
      environmentExpression === node &&
      isEnvironmentObject(node) &&
      (!ts.isIdentifier(node) || isIdentifierReference(node))
    ) {
      recordWholeEnvironmentEscape(node);
    }
    if (
      outerEnvironmentHostExpression(node) === node &&
      environmentHostKinds(node).size > 0 &&
      (!ts.isIdentifier(node) || isIdentifierReference(node))
    ) {
      recordEnvironmentHostEscape(node);
    }
    ts.forEachChild(node, scan);
  };
  scan(sourceFile);

  const exportedBindings = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName ?? element.name;
        const resolution = resolveLexicalBinding(localName);
        if (!resolution.ambiguous && resolution.binding) exportedBindings.add(resolution.binding);
      }
    }
    if (ts.isExportAssignment(statement)) {
      const expression = unwrapExpression(statement.expression);
      if (ts.isIdentifier(expression)) {
        const resolution = resolveLexicalBinding(expression);
        if (!resolution.ambiguous && resolution.binding) exportedBindings.add(resolution.binding);
      }
    }
  }
  const isExportedFunction = (info) => {
    if (hasExportModifier(info.node) || exportedBindings.has(info.binding)) return true;
    if (!info.binding || !ts.isVariableDeclaration(info.binding)) return false;
    const declarationList = info.binding.parent;
    const statement = ts.isVariableDeclarationList(declarationList) ? declarationList.parent : undefined;
    return ts.isVariableStatement(statement) && hasExportModifier(statement);
  };
  const readerBindingEscapes = (info) => {
    if (!info.binding) return [];
    const escapes = [];
    const visit = (node) => {
      if (ts.isIdentifier(node) && isIdentifierReference(node)) {
        const resolution = resolveLexicalBinding(node);
        if (resolution.binding === info.binding) {
          const isDeclaredFunctionName =
            (ts.isFunctionDeclaration(info.node) || ts.isFunctionExpression(info.node)) &&
            info.node.name === node;
          const outer = outerExpression(node);
          const isDirectCall = ts.isCallExpression(outer.parent) && outer.parent.expression === outer;
          if (!isDeclaredFunctionName && !isDirectCall) escapes.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return escapes;
  };

  let sinksChanged = true;
  while (sinksChanged) {
    sinksChanged = false;
    for (const call of calls) {
      const target = localFunctionForCall(call);
      const sink = sinkParameters.get(target);
      if (!sink) continue;
      for (const parameterIndex of sink) {
        const argument = call.arguments[parameterIndex];
        const finiteNames = resolveFiniteNames(argument);
        if (finiteNames) {
          for (const name of finiteNames) names.add(name);
          continue;
        }
        const caller = enclosingFunction(call);
        const unwrappedArgument = argument ? unwrapExpression(argument) : undefined;
        const callerParameterIndex =
          caller && unwrappedArgument && ts.isIdentifier(unwrappedArgument)
            ? caller.node.parameters.findIndex(
                (parameter) => resolveLexicalBinding(unwrappedArgument).binding === parameter,
              )
            : -1;
        invariant(
          callerParameterIndex >= 0,
          `${file}: unresolved call into dynamic environment reader ${target.name}`,
        );
        if (addSinkParameter(caller, callerParameterIndex)) sinksChanged = true;
      }
    }
  }

  for (const [info, parameterIndexes] of sinkParameters) {
    invariant(
      !isExportedFunction(info),
      `${file}: exported dynamic environment reader ${info.name} is not statically bounded`,
    );
    for (const parameterIndex of parameterIndexes) {
      invariant(
        calls.some((call) => localFunctionForCall(call) === info && call.arguments[parameterIndex]),
        `${file}: dynamic environment reader ${info.name} has no finite call sites`,
      );
    }
    invariant(
      readerBindingEscapes(info).length === 0,
      `${file}: dynamic environment reader ${info.name} cannot escape its lexical call targets`,
    );
  }

  return { names, wholeEnvironmentEscapes };
}

const sampleConfigurationCache = new Map();

async function scanSampleConfiguration(sourcePath) {
  const names = new Set();
  const wholeEnvironmentEscapes = [];
  const files = (await walkFiles(sourcePath)).filter(
    (file) =>
      SAMPLE_SOURCE_EXTENSIONS.has(path.extname(file)) &&
      !file.split("/").some((segment) => ["dist", "node_modules", "test-results"].includes(segment)),
  );
  for (const file of files) {
    const source = await readFile(path.join(PROJECT_ROOT, file), "utf8");
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const report = analyzeConfigurationSource(sourceFile, file);
    for (const name of report.names) names.add(name);
    wholeEnvironmentEscapes.push(...report.wholeEnvironmentEscapes);
  }
  return {
    names: [...names].sort(),
    wholeEnvironmentEscapes: wholeEnvironmentEscapes.sort(
      (left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
    ),
  };
}

export async function inspectSampleConfiguration(sourcePath, exemptions = []) {
  if (!sampleConfigurationCache.has(sourcePath)) {
    sampleConfigurationCache.set(sourcePath, scanSampleConfiguration(sourcePath));
  }
  const report = await sampleConfigurationCache.get(sourcePath);
  const exemptionNames = new Set(exemptions.map((entry) => entry.name));
  return {
    names: report.names.filter((name) => !exemptionNames.has(name)),
    wholeEnvironmentEscapes: report.wholeEnvironmentEscapes.map((escape) => ({ ...escape, roots: [...escape.roots] })),
  };
}

export async function extractSampleConfiguration(sourcePath, exemptions = []) {
  return (await inspectSampleConfiguration(sourcePath, exemptions)).names;
}

function isChildProcessModule(moduleName) {
  return moduleName === "child_process" || moduleName === "node:child_process";
}

function isUnreviewedHarnessModuleSpecifier(moduleName) {
  return (
    moduleName.startsWith(".") ||
    /^(?:data|file):/i.test(moduleName) ||
    path.posix.isAbsolute(moduleName) ||
    path.win32.isAbsolute(moduleName)
  );
}

function isConstVariableDeclaration(declaration) {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const
  );
}

function isNpmExecutable(command) {
  return /(?:^|[/\\])npm(?:\.cmd)?$/i.test(command);
}

function childExecutableName(command) {
  return command.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

function isBoundedNonBuildLaunch(commands, argv) {
  return commands.every((command) => {
    const executable = childExecutableName(command).replace(/\.exe$/i, "");
    return argv.every((values) => REVIEWED_NON_BUILD_CHILD_LAUNCHES.has([executable, ...values].join("\0")));
  });
}

export function validateFixtureBuildHarnessSource(source, file = "mock-server.mjs", expectedBuildScript) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const childProcessImports = new Map();
  const childProcessNamespaces = new Set();
  const createRequireImports = new Set();
  const fixtureEnvironmentImports = new Set();
  const getBuiltinModuleImports = new Set();
  const moduleObjectImports = new Set();
  const processObjectImports = new Set();
  const variableDeclarations = [];
  const functionNodes = new Set();
  const catchClauses = [];
  const classDeclarations = [];

  const collectSyntax = (node) => {
    if (ts.isVariableDeclaration(node)) variableDeclarations.push(node);
    if (ts.isCatchClause(node)) catchClauses.push(node);
    if (ts.isClassDeclaration(node)) classDeclarations.push(node);
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      functionNodes.add(node);
    }
    ts.forEachChild(node, collectSyntax);
  };
  collectSyntax(sourceFile);

  const isLexicalScope = (node) =>
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node);
  const nearestLexicalScope = (node) => {
    let current = node.parent;
    while (current && !isLexicalScope(current) && !functionNodes.has(current)) current = current.parent;
    return current;
  };
  const variableScope = (declaration) => {
    const declarationList = declaration.parent;
    let current = declaration.parent;
    if (
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      while (current && !ts.isSourceFile(current) && !functionNodes.has(current)) current = current.parent;
      return current;
    }
    return nearestLexicalScope(declaration);
  };
  const lexicalBindingsByName = new Map();
  const addLexicalBinding = (scope, name, binding) => {
    if (!scope) return;
    const bindings = lexicalBindingsByName.get(name) ?? [];
    bindings.push({ scope, binding });
    lexicalBindingsByName.set(name, bindings);
  };
  const addBindingPattern = (scope, pattern, binding) => {
    if (ts.isIdentifier(pattern)) {
      addLexicalBinding(scope, pattern.text, binding);
      return;
    }
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue;
      addBindingPattern(scope, element.name, element);
    }
  };
  for (const declaration of variableDeclarations) {
    addBindingPattern(variableScope(declaration), declaration.name, declaration);
  }
  for (const functionNode of functionNodes) {
    for (const parameter of functionNode.parameters) {
      addBindingPattern(functionNode, parameter.name, parameter);
    }
    if (ts.isFunctionDeclaration(functionNode) && functionNode.name) {
      addLexicalBinding(nearestLexicalScope(functionNode), functionNode.name.text, functionNode);
    }
    if (ts.isFunctionExpression(functionNode) && functionNode.name) {
      addLexicalBinding(functionNode, functionNode.name.text, functionNode);
    }
  }
  for (const catchClause of catchClauses) {
    if (catchClause.variableDeclaration) {
      addBindingPattern(catchClause, catchClause.variableDeclaration.name, catchClause.variableDeclaration);
    }
  }
  for (const declaration of classDeclarations) {
    if (declaration.name) addLexicalBinding(nearestLexicalScope(declaration), declaration.name.text, declaration);
  }
  const lexicalScopeChain = (node) => {
    const scopes = [];
    let current = node.parent;
    while (current) {
      if (isLexicalScope(current) || functionNodes.has(current)) scopes.push(current);
      current = current.parent;
    }
    return scopes;
  };
  const resolveLexicalBinding = (identifier) => {
    const bindings = lexicalBindingsByName.get(identifier.text) ?? [];
    for (const scope of lexicalScopeChain(identifier)) {
      const scoped = bindings.filter((entry) => entry.scope === scope);
      if (scoped.length > 0) return { binding: scoped[0].binding, ambiguous: scoped.length > 1 };
    }
    return { binding: undefined, ambiguous: false };
  };

  const registerImportBinding = (name, binding) => {
    addLexicalBinding(sourceFile, name, binding);
    return binding;
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const { importClause } = statement;
    if (importClause.name) registerImportBinding(importClause.name.text, importClause);
    const bindings = importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) registerImportBinding(bindings.name.text, bindings);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) registerImportBinding(element.name.text, element);
    }
  }

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const moduleName = stringLiteralValue(statement.moduleSpecifier);
      invariant(
        !moduleName || !isUnreviewedHarnessModuleSpecifier(moduleName),
        `${file}: fixture build harnesses cannot re-export unreviewed local or data modules`,
      );
      continue;
    }
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = stringLiteralValue(statement.moduleSpecifier);
    invariant(
      !moduleName ||
        !isUnreviewedHarnessModuleSpecifier(moduleName) ||
        REVIEWED_FIXTURE_HARNESS_IMPORTS.has(moduleName),
      `${file}: fixture build harnesses cannot import unreviewed local or data modules`,
    );
    const importClause = statement.importClause;
    if (isChildProcessModule(moduleName)) {
      if (importClause?.name) childProcessNamespaces.add(importClause);
      const bindings = importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) childProcessNamespaces.add(bindings);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (CHILD_PROCESS_LAUNCH_APIS.has(importedName)) childProcessImports.set(element, importedName);
          if (importedName === "default") childProcessNamespaces.add(element);
        }
      }
    }
    if (moduleName === "module" || moduleName === "node:module") {
      const bindings = importClause?.namedBindings;
      if (importClause?.name) moduleObjectImports.add(importClause);
      if (bindings && ts.isNamespaceImport(bindings)) moduleObjectImports.add(bindings);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "createRequire") {
            createRequireImports.add(element);
          }
          if (importedName === "default") moduleObjectImports.add(element);
        }
      }
    }
    if (moduleName === "process" || moduleName === "node:process") {
      const bindings = importClause?.namedBindings;
      if (importClause?.name) processObjectImports.add(importClause);
      if (bindings && ts.isNamespaceImport(bindings)) processObjectImports.add(bindings);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === "getBuiltinModule") getBuiltinModuleImports.add(element);
          if (importedName === "default") processObjectImports.add(element);
        }
      }
    }
    if (moduleName === FIXTURE_BUILD_ENVIRONMENT_HELPER) {
      const bindings = importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === "createFixtureBuildEnvironment") {
            fixtureEnvironmentImports.add(element);
          }
        }
      }
    }
  }

  const constVariableInitializer = (binding, name, label) => {
    invariant(ts.isVariableDeclaration(binding), `${file}: ${label} ${name} must be a lexical const`);
    invariant(isConstVariableDeclaration(binding), `${file}: ${label} ${name} must be const`);
    invariant(binding.initializer, `${file}: ${label} ${name} must have an initializer`);
    return binding.initializer;
  };

  const resolveIdentifierInitializer = (identifier, label) => {
    const resolution = resolveLexicalBinding(identifier);
    invariant(!resolution.ambiguous, `${file}: ${label} ${identifier.text} is ambiguous`);
    if (!resolution.binding) return undefined;
    return {
      binding: resolution.binding,
      initializer: constVariableInitializer(resolution.binding, identifier.text, label),
    };
  };

  const unwrapAwait = (node) => {
    const expression = unwrapExpression(node);
    return ts.isAwaitExpression(expression) ? unwrapExpression(expression.expression) : expression;
  };

  const resolveFiniteStrings = (node, seen = new Set()) => {
    const expression = unwrapExpression(node);
    const literal = stringLiteralValue(expression);
    if (literal !== undefined) return [literal];
    if (ts.isIdentifier(expression)) {
      const resolved = resolveIdentifierInitializer(expression, "static process-launch value");
      if (!resolved || seen.has(resolved.binding)) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(resolved.binding);
      return resolveFiniteStrings(resolved.initializer, nextSeen);
    }
    if (ts.isConditionalExpression(expression)) {
      const left = resolveFiniteStrings(expression.whenTrue, new Set(seen));
      const right = resolveFiniteStrings(expression.whenFalse, new Set(seen));
      return left && right ? [...new Set([...left, ...right])] : undefined;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveFiniteStrings(expression.left, new Set(seen));
      const right = resolveFiniteStrings(expression.right, new Set(seen));
      if (!left || !right || left.length * right.length > 16) return undefined;
      return [...new Set(left.flatMap((prefix) => right.map((suffix) => `${prefix}${suffix}`)))];
    }
    if (ts.isTemplateExpression(expression)) {
      let values = [expression.head.text];
      for (const span of expression.templateSpans) {
        const replacements = resolveFiniteStrings(span.expression, new Set(seen));
        if (!replacements || values.length * replacements.length > 16) return undefined;
        values = values.flatMap((prefix) =>
          replacements.map((replacement) => `${prefix}${replacement}${span.literal.text}`),
        );
      }
      return [...new Set(values)];
    }
    return undefined;
  };

  const isImportedIdentity = (node, imports, label, seen = new Set()) => {
    const target = unwrapExpression(node);
    if (!ts.isIdentifier(target)) return false;
    const resolution = resolveLexicalBinding(target);
    if (resolution.ambiguous || !resolution.binding) return false;
    if (imports.has(resolution.binding)) return true;
    if (seen.has(resolution.binding) || !ts.isVariableDeclaration(resolution.binding)) return false;
    const { initializer } = resolution.binding;
    if (!initializer) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(resolution.binding);
    if (!isImportedIdentity(initializer, imports, label, nextSeen)) return false;
    invariant(isConstVariableDeclaration(resolution.binding), `${file}: ${label} aliases must be const`);
    return true;
  };

  const isCreateRequireFactoryTarget = (node, seen = new Set()) => {
    const target = unwrapExpression(node);
    if (ts.isIdentifier(target)) {
      const resolution = resolveLexicalBinding(target);
      if (resolution.ambiguous || !resolution.binding) return false;
      if (createRequireImports.has(resolution.binding)) return true;
      if (seen.has(resolution.binding) || !ts.isVariableDeclaration(resolution.binding)) return false;
      const { initializer } = resolution.binding;
      if (!initializer) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(resolution.binding);
      if (!isCreateRequireFactoryTarget(initializer, nextSeen)) return false;
      invariant(isConstVariableDeclaration(resolution.binding), `${file}: createRequire aliases must be const`);
      return true;
    }
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
    const name = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : stringLiteralValue(unwrapExpression(target.argumentExpression));
    return (
      name === "createRequire" &&
      isImportedIdentity(target.expression, moduleObjectImports, "node:module object")
    );
  };

  const isTracedRequireBinding = (binding, seen = new Set()) => {
    if (seen.has(binding) || !ts.isVariableDeclaration(binding) || !binding.initializer) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(binding);
    const initializer = unwrapExpression(binding.initializer);
    let traced =
      ts.isCallExpression(initializer) &&
      initializer.arguments.length === 1 &&
      isCreateRequireFactoryTarget(initializer.expression);
    if (!traced && ts.isIdentifier(initializer)) {
      const resolution = resolveLexicalBinding(initializer);
      traced = !resolution.ambiguous && resolution.binding && isTracedRequireBinding(resolution.binding, nextSeen);
    }
    if (!traced) return false;
    invariant(isConstVariableDeclaration(binding), `${file}: createRequire loader aliases must be const`);
    return true;
  };

  const isGlobalThisProcessRoot = (node) => {
    const target = unwrapExpression(node);
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
    const name = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : stringLiteralValue(unwrapExpression(target.argumentExpression));
    const host = unwrapExpression(target.expression);
    return (
      name === "process" &&
      ts.isIdentifier(host) &&
      host.text === "globalThis" &&
      !resolveLexicalBinding(host).binding
    );
  };

  const isProcessObjectRoot = (node, seen = new Set()) => {
    const target = unwrapExpression(node);
    if (isGlobalThisProcessRoot(target)) return true;
    if (!ts.isIdentifier(target)) return false;
    const resolution = resolveLexicalBinding(target);
    if (target.text === "process" && !resolution.binding) return true;
    if (isImportedIdentity(target, processObjectImports, "node:process object")) return true;
    if (
      resolution.ambiguous ||
      !resolution.binding ||
      seen.has(resolution.binding) ||
      !ts.isVariableDeclaration(resolution.binding) ||
      !resolution.binding.initializer
    ) {
      return false;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(resolution.binding);
    if (!isProcessObjectRoot(resolution.binding.initializer, nextSeen)) return false;
    invariant(isConstVariableDeclaration(resolution.binding), `${file}: process object aliases must be const`);
    return true;
  };

  const isGetBuiltinModuleTarget = (node, seen = new Set()) => {
    const target = unwrapExpression(node);
    if (ts.isIdentifier(target)) {
      const resolution = resolveLexicalBinding(target);
      if (isImportedIdentity(target, getBuiltinModuleImports, "node:process getBuiltinModule")) return true;
      if (
        resolution.ambiguous ||
        !resolution.binding ||
        seen.has(resolution.binding) ||
        !ts.isVariableDeclaration(resolution.binding) ||
        !resolution.binding.initializer
      ) {
        return false;
      }
      const nextSeen = new Set(seen);
      nextSeen.add(resolution.binding);
      if (!isGetBuiltinModuleTarget(resolution.binding.initializer, nextSeen)) return false;
      invariant(isConstVariableDeclaration(resolution.binding), `${file}: getBuiltinModule aliases must be const`);
      return true;
    }
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
    const name = ts.isPropertyAccessExpression(target)
      ? target.name.text
      : stringLiteralValue(unwrapExpression(target.argumentExpression));
    return name === "getBuiltinModule" && isProcessObjectRoot(target.expression);
  };

  const isModuleLoaderTarget = (node) => {
    const target = unwrapExpression(node);
    if (target.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (isGetBuiltinModuleTarget(target)) return true;
    if (ts.isIdentifier(target)) {
      const resolution = resolveLexicalBinding(target);
      if (target.text === "require" && !resolution.binding) return true;
      return !resolution.ambiguous && resolution.binding && isTracedRequireBinding(resolution.binding);
    }
    return (
      ts.isCallExpression(target) &&
      target.arguments.length === 1 &&
      isCreateRequireFactoryTarget(target.expression)
    );
  };

  const isChildProcessNamespace = (node, seen = new Set()) => {
    const expression = unwrapAwait(node);
    if (ts.isIdentifier(expression)) {
      const resolution = resolveLexicalBinding(expression);
      if (resolution.ambiguous) return false;
      const { binding } = resolution;
      if (!binding) return false;
      if (childProcessNamespaces.has(binding)) return true;
      if (seen.has(binding) || !ts.isVariableDeclaration(binding) || !binding.initializer) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(binding);
      if (!isChildProcessNamespace(binding.initializer, nextSeen)) return false;
      invariant(
        isConstVariableDeclaration(binding),
        `${file}: child-process namespace alias ${expression.text} must be const`,
      );
      return true;
    }
    if (!ts.isCallExpression(expression)) return false;
    if (!isModuleLoaderTarget(expression.expression)) return false;
    const moduleNames = expression.arguments[0] ? resolveFiniteStrings(expression.arguments[0]) : undefined;
    return expression.arguments.length === 1 && moduleNames?.some(isChildProcessModule) === true;
  };

  const destructuredChildProcessImports = new Map();
  const collectDestructuredImports = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer &&
      isChildProcessNamespace(node.initializer)
    ) {
      invariant(isConstVariableDeclaration(node), `${file}: child-process destructuring must be const`);
      for (const element of node.name.elements) {
        const importedName = propertyName(element.propertyName ?? element.name);
        invariant(!element.dotDotDotToken, `${file}: child-process destructuring cannot use a rest binding`);
        invariant(importedName, `${file}: child-process destructuring names must be static`);
        invariant(
          CHILD_PROCESS_LAUNCH_APIS.has(importedName),
          `${file}: child-process destructuring permits only launch APIs`,
        );
        invariant(ts.isIdentifier(element.name), `${file}: child-process launch aliases must be identifiers`);
        destructuredChildProcessImports.set(element, importedName);
      }
    }
    ts.forEachChild(node, collectDestructuredImports);
  };
  const resolveChildProcessApi = (node, seen = new Set()) => {
    const expression = unwrapAwait(node);
    if (ts.isIdentifier(expression)) {
      const resolution = resolveLexicalBinding(expression);
      if (resolution.ambiguous) return undefined;
      const { binding } = resolution;
      if (!binding) return undefined;
      const importedApi = childProcessImports.get(binding) ?? destructuredChildProcessImports.get(binding);
      if (importedApi) return importedApi;
      if (seen.has(binding) || !ts.isVariableDeclaration(binding) || !binding.initializer) return undefined;
      const nextSeen = new Set(seen);
      nextSeen.add(binding);
      const api = resolveChildProcessApi(binding.initializer, nextSeen);
      if (!api) return undefined;
      invariant(
        isConstVariableDeclaration(binding),
        `${file}: child-process launch alias ${expression.text} must be const`,
      );
      return api;
    }
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
    const api = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : stringLiteralValue(unwrapExpression(expression.argumentExpression));
    if (!CHILD_PROCESS_LAUNCH_APIS.has(api)) return undefined;
    return isChildProcessNamespace(expression.expression) ? api : undefined;
  };

  collectDestructuredImports(sourceFile);

  const resolveStaticArgv = (node, seen = new Set()) => {
    const expression = unwrapExpression(node);
    if (!ts.isArrayLiteralExpression(expression) || expression.elements.some((element) => ts.isSpreadElement(element))) {
      return undefined;
    }
    let combinations = [[]];
    for (const element of expression.elements) {
      const values = resolveFiniteStrings(element, new Set(seen));
      if (!values || combinations.length * values.length > 16) return undefined;
      combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, value]));
    }
    return combinations;
  };

  const containsAmbientEnvironmentRoot = (node) => {
    const expression = unwrapExpression(node);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const target = unwrapExpression(expression.expression);
      const name = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : stringLiteralValue(unwrapExpression(expression.argumentExpression));
      const isEnvironmentHost =
        isProcessObjectRoot(target) ||
        (ts.isMetaProperty(target) && target.keywordToken === ts.SyntaxKind.ImportKeyword);
      if (isEnvironmentHost && (name === "env" || ts.isElementAccessExpression(expression))) return true;
    }
    let found = false;
    ts.forEachChild(node, (child) => {
      if (!found && containsAmbientEnvironmentRoot(child)) found = true;
    });
    return found;
  };

  const assertBoundedOverrideValue = (node, seen = new Set()) => {
    const expression = unwrapExpression(node);
    invariant(
      !containsAmbientEnvironmentRoot(expression),
      `${file}: fixture build overrides cannot derive from ambient environment variables`,
    );
    if (
      stringLiteralValue(expression) !== undefined ||
      ts.isNumericLiteral(expression) ||
      ts.isBigIntLiteral(expression) ||
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword
    ) {
      return;
    }
    if (ts.isIdentifier(expression)) {
      if (expression.text === "undefined") return;
      const resolved = resolveIdentifierInitializer(expression, "fixture build override value");
      invariant(resolved, `${file}: fixture build override value ${expression.text} must be lexically bound`);
      invariant(!seen.has(resolved.binding), `${file}: fixture build override values cannot be cyclic`);
      const nextSeen = new Set(seen);
      nextSeen.add(resolved.binding);
      assertBoundedOverrideValue(resolved.initializer, nextSeen);
      return;
    }
    if (ts.isTemplateExpression(expression)) {
      for (const span of expression.templateSpans) assertBoundedOverrideValue(span.expression, new Set(seen));
      return;
    }
    if (ts.isPrefixUnaryExpression(expression)) {
      assertBoundedOverrideValue(expression.operand, new Set(seen));
      return;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      assertBoundedOverrideValue(expression.left, new Set(seen));
      assertBoundedOverrideValue(expression.right, new Set(seen));
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      assertBoundedOverrideValue(expression.condition, new Set(seen));
      assertBoundedOverrideValue(expression.whenTrue, new Set(seen));
      assertBoundedOverrideValue(expression.whenFalse, new Set(seen));
      return;
    }
    throw new Error(`${file}: fixture build override values must be statically bounded literals`);
  };

  const isAssignmentOperator = (kind) =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const assertOverrideObjectBindingIsStable = (binding) => {
    const inspectReference = (node) => {
      if (ts.isIdentifier(node)) {
        const isDeclarationName =
          (ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
          (ts.isBindingElement(node.parent) && node.parent.name === node);
        if (!isDeclarationName) {
          const resolution = resolveLexicalBinding(node);
          if (!resolution.ambiguous && resolution.binding === binding) {
            let expression = node;
            while (
              expression.parent &&
              (ts.isParenthesizedExpression(expression.parent) ||
                ts.isAsExpression(expression.parent) ||
                ts.isTypeAssertionExpression(expression.parent) ||
                ts.isNonNullExpression(expression.parent)) &&
              expression.parent.expression === expression
            ) {
              expression = expression.parent;
            }
            const directParent = expression.parent;
            const isFixtureHelperArgument =
              ts.isCallExpression(directParent) &&
              directParent.arguments[0] === expression &&
              ts.isIdentifier(unwrapExpression(directParent.expression)) &&
              fixtureEnvironmentImports.has(resolveLexicalBinding(unwrapExpression(directParent.expression)).binding);
            if (!isFixtureHelperArgument) {
              while (
                expression.parent &&
                (ts.isPropertyAccessExpression(expression.parent) || ts.isElementAccessExpression(expression.parent)) &&
                expression.parent.expression === expression
              ) {
                expression = expression.parent;
              }
              const parent = expression.parent;
              const isWrite =
                (ts.isBinaryExpression(parent) &&
                  parent.left === expression &&
                  isAssignmentOperator(parent.operatorToken.kind)) ||
                ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
                  parent.operand === expression) ||
                (ts.isDeleteExpression(parent) && parent.expression === expression) ||
                ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === expression);
              const isMethodCall = ts.isCallExpression(parent) && parent.expression === expression;
              invariant(
                expression !== node && !isWrite && !isMethodCall,
                `${file}: fixture build override objects must remain immutable and cannot escape`,
              );
            }
          }
        }
      }
      ts.forEachChild(node, inspectReference);
    };
    inspectReference(sourceFile);
  };

  const resolveOverrideObject = (node, seen = new Set()) => {
    const expression = unwrapExpression(node);
    if (ts.isObjectLiteralExpression(expression)) return expression;
    invariant(ts.isIdentifier(expression), `${file}: fixture build overrides must resolve to an object literal`);
    const resolved = resolveIdentifierInitializer(expression, "fixture build override object");
    invariant(resolved, `${file}: fixture build override object ${expression.text} must be lexically bound`);
    invariant(!seen.has(resolved.binding), `${file}: fixture build override objects cannot be cyclic`);
    assertOverrideObjectBindingIsStable(resolved.binding);
    const nextSeen = new Set(seen);
    nextSeen.add(resolved.binding);
    return resolveOverrideObject(resolved.initializer, nextSeen);
  };

  const validateFixtureEnvironment = (options) => {
    invariant(fixtureEnvironmentImports.size > 0, `${file}: fixture build must import createFixtureBuildEnvironment`);
    invariant(options && ts.isObjectLiteralExpression(options), `${file}: fixture build options must be an object literal`);
    for (const property of options.properties) {
      invariant(!ts.isSpreadAssignment(property), `${file}: fixture build options cannot use spreads`);
      invariant(
        !property.name || !ts.isComputedPropertyName(property.name),
        `${file}: fixture build option names must be static`,
      );
    }
    const environmentProperties = options.properties.filter(
      (property) => property.name && propertyName(property.name) === "env",
    );
    invariant(
      environmentProperties.length === 1 && ts.isPropertyAssignment(environmentProperties[0]),
      `${file}: fixture build must declare an explicit env option`,
    );
    const environmentCall = unwrapExpression(environmentProperties[0].initializer);
    const environmentTarget = ts.isCallExpression(environmentCall)
      ? unwrapExpression(environmentCall.expression)
      : undefined;
    const environmentBinding = environmentTarget && ts.isIdentifier(environmentTarget)
      ? resolveLexicalBinding(environmentTarget)
      : { binding: undefined, ambiguous: false };
    invariant(
      ts.isCallExpression(environmentCall) &&
        environmentTarget &&
        ts.isIdentifier(environmentTarget) &&
        !environmentBinding.ambiguous &&
        fixtureEnvironmentImports.has(environmentBinding.binding) &&
        environmentCall.arguments.length <= 1,
      `${file}: fixture build env must come directly from createFixtureBuildEnvironment`,
    );
    if (environmentCall.arguments.length === 0) return;
    const overrideObject = resolveOverrideObject(environmentCall.arguments[0]);
    const names = new Set();
    for (const property of overrideObject.properties) {
      invariant(
        ts.isPropertyAssignment(property),
        `${file}: fixture build overrides must use explicit property assignments`,
      );
      const name = propertyName(property.name);
      invariant(name && /^VITE_[A-Z0-9_]+$/.test(name), `${file}: fixture build override names must be uppercase VITE_*`);
      invariant(!names.has(name), `${file}: duplicate fixture build override ${name}`);
      names.add(name);
      invariant(
        classifyConfigurationName(name).valueKind !== "credential",
        `${file}: fixture build override ${name} is credential-classified`,
      );
      assertBoundedOverrideValue(property.initializer);
    }
  };

  const buildScripts = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (isModuleLoaderTarget(node.expression)) {
        const moduleNames = node.arguments[0] ? resolveFiniteStrings(node.arguments[0]) : undefined;
        invariant(
          node.arguments.length === 1 && moduleNames,
          `${file}: dynamic module loader specifiers must be statically bounded`,
        );
        invariant(
          moduleNames.every((moduleName) => !isUnreviewedHarnessModuleSpecifier(moduleName)),
          `${file}: fixture build harnesses cannot dynamically load unreviewed local or data modules`,
        );
      }
      const api = resolveChildProcessApi(node.expression);
      if (api) {
        if (api === "exec" || api === "execSync") {
          const commands = resolveFiniteStrings(node.arguments[0]);
          invariant(commands, `${file}: ${api} command must be statically bounded`);
          invariant(
            commands.every((command) => {
              const [executable, ...arguments_] = command.split(" ");
              return isBoundedNonBuildLaunch([executable], [arguments_]);
            }),
            `${file}: ${api} permits only allowlisted non-build commands`,
          );
        } else {
          const commands = resolveFiniteStrings(node.arguments[0]);
          invariant(commands, `${file}: ${api} command must be statically bounded`);
          const argvExpression = node.arguments[1] && unwrapExpression(node.arguments[1]);
          const argv =
            !argvExpression ||
            ts.isObjectLiteralExpression(argvExpression) ||
            ts.isFunctionExpression(argvExpression) ||
            ts.isArrowFunction(argvExpression)
              ? [[]]
              : resolveStaticArgv(argvExpression);
          invariant(argv, `${file}: ${api} argv must be statically bounded`);
          const buildCandidates = (argv ?? []).filter((values) =>
            values.some((value) => /(?:^|[^a-z0-9-])demo:[a-z0-9-]+:build(?:$|[^a-z0-9-])/i.test(value)),
          );
          if (buildCandidates.length > 0) {
            invariant(
              api === "spawnSync" &&
                commands.every(isNpmExecutable) &&
                argv.length === 1 &&
                buildCandidates.length === 1 &&
                buildCandidates[0].length === 3 &&
                buildCandidates[0][0] === "run" &&
                /^demo:[a-z0-9-]+:build(?::offline)?$/.test(buildCandidates[0][1]) &&
                buildCandidates[0][2] === "--silent",
              `${file}: unsupported fixture build invocation`,
            );
            validateFixtureEnvironment(node.arguments[2]);
            buildScripts.push(buildCandidates[0][1]);
          } else {
            invariant(
              isBoundedNonBuildLaunch(commands, argv),
              `${file}: ${api} process launch is not a proven non-build command`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const outerTransparentExpression = (node) => {
    let current = node;
    while (
      current.parent &&
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAwaitExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isTypeAssertionExpression(current.parent) ||
        ts.isNonNullExpression(current.parent) ||
        (ts.isSatisfiesExpression && ts.isSatisfiesExpression(current.parent))) &&
      current.parent.expression === current
    ) {
      current = current.parent;
    }
    return current;
  };

  const isDeclarationOrPropertyName = (node) => {
    const parent = node.parent;
    return (
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent) ||
      (ts.isImportClause(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node)
    );
  };

  const assertChildProcessReferencesDoNotEscape = (node) => {
    const isPotentialReference =
      (ts.isIdentifier(node) && !isDeclarationOrPropertyName(node)) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node);
    if (isPotentialReference && resolveChildProcessApi(node)) {
      const expression = outerTransparentExpression(node);
      const parent = expression.parent;
      const isDirectCall = ts.isCallExpression(parent) && parent.expression === expression;
      const isConstAlias =
        ts.isVariableDeclaration(parent) && parent.initializer === expression && isConstVariableDeclaration(parent);
      invariant(
        isDirectCall || isConstAlias,
        `${file}: child-process launch functions cannot escape direct calls or const aliases`,
      );
    }
    const isPotentialNamespaceReference =
      (ts.isIdentifier(node) && !isDeclarationOrPropertyName(node)) ||
      ts.isCallExpression(node) ||
      ts.isAwaitExpression(node);
    if (isPotentialNamespaceReference && isChildProcessNamespace(node)) {
      const expression = outerTransparentExpression(node);
      const parent = expression.parent;
      const staticMember =
        ts.isPropertyAccessExpression(parent) && parent.expression === expression
          ? parent.name.text
          : ts.isElementAccessExpression(parent) && parent.expression === expression
            ? stringLiteralValue(unwrapExpression(parent.argumentExpression))
            : undefined;
      const isLaunchMember = staticMember !== undefined && CHILD_PROCESS_LAUNCH_APIS.has(staticMember);
      const isConstAlias =
        ts.isVariableDeclaration(parent) && parent.initializer === expression && isConstVariableDeclaration(parent);
      invariant(
        isLaunchMember || isConstAlias,
        `${file}: child-process namespaces cannot escape launch API member access or const aliases`,
      );
    }
    ts.forEachChild(node, assertChildProcessReferencesDoNotEscape);
  };
  assertChildProcessReferencesDoNotEscape(sourceFile);

  if (expectedBuildScript !== undefined) {
    invariant(
      buildScripts.length === 1 && buildScripts[0] === expectedBuildScript,
      `${file}: expected exactly one ${expectedBuildScript} fixture build, found ${buildScripts.join(", ") || "none"}`,
    );
  }
  return buildScripts.length;
}

let fixtureBuildHarnessValidation;

export async function validateFixtureBuildHarnesses() {
  fixtureBuildHarnessValidation ??= (async () => {
    const files = (await walkFiles("examples")).filter((file) => file.endsWith("/mock-server.mjs"));
    let buildCalls = 0;
    const validatedHarnesses = new Set();
    for (const file of files) {
      const expectedBuildScript = EXPECTED_FIXTURE_BUILD_HARNESSES.get(file);
      const fileBuildCalls = validateFixtureBuildHarnessSource(
        await readFile(path.join(PROJECT_ROOT, file), "utf8"),
        file,
        expectedBuildScript,
      );
      invariant(
        expectedBuildScript !== undefined || fileBuildCalls === 0,
        `${file}: fixture build harness is not in the approved file-to-script inventory`,
      );
      if (expectedBuildScript !== undefined) validatedHarnesses.add(file);
      buildCalls += fileBuildCalls;
    }
    invariant(
      validatedHarnesses.size === EXPECTED_FIXTURE_BUILD_HARNESSES.size,
      `fixture build harness inventory drift: expected ${EXPECTED_FIXTURE_BUILD_HARNESSES.size}, found ${validatedHarnesses.size}`,
    );
    return buildCalls;
  })();
  return fixtureBuildHarnessValidation;
}

async function runnableDocsExampleDirectories() {
  const root = path.join(PROJECT_ROOT, "docs/examples");
  const entries = await readdir(root, { withFileTypes: true });
  const runnable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relative = `docs/examples/${entry.name}`;
    if (!(await pathExists(`${relative}/index.html`))) continue;
    const hasAppEntry = ["app.js", "app.mjs", "app.ts"].some((name) =>
      require("node:fs").existsSync(path.join(PROJECT_ROOT, relative, name)),
    );
    if (hasAppEntry) runnable.push(relative);
  }
  return runnable.sort();
}

export function isRunnableRootExampleDirectory(name, markers) {
  if (name.startsWith("_") || name.startsWith(".")) return false;
  return ["index.html", "package.json", "src/server.ts"].some((marker) => markers.includes(marker));
}

async function runnableRootExampleDirectories() {
  const root = path.join(PROJECT_ROOT, "examples");
  const entries = await readdir(root, { withFileTypes: true });
  const runnable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const relative = `examples/${entry.name}`;
    const markers = [];
    for (const marker of ["index.html", "package.json", "src/server.ts"]) {
      if (await pathExists(`${relative}/${marker}`)) markers.push(marker);
    }
    if (isRunnableRootExampleDirectory(entry.name, markers)) runnable.push(relative);
  }
  return runnable.sort();
}

function inferredLiveMode(sample) {
  if (sample.lanes.live.status === "not-applicable") return "unavailable";
  if (!["none", "anonymous"].includes(sample.data.authMode)) return "authenticated";
  return sample.protocols.includes("honua") || sample.protocols.includes("sse") ? "demo-live" : "public-live";
}

export async function migrateCatalogV1ToV2(catalog, migration) {
  validateSensitiveMetadata(catalog, "migration source catalog");
  validateSensitiveMetadata(migration, "catalog migration");
  await validateJsonSchema(migration, MIGRATION_SCHEMA_PATH);
  invariant(catalog.format === "honua.sdk.sample-catalog.v1", "migration source catalog format must be v1");
  invariant(catalog.schemaVersion === 1, "migration source catalog schemaVersion must be 1");
  const sourceIds = catalog.samples.map((sample) => sample.id).sort();
  const overrideIds = Object.keys(migration.sampleOverrides).sort();
  invariant(
    JSON.stringify(sourceIds) === JSON.stringify(overrideIds),
    `migration overrides must cover every v1 sample exactly:\nsource ${sourceIds.join(", ")}\noverrides ${overrideIds.join(", ")}`,
  );

  const migratedSamples = await Promise.all(catalog.samples.map(async (sample) => {
    const override = migration.sampleOverrides[sample.id];
    const migratedState = sample.disposition.decision === "keep" ? "active" : sample.disposition.decision;
    const state = override.lifecycle?.state ?? migratedState;
    const lifecycle = {
      state,
      reason: override.lifecycle?.reason ?? sample.disposition.reason,
      ...(state === "active" ? {} : { targetRelease: migration.targetRelease }),
      ...(override.lifecycle?.replacement || override.replacement
        ? { replacement: override.lifecycle?.replacement ?? override.replacement }
        : {}),
    };
    const originalFixture = sample.lanes.fixture;
    const fixtureOverride = override.fixture ?? {};
    const originalLive = sample.lanes.live;
    const liveOverride = override.live ?? {};
    const live = {
      mode: liveOverride.mode ?? inferredLiveMode(sample),
      ...(liveOverride.targetMode ? { targetMode: liveOverride.targetMode } : {}),
      status: liveOverride.status ?? originalLive.status,
      commands: [...(liveOverride.commands ?? originalLive.commands)],
      ...(liveOverride.evidencePath || originalLive.evidencePath
        ? { evidencePath: liveOverride.evidencePath ?? originalLive.evidencePath }
        : {}),
      ...(liveOverride.expiresAt ? { expiresAt: liveOverride.expiresAt } : {}),
    };
    const config = await extractSampleConfiguration(
      sample.sourcePath,
      migration.configuration.environmentReadExemptions,
    );
    const configClassifications = config.map(classifyConfigurationName);
    const configurationStatus = override.configuration?.status ?? (config.length > 0 ? "approved" : "not-required");
    return {
      id: sample.id,
      title: override.title ?? sample.title,
      summary: override.summary ?? sample.summary,
      sourceKind: "root-example",
      track: override.track,
      ...(override.journeyId ? { journeyId: override.journeyId } : {}),
      supportTier: sample.supportStatus,
      lifecycle,
      sourcePath: sample.sourcePath,
      docsPath: sample.docsPath,
      capabilities: [...(override.capabilities ?? sample.capabilities)],
      protocols: [...(override.protocols ?? sample.protocols)],
      renderers: [...(override.renderers ?? sample.renderers)],
      data: {
        ...structuredClone(sample.data),
        ...structuredClone(override.data ?? {}),
        configurationStatus,
        ...(override.configuration?.gap ? { configurationGap: override.configuration.gap } : {}),
        config,
        configClassifications,
      },
      evidence: {
        fixture: {
          mode: "fixture",
          status: fixtureOverride.status ?? originalFixture.status,
          commands: [...(fixtureOverride.commands ?? originalFixture.commands)],
          ...(fixtureOverride.evidencePath || originalFixture.evidencePath
            ? { evidencePath: fixtureOverride.evidencePath ?? originalFixture.evidencePath }
            : {}),
        },
        live,
      },
      expectedDegradation: override.expectedDegradation ?? sample.expectedDegradation,
      validationProfile: override.validationProfile,
      validation: [...(override.validation ?? sample.validation)],
    };
  }));

  const addedSamples = migration.addedSamples.map((sample) => ({
    ...structuredClone(sample),
    data: {
      ...structuredClone(sample.data),
      configClassifications: sample.data.config.map(classifyConfigurationName),
    },
  }));

  const siteMappingIds = new Set(catalog.siteMappings.map((mapping) => mapping.id));
  for (const mappingId of Object.keys(migration.siteMappingOverrides)) {
    invariant(siteMappingIds.has(mappingId), `migration override references unknown site mapping ${mappingId}`);
  }
  const siteMappings = catalog.siteMappings.map((mapping) => {
    const override = migration.siteMappingOverrides[mapping.id] ?? {};
    if (mapping.ownership === "sdk-projection") return { ...structuredClone(mapping), ...structuredClone(override) };
    const track =
      mapping.tier === "flagship"
        ? "golden"
        : mapping.tier === "recipe"
          ? "recipe"
          : "lab";
    const { tier: _tier, supportStatus: _supportStatus, ...rest } = mapping;
    return { ...rest, track, supportTier: mapping.supportStatus, ...structuredClone(override) };
  });

  const migratedCatalog = {
    $schema: "./contract/v2/schemas/sample-catalog.schema.json",
    format: "honua.sdk.sample-catalog.v2",
    schemaVersion: 2,
    migratedFrom: { format: catalog.format, path: migration.source },
    sdk: structuredClone(catalog.sdk),
    configuration: {
      ...structuredClone(catalog.configuration),
      ...structuredClone(migration.configuration),
    },
    goldenJourneys: structuredClone(migration.goldenJourneys),
    qualityProfiles: structuredClone(migration.qualityProfiles),
    externalReplacements: structuredClone(migration.externalReplacements),
    samples: [...migratedSamples, ...addedSamples].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    siteMappings,
  };
  await validateJsonSchema(migratedCatalog, CATALOG_SCHEMA_PATH);
  return migratedCatalog;
}

export async function validateCatalog(catalog, packageJson, options = {}) {
  invariant(
    options.qualificationBootstrapSampleId === undefined ||
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.qualificationBootstrapSampleId),
    "qualification bootstrap sample id is invalid",
  );
  validateSensitiveMetadata(catalog, "catalog");
  await validateJsonSchema(catalog, CATALOG_SCHEMA_PATH);
  await validateFixtureBuildHarnesses();
  invariant(catalog.format === "honua.sdk.sample-catalog.v2", "catalog format must be v2");
  invariant(catalog.schemaVersion === 2, "catalog schemaVersion must be 2");
  invariant(catalog.migratedFrom?.path === V1_CATALOG_PATH, "catalog v1 migration source is required");
  invariant(catalog.sdk && typeof catalog.sdk === "object", "catalog SDK metadata is required");
  invariant(catalog.sdk?.package === packageJson.name, "catalog SDK package must match package.json");
  invariant(!Object.hasOwn(catalog.sdk, "version"), "catalog SDK version is derived from package.json and must not be pinned");
  invariant(catalog.configuration?.endpointValuePolicy === "environment-name-only", "catalog endpoint values must remain external");
  invariant(
    JSON.stringify(catalog.configuration?.allowedSchemes) === JSON.stringify(["http", "https"]),
    "catalog endpoints must be restricted to HTTP(S)",
  );
  invariant(
    JSON.stringify(catalog.configuration?.credentialQueryParameters) === JSON.stringify(CREDENTIAL_QUERY_PARAMETERS),
    "configuration.credentialQueryParameters must exactly match the canonical normalized credential-key set",
  );
  invariant(Number.isInteger(catalog.configuration?.evidenceExpiry?.executedMaxDays), "executed evidence expiry policy is required");
  invariant(Number.isInteger(catalog.configuration?.evidenceExpiry?.nonExecutedMaxDays), "non-executed evidence expiry policy is required");
  invariant(
    Number.isInteger(catalog.configuration?.evidenceExpiry?.maxFutureSkewSeconds),
    "future evidence clock-skew policy is required",
  );
  const environmentReadExemptions = catalog.configuration?.environmentReadExemptions ?? [];
  sortedUnique(
    environmentReadExemptions.map((entry) => entry.name),
    "configuration.environmentReadExemptions",
  );
  for (const exemption of environmentReadExemptions) {
    invariant(
      STANDARD_CONFIGURATION_EXEMPTIONS.get(exemption.name) === exemption.provider,
      `configuration exemption ${exemption.name} is not an approved standard built-in`,
    );
  }
  invariant(Array.isArray(catalog.samples), "catalog samples must be an array");
  invariant(Array.isArray(catalog.siteMappings), "catalog siteMappings must be an array");

  const journeyIds = catalog.goldenJourneys.map((journey) => journey.id);
  invariant(
    JSON.stringify(journeyIds) === JSON.stringify(RESERVED_GOLDEN_JOURNEY_IDS),
    `golden journey IDs must be reserved in canonical order: ${RESERVED_GOLDEN_JOURNEY_IDS.join(", ")}`,
  );
  invariant(
    new Set(catalog.goldenJourneys.map((journey) => journey.candidateSampleId)).size === 7,
    "golden journey candidate sample IDs must be unique",
  );

  const qualityProfileIds = catalog.qualityProfiles.map((profile) => profile.id);
  invariant(new Set(qualityProfileIds).size === qualityProfileIds.length, "quality profile IDs must be unique");
  invariant(
    JSON.stringify(qualityProfileIds) === JSON.stringify([...qualityProfileIds].sort()),
    "quality profiles must be sorted by id",
  );
  const qualityProfiles = new Map(catalog.qualityProfiles.map((profile) => [profile.id, profile]));
  const goldenProfile = qualityProfiles.get("golden-browser");
  invariant(goldenProfile, "golden-browser quality profile is required");
  invariant(Object.values(goldenProfile.gates).every(Boolean), "golden-browser must require every quality gate");

  const externalReplacementIds = catalog.externalReplacements.map((replacement) => replacement.id);
  invariant(new Set(externalReplacementIds).size === externalReplacementIds.length, "external replacement IDs must be unique");
  const externalReplacements = new Set(externalReplacementIds);

  const sampleIds = new Set();
  const sourcePaths = new Set();
  const observedEnvironmentReadExemptions = new Set();
  const orderedSampleIds = catalog.samples.map((sample) => sample.id);
  invariant(JSON.stringify(orderedSampleIds) === JSON.stringify([...orderedSampleIds].sort()), "catalog samples must be sorted by id");
  const currentTime = options.now === undefined ? Date.now() : parseDateTime(options.now, "validation time");
  for (const sample of catalog.samples) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sample.id), `invalid sample id: ${sample.id}`);
    invariant(!sampleIds.has(sample.id), `duplicate sample id: ${sample.id}`);
    sampleIds.add(sample.id);
    invariant(typeof sample.title === "string" && sample.title.length > 0, `${sample.id}: title is required`);
    invariant(["golden", "recipe", "lab", "fixture"].includes(sample.track), `${sample.id}: invalid track`);
    invariant(
      ["supported", "experimental", "internal", "deprecated"].includes(sample.supportTier),
      `${sample.id}: invalid support tier`,
    );
    invariant(qualityProfiles.has(sample.validationProfile), `${sample.id}: unknown validation profile ${sample.validationProfile}`);
    invariant(typeof sample.lifecycle?.reason === "string" && sample.lifecycle.reason.length > 0, `${sample.id}: lifecycle reason is required`);
    if (sample.lifecycle.state !== "active") {
      invariant(sample.lifecycle.targetRelease, `${sample.id}: unresolved lifecycle requires targetRelease`);
      invariant(
        compareReleases(packageJson.version, sample.lifecycle.targetRelease) < 0,
        `${sample.id}: lifecycle ${sample.lifecycle.state} expired at ${sample.lifecycle.targetRelease}`,
      );
    }
    assertRelativePath(sample.sourcePath, `${sample.id}.sourcePath`);
    assertRelativePath(sample.docsPath, `${sample.id}.docsPath`);
    invariant(await pathExists(sample.sourcePath), `${sample.id}: sourcePath does not exist: ${sample.sourcePath}`);
    invariant(await pathExists(sample.docsPath), `${sample.id}: docsPath does not exist: ${sample.docsPath}`);
    invariant(
      sample.sourceKind === "root-example"
        ? sample.sourcePath.startsWith("examples/")
        : sample.sourcePath.startsWith("docs/examples/"),
      `${sample.id}: sourceKind does not match sourcePath`,
    );
    sourcePaths.add(sample.sourcePath);
    sortedUnique(sample.capabilities, `${sample.id}.capabilities`);
    sortedUnique(sample.protocols, `${sample.id}.protocols`);
    sortedUnique(sample.renderers, `${sample.id}.renderers`);
    invariant(
      ["fixture", "public-live", "demo-live", "authenticated-live", "hybrid", "none"].includes(
        sample.data.mode,
      ),
      `${sample.id}: invalid data mode`,
    );
    invariant(["none", "anonymous", "api-key", "bearer", "oauth", "host-mediated"].includes(sample.data.authMode), `${sample.id}: invalid auth mode`);
    invariant(typeof sample.data.provenance === "string", `${sample.id}: provenance is required`);
    invariant(typeof sample.data.attribution === "string", `${sample.id}: attribution is required`);
    invariant(typeof sample.data.freshness === "string", `${sample.id}: freshness is required`);
    invariant(Array.isArray(sample.data.config) && sample.data.config.every((entry) => typeof entry === "string"), `${sample.id}: data.config must contain variable names`);
    if (sample.data.config.length > 0) sortedUnique(sample.data.config, `${sample.id}.data.config`);
    const sourceInspection = await inspectSampleConfiguration(sample.sourcePath);
    const sourceConfiguration = sourceInspection.names;
    invariant(
      sample.data.configurationStatus === "legacy-unsafe" || sourceInspection.wholeEnvironmentEscapes.length === 0,
      `${sample.id}: ${sample.data.configurationStatus} configuration cannot expose a whole environment object: ${sourceInspection.wholeEnvironmentEscapes
        .map(
          (escape) =>
            `${escape.file}:${escape.line}:${escape.column} ${escape.roots.join("+")} ${escape.reason}`,
        )
        .join("; ")}`,
    );
    const exemptionNames = new Set(environmentReadExemptions.map((entry) => entry.name));
    for (const name of sourceConfiguration) {
      if (exemptionNames.has(name)) observedEnvironmentReadExemptions.add(name);
    }
    const supportedConfiguration = sourceConfiguration.filter((name) => !exemptionNames.has(name));
    invariant(
      JSON.stringify(sample.data.config) === JSON.stringify(supportedConfiguration),
      `${sample.id}: configuration declaration drift; source reads [${supportedConfiguration.join(", ")}], catalog declares [${sample.data.config.join(", ")}]`,
    );
    const expectedClassifications = supportedConfiguration.map(classifyConfigurationName);
    invariant(
      JSON.stringify(sample.data.configClassifications) === JSON.stringify(expectedClassifications),
      `${sample.id}: configuration exposure/classification drift`,
    );
    if (sample.data.configurationStatus === "approved") {
      invariant(sample.data.config.length > 0, `${sample.id}: approved configuration requires declared config names`);
      invariant(!sample.data.configurationGap, `${sample.id}: approved configuration cannot declare a gap`);
    } else if (sample.data.configurationStatus === "not-required") {
      invariant(sample.data.config.length === 0, `${sample.id}: not-required configuration cannot declare config names`);
      invariant(!sample.data.configurationGap, `${sample.id}: not-required configuration cannot declare a gap`);
    } else {
      invariant(sample.data.configurationStatus === "legacy-unsafe", `${sample.id}: invalid configuration status`);
      invariant(
        typeof sample.data.configurationGap === "string" && sample.data.configurationGap.length > 0,
        `${sample.id}: legacy-unsafe configuration requires a configurationGap`,
      );
      invariant(sample.lifecycle.state !== "active", `${sample.id}: legacy-unsafe configuration requires bounded rework`);
    }
    invariant(
      !sample.data.configClassifications.some(
        (entry) => entry.exposure === "browser-public" && entry.valueKind === "credential",
      ) || sample.data.configurationStatus === "legacy-unsafe",
      `${sample.id}: browser-public credentials require legacy-unsafe status and bounded rework`,
    );
    if (
      ["hybrid", "authenticated-live"].includes(sample.data.mode) &&
      !["none", "anonymous"].includes(sample.data.authMode)
    ) {
      invariant(
        sample.data.configurationStatus !== "not-required",
        `${sample.id}: credentialed live data requires approved configuration or an explicit legacy gap`,
      );
    }
    invariant(typeof sample.expectedDegradation === "string", `${sample.id}: expectedDegradation is required`);
    invariant(Array.isArray(sample.validation) && sample.validation.length > 0, `${sample.id}: validation is required`);
    const commandRecords = new Map();
    for (const command of [...sample.evidence.fixture.commands, ...sample.evidence.live.commands, ...sample.validation]) {
      commandRecords.set(command, await validateCatalogCommand(command, sample.id, packageJson));
    }
    for (const command of sample.validation) {
      invariant(
        isBoundedValidationCommand(commandRecords.get(command), packageJson),
        `${sample.id}: automatic validation command is not in the reviewed bounded registry: ${command}`,
      );
    }
    for (const command of sample.evidence.live.commands) {
      invariant(
        isBoundedLiveCommand(commandRecords.get(command), packageJson),
        `${sample.id}: scheduled live command is not in the reviewed bounded producer registry: ${command}`,
      );
    }
    invariant(
      ["executed", "not-applicable", "planned"].includes(sample.evidence.fixture.status),
      `${sample.id}: invalid fixture lane status`,
    );
    invariant(sample.evidence.fixture.mode === "fixture", `${sample.id}: fixture evidence mode must be fixture`);
    invariant(
      ["executed", "not-applicable", "planned", "skipped", "credential-unavailable", "failed"].includes(
        sample.evidence.live.status,
      ),
      `${sample.id}: invalid live lane status`,
    );
    const evidenceBoundStatuses = new Set(["executed", "skipped", "credential-unavailable", "failed"]);
    if (evidenceBoundStatuses.has(sample.evidence.live.status)) {
      invariant(sample.evidence.live.commands.length > 0, `${sample.id}: evidence-bound live status requires a producer command`);
      invariant(sample.evidence.live.evidencePath, `${sample.id}: ${sample.evidence.live.status} live status requires evidencePath`);
      invariant(sample.evidence.live.expiresAt, `${sample.id}: ${sample.evidence.live.status} live status requires expiresAt`);
      assertRelativePath(sample.evidence.live.evidencePath, `${sample.id}.evidence.live.evidencePath`);
      const evidence = validateEvidenceEnvelope(await readJson(sample.evidence.live.evidencePath), {
        now: new Date(currentTime).toISOString(),
        maxFutureSkewSeconds: catalog.configuration.evidenceExpiry.maxFutureSkewSeconds,
      });
      invariant(evidence.sampleId === sample.id, `${sample.id}: live evidence sampleId drift`);
      invariant(evidence.lane === "live", `${sample.id}: catalog evidence must be a live envelope`);
      invariant(evidence.status === sample.evidence.live.status, `${sample.id}: live lane status must match evidence`);
      invariant(
        evidence.sdk.version === packageJson.version,
        `${sample.id}: live evidence SDK version ${evidence.sdk.version} does not match ${packageJson.version}`,
      );
      const observedAt = parseDateTime(evidence.observedAt, `${sample.id}.evidence.observedAt`);
      const expiresAt = parseDateTime(sample.evidence.live.expiresAt, `${sample.id}.evidence.live.expiresAt`);
      invariant(expiresAt > observedAt, `${sample.id}: evidence expiry must follow observation time`);
      const maxDays =
        sample.evidence.live.status === "executed"
          ? catalog.configuration.evidenceExpiry.executedMaxDays
          : catalog.configuration.evidenceExpiry.nonExecutedMaxDays;
      invariant(
        expiresAt - observedAt <= maxDays * 24 * 60 * 60 * 1000,
        `${sample.id}: evidence expiry exceeds ${maxDays}-day policy`,
      );
      invariant(currentTime < expiresAt, `${sample.id}: live evidence expired at ${sample.evidence.live.expiresAt}`);
      if (sample.evidence.live.status === "executed") {
        invariant(
          ["public-live", "demo-live", "authenticated"].includes(sample.evidence.live.mode),
          `${sample.id}: executed live evidence requires a live mode`,
        );
        invariant(!sample.evidence.live.targetMode, `${sample.id}: executed evidence cannot declare targetMode`);
      } else {
        invariant(
          ["degraded", "unavailable"].includes(sample.evidence.live.mode),
          `${sample.id}: non-executed evidence must be degraded or unavailable`,
        );
        invariant(sample.evidence.live.targetMode, `${sample.id}: non-executed live evidence requires targetMode`);
      }
      await validateLiveEvidenceProducer(evidence, sample);
    } else {
      invariant(!sample.evidence.live.evidencePath, `${sample.id}: ${sample.evidence.live.status} cannot carry evidencePath`);
      invariant(!sample.evidence.live.expiresAt, `${sample.id}: ${sample.evidence.live.status} cannot carry expiresAt`);
      invariant(!sample.evidence.live.targetMode, `${sample.id}: ${sample.evidence.live.status} cannot carry targetMode`);
      if (sample.evidence.live.status === "not-applicable") {
        invariant(sample.evidence.live.mode === "unavailable", `${sample.id}: not-applicable live mode must be unavailable`);
      } else {
        invariant(
          ["public-live", "demo-live", "authenticated"].includes(sample.evidence.live.mode),
          `${sample.id}: planned live evidence requires a target live mode`,
        );
      }
    }
  }

  invariant(
    JSON.stringify([...observedEnvironmentReadExemptions].sort()) ===
      JSON.stringify(environmentReadExemptions.map((entry) => entry.name)),
    "configuration.environmentReadExemptions must list exactly the observed standard built-in reads",
  );

  for (const sample of catalog.samples) {
    const replacement = sample.lifecycle.replacement;
    if (!replacement) continue;
    invariant(replacement.id !== sample.id, `${sample.id}: lifecycle replacement cannot reference itself`);
    if (replacement.kind === "sample") invariant(sampleIds.has(replacement.id), `${sample.id}: unknown replacement sample ${replacement.id}`);
    if (replacement.kind === "journey") invariant(journeyIds.includes(replacement.id), `${sample.id}: unknown replacement journey ${replacement.id}`);
    if (replacement.kind === "external") invariant(externalReplacements.has(replacement.id), `${sample.id}: unknown external replacement ${replacement.id}`);
  }
  const replacementGraph = new Map();
  for (const sample of catalog.samples) {
    const replacement = sample.lifecycle.replacement;
    if (!replacement || replacement.kind === "external") continue;
    replacementGraph.set(
      `sample:${sample.id}`,
      `${replacement.kind}:${replacement.id}`,
    );
  }
  for (const journey of catalog.goldenJourneys) {
    replacementGraph.set(`journey:${journey.id}`, `sample:${journey.candidateSampleId}`);
  }
  for (const start of replacementGraph.keys()) {
    const chain = [start];
    let current = start;
    while (replacementGraph.has(current)) {
      const next = replacementGraph.get(current);
      invariant(!chain.includes(next), `sample/journey replacement cycle: ${[...chain, next].join(" -> ")}`);
      chain.push(next);
      current = next;
    }
  }

  for (const journey of catalog.goldenJourneys) {
    const sample = catalog.samples.find((candidate) => candidate.id === journey.candidateSampleId);
    invariant(sample, `${journey.id}: candidate sample does not exist: ${journey.candidateSampleId}`);
    invariant(sample.journeyId === journey.id, `${journey.id}: journey/candidate mapping drift`);
    if (journey.status === "qualified") {
      invariant(sample.track === "golden", `${journey.id}: qualified journey candidate must use the golden track`);
    } else {
      invariant(sample.track !== "golden", `${journey.id}: planned journey candidate cannot use the golden track`);
    }
  }
  for (const sample of catalog.samples) {
    if (!sample.journeyId) continue;
    const journey = catalog.goldenJourneys.find((candidate) => candidate.id === sample.journeyId);
    invariant(journey, `${sample.id}: unknown golden journey ${sample.journeyId}`);
    invariant(journey.candidateSampleId === sample.id, `${sample.id}: sample is not the declared candidate for ${sample.journeyId}`);
  }

  const goldenSamples = catalog.samples.filter((sample) => sample.track === "golden");
  const qualifiedJourneys = catalog.goldenJourneys.filter((journey) => journey.status === "qualified");
  invariant(
    options.qualificationBootstrapSampleId === undefined ||
      goldenSamples.some((sample) => sample.id === options.qualificationBootstrapSampleId),
    `${options.qualificationBootstrapSampleId}: qualification bootstrap requires a qualified golden sample`,
  );
  let qualificationBootstrapConsumed = false;
  invariant(
    goldenSamples.length === qualifiedJourneys.length,
    "golden sample count must match the qualified journey count",
  );
  for (const sample of goldenSamples) {
    const profile = qualityProfiles.get(sample.validationProfile);
    invariant(sample.supportTier === "supported", `${sample.id}: golden samples must be supported`);
    invariant(sample.lifecycle.state === "active", `${sample.id}: golden samples must be active`);
    invariant(sample.evidence.fixture.status === "executed", `${sample.id}: golden samples require executed fixture evidence`);
    invariant(Object.values(profile.gates).every(Boolean), `${sample.id}: golden samples require every quality gate`);
    if (profile.gates.liveEvidence) {
      invariant(sample.evidence.live.status === "executed", `${sample.id}: golden samples require current executed live evidence`);
    }
    const journey = catalog.goldenJourneys.find((candidate) => candidate.id === sample.journeyId);
    invariant(journey?.status === "qualified", `${sample.id}: golden sample journey must be qualified`);
    invariant(journey.candidateSampleId === sample.id, `${sample.id}: golden sample must be its journey candidate`);
    const selectedSample = {
      id: sample.id,
      commandPlan: {
        validation: { execution: "automatic", commands: [...sample.validation] },
        fixtureEvidence: { execution: "orchestrated", commands: [...sample.evidence.fixture.commands] },
        liveEvidence: { execution: "scheduled-only", commands: [...sample.evidence.live.commands] },
      },
    };
    if (options.qualificationBootstrapSampleId === sample.id) {
      qualificationBootstrapConsumed = true;
      continue;
    }
    await validateQualificationReceiptSet({
      sample: selectedSample,
      profile,
      expectedCommand: expectedGateCommand,
      receiptRoot: path.resolve(options.receiptRoot ?? path.join(PROJECT_ROOT, "samples/evidence")),
      now: new Date(currentTime).toISOString(),
      projectRoot: PROJECT_ROOT,
      verifyCheckout: options.verifyCheckout,
    });
  }
  invariant(
    options.qualificationBootstrapSampleId === undefined || qualificationBootstrapConsumed,
    `${options.qualificationBootstrapSampleId}: qualification bootstrap requires a qualified golden sample`,
  );

  const exampleDirectories = await runnableRootExampleDirectories();
  const representedExamples = catalog.samples
    .filter((sample) => sample.sourceKind === "root-example")
    .map((sample) => sample.sourcePath)
    .sort();
  invariant(
    JSON.stringify(exampleDirectories) === JSON.stringify(representedExamples),
    `example inventory drift:\nexpected ${exampleDirectories.join(", ")}\nrepresented ${representedExamples.join(", ")}`,
  );
  const docsExamples = await runnableDocsExampleDirectories();
  const representedDocsExamples = catalog.samples
    .filter((sample) => sample.sourceKind === "docs-example")
    .map((sample) => sample.sourcePath)
    .sort();
  invariant(
    JSON.stringify(docsExamples) === JSON.stringify(representedDocsExamples),
    `runnable docs example inventory drift:\nexpected ${docsExamples.join(", ")}\nrepresented ${representedDocsExamples.join(", ")}`,
  );
  invariant(sourcePaths.size === catalog.samples.length, "sample source paths must be unique");

  const siteIds = new Set();
  for (const mapping of catalog.siteMappings) {
    invariant(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mapping.id), `invalid site sample id: ${mapping.id}`);
    invariant(!siteIds.has(mapping.id), `duplicate site sample id: ${mapping.id}`);
    siteIds.add(mapping.id);
    invariant(/^[-a-z0-9]+\.html$/.test(mapping.route), `${mapping.id}: invalid static site route`);
    invariant(["sdk-projection", "site-exception"].includes(mapping.ownership), `${mapping.id}: invalid ownership`);
    if (mapping.ownership === "sdk-projection") {
      invariant(sampleIds.has(mapping.sampleId), `${mapping.id}: unknown SDK sample ${mapping.sampleId}`);
    } else {
      invariant(!mapping.sampleId, `${mapping.id}: site exceptions cannot identify SDK executable source`);
      invariant(typeof mapping.exceptionReason === "string" && mapping.exceptionReason.length > 0, `${mapping.id}: site exception reason is required`);
      invariant(typeof mapping.title === "string" && mapping.title.length > 0, `${mapping.id}: site exception title is required`);
      invariant(["golden", "recipe", "lab", "fixture"].includes(mapping.track), `${mapping.id}: site exception track is required`);
      invariant(
        ["supported", "experimental", "internal", "deprecated"].includes(mapping.supportTier),
        `${mapping.id}: site exception support tier is required`,
      );
      sortedUnique(mapping.capabilities, `${mapping.id}.capabilities`);
    }
  }
  invariant(catalog.siteMappings.length === 21, "the compatibility route fixture must map all 21 existing honua.io samples");
}

export async function validateLiveEvidenceProducer(evidence, sample) {
  const producers = (evidence.artifacts ?? []).filter((artifact) => artifact.kind === "producer-generator");
  if (evidence.status !== "executed" && producers.length === 0) return;
  const claimLabel = evidence.status === "executed" ? "executed live evidence" : "non-executed live producer claim";
  const commands = sample.evidence?.live?.commands;
  invariant(
    Array.isArray(commands) && commands.length === 1,
    `${sample.id}: ${claimLabel} requires exactly one reviewed producer command`,
  );
  const [command] = commands;
  const parsed = parseCatalogCommand(command);
  const binding = parsed.runner === "npm" ? REVIEWED_LIVE_PRODUCERS.get(parsed.script) : undefined;
  invariant(binding, `${sample.id}: ${claimLabel} command is not in the reviewed producer registry: ${command}`);
  invariant(producers.length === 1, `${sample.id}: live evidence requires exactly one producer-generator artifact`);
  const [producer] = producers;
  assertRelativePath(producer.path, `${sample.id}.producer.path`);
  invariant(
    producer.path === binding.generatorPath,
    `${sample.id}: producer generator path for ${command} must be ${binding.generatorPath}`,
  );
  const generatorBytes = await readFile(path.join(PROJECT_ROOT, producer.path));
  invariant(
    sha256(generatorBytes) === producer.sha256,
    `${sample.id}: producer generator digest drift`,
  );
  if (binding.sampleId) {
    invariant(sample.id === binding.sampleId, `${sample.id}: producer generator does not support this sample`);
  }
  if (binding.operation) {
    invariant(
      evidence.semantics.operation === binding.operation,
      `${sample.id}: producer generator does not support this journey`,
    );
  }
  if (parsed.script === "bench:live") {
    const generator = generatorBytes.toString("utf8");
    const sampleLiteral = `sampleId: "${sample.id}"`;
    const journeyLiteral = `journeyId: "${evidence.semantics.operation}"`;
    invariant(generator.includes(sampleLiteral), `${sample.id}: producer generator does not support this sample`);
    invariant(generator.includes(journeyLiteral), `${sample.id}: producer generator does not support this journey`);
  }
}

export function effectiveCatalog(catalog, packageJson) {
  return {
    ...catalog,
    sdk: {
      package: packageJson.name,
      version: packageJson.version,
    },
  };
}

function publicSample(sample, sdk) {
  return {
    id: sample.id,
    title: sample.title,
    summary: sample.summary,
    sourceKind: sample.sourceKind,
    track: sample.track,
    ...(sample.journeyId ? { journeyId: sample.journeyId } : {}),
    supportTier: sample.supportTier,
    lifecycle: structuredClone(sample.lifecycle),
    validationProfile: sample.validationProfile,
    source: {
      repository: "honua-io/honua-sdk-js",
      path: sample.sourcePath,
      docsPath: sample.docsPath,
    },
    sdk: { package: sdk.package, version: sdk.version },
    capabilities: sample.capabilities,
    protocols: sample.protocols,
    renderers: sample.renderers,
    data: {
      mode: sample.data.mode,
      authMode: sample.data.authMode,
      provenance: sample.data.provenance,
      attribution: sample.data.attribution,
      freshness: sample.data.freshness,
      configurationStatus: sample.data.configurationStatus,
      ...(sample.data.configurationGap ? { configurationGap: sample.data.configurationGap } : {}),
    },
    evidence: {
      fixture: {
        mode: sample.evidence.fixture.mode,
        status: sample.evidence.fixture.status,
      },
      live: {
        mode: sample.evidence.live.mode,
        ...(sample.evidence.live.targetMode ? { targetMode: sample.evidence.live.targetMode } : {}),
        status: sample.evidence.live.status,
        ...(sample.evidence.live.evidencePath ? { evidencePath: sample.evidence.live.evidencePath } : {}),
        ...(sample.evidence.live.expiresAt ? { expiresAt: sample.evidence.live.expiresAt } : {}),
      },
    },
    expectedDegradation: sample.expectedDegradation,
  };
}

export function generateSiteProjection(catalog, packageJson) {
  const effective = effectiveCatalog(catalog, packageJson);
  const routes = catalog.siteMappings.map((mapping) => {
    if (mapping.ownership === "site-exception") {
      return {
        id: mapping.id,
        route: mapping.route,
        ownership: mapping.ownership,
        exceptionReason: mapping.exceptionReason,
        title: mapping.title,
        summary: mapping.summary,
        track: mapping.track,
        supportTier: mapping.supportTier,
        capabilities: mapping.capabilities,
      };
    }
    return {
      id: mapping.id,
      route: mapping.route,
      ownership: mapping.ownership,
      sampleId: mapping.sampleId,
    };
  });
  return {
    format: "honua.site.sdk-sample-projection.v2",
    schemaVersion: 2,
    catalog: {
      format: effective.format,
      schemaVersion: effective.schemaVersion,
      package: effective.sdk.package,
      version: effective.sdk.version,
    },
    contract: {
      producer: "honua-io/honua-sdk-js#540",
      consumer: "honua-io/honua-sdk-js#550",
      executableSourceOwner: "honua-io/honua-sdk-js",
      presentationOwner: "honua-io/honua-site",
    },
    goldenJourneys: structuredClone(catalog.goldenJourneys),
    externalReplacements: structuredClone(catalog.externalReplacements),
    qualityProfiles: structuredClone(catalog.qualityProfiles),
    samples: effective.samples.map((sample) => publicSample(sample, effective.sdk)),
    routes,
  };
}

export function generateCiSelection(catalog) {
  const profiles = catalog.qualityProfiles.map((profile) => ({
    id: profile.id,
    gates: structuredClone(profile.gates),
    sampleIds: catalog.samples
      .filter((sample) => sample.validationProfile === profile.id)
      .map((sample) => sample.id),
  }));
  const profileById = new Map(catalog.qualityProfiles.map((profile) => [profile.id, profile]));
  return {
    format: "honua.sdk.sample-ci-selection.v2",
    schemaVersion: 2,
    catalog: {
      format: catalog.format,
      schemaVersion: catalog.schemaVersion,
    },
    goldenJourneys: structuredClone(catalog.goldenJourneys),
    profiles,
    samples: catalog.samples.map((sample) => {
      return {
        id: sample.id,
        sourcePath: sample.sourcePath,
        track: sample.track,
        ...(sample.journeyId ? { journeyId: sample.journeyId } : {}),
        supportTier: sample.supportTier,
        validationProfile: sample.validationProfile,
        gates: structuredClone(profileById.get(sample.validationProfile).gates),
        commandPlan: {
          validation: {
            execution: "automatic",
            commands: [...sample.validation],
          },
          fixtureEvidence: {
            execution: "orchestrated",
            commands: [...sample.evidence.fixture.commands],
          },
          liveEvidence: {
            execution: "scheduled-only",
            commands: [...sample.evidence.live.commands],
          },
        },
        liveEvidence: {
          mode: sample.evidence.live.mode,
          ...(sample.evidence.live.targetMode ? { targetMode: sample.evidence.live.targetMode } : {}),
          status: sample.evidence.live.status,
          ...(sample.evidence.live.evidencePath ? { evidencePath: sample.evidence.live.evidencePath } : {}),
          ...(sample.evidence.live.expiresAt ? { expiresAt: sample.evidence.live.expiresAt } : {}),
        },
      };
    }),
  };
}

export async function validateSiteProjection(projection) {
  validateSensitiveMetadata(projection, "site projection");
  await validateJsonSchema(projection, SITE_PROJECTION_SCHEMA_PATH);
}

export async function validateCiSelection(selection) {
  validateSensitiveMetadata(selection, "CI selection");
  await validateJsonSchema(selection, CI_SELECTION_SCHEMA_PATH);
}

function generateSiteConsumerFixture(projection) {
  return {
    format: "honua.site.sdk-sample-consumer-fixture.v2",
    schemaVersion: 2,
    accepts: {
      projectionFormat: projection.format,
      projectionSchemaVersion: projection.schemaVersion,
      catalogFormat: projection.catalog.format,
      catalogSchemaVersion: projection.catalog.schemaVersion,
    },
    input: {
      path: SITE_PROJECTION_PATH,
      schemaPath: SITE_PROJECTION_SCHEMA_PATH,
      sha256: sha256(Buffer.from(stableJson(projection))),
    },
    assertions: {
      sampleCount: projection.samples.length,
      rootExampleCount: projection.samples.filter((sample) => sample.sourceKind === "root-example").length,
      docsExampleCount: projection.samples.filter((sample) => sample.sourceKind === "docs-example").length,
      goldenJourneyCount: projection.goldenJourneys.length,
      qualifiedGoldenCount: projection.goldenJourneys.filter((journey) => journey.status === "qualified").length,
      routeCount: projection.routes.length,
      sampleIdsUnique: true,
      routeIdsUnique: true,
      routesEndInHtml: true,
      executableSourceOwner: "honua-io/honua-sdk-js",
      presentationOwner: "honua-io/honua-site",
      credentialValuesForbidden: true,
    },
    representativeRoutes: ["quickstart-map", "public-safety", "two-protocols"],
  };
}

function generatedCatalogMarkdown(catalog, packageJson) {
  const journeyRows = catalog.goldenJourneys.map(
    (journey) =>
      `| \`${journey.id}\` | ${journey.status} | [\`${journey.candidateSampleId}\`](#${journey.candidateSampleId}) |`,
  );
  const rows = catalog.samples.map(
    (sample) =>
      `| <a id="${sample.id}"></a>[\`${sample.id}\`](../../${sample.docsPath}) | ${sample.track} | ${sample.journeyId ?? "-"} | ${sample.supportTier} | ${sample.lifecycle.state} | ${sample.validationProfile} | ${sample.data.mode} | ${sample.data.configurationStatus} | ${sample.summary} |`,
  );
  return [
    "# SDK sample catalog",
    "",
    "This inventory is generated from [`samples/catalog.v2.json`](../../samples/catalog.v2.json). Do not edit it by hand.",
    "",
    `Catalog contract: \`${catalog.format}\` · SDK: \`${packageJson.name}\` (effective version derived from \`package.json\`) · ${catalog.samples.length} executable examples`,
    "",
    "## Golden journey readiness",
    "",
    "Journey IDs are stable roadmap slots. `planned` candidates remain recipes or labs until their golden quality profile and evidence are satisfied; only `qualified` candidates use the golden track.",
    "",
    "| Journey | Status | Candidate sample |",
    "| --- | --- | --- |",
    ...journeyRows,
    "",
    "## Executable samples",
    "",
    "| Sample | Track | Journey candidate | Support | Lifecycle | Quality profile | Data | Configuration | Demonstration |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "The catalog also carries fixture/live evidence, evidence expiry, endpoint configuration names, provenance, attribution, freshness, lifecycle targets, validation profiles, and the complete 21-route honua.io migration mapping. The presentation-safe projection is [`samples/dist/honua-site-samples.v2.json`](../../samples/dist/honua-site-samples.v2.json).",
    "",
  ].join("\n");
}

function readmeFragment(catalog) {
  const counts = Object.fromEntries(
    ["golden", "recipe", "lab", "fixture"].map((track) => [
      track,
      catalog.samples.filter((sample) => sample.track === track).length,
    ]),
  );
  const plannedJourneys = catalog.goldenJourneys.filter((journey) => journey.status === "planned").length;
  return [
    README_START,
    `The versioned [SDK sample catalog](./docs/generated/sample-catalog.md) tracks all ${catalog.samples.length} executable examples: ${counts.golden} qualified golden ${counts.golden === 1 ? "sample" : "samples"}, ${counts.recipe} recipes, ${counts.lab} labs, and ${counts.fixture} fixtures. Seven journey IDs are reserved; ${plannedJourneys} remain explicitly planned candidates. The catalog is the source of truth for track, support, lifecycle, fixture/live evidence, quality profiles, and the honua.io projection.`,
    README_END,
  ].join("\n");
}

function replaceReadmeFragment(readme, fragment) {
  const start = readme.indexOf(README_START);
  const end = readme.indexOf(README_END);
  invariant(start >= 0 && end > start, "README sample catalog markers are missing or malformed");
  return `${readme.slice(0, start)}${fragment}${readme.slice(end + README_END.length)}`;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function generatedOutputs(catalog, packageJson) {
  const readme = await readFile(path.join(PROJECT_ROOT, "README.md"), "utf8");
  const projection = generateSiteProjection(catalog, packageJson);
  const ciSelection = generateCiSelection(catalog);
  return new Map([
    [GENERATED_CATALOG_PATH, generatedCatalogMarkdown(catalog, packageJson)],
    [SITE_PROJECTION_PATH, stableJson(projection)],
    [CI_SELECTION_PATH, stableJson(ciSelection)],
    [SITE_CONSUMER_FIXTURE_PATH, stableJson(generateSiteConsumerFixture(projection))],
    ["README.md", replaceReadmeFragment(readme, readmeFragment(catalog))],
  ]);
}

export function generatedOutputDrift(expectedOutputs, currentOutputs) {
  return [...expectedOutputs]
    .filter(([relativePath, expected]) => currentOutputs.get(relativePath) !== expected)
    .map(([relativePath]) => relativePath);
}

function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walkFiles(relativeDirectory) {
  const files = [];
  const entries = await readdir(path.join(PROJECT_ROOT, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

export async function buildBrowserArtifactManifest({ artifacts, gitCommit = gitSha() }) {
  const packageJson = await readJson("package.json");
  const packageLock = await readFile(path.join(PROJECT_ROOT, "package-lock.json"));
  invariant(typeof gitCommit === "string" && /^[a-f0-9]{40}$/.test(gitCommit), "gitCommit must be a 40-character SHA");
  invariant(Array.isArray(artifacts) && artifacts.length > 0, "at least one browser artifact is required");
  const files = [];
  for (const artifact of [...artifacts].sort((left, right) => left.path.localeCompare(right.path))) {
    assertRelativePath(artifact.path, "artifact.path");
    const bytes = await readFile(path.join(PROJECT_ROOT, artifact.path));
    files.push({
      path: artifact.path,
      entrypoint: artifact.entrypoint,
      mediaType: artifact.mediaType ?? "text/javascript",
      bytes: bytes.byteLength,
      integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
      sha256: sha256(bytes),
    });
  }
  const inputPaths = [
    "package.json",
    "package-lock.json",
    "scripts/build-browser-bundle.mjs",
    ...(await walkFiles("src")),
  ];
  const inputs = [];
  for (const inputPath of inputPaths.sort()) {
    const bytes = await readFile(path.join(PROJECT_ROOT, inputPath));
    inputs.push({ path: inputPath, sha256: sha256(bytes) });
  }
  return {
    format: "honua.sdk.browser-artifacts.v1",
    schemaVersion: 1,
    package: { name: packageJson.name, version: packageJson.version, gitCommit },
    build: {
      command: "npm run build:browser",
      node: packageJson.engines.node,
      lockfileSha256: sha256(packageLock),
      inputs,
    },
    compatibility: {
      exports: ["./browser"],
      browsers: packageJson.browserslist,
      peers: Object.fromEntries(Object.entries(packageJson.peerDependencies ?? {}).sort(([left], [right]) => left.localeCompare(right))),
      optionalPeers: Object.keys(packageJson.peerDependenciesMeta ?? {})
        .filter((name) => packageJson.peerDependenciesMeta[name]?.optional)
        .sort(),
    },
    files,
  };
}

export async function verifyBrowserArtifactManifest(manifest) {
  invariant(manifest.format === "honua.sdk.browser-artifacts.v1", "artifact manifest format must be v1");
  invariant(manifest.schemaVersion === 1, "artifact manifest schemaVersion must be 1");
  invariant(/^[a-f0-9]{40}$/.test(manifest.package.gitCommit), "artifact manifest gitCommit is invalid");
  const packageJson = await readJson("package.json");
  invariant(manifest.package.name === packageJson.name, "artifact package name drift");
  invariant(manifest.package.version === packageJson.version, "artifact package version drift");
  invariant(manifest.build.command === "npm run build:browser", "artifact build command drift");
  const packageLock = await readFile(path.join(PROJECT_ROOT, "package-lock.json"));
  invariant(manifest.build.lockfileSha256 === sha256(packageLock), "artifact lockfile digest drift");
  for (const input of manifest.build.inputs) {
    const bytes = await readFile(path.join(PROJECT_ROOT, input.path));
    invariant(sha256(bytes) === input.sha256, `${input.path}: build input digest drift`);
  }
  const expectedPeers = Object.fromEntries(
    Object.entries(packageJson.peerDependencies ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  invariant(JSON.stringify(manifest.compatibility.peers) === JSON.stringify(expectedPeers), "artifact peer compatibility drift");
  invariant(new Set(manifest.files.map((file) => file.path)).size === manifest.files.length, "artifact paths must be unique");
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(PROJECT_ROOT, file.path));
    invariant(bytes.byteLength === file.bytes, `${file.path}: byte length drift`);
    invariant(sha256(bytes) === file.sha256, `${file.path}: SHA-256 drift`);
    invariant(
      `sha256-${createHash("sha256").update(bytes).digest("base64")}` === file.integrity,
      `${file.path}: SRI drift`,
    );
  }
}

export function validateEvidenceEnvelope(evidence, options = {}) {
  validateSensitiveMetadata(evidence, "evidence");
  const isDateTime = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
  invariant(evidence.format === "honua.sdk.sample-evidence.v1", "evidence format must be v1");
  invariant(evidence.schemaVersion === 1, "evidence schemaVersion must be 1");
  invariant(["fixture", "live"].includes(evidence.lane), "evidence lane must be fixture or live");
  invariant(
    ["executed", "failed", "skipped", "credential-unavailable"].includes(evidence.status),
    "evidence status is invalid",
  );
  invariant(typeof evidence.sampleId === "string", "evidence sampleId is required");
  invariant(isDateTime(evidence.observedAt), "evidence observedAt must be an RFC 3339 date-time");
  const observedAt = Date.parse(evidence.observedAt);
  const validationTime = options.now === undefined ? Date.now() : parseDateTime(options.now, "evidence validation time");
  const maxFutureSkewSeconds = options.maxFutureSkewSeconds ?? 300;
  invariant(
    Number.isInteger(maxFutureSkewSeconds) && maxFutureSkewSeconds >= 0 && maxFutureSkewSeconds <= 300,
    "evidence maxFutureSkewSeconds must be between 0 and 300",
  );
  const maxFutureSkewMs = maxFutureSkewSeconds * 1000;
  invariant(
    observedAt <= validationTime + maxFutureSkewMs,
    `evidence observedAt is more than ${maxFutureSkewSeconds} seconds in the future`,
  );
  invariant(["none", "anonymous", "api-key", "bearer", "oauth", "host-mediated"].includes(evidence.authMode), "evidence authMode is invalid");
  invariant(evidence.sdk?.package === "@honua/sdk-js", "evidence sdk.package is invalid");
  invariant(typeof evidence.sdk?.version === "string", "evidence sdk.version is required");
  invariant(
    evidence.sdk?.gitCommit === null || /^[a-f0-9]{40}$/.test(evidence.sdk?.gitCommit),
    "evidence sdk.gitCommit must be null or a full reported source revision",
  );
  invariant(typeof evidence.source?.provider === "string", "evidence source.provider is required");
  invariant(typeof evidence.source?.identity === "string", "evidence source.identity is required");
  for (const field of ["endpoint", "deploymentVersion", "dataVersion"]) {
    invariant(
      evidence.source?.[field] === null || typeof evidence.source?.[field] === "string",
      `evidence source.${field} is invalid`,
    );
  }
  if (evidence.source.endpoint !== null) {
    let endpoint;
    try {
      endpoint = new URL(evidence.source.endpoint);
    } catch {
      throw new Error("evidence source.endpoint must be an absolute URL");
    }
    invariant(["http:", "https:"].includes(endpoint.protocol), "evidence source.endpoint must use HTTP(S)");
    invariant(!endpoint.username && !endpoint.password, "evidence source.endpoint must not contain credentials");
    invariant(!endpoint.hash, "evidence source.endpoint must not contain a fragment");
    for (const parameter of endpoint.searchParams.keys()) {
      invariant(
        !isCredentialQueryParameter(parameter),
        `evidence source.endpoint contains forbidden credential query parameter ${parameter}`,
      );
    }
  }
  if (evidence.status === "executed") {
    invariant(typeof evidence.provenance?.sourceId === "string", "executed evidence requires provenance.sourceId");
  } else if (evidence.provenance !== null) {
    invariant(typeof evidence.provenance?.sourceId === "string", "evidence provenance.sourceId is invalid");
  }
  if (evidence.provenance !== null) {
    invariant(isDateTime(evidence.provenance?.observedAt), "evidence provenance.observedAt must be an RFC 3339 date-time");
    const provenanceObservedAt = Date.parse(evidence.provenance.observedAt);
    invariant(
      provenanceObservedAt <= observedAt + maxFutureSkewMs,
      "evidence provenance.observedAt cannot follow evidence observedAt beyond clock skew",
    );
    invariant(
      provenanceObservedAt <= validationTime + maxFutureSkewMs,
      `evidence provenance.observedAt is more than ${maxFutureSkewSeconds} seconds in the future`,
    );
    invariant(
      evidence.provenance?.validAt === null || isDateTime(evidence.provenance?.validAt),
      "evidence provenance.validAt must be null or an RFC 3339 date-time",
    );
    invariant(
      ["live", "cached", "replayed", "pending-local"].includes(evidence.provenance?.state),
      "evidence provenance.state is invalid",
    );
    invariant(typeof evidence.provenance?.attribution === "string", "evidence provenance.attribution is required");
  }
  invariant(typeof evidence.semantics?.operation === "string", "evidence semantics.operation is required");
  invariant(
    evidence.semantics?.outcome === null || typeof evidence.semantics?.outcome === "string",
    "evidence semantics.outcome is invalid",
  );
  invariant(
    evidence.semantics?.itemCount === null ||
      (Number.isInteger(evidence.semantics?.itemCount) && evidence.semantics.itemCount >= 0),
    "evidence semantics.itemCount is invalid",
  );
  invariant(
    Array.isArray(evidence.semantics?.assertions) && evidence.semantics.assertions.every((value) => typeof value === "string"),
    "evidence semantics.assertions is invalid",
  );
  invariant(
    evidence.timing?.totalMs === null || (typeof evidence.timing?.totalMs === "number" && evidence.timing.totalMs >= 0),
    "evidence timing.totalMs is invalid",
  );
  invariant(
    evidence.timing?.firstSuccessfulInteractionMs === null ||
      (typeof evidence.timing?.firstSuccessfulInteractionMs === "number" &&
        evidence.timing.firstSuccessfulInteractionMs >= 0),
    "evidence timing.firstSuccessfulInteractionMs is invalid",
  );
  invariant(
    ["none", "expected", "unexpected", "unavailable"].includes(evidence.degradation?.state),
    "evidence degradation.state is invalid",
  );
  invariant(
    Array.isArray(evidence.degradation?.reasons) && evidence.degradation.reasons.every((value) => typeof value === "string"),
    "evidence degradation.reasons is invalid",
  );
  invariant(Array.isArray(evidence.artifacts), "evidence artifacts must be an array");
  for (const artifact of evidence.artifacts ?? []) {
    invariant(typeof artifact?.kind === "string" && artifact.kind.length > 0, "evidence artifact.kind is required");
    invariant(typeof artifact?.path === "string" && artifact.path.length > 0, "evidence artifact.path is required");
    invariant(/^[a-f0-9]{64}$/.test(artifact?.sha256), "evidence artifact.sha256 is invalid");
  }
  if (evidence.status === "executed") {
    invariant(typeof evidence.semantics?.outcome === "string", "executed evidence requires semantic outcome");
    invariant(typeof evidence.timing?.totalMs === "number" && evidence.timing.totalMs >= 0, "executed evidence requires timing");
    if (evidence.lane === "live") {
      invariant(
        typeof evidence.sdk.gitCommit === "string" && /^[a-f0-9]{40}$/.test(evidence.sdk.gitCommit),
        "executed live evidence requires a full reported source revision",
      );
      invariant(
        evidence.artifacts.some((artifact) => artifact.kind === "producer-generator"),
        "executed live evidence requires a producer-generator artifact",
      );
    }
  } else {
    invariant(typeof evidence.reason === "string" && evidence.reason.length > 0, "non-executed evidence requires a reason");
  }
  if (evidence.realtime) {
    invariant(typeof evidence.realtime.observationWindowMs === "number", "realtime evidence requires an observation window");
    invariant("snapshotAt" in evidence.realtime, "realtime evidence requires snapshotAt");
    invariant("cursor" in evidence.realtime, "realtime evidence requires cursor");
    invariant("lagMs" in evidence.realtime, "realtime evidence requires lagMs");
  }
  return evidence;
}

async function runContract(command, options = {}) {
  const catalog = await readJson(CATALOG_PATH);
  const packageJson = await readJson("package.json");
  await validateCatalog(catalog, packageJson, options);
  for (const fixturePath of [
    "samples/contract/v1/fixtures/sample-evidence.fixture.json",
    "samples/contract/v1/fixtures/sample-evidence.live.json",
    "samples/contract/v1/fixtures/sample-evidence.skipped.json",
  ]) {
    validateEvidenceEnvelope(await readJson(fixturePath));
  }
  await validateSiteProjection(generateSiteProjection(catalog, packageJson));
  await validateCiSelection(generateCiSelection(catalog));
  const outputs = await generatedOutputs(catalog, packageJson);
  if (command === "write") {
    for (const [relativePath, expected] of outputs) {
      await mkdir(path.dirname(path.join(PROJECT_ROOT, relativePath)), { recursive: true });
      await writeFile(path.join(PROJECT_ROOT, relativePath), expected, "utf8");
    }
  } else {
    const currentOutputs = new Map();
    for (const relativePath of outputs.keys()) {
      currentOutputs.set(relativePath, await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"));
    }
    const drift = generatedOutputDrift(outputs, currentOutputs);
    invariant(drift.length === 0, `${drift.join(", ")} has drifted; run npm run samples:generate`);
  }
  process.stdout.write(
    `${command === "write" ? "Generated" : "Verified"} ${catalog.samples.length} SDK and docs examples, seven reserved journey IDs, and ${catalog.siteMappings.length} honua.io routes (${catalog.format})\n`,
  );
}

async function main(argv) {
  const [command = "check", ...args] = argv;
  if (["check", "write"].includes(command)) {
    let qualificationBootstrapSampleId;
    if (command === "write" && args.length === 2 && args[0] === "--qualification-bootstrap") {
      qualificationBootstrapSampleId = args[1];
    } else {
      invariant(args.length === 0, `${command} does not accept arguments`);
    }
    await runContract(command, { qualificationBootstrapSampleId });
    return;
  }
  if (command === "migrate-v1") {
    let qualificationBootstrapSampleId;
    if (args.length === 2 && args[0] === "--qualification-bootstrap") {
      qualificationBootstrapSampleId = args[1];
    } else {
      invariant(args.length === 0, "migrate-v1 does not accept arguments");
    }
    const catalog = await migrateCatalogV1ToV2(
      await readJson(V1_CATALOG_PATH),
      await readJson(V1_MIGRATION_PATH),
    );
    await validateCatalog(catalog, await readJson("package.json"), {
      qualificationBootstrapSampleId,
      verifyCheckout: false,
    });
    await writeFile(path.join(PROJECT_ROOT, CATALOG_PATH), stableJson(catalog), "utf8");
    process.stdout.write(`Migrated ${catalog.samples.length} executable examples to ${CATALOG_PATH}\n`);
    return;
  }
  if (command === "artifacts") {
    let output = "dist/browser/honua-sdk.browser-artifacts.v1.json";
    let gitCommit = gitSha();
    const artifacts = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--output") output = args[++index];
      else if (args[index] === "--git-sha") gitCommit = args[++index];
      else if (args[index] === "--artifact") {
        const [artifactPath, entrypoint] = (args[++index] ?? "").split("=");
        artifacts.push({ path: artifactPath, entrypoint });
      } else throw new Error(`Unknown artifacts argument: ${args[index]}`);
    }
    const defaults = [
      { path: "dist/browser/honua-sdk.esm.js", entrypoint: "./browser:import" },
      {
        path: "dist/browser/honua-sdk.esm.js.map",
        entrypoint: "./browser:import:sourcemap",
        mediaType: "application/json",
      },
      { path: "dist/browser/honua-sdk.min.js", entrypoint: "browser" },
      {
        path: "dist/browser/honua-sdk.min.js.map",
        entrypoint: "browser:sourcemap",
        mediaType: "application/json",
      },
    ];
    const manifest = await buildBrowserArtifactManifest({ artifacts: artifacts.length > 0 ? artifacts : defaults, gitCommit });
    await verifyBrowserArtifactManifest(manifest);
    await mkdir(path.dirname(path.join(PROJECT_ROOT, output)), { recursive: true });
    await writeFile(path.join(PROJECT_ROOT, output), stableJson(manifest), "utf8");
    process.stdout.write(`Wrote verified browser artifact manifest to ${output}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`sample contract failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
