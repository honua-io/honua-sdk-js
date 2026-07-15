#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HONUA_ERROR_RUNTIME_CLASSIFICATIONS } from "../dist/src/core/error-classifications.js";
import { HONUA_ERROR_CODE_REGISTRY } from "../dist/src/core/error-code-registry.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_PATH = path.join(ROOT, "docs/errors.md");
let doc = fs.readFileSync(DOC_PATH, "utf8");
const TABLE_START = "<!-- error-code-registry:start -->";
const TABLE_END = "<!-- error-code-registry:end -->";
const VALID_DOMAINS = new Set(["core", "discovery", "query", "map", "runtime", "realtime", "offline", "plugin"]);
const VALID_CATEGORIES = new Set([
  "authentication",
  "cancellation",
  "capability",
  "internal",
  "network",
  "protocol",
  "timeout",
  "validation",
]);
const MIGRATED_PUBLIC_CLASSES = [
  "HonuaHttpError",
  "HonuaTimeoutError",
  "HonuaNetworkError",
  "HonuaAbortError",
  "HonuaGrpcError",
  "HonuaGeometryError",
  "HonuaAuthError",
  "HonuaCapabilityNotSupportedError",
  "HonuaExplorationContextError",
  "HonuaWfsExceptionError",
  "HonuaJobFailedError",
  "HonuaWmsCapabilitiesParseError",
  "HonuaWmtsCapabilitiesParseError",
  "HonuaDiscoveryError",
  "HonuaQueryPlanningError",
  "HonuaQueryPlanExecutionError",
  "HonuaMapLibreSourceAdapterError",
  "HonuaDataToMapBridgeError",
  "HonuaAutomaticMapLibreStrategyError",
  "HonuaMapLibreRasterStrategyError",
  "HonuaAutomaticMapLibreIntegrationError",
  "HonuaTemporalPlaybackError",
  "HonuaMapPackageError",
  "HonuaRuntimeDiagnosticError",
  "QueryTileServerResponseError",
  "HonuaRealtimeResumeError",
  "HonuaOfflineRegionError",
  "HonuaReplicaSyncError",
  "HonuaPluginRegistryError",
];

const codes = Object.keys(HONUA_ERROR_CODE_REGISTRY);
const runtimeCodes = Object.keys(HONUA_ERROR_RUNTIME_CLASSIFICATIONS);
const failures = [];

if (new Set(codes).size !== codes.length) failures.push("registry contains duplicate codes");
if (codes.length === 0) failures.push("registry is empty");
if (!Object.isFrozen(HONUA_ERROR_CODE_REGISTRY)) failures.push("registry object is mutable");
if (!Object.isFrozen(HONUA_ERROR_RUNTIME_CLASSIFICATIONS)) failures.push("runtime classification table is mutable");
if (JSON.stringify(runtimeCodes) !== JSON.stringify(codes)) {
  failures.push("runtime classification code set or ordering differs from the canonical registry");
}

for (const code of codes) {
  const descriptor = HONUA_ERROR_CODE_REGISTRY[code];
  const runtimeClassification = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[code];
  if (!VALID_DOMAINS.has(descriptor.domain)) failures.push(`${code}: unknown domain ${descriptor.domain}`);
  if (!code.startsWith(`${descriptor.domain}.`)) failures.push(`${code}: code/domain prefix mismatch`);
  if (!VALID_CATEGORIES.has(descriptor.category)) failures.push(`${code}: unknown category ${descriptor.category}`);
  if (typeof descriptor.retryable !== "boolean") failures.push(`${code}: retryable must be boolean`);
  if (typeof descriptor.summary !== "string" || descriptor.summary.trim().length < 8) {
    failures.push(`${code}: missing registry documentation summary`);
  }
  if (!Object.isFrozen(descriptor)) failures.push(`${code}: registry descriptor is mutable`);
  if (!runtimeClassification) {
    failures.push(`${code}: missing runtime classification`);
  } else {
    const [domain, category, retryable] = runtimeClassification;
    if (!Object.isFrozen(runtimeClassification)) failures.push(`${code}: runtime classification is mutable`);
    if (runtimeClassification.length !== 3) failures.push(`${code}: runtime classification is not minimal`);
    if (domain !== descriptor.domain || category !== descriptor.category || retryable !== descriptor.retryable) {
      failures.push(`${code}: runtime classification differs from the canonical registry descriptor`);
    }
  }
}

const table = [
  TABLE_START,
  "| Registered code | Domain | Category | Retryable | Summary |",
  "|-----------------|--------|----------|-----------|---------|",
  ...codes.map((code) => {
    const descriptor = HONUA_ERROR_CODE_REGISTRY[code];
    return `| \`${code}\` | \`${descriptor.domain}\` | \`${descriptor.category}\` | ${descriptor.retryable ? "yes" : "no"} | ${descriptor.summary} |`;
  }),
  TABLE_END,
].join("\n");
const tablePattern = new RegExp(`${TABLE_START}[\\s\\S]*?${TABLE_END}`);

if (process.argv.includes("--write")) {
  if (!tablePattern.test(doc)) throw new Error("docs/errors.md is missing error-code registry markers");
  doc = doc.replace(tablePattern, table);
  fs.writeFileSync(DOC_PATH, doc);
} else {
  const documentedTable = doc.match(tablePattern)?.[0];
  if (documentedTable !== table) failures.push("docs/errors.md individual error-code table is out of date");
}

for (const className of MIGRATED_PUBLIC_CLASSES) {
  const matches = doc.match(new RegExp("\\| `" + className + "` \\|", "g")) ?? [];
  if (matches.length === 0) failures.push(`${className}: missing docs/errors.md registry-family row`);
}

for (const requiredText of [
  "HONUA_ERROR_CODE_REGISTRY",
  "sdkCode",
  "serializeHonuaError",
  "HonuaRealtimeResumeError",
  "#569",
  "#570",
  "#571",
]) {
  if (!doc.includes(requiredText)) failures.push(`docs/errors.md is missing ${requiredText}`);
}

if (failures.length > 0) {
  process.stderr.write(`Error-code registry check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `${process.argv.includes("--write") ? "Wrote" : "Verified"} error-code registry: ${codes.length} unique codes, ${MIGRATED_PUBLIC_CLASSES.length} documented public classes.\n`,
);
