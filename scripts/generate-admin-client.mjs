#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = path.join(root, "config", "admin-client.v1.json");
const generatedTypesPath = path.join(root, "src", "control-plane", "generated", "admin-api.ts");
const generatedCatalogPath = path.join(root, "src", "control-plane", "generated", "admin-operations.ts");
const generatedReferencePath = path.join(root, "docs", "admin-cli-reference.md");
const mode = process.argv[2] ?? "check";

if (mode !== "write" && mode !== "check") {
  throw new Error("Usage: node scripts/generate-admin-client.mjs [write|check]");
}

const source = JSON.parse(await readFile(sourceManifestPath, "utf8"));
assertSourceManifest(source);
const coveragePath = path.join(root, source.adminMcpContract.coveragePath);
const coverageText = normalizeLf(await readFile(coveragePath, "utf8"));
const coverageDigest = createHash("sha256").update(coverageText).digest("hex");
if (coverageDigest !== source.adminMcpContract.coverageSha256) {
  throw new Error(
    `Pinned Admin MCP coverage digest mismatch: expected ${source.adminMcpContract.coverageSha256}, ` +
      `received ${coverageDigest}. Advance config/admin-client.v1.json with the reviewed server artifact.`,
  );
}
const coverage = JSON.parse(coverageText);

const sourceUrl =
  process.env.HONUA_ADMIN_OPENAPI_URL ??
  `https://raw.githubusercontent.com/${source.serverRepository}/${source.serverSha}/${source.specPath}`;
const response = await fetch(sourceUrl, {
  headers: { Accept: "application/json", "User-Agent": "honua-sdk-js-admin-client-generator" },
});
if (!response.ok) {
  throw new Error(`Unable to fetch pinned admin OpenAPI (${response.status}) from ${sourceUrl}`);
}
const sourceText = normalizeLf(await response.text());
const digest = createHash("sha256").update(sourceText).digest("hex");
if (digest !== source.specSha256) {
  throw new Error(
    `Pinned admin OpenAPI digest mismatch: expected ${source.specSha256}, received ${digest}. ` +
      "Advance config/admin-client.v1.json deliberately; never generate from an unreviewed moving contract.",
  );
}

const document = JSON.parse(sourceText);
const operations = collectOperations(document);
if (operations.length !== source.operationCount) {
  throw new Error(
    `Pinned admin OpenAPI operation regression: expected ${source.operationCount}, received ${operations.length}.`,
  );
}
if (source.operationCount < 396) {
  throw new Error(`The 2026.1 generated client requires all 396 operations; the candidate exposes ${source.operationCount}.`);
}
assertCoverageContract(source, coverage, operations);

const generated = astToString(
  await openapiTS(document, {
    alphabetize: true,
    defaultNonNullable: false,
    exportType: true,
    immutable: true,
  }),
);
const typesContent = normalizeLf(`${provenance(source)}${generated}`);
const catalogContent = renderCatalog(source, operations, coverage);
const referenceContent = renderReference(source, operations, coverage);

if (mode === "write") {
  await mkdir(path.dirname(generatedTypesPath), { recursive: true });
  await writeFile(generatedTypesPath, typesContent, "utf8");
  await writeFile(generatedCatalogPath, catalogContent, "utf8");
  await writeFile(generatedReferencePath, referenceContent, "utf8");
  process.stdout.write(`Generated ${operations.length} admin operations from ${source.serverSha}.\n`);
} else {
  await assertUnchanged(generatedTypesPath, typesContent);
  await assertUnchanged(generatedCatalogPath, catalogContent);
  await assertUnchanged(generatedReferencePath, referenceContent);
  process.stdout.write(`Admin client is current at ${source.serverSha} (${operations.length} operations).\n`);
}

function assertSourceManifest(value) {
  for (const key of [
    "serverRepository",
    "serverSha",
    "specPath",
    "specSha256",
    "operationCount",
    "adminBasePath",
  ]) {
    if (value[key] === undefined || value[key] === "") throw new Error(`Admin client source manifest is missing ${key}.`);
  }
  const contract = value.adminMcpContract;
  if (!contract || typeof contract !== "object") {
    throw new Error("Admin client source manifest is missing adminMcpContract.");
  }
  for (const key of [
    "coveragePath",
    "coverageSha256",
    "exclusionRosterSha256",
    "publishedOperationCount",
    "excludedOperationCount",
    "defaultStaticToolCount",
    "defaultTotalToolCount",
    "status",
  ]) {
    if (contract[key] === undefined || contract[key] === "") {
      throw new Error(`Admin MCP contract is missing ${key}.`);
    }
  }
  if (contract.serverSha !== null && !/^[0-9a-f]{40}$/.test(contract.serverSha)) {
    throw new Error("Admin MCP contract serverSha must be null while awaiting the final server head or a full commit SHA.");
  }
  if (!/^[0-9a-f]{40}$/.test(contract.reviewServerSha)) {
    throw new Error("Admin MCP contract reviewServerSha must be a full commit SHA.");
  }
  if (contract.publishedOperationCount + contract.excludedOperationCount !== value.operationCount) {
    throw new Error(
      `Admin MCP coverage equation failed: ${contract.publishedOperationCount} published + ` +
        `${contract.excludedOperationCount} excluded != ${value.operationCount} REST operations.`,
    );
  }
  if (contract.defaultStaticToolCount + contract.publishedOperationCount !== contract.defaultTotalToolCount) {
    throw new Error(
      `Default MCP roster equation failed: ${contract.defaultStaticToolCount} static + ` +
        `${contract.publishedOperationCount} admin != ${contract.defaultTotalToolCount} total tools.`,
    );
  }
  if (value.releaseManifestOperationCount < value.operationCount) {
    process.stderr.write(
      `warning: release manifest server pin exposes ${value.releaseManifestOperationCount} admin operations; ` +
        `${value.operationCount} are required. Candidate certification remains blocked until honua-release advances.\n`,
    );
  }
}

function assertCoverageContract(source, coverage, operations) {
  const contract = source.adminMcpContract;
  if (coverage.schemaVersion !== "honua.admin-mcp-coverage.v1") {
    throw new Error(`Unsupported Admin MCP coverage schema ${coverage.schemaVersion}.`);
  }
  if (coverage.source !== source.specPath) {
    throw new Error(`Admin MCP coverage source ${coverage.source} does not match ${source.specPath}.`);
  }
  const projected = array(coverage.projected, "projected");
  const excluded = array(coverage.excluded, "excluded");
  const summary = coverage.summary ?? {};
  if (
    summary.openApiOperationCount !== source.operationCount ||
    summary.projectedOperationCount !== contract.publishedOperationCount ||
    summary.excludedOperationCount !== contract.excludedOperationCount ||
    projected.length !== contract.publishedOperationCount ||
    excluded.length !== contract.excludedOperationCount
  ) {
    throw new Error(
      `Admin MCP coverage summary does not match the pinned ${source.operationCount} REST / ` +
        `${contract.publishedOperationCount} published / ${contract.excludedOperationCount} excluded contract.`,
    );
  }
  const exclusionDigest = createHash("sha256").update(JSON.stringify(excluded)).digest("hex");
  if (exclusionDigest !== contract.exclusionRosterSha256) {
    throw new Error(
      `Admin MCP exclusion roster digest mismatch: expected ${contract.exclusionRosterSha256}, received ${exclusionDigest}.`,
    );
  }

  const openApiById = new Map(operations.map((operation) => [operation.id, operation]));
  const coveredOpenApiIds = new Set();
  const semanticOperationIds = new Set();
  const toolNames = new Set();
  for (const row of projected) {
    assertCoverageRow(row, "projected");
    if (semanticOperationIds.has(row.operationId)) throw new Error(`Duplicate Admin semantic operation ${row.operationId}.`);
    if (coveredOpenApiIds.has(row.openApiOperationId)) {
      throw new Error(`Duplicate Admin OpenAPI operation ${row.openApiOperationId}.`);
    }
    if (toolNames.has(row.toolName)) throw new Error(`Duplicate Admin MCP tool ${row.toolName}.`);
    semanticOperationIds.add(row.operationId);
    coveredOpenApiIds.add(row.openApiOperationId);
    toolNames.add(row.toolName);
    const expectedToolName = projectAdminToolName(row.operationId);
    if (row.toolName !== expectedToolName) {
      throw new Error(`Admin MCP tool-name drift for ${row.operationId}: expected ${expectedToolName}, received ${row.toolName}.`);
    }
    const operation = openApiById.get(row.openApiOperationId);
    if (!operation) throw new Error(`Admin MCP coverage references unknown OpenAPI operation ${row.openApiOperationId}.`);
    const expectedPath = `${source.adminBasePath}${operation.path}`;
    if (row.method !== operation.method || row.path !== expectedPath) {
      throw new Error(
        `Admin MCP coverage route drift for ${row.openApiOperationId}: expected ${operation.method} ${expectedPath}, ` +
          `received ${row.method} ${row.path}.`,
      );
    }
  }
  for (const row of excluded) {
    assertCoverageRow(row, "excluded");
    if (semanticOperationIds.has(row.operationId)) throw new Error(`Duplicate Admin semantic operation ${row.operationId}.`);
    if (coveredOpenApiIds.has(row.openApiOperationId)) {
      throw new Error(`Duplicate Admin OpenAPI operation ${row.openApiOperationId}.`);
    }
    if (!nonEmpty(row.code) || !nonEmpty(row.reason)) {
      throw new Error(`Admin MCP exclusion ${row.operationId} must include a code and reason.`);
    }
    semanticOperationIds.add(row.operationId);
    coveredOpenApiIds.add(row.openApiOperationId);
    if (!openApiById.has(row.openApiOperationId)) {
      throw new Error(`Admin MCP exclusion references unknown OpenAPI operation ${row.openApiOperationId}.`);
    }
  }
  const missing = [...openApiById.keys()].filter((operationId) => !coveredOpenApiIds.has(operationId));
  const unexpected = [...coveredOpenApiIds].filter((operationId) => !openApiById.has(operationId));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Admin MCP coverage must classify every REST operation exactly once; missing=${missing.join(",") || "none"}; ` +
        `unexpected=${unexpected.join(",") || "none"}.`,
    );
  }
}

function assertCoverageRow(row, family) {
  if (!row || typeof row !== "object" || !nonEmpty(row.operationId) || !nonEmpty(row.openApiOperationId)) {
    throw new Error(`Admin MCP ${family} contains an invalid coverage row.`);
  }
  if (!row.operationId.startsWith("admin.")) {
    throw new Error(`Admin MCP ${family} operation ${row.operationId} is outside the admin semantic family.`);
  }
}

function projectAdminToolName(operationId) {
  let sanitized = "";
  for (const character of operationId) {
    sanitized += /^[A-Za-z0-9]$/.test(character) ? character.toLowerCase() : "_";
  }
  return `honua_admin_${sanitized.slice("admin_".length)}`;
}

function array(value, name) {
  if (!Array.isArray(value)) throw new Error(`Admin MCP coverage ${name} must be an array.`);
  return value;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function collectOperations(document) {
  const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
  const seen = new Set();
  const result = [];
  for (const route of Object.keys(document.paths ?? {}).sort()) {
    const pathItem = document.paths[route];
    for (const method of Object.keys(pathItem).sort()) {
      if (!methods.has(method)) continue;
      const operation = pathItem[method];
      if (!operation?.operationId) throw new Error(`${method.toUpperCase()} ${route} has no operationId.`);
      if (seen.has(operation.operationId)) throw new Error(`Duplicate operationId ${operation.operationId}.`);
      seen.add(operation.operationId);
      result.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path: route,
        summary: operation.summary ?? operation.operationId,
        tags: operation.tags ?? [],
        mutating: !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()),
        group: classifyGroup(operation.operationId, route),
        requestContentTypes: Object.keys(operation.requestBody?.content ?? {}).sort(),
        responseContentTypes: Object.entries(operation.responses ?? {})
          .filter(([status]) => /^2\d\d$/.test(status) || status === "2XX")
          .flatMap(([, response]) => Object.keys(response?.content ?? {}))
          .sort(),
      });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function renderCatalog(source, operations, coverage) {
  const entries = operations
    .map(
      (operation) =>
        `  ${JSON.stringify(operation.id)}: { method: ${JSON.stringify(operation.method)}, path: ${JSON.stringify(operation.path)}, ` +
        `summary: ${JSON.stringify(operation.summary)}, tags: ${JSON.stringify(operation.tags)}, ` +
        `mutating: ${operation.mutating}, group: ${JSON.stringify(operation.group)}, ` +
        `requestContentTypes: ${JSON.stringify(operation.requestContentTypes)}, ` +
        `responseContentTypes: ${JSON.stringify(operation.responseContentTypes)} },`,
    )
    .join("\n");
  const publishedToolNames = coverage.projected.map((operation) => `  ${JSON.stringify(operation.toolName)},`).join("\n");
  const exclusions = coverage.excluded
    .map(
      (operation) =>
        `  { operationId: ${JSON.stringify(operation.operationId)}, openApiOperationId: ${JSON.stringify(operation.openApiOperationId)}, ` +
        `toolName: ${JSON.stringify(projectAdminToolName(operation.operationId))}, code: ${JSON.stringify(operation.code)}, ` +
        `reason: ${JSON.stringify(operation.reason)} },`,
    )
    .join("\n");
  const contract = source.adminMcpContract;
  return normalizeLf(`${provenance(source)}export const ADMIN_API_OPERATION_COUNT = ${operations.length} as const;
export const ADMIN_API_SERVER_SHA = ${JSON.stringify(source.serverSha)} as const;
export const ADMIN_API_SPEC_SHA256 = ${JSON.stringify(source.specSha256)} as const;
export const ADMIN_API_BASE_PATH = ${JSON.stringify(source.adminBasePath)} as const;
export const ADMIN_PUBLISHED_OPERATION_COUNT = ${contract.publishedOperationCount} as const;
export const ADMIN_MCP_EXCLUDED_OPERATION_COUNT = ${contract.excludedOperationCount} as const;
export const ADMIN_MCP_COVERAGE_SHA256 = ${JSON.stringify(contract.coverageSha256)} as const;
export const ADMIN_MCP_EXCLUSION_ROSTER_SHA256 = ${JSON.stringify(contract.exclusionRosterSha256)} as const;
export const ADMIN_MCP_CONTRACT_SERVER_SHA = ${contract.serverSha === null ? "null" : `${JSON.stringify(contract.serverSha)} as const`};
export const ADMIN_MCP_CONTRACT_REVIEW_SERVER_SHA = ${JSON.stringify(contract.reviewServerSha)} as const;
export const ADMIN_MCP_CONTRACT_STATUS = ${JSON.stringify(contract.status)} as const;
export const MCP_DEFAULT_STATIC_TOOL_COUNT = ${contract.defaultStaticToolCount} as const;
export const MCP_DEFAULT_TOTAL_TOOL_COUNT = ${contract.defaultTotalToolCount} as const;
export const ADMIN_LOCAL_SERVER_IMAGE = ${JSON.stringify(source.serverImage)} as const;
export const ADMIN_RELEASE_SERVER_SHA = ${JSON.stringify(source.releaseManifestServerSha)} as const;
export const ADMIN_RELEASE_OPERATION_COUNT = ${source.releaseManifestOperationCount} as const;
export const ADMIN_RELEASE_CONTRACT_STATUS = ${JSON.stringify(source.releaseManifestStatus)} as const;
export const ADMIN_RELEASE_CONTRACT_COMPATIBLE = ${source.releaseManifestOperationCount >= source.operationCount} as const;

export const ADMIN_MCP_PUBLISHED_TOOL_NAMES = [
${publishedToolNames}
] as const;

export const ADMIN_MCP_EXCLUDED_OPERATIONS = [
${exclusions}
] as const;

export const ADMIN_OPERATIONS = {
${entries}
} as const;

export type AdminOperationId = keyof typeof ADMIN_OPERATIONS;
export type AdminOperationDescriptor = (typeof ADMIN_OPERATIONS)[AdminOperationId];
export type AdminMcpPublishedToolName = (typeof ADMIN_MCP_PUBLISHED_TOOL_NAMES)[number];
export type AdminMcpExcludedOperation = (typeof ADMIN_MCP_EXCLUDED_OPERATIONS)[number];
`);
}

function classifyGroup(operationId, route) {
  const value = `${operationId} ${route}`.toLowerCase();
  if (route.startsWith("/connections") && !route.includes("/layers")) return "connect";
  if (route.startsWith("/import")) return "import";
  if (route.includes("/layers") || /publish|style|popup|drawing|field|filter/.test(value)) return "publish";
  if (/api-keys|users|roles|oidc|oauth|rate-limits|rls|field-mask|tenants|security/.test(value)) return "secure";
  if (/release|deploy|rollback|prevalidate|gitops/.test(value)) return "release";
  if (/status|health|cache|license|observability|operation|proposal|audit|configuration|secret/.test(value)) {
    return "operate";
  }
  return "configure";
}

function renderReference(source, operations, coverage) {
  const oneTimeSecretOperations = coverage.excluded
    .filter((operation) => operation.code === "one-time-secret-result")
    .map((operation) => `\`${operation.openApiOperationId}\``);
  const lines = [
    "<!-- GENERATED FILE - DO NOT EDIT. -->",
    "<!-- Regenerate with: npm run admin-client:generate -->",
    "",
    "# `honua admin` command reference",
    "",
    `Generated from \`${source.serverRepository}@${source.serverSha}\` (${operations.length} REST operations).`,
    "",
    "Every operation is available through `honua admin api <operationId>`. The grouped spelling",
    "`honua admin <group> <operationId>` adds an intentional workflow namespace without forking",
    "the generated request or response contract.",
    "",
    "Common options: `--body @file.json`, repeated `--path name=value`, repeated",
    "`--query name=value`, `--json`, `--dry-run`, `--yes`, and `--profile <name>`.",
    "Credential-bearing Admin requests require HTTPS; plain HTTP is accepted only",
    "for exact loopback development hosts. Base URLs with user information, query",
    "parameters, or fragments are rejected, and redirects are never followed.",
    "`--dry-run` preserves request structure but replaces credential-bearing header,",
    "query, and nested body values with `[REDACTED]`.",
    "",
    `The six one-time-secret operations (${oneTimeSecretOperations.join(", ")}) fail closed unless`,
    "`--secret-output <new-private-file>` is supplied. The CLI atomically creates that file with",
    "private permissions, refuses overwrite/reuse, and prints only allowlisted resource metadata plus",
    "the sink path and SHA-256 digest; plaintext material is never written to stdout or stderr.",
    "Existing saved profiles and local-install credential files are consumed only",
    "after the same owner-only permission/ACL proof succeeds; permissive legacy files",
    "must be rotated or reconciled rather than silently reused.",
    "",
  ];
  for (const group of ["connect", "import", "publish", "configure", "secure", "release", "operate"]) {
    lines.push(`## ${group}`, "", "| Operation ID | Method | Path | Summary |", "| --- | --- | --- | --- |");
    for (const operation of operations.filter((candidate) => candidate.group === group)) {
      lines.push(
        `| \`${operation.id}\` | \`${operation.method}\` | \`${operation.path}\` | ${operation.summary.replaceAll("|", "\\|")} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function provenance(source) {
  return (
    "// GENERATED FILE - DO NOT EDIT.\n" +
    `// Source: ${source.serverRepository}@${source.serverSha}/${source.specPath}\n` +
    `// SHA-256: ${source.specSha256}; operations: ${source.operationCount}\n` +
    "// Regenerate with: npm run admin-client:generate\n\n"
  );
}

async function assertUnchanged(filePath, expected) {
  let actual;
  try {
    actual = normalizeLf(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${path.relative(root, filePath)} is missing; run npm run admin-client:generate.`, { cause: error });
  }
  if (actual !== expected) {
    throw new Error(`${path.relative(root, filePath)} has drifted; run npm run admin-client:generate and commit the result.`);
  }
}

function normalizeLf(value) {
  return value.replace(/\r\n/g, "\n");
}
