#!/usr/bin/env node

/**
 * Build reproducible static browser bundles for the browser-embeddable sample
 * gallery entries (issue #642, completing #401 REQ-003's publication leg).
 *
 * Builds each `INCLUDED_SAMPLES` entry through its existing
 * `npm run demo:<x>:build` Vite production build with every `VITE_*`
 * environment variable stripped first, so the emitted bundle only ever uses
 * the sample's own committed fixture-mode default (no live override, no
 * secret can leak in — matches the catalog's `browser-public` configuration
 * classification for every declared config name). The built
 * `examples/<id>/dist/` output is copied into `.artifacts/sample-bundles/<id>/`
 * (both under the repository's gitignored `dist/`, so nothing this script
 * writes is committed) and a `honua.sdk.sample-bundles.v1` manifest is
 * written describing every sample's entrypoint, per-file SHA-256 / SRI
 * integrity, declared config surface, data mode, and the exact commit /
 * package version the bundle was built from.
 *
 * Publication (workflow artifact + GitHub Release asset) happens in CI
 * (.github/workflows/ci.yml `sample-bundles-release` job); see
 * docs/sample-bundles.md for the consumer contract.
 *
 * Run with:
 *   npm run samples:bundles:build   # build + write the manifest
 *   npm run samples:bundles:verify  # re-hash an existing manifest + files
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
// NOTE: NOT under dist/ — that tree is owned by the prepared-SDK artifact
// snapshot (scripts/lib/prepared-sdk-artifact.mjs); foreign files there break
// its digest verification in every downstream test step.
const OUTPUT_ROOT = path.join(PROJECT_ROOT, ".artifacts", "sample-bundles");
const MANIFEST_PATH = path.join(OUTPUT_ROOT, "sample-bundles.v1.json");
const SCHEMA_PATH = path.join(PROJECT_ROOT, "samples/contract/v2/schemas/sample-bundles.schema.json");

/**
 * Browser-buildable, gallery-embeddable catalog entries selected for this
 * first publication pass. Every entry here:
 *  - has an `examples/<id>/vite.config.ts` (Vite-buildable, not server-only);
 *  - has `lifecycle.state: "active"` in samples/catalog.v2.json;
 *  - builds fully offline/deterministic under the sample's *default*
 *    (no `.env` override) fixture-mode config: no live network call, mock
 *    server, or credential is required to open the built bundle.
 *
 * `scripts/sample-contract.mjs` imports `INCLUDED_SAMPLE_IDS` from this file
 * so the site projection can point at the same authoritative list without a
 * second hand-maintained copy.
 *
 * See EXCLUDED_SAMPLES below for the documented rationale for every other
 * catalog entry considered and left out of this pass.
 */
export const INCLUDED_SAMPLES = [
  { id: "maplibre-quickstart", buildScript: "demo:quickstart:build" },
  { id: "pmtiles-static", buildScript: "demo:pmtiles-static:build" },
  { id: "sketch-editing", buildScript: "demo:sketch-editing:build" },
  { id: "stac-imagery-browser", buildScript: "demo:stac-browser:build" },
  { id: "temporal-playback", buildScript: "demo:temporal-playback:build" },
  { id: "migration-workbench", buildScript: "demo:migration-workbench:build" },
  { id: "nl-map-control", buildScript: "demo:nl-map-control:build" },
];

export const INCLUDED_SAMPLE_IDS = INCLUDED_SAMPLES.map((sample) => sample.id);

/**
 * Every other samples/catalog.v2.json entry considered for this pass and why
 * it was left out. None of these are excluded because the tooling can't
 * build them offline in principle — most already build fixture-safe today —
 * they are excluded because embedding them in a public gallery iframe raises
 * a question (a live backend preference, a required companion server, a
 * heavier prepare step, or an owning contract) this issue does not settle.
 */
export const EXCLUDED_SAMPLES = [
  {
    id: "ai-spatial-app-builder",
    reason:
      "Agent-safety workbench flagship; its deterministic default needs no model/network/credential, but it has no map renderer and a complex approval-evidence UI better scoped in a follow-up.",
  },
  {
    id: "mcp-gis-assistant",
    reason: "MCP assistant interaction-pattern demo; agent-shaped, no map renderer — deferred.",
  },
  {
    id: "realtime-incident-dashboard",
    reason:
      "Realtime flagship that prefers a deployed live stream before falling back to replay; a gallery-safe replay-only embedding mode is undecided — deferred.",
  },
  {
    id: "overture-geoparquet",
    reason:
      "Large-data DuckDB-WASM flagship; needs a pinned-extension prepare step (`npm run demo:overture:prepare`) this build script does not orchestrate, plus a much heavier bundle — deferred.",
  },
  {
    id: "react-quickstart",
    reason: "Hybrid data mode with api-key auth; needs a backend credential a static gallery bundle cannot embed.",
  },
  {
    id: "imagery-cog-quickstart",
    reason:
      "Hybrid data mode with host-mediated auth and a configured-live COG leg — deferred pending a browser-public config review.",
  },
  {
    id: "oauth-signin",
    reason:
      "Requires its own running mock OAuth identity provider (mock-server.mjs) at runtime; no map renderer; not a static-embeddable bundle.",
  },
  {
    id: "node-backend-quickstart",
    reason: "Server-side Node app; no Vite config, no browser renderer.",
  },
  {
    id: "arcgis-source-app",
    reason:
      "Migration-codemod end-to-end test input (a pre-migration ArcGIS app), not a Honua-runtime browser sample; no Vite config.",
  },
  {
    id: "automatic-source-workflow",
    reason: "Documentation snippet under docs/examples/ (plain script/CDN pattern), not a Vite-built package.",
  },
  {
    id: "shared-renderer-state",
    reason: "Documentation snippet under docs/examples/ (plain script/CDN pattern), not a Vite-built package.",
  },
  // Every remaining catalog entry (app-bootstrap-basic, cesium-route-playback,
  // edit-workflow-demo, geocoding-quickstart, geoprocessing-job-runner,
  // kepler-analytics, planning-permitting-workbench, runtime-parity-showcase,
  // service-explorer, spatial-analytics-workbench, storytelling-25d-map,
  // terrain-rgb-elevation, unified-ops-workspace, web-components-basic) has a
  // non-"active" samples/catalog.v2.json `lifecycle.state`
  // (rework/retire/merge/replace) and is excluded categorically until it is
  // promoted back to active.
];

const MEDIA_TYPES = new Map([
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".map", "application/json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".wasm", "application/wasm"],
  [".pmtiles", "application/octet-stream"],
  [".txt", "text/plain"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function mediaTypeFor(filePath) {
  return MEDIA_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

async function walkFiles(root, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

async function hashDirectory(root) {
  const files = [];
  for (const relativePath of await walkFiles(root)) {
    const bytes = await readFile(path.join(root, relativePath));
    files.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      integrity: `sha256-${createHash("sha256").update(bytes).digest("base64")}`,
      mediaType: mediaTypeFor(relativePath),
    });
  }
  return files;
}

/** Strip every `VITE_*` variable so each build only ever sees the sample's
 * own committed fixture-mode default — never an ambient live override. */
function fixtureBuildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITE_")) delete env[key];
  }
  return env;
}

async function buildSample({ id, buildScript }, { catalog, gitCommit, packageVersion }) {
  const catalogEntry = catalog.samples.find((sample) => sample.id === id);
  invariant(catalogEntry, `${id}: not found in samples/catalog.v2.json`);
  invariant(catalogEntry.lifecycle.state === "active", `${id}: lifecycle.state must be active to bundle`);

  const exampleDist = path.join(PROJECT_ROOT, "examples", id, "dist");
  await rm(exampleDist, { recursive: true, force: true });

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  // "--base ./" makes Vite emit relative asset URLs so bundles work when
// served under per-sample subpaths (samples.honua.io/sdk/<id>/app/).
const result = spawnSync(npmCommand, ["run", buildScript, "--silent", "--", "--base", "./"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: fixtureBuildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${id}: ${buildScript} exited ${result.status}`);
  }
  invariant(fs.existsSync(path.join(exampleDist, "index.html")), `${id}: build did not emit index.html`);

  const bundleDir = path.join(OUTPUT_ROOT, id);
  await rm(bundleDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  await cp(exampleDist, bundleDir, { recursive: true });

  const files = await hashDirectory(bundleDir);
  invariant(
    files.some((file) => file.path === "index.html"),
    `${id}: copied bundle is missing index.html`,
  );

  const configDefaults = Object.fromEntries((catalogEntry.data.config ?? []).map((name) => [name, null]));

  return {
    id,
    entrypoint: "index.html",
    dataMode: catalogEntry.data.mode,
    configDefaults,
    builtFrom: { commit: gitCommit, packageVersion },
    files,
  };
}

export async function buildSampleBundleManifest({ gitCommit = gitSha() } = {}) {
  invariant(/^[a-f0-9]{40}$/.test(gitCommit), "gitCommit must be a 40-character SHA");
  const packageJson = await readJson("package.json");
  const catalog = await readJson("samples/catalog.v2.json");
  const packageLock = await readFile(path.join(PROJECT_ROOT, "package-lock.json"));

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const samples = [];
  for (const sample of INCLUDED_SAMPLES) {
    process.stdout.write(`Building ${sample.id} (${sample.buildScript})...\n`);
    samples.push(
      await buildSample(sample, { catalog, gitCommit, packageVersion: packageJson.version }),
    );
  }

  return {
    format: "honua.sdk.sample-bundles.v1",
    schemaVersion: 1,
    build: {
      node: packageJson.engines.node,
      lockfileSha256: sha256(packageLock),
    },
    samples,
  };
}

async function loadSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

export async function validateSampleBundleManifest(manifest) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(await loadSchema());
  if (!validate(manifest)) {
    throw new Error(`sample bundle manifest is invalid: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  }
  invariant(manifest.samples.length === INCLUDED_SAMPLES.length, "manifest sample count drift");
  const seen = new Set();
  for (const sample of manifest.samples) {
    invariant(!seen.has(sample.id), `duplicate sample id in manifest: ${sample.id}`);
    seen.add(sample.id);
    const paths = new Set();
    for (const file of sample.files) {
      invariant(!paths.has(file.path), `${sample.id}: duplicate file path ${file.path}`);
      paths.add(file.path);
    }
    invariant(paths.has(sample.entrypoint), `${sample.id}: entrypoint ${sample.entrypoint} is not one of its files`);
  }
  return manifest;
}

async function verifyOnDisk() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  await validateSampleBundleManifest(manifest);
  for (const sample of manifest.samples) {
    const bundleDir = path.join(OUTPUT_ROOT, sample.id);
    for (const file of sample.files) {
      const bytes = await readFile(path.join(bundleDir, file.path));
      invariant(bytes.byteLength === file.bytes, `${sample.id}/${file.path}: byte length drift`);
      invariant(sha256(bytes) === file.sha256, `${sample.id}/${file.path}: SHA-256 drift`);
      invariant(
        `sha256-${createHash("sha256").update(bytes).digest("base64")}` === file.integrity,
        `${sample.id}/${file.path}: SRI drift`,
      );
    }
  }
  process.stdout.write(
    `Verified ${manifest.samples.length} sample bundles (${manifest.samples.reduce((total, sample) => total + sample.files.length, 0)} files) against ${path.relative(PROJECT_ROOT, MANIFEST_PATH)}\n`,
  );
}

async function main(argv) {
  const [command = "build"] = argv;
  if (command === "build") {
    const manifest = await buildSampleBundleManifest();
    await validateSampleBundleManifest(manifest);
    await writeFile(MANIFEST_PATH, stableJson(manifest), "utf8");
    const totalFiles = manifest.samples.reduce((total, sample) => total + sample.files.length, 0);
    const totalBytes = manifest.samples.reduce(
      (total, sample) => total + sample.files.reduce((sum, file) => sum + file.bytes, 0),
      0,
    );
    for (const sample of manifest.samples) {
      const bytes = sample.files.reduce((sum, file) => sum + file.bytes, 0);
      process.stdout.write(`  ${sample.id}: ${sample.files.length} files, ${(bytes / 1024).toFixed(1)} KiB\n`);
    }
    process.stdout.write(
      `Wrote ${path.relative(PROJECT_ROOT, MANIFEST_PATH)} (${manifest.samples.length} samples, ${totalFiles} files, ${(totalBytes / 1024).toFixed(1)} KiB)\n`,
    );
    return;
  }
  if (command === "check") {
    await verifyOnDisk();
    return;
  }
  throw new Error(`Unknown command: ${command} (expected build|check)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-sample-bundles failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
