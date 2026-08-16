#!/usr/bin/env node

// The offline region reference ships a hand-maintained application shell
// manifest whose entries pin an exact byte length and SHA-256 digest. Its
// service worker (docs/examples/offline-region-reference/service-worker.mjs)
// refuses to commit a generation when a single pin disagrees with the bytes it
// fetched, so one drifted pin leaves `shellReady` false and turns the whole
// offline browser suite red with a signature that names nothing near the cause.
// This script recomputes every pin from the real file on disk so drift is a
// one-line diff (`write`) or a named CI failure (`check`) instead of a
// debugging session.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "docs/examples/offline-region-reference/shell-manifest.v1.json";
export const EXAMPLE_DIRECTORY = "docs/examples/offline-region-reference";

// The scope the reference is served under by test/playwright/offline-indexeddb.spec.mjs
// (`/reference/`), which is also the scope the service worker derives its URL
// admission rule from. Relative manifest URLs resolve against the manifest's
// own URL inside that scope; `/dist/` is the one absolute prefix the worker's
// normalizedShellUrl() admits outside the scope.
export const SHELL_SCOPE_PATH = "/reference/";
export const SHELL_MANIFEST_FILENAME = "shell-manifest.v1.json";
const SHELL_ORIGIN = "http://localhost";
const DIST_PREFIX = "/dist/";
const DIRECTORY_INDEX_FILE = "index.html";

// Mirrors the service worker's own limits so a pin that would be rejected at
// runtime for size is reported here rather than at shell-commit time.
const SHELL_MANIFEST_FORMAT = "honua.offline-shell-manifest.v1";
const MAX_SHELL_URLS = 128;
const MAX_SHELL_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_SHELL_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_SHELL_MANIFEST_BYTES = 64 * 1024;

// The fixture server labels reference files by extension and serves everything
// under /dist/ as a module. The worker compares the bare type/subtype essence,
// lowercased, so these are the essences the manifest must pin.
const MEDIA_TYPE_BY_EXTENSION = new Map([
  [".html", "text/html"],
  [".json", "application/json"],
  [".mjs", "application/javascript"],
  [".js", "application/javascript"],
]);

/**
 * Digest encoding mirrored from the service worker's sha256Integrity():
 * `sha256:` followed by the lowercase hex expansion of the SHA-256 bytes.
 */
export function sha256Integrity(bytes) {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function shellMediaType(file) {
  const mediaType = MEDIA_TYPE_BY_EXTENSION.get(path.posix.extname(file).toLowerCase());
  if (!mediaType) throw new Error(`Application shell resource ${file} has no reviewed media type`);
  return mediaType;
}

/**
 * Resolves a manifest resource URL to its repository-relative file, mirroring
 * both the worker's URL admission rule and the fixture server's routing table:
 *   ./                -> docs/examples/offline-region-reference/index.html
 *   ./index.html      -> docs/examples/offline-region-reference/index.html
 *   ./app.mjs         -> docs/examples/offline-region-reference/app.mjs
 *   /dist/src/x.js    -> dist/src/x.js
 */
export function resolveShellResourceFile(resourceUrl) {
  if (typeof resourceUrl !== "string" || resourceUrl.length === 0) {
    throw new Error("Application shell resource URL must be a non-empty string");
  }
  const manifestUrl = new URL(`${SHELL_SCOPE_PATH}${SHELL_MANIFEST_FILENAME}`, SHELL_ORIGIN);
  let url;
  try {
    url = new URL(resourceUrl, manifestUrl);
  } catch {
    throw new Error(`Application shell resource URL is unparseable: ${resourceUrl}`);
  }
  if (url.origin !== manifestUrl.origin || url.username || url.password || url.search || url.hash) {
    throw new Error(`Application shell resource URL is unreviewed: ${resourceUrl}`);
  }
  if (url.pathname.startsWith(DIST_PREFIX)) return url.pathname.slice(1);
  if (!url.pathname.startsWith(SHELL_SCOPE_PATH)) {
    throw new Error(`Application shell resource URL escapes the reference scope: ${resourceUrl}`);
  }
  const relative = url.pathname.slice(SHELL_SCOPE_PATH.length);
  return path.posix.join(EXAMPLE_DIRECTORY, relative === "" ? DIRECTORY_INDEX_FILE : relative);
}

function readResourceBytes(projectRoot, file) {
  const absolute = path.resolve(projectRoot, file);
  if (absolute !== path.join(projectRoot, file)) {
    throw new Error(`Application shell resource path escapes the repository: ${file}`);
  }
  try {
    return fs.readFileSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const hint = file.startsWith("dist/") ? " (run `npm run build` first)" : "";
      throw new Error(`Application shell resource ${file} does not exist${hint}`);
    }
    throw error;
  }
}

/**
 * Recomputes every pin the manifest already declares. The manifest's URL list
 * stays authoritative: which files belong in the shell is a reviewed decision,
 * not something this script discovers.
 */
export function recomputeShellManifest(manifest, { projectRoot = PROJECT_ROOT } = {}) {
  if (manifest?.format !== SHELL_MANIFEST_FORMAT) {
    throw new Error(`Application shell manifest format must be ${SHELL_MANIFEST_FORMAT}`);
  }
  if (typeof manifest.deploymentId !== "string" || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(manifest.deploymentId)) {
    throw new Error("Application shell manifest deploymentId is invalid");
  }
  if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) {
    throw new Error("Application shell manifest declares no resources");
  }
  if (manifest.resources.length > MAX_SHELL_URLS) {
    throw new Error(`Application shell manifest exceeds ${MAX_SHELL_URLS} resources`);
  }

  const seen = new Set();
  const drift = [];
  let totalBytes = 0;
  const resources = manifest.resources.map((resource) => {
    const file = resolveShellResourceFile(resource?.url);
    if (seen.has(resource.url)) throw new Error(`Duplicate application shell URL: ${resource.url}`);
    seen.add(resource.url);
    const bytes = readResourceBytes(projectRoot, file);
    const recomputed = {
      url: resource.url,
      byteLength: bytes.byteLength,
      integrity: sha256Integrity(bytes),
      mediaType: shellMediaType(file),
    };
    if (recomputed.byteLength > MAX_SHELL_ASSET_BYTES) {
      throw new Error(
        `Application shell resource ${file} is ${recomputed.byteLength} bytes, over the ` +
          `${MAX_SHELL_ASSET_BYTES}-byte per-asset budget the service worker enforces`,
      );
    }
    totalBytes += recomputed.byteLength;
    for (const field of ["byteLength", "integrity", "mediaType"]) {
      if (resource[field] !== recomputed[field]) {
        drift.push({ url: resource.url, file, field, pinned: resource[field], actual: recomputed[field] });
      }
    }
    return recomputed;
  });
  if (totalBytes > MAX_SHELL_TOTAL_BYTES) {
    throw new Error(
      `Application shell totals ${totalBytes} bytes, over the ${MAX_SHELL_TOTAL_BYTES}-byte budget ` +
        "the service worker enforces",
    );
  }
  return { manifest: { ...manifest, resources }, drift, totalBytes };
}

export function serializeShellManifest(manifest) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SHELL_MANIFEST_BYTES) {
    throw new Error(`Application shell manifest exceeds its ${MAX_SHELL_MANIFEST_BYTES}-byte transfer budget`);
  }
  return serialized;
}

export function formatDriftReport(drift) {
  const lines = [
    `Application shell manifest pins are stale: ${drift.length} drifted ${drift.length === 1 ? "value" : "values"}.`,
    "The service worker refuses to commit a shell generation when any pin disagrees with the bytes it fetched,",
    "so every offline browser test fails until these are refreshed. Run `npm run offline:shell-manifest:generate`.",
    "",
  ];
  for (const entry of drift) {
    lines.push(`  ${entry.url} (${entry.file})`);
    lines.push(`    ${entry.field}: ${String(entry.pinned)} -> ${String(entry.actual)}`);
  }
  return lines.join("\n");
}

export function loadShellManifest(projectRoot = PROJECT_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, MANIFEST_PATH), "utf8"));
}

function main() {
  const mode = process.argv[2] ?? "check";
  if (mode !== "check" && mode !== "write") {
    throw new Error("Usage: node scripts/offline-shell-manifest.mjs [check|write]");
  }
  const { manifest, drift, totalBytes } = recomputeShellManifest(loadShellManifest());
  const serialized = serializeShellManifest(manifest);
  if (mode === "write") {
    fs.writeFileSync(path.join(PROJECT_ROOT, MANIFEST_PATH), serialized);
    const summary = drift.length === 0 ? "already current" : `refreshed ${drift.length}`;
    process.stdout.write(`wrote ${MANIFEST_PATH} (${manifest.resources.length} resources, ${summary})\n`);
    return;
  }
  if (drift.length > 0) {
    process.stderr.write(`${formatDriftReport(drift)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `offline shell manifest: ${manifest.resources.length} resources pinned, ${totalBytes} bytes, no drift\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
