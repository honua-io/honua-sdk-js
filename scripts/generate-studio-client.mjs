#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "studio-client.v1.json");
const outputPath = path.join(root, "src", "studio", "generated", "studio-api.ts");
const mode = process.argv[2] ?? "check";

if (mode !== "write" && mode !== "check") {
  throw new Error("Usage: node scripts/generate-studio-client.mjs [write|check]");
}

const source = JSON.parse(await readFile(manifestPath, "utf8"));
for (const key of ["serverRepository", "serverSha", "specPath", "specSha256", "operationCount", "studioBasePath"]) {
  if (source[key] === undefined || source[key] === "") throw new Error(`Studio client source manifest is missing ${key}.`);
}
if (!/^[0-9a-f]{40}$/.test(source.serverSha)) throw new Error("Studio client serverSha must be a full commit SHA.");

const sourceUrl =
  process.env.HONUA_STUDIO_OPENAPI_URL ??
  `https://raw.githubusercontent.com/${source.serverRepository}/${source.serverSha}/${source.specPath}`;
const response = await fetch(sourceUrl, {
  headers: { Accept: "application/json", "User-Agent": "honua-sdk-js-studio-client-generator" },
});
if (!response.ok) throw new Error(`Unable to fetch pinned Studio OpenAPI (${response.status}) from ${sourceUrl}`);
const sourceText = (await response.text()).replaceAll("\r\n", "\n");
const digest = createHash("sha256").update(sourceText).digest("hex");
if (digest !== source.specSha256) {
  throw new Error(`Pinned Studio OpenAPI digest mismatch: expected ${source.specSha256}, received ${digest}.`);
}

const document = JSON.parse(sourceText);
const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
const operationCount = Object.values(document.paths ?? {}).reduce(
  (count, pathItem) => count + Object.keys(pathItem).filter((key) => methods.has(key)).length,
  0,
);
if (operationCount !== source.operationCount) {
  throw new Error(`Pinned Studio OpenAPI operation regression: expected ${source.operationCount}, received ${operationCount}.`);
}
if (document.servers?.[0]?.url !== source.studioBasePath) {
  throw new Error(`Pinned Studio base path drift: expected ${source.studioBasePath}, received ${document.servers?.[0]?.url}.`);
}

const generated = astToString(
  await openapiTS(document, { alphabetize: true, defaultNonNullable: false, exportType: true, immutable: true }),
);
const content = `// Generated from ${source.serverRepository}@${source.serverSha}\n// Source: ${source.specPath} (sha256:${source.specSha256})\n// Do not edit by hand; run npm run studio-client:generate.\n\n${generated}`;

if (mode === "write") {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  process.stdout.write(`Generated ${operationCount} Studio operations from ${source.serverSha}.\n`);
} else {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== content) throw new Error("Generated Studio client types are stale; run npm run studio-client:generate.");
  process.stdout.write(`Studio client is current at ${source.serverSha} (${operationCount} operations).\n`);
}
