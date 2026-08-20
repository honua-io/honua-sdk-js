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

const generated = astToString(
  await openapiTS(document, {
    alphabetize: true,
    defaultNonNullable: false,
    exportType: true,
    immutable: true,
  }),
);
const typesContent = normalizeLf(`${provenance(source)}${generated}`);
const catalogContent = renderCatalog(source, operations);
const referenceContent = renderReference(source, operations);

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
  if (value.releaseManifestOperationCount < value.operationCount) {
    process.stderr.write(
      `warning: release manifest server pin exposes ${value.releaseManifestOperationCount} admin operations; ` +
        `${value.operationCount} are required. Candidate certification remains blocked until honua-release advances.\n`,
    );
  }
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
      });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

function renderCatalog(source, operations) {
  const entries = operations
    .map(
      (operation) =>
        `  ${JSON.stringify(operation.id)}: { method: ${JSON.stringify(operation.method)}, path: ${JSON.stringify(operation.path)}, ` +
        `summary: ${JSON.stringify(operation.summary)}, tags: ${JSON.stringify(operation.tags)}, ` +
        `mutating: ${operation.mutating}, group: ${JSON.stringify(operation.group)} },`,
    )
    .join("\n");
  return normalizeLf(`${provenance(source)}export const ADMIN_API_OPERATION_COUNT = ${operations.length} as const;
export const ADMIN_API_SERVER_SHA = ${JSON.stringify(source.serverSha)} as const;
export const ADMIN_API_SPEC_SHA256 = ${JSON.stringify(source.specSha256)} as const;
export const ADMIN_API_BASE_PATH = ${JSON.stringify(source.adminBasePath)} as const;
export const ADMIN_PUBLISHED_OPERATION_COUNT = ${source.publishedAdminOperationCount} as const;
export const ADMIN_LOCAL_SERVER_IMAGE = ${JSON.stringify(source.serverImage)} as const;
export const ADMIN_RELEASE_SERVER_SHA = ${JSON.stringify(source.releaseManifestServerSha)} as const;
export const ADMIN_RELEASE_OPERATION_COUNT = ${source.releaseManifestOperationCount} as const;
export const ADMIN_RELEASE_CONTRACT_STATUS = ${JSON.stringify(source.releaseManifestStatus)} as const;
export const ADMIN_RELEASE_CONTRACT_COMPATIBLE = ${source.releaseManifestOperationCount >= source.operationCount} as const;

export const ADMIN_OPERATIONS = {
${entries}
} as const;

export type AdminOperationId = keyof typeof ADMIN_OPERATIONS;
export type AdminOperationDescriptor = (typeof ADMIN_OPERATIONS)[AdminOperationId];
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

function renderReference(source, operations) {
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
  return `${lines.join("\n")}\n`;
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
