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
  // overture-geoparquet (#656): `demo:overture:build` already orchestrates the
  // pinned-extension prepare step (`prepare-duckdb-extension.mjs`, cache-hit
  // when warm, network-fetched + SHA-256/byte-length/WebAssembly-magic
  // validated against `PARQUET_EXTENSION_PROVENANCE` otherwise) ahead of the
  // Vite build, so no bespoke orchestration is needed here — reusing the
  // existing npm script chain is the same pattern the "Acquire pinned
  // Overture extension" CI step already exercises. The emitted bundle is
  // substantially larger than every other included sample (it self-hosts the
  // duckdb-wasm main module, worker, and the ~3 MB pinned Parquet extension
  // under `duckdb/`); see docs/sample-bundles.md for the size callout.
  { id: "overture-geoparquet", buildScript: "demo:overture:build" },
];

export const INCLUDED_SAMPLE_IDS = INCLUDED_SAMPLES.map((sample) => sample.id);

/**
 * Machine-readable exclusion reason categories (#656 REQ-004). Kept in sync
 * with `samples/contract/v2/schemas/sample-bundles.schema.json`'s
 * `excludedSample.category` enum — `test/scripts/build-sample-bundles.test.mjs`
 * asserts the two never drift apart.
 */
export const EXCLUDED_SAMPLE_CATEGORIES = [
  "needs-prepare-step",
  "requires-api-key",
  "requires-live-backend",
  "requires-companion-server",
  "replay-mode-undecided",
  "agent-shaped",
  "non-browser-app",
  "non-runtime-sample",
  "lifecycle-not-active",
  "audit-pending",
];

/**
 * Hand-classified catalog entries considered for this pass and left out,
 * with the structured reason category this issue does not settle a product
 * answer for (#656 REQ-003/REQ-004). None of these are excluded because the
 * tooling can't build them offline in principle — most already build
 * fixture-safe today — they are excluded because embedding them in a public
 * gallery iframe raises a question (a live backend preference, a required
 * companion server, an agent-shaped product surface, or an owning contract)
 * this issue does not settle.
 *
 * Every other catalog entry (every `lifecycle.state !== "active"` sample) is
 * excluded categorically and mechanically by `deriveExcludedSamples` below —
 * it does not need a hand-written entry here.
 */
export const EXCLUDED_SAMPLES = [
  {
    id: "ai-spatial-app-builder",
    category: "agent-shaped",
    reason:
      "Agent-safety workbench flagship; its deterministic default needs no model/network/credential, but it has no map renderer and a complex approval-evidence UI better scoped in a follow-up.",
  },
  {
    id: "arcgis-source-app",
    category: "non-runtime-sample",
    reason:
      "Migration-codemod end-to-end test input (a pre-migration ArcGIS app), not a Honua-runtime browser sample; no Vite config.",
  },
  {
    id: "automatic-source-workflow",
    category: "non-runtime-sample",
    reason: "Documentation snippet under docs/examples/ (plain script/CDN pattern), not a Vite-built package.",
  },
  {
    id: "imagery-cog-quickstart",
    category: "requires-live-backend",
    reason:
      "Hybrid data mode with host-mediated auth and a configured-live COG leg — deferred pending a browser-public config review.",
  },
  {
    id: "node-backend-quickstart",
    category: "non-browser-app",
    reason: "Server-side Node app; no Vite config, no browser renderer.",
  },
  {
    id: "oauth-signin",
    category: "requires-companion-server",
    reason:
      "Requires its own running mock OAuth identity provider (mock-server.mjs) at runtime; no map renderer; not a static-embeddable bundle.",
  },
  {
    id: "planning-permitting-workbench",
    category: "audit-pending",
    reason:
      'Active, Vite-buildable, fixture-mode candidate with no declared config surface -- structurally similar to the already-included fixture samples. It was previously miscategorized in this file\'s "every remaining catalog entry has a non-active lifecycle" catch-all comment, which was inaccurate for this id; the REQ-001 audit (support tier, browser-secret policy, fixture determinism, runtime dependencies) has not actually been completed for it. Promotion is a follow-up decision, not resolved by this pass.',
  },
  {
    id: "react-quickstart",
    category: "requires-api-key",
    reason: "Hybrid data mode with api-key auth; needs a backend credential a static gallery bundle cannot embed.",
  },
  {
    id: "realtime-incident-dashboard",
    category: "replay-mode-undecided",
    reason:
      "Realtime flagship that prefers a deployed live stream before falling back to replay; a gallery-safe replay-only embedding mode is undecided — deferred.",
  },
  {
    id: "service-explorer",
    category: "audit-pending",
    reason:
      'Active, Vite-buildable, hybrid-mode candidate whose sole declared config (HONUA_SERVICE_EXPLORER_LIVE_ENABLED) toggles a live producer path. It was previously miscategorized in this file\'s "every remaining catalog entry has a non-active lifecycle" catch-all comment, which was inaccurate for this id; the REQ-001 audit (confirming its default resolves to a fixture-safe, secret-free config) has not actually been completed for it. Promotion is a follow-up decision, not resolved by this pass.',
  },
  {
    id: "shared-renderer-state",
    category: "non-runtime-sample",
    reason: "Documentation snippet under docs/examples/ (plain script/CDN pattern), not a Vite-built package.",
  },
];

/**
 * Combines the hand-classified `EXCLUDED_SAMPLES` above with every remaining
 * `samples/catalog.v2.json` entry that isn't bundled (#656 REQ-004): every
 * catalog id not in `INCLUDED_SAMPLE_IDS` and not hand-classified above must
 * have `lifecycle.state !== "active"` and is projected as `category:
 * "lifecycle-not-active"` with a reason generated straight from the
 * catalog's own `lifecycle.reason` (and `targetRelease` / `replacement` when
 * present) -- no hand-maintained duplicate to drift from the catalog.
 *
 * This function is the drift check: it throws if
 *  - a hand-classified id doesn't exist in the catalog;
 *  - a hand-classified id is also in `INCLUDED_SAMPLES`;
 *  - a hand-classified `"lifecycle-not-active"` entry's catalog lifecycle is
 *    actually `"active"` (its category is now wrong -- reclassify it);
 *  - a hand-classified entry using any *other* category has a catalog
 *    lifecycle that is *not* `"active"` (those categories assert the sample
 *    is otherwise buildable and only blocked by the stated product
 *    question -- use `"lifecycle-not-active"` instead once that stops being
 *    true);
 *  - an *active* catalog sample has no `INCLUDED_SAMPLES` or
 *    `EXCLUDED_SAMPLES` entry at all (a newly-added or newly-promoted active
 *    sample needs an explicit human decision, not a guessed category).
 */
export function deriveExcludedSamples(catalog, { explicit = EXCLUDED_SAMPLES, includedIds: includedIdsOption } = {}) {
  invariant(catalog && Array.isArray(catalog.samples), "catalog.samples is required");
  const includedIds = includedIdsOption ?? new Set(INCLUDED_SAMPLE_IDS);
  const byId = new Map(catalog.samples.map((sample) => [sample.id, sample]));
  const derived = [];
  const seen = new Set();

  for (const entry of explicit) {
    invariant(!seen.has(entry.id), `${entry.id}: duplicate id in EXCLUDED_SAMPLES`);
    invariant(!includedIds.has(entry.id), `${entry.id}: listed in both INCLUDED_SAMPLES and EXCLUDED_SAMPLES`);
    invariant(
      EXCLUDED_SAMPLE_CATEGORIES.includes(entry.category),
      `${entry.id}: unknown exclusion category "${entry.category}"`,
    );
    const catalogEntry = byId.get(entry.id);
    invariant(catalogEntry, `${entry.id}: not found in samples/catalog.v2.json`);
    if (entry.category === "lifecycle-not-active") {
      invariant(
        catalogEntry.lifecycle.state !== "active",
        `${entry.id}: category "lifecycle-not-active" but catalog lifecycle.state is "active" -- reclassify it`,
      );
    } else {
      invariant(
        catalogEntry.lifecycle.state === "active",
        `${entry.id}: category "${entry.category}" implies an active catalog entry but lifecycle.state is "${catalogEntry.lifecycle.state}" -- use category "lifecycle-not-active" instead`,
      );
    }
    derived.push(entry);
    seen.add(entry.id);
  }

  for (const sample of catalog.samples) {
    if (includedIds.has(sample.id) || seen.has(sample.id)) continue;
    invariant(
      sample.lifecycle.state !== "active",
      `${sample.id}: active catalog sample has no INCLUDED_SAMPLES or EXCLUDED_SAMPLES entry in scripts/build-sample-bundles.mjs -- add one with an explicit category`,
    );
    const targetRelease = sample.lifecycle.targetRelease ? ` (target ${sample.lifecycle.targetRelease})` : "";
    const replacement = sample.lifecycle.replacement
      ? ` Replacement: ${sample.lifecycle.replacement.kind} "${sample.lifecycle.replacement.id}".`
      : "";
    derived.push({
      id: sample.id,
      category: "lifecycle-not-active",
      reason: `Catalog lifecycle.state is "${sample.lifecycle.state}"${targetRelease}: ${sample.lifecycle.reason}${replacement}`,
    });
    seen.add(sample.id);
  }

  return derived.sort((left, right) => left.id.localeCompare(right.id));
}

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

  const excluded = deriveExcludedSamples(catalog);

  return {
    format: "honua.sdk.sample-bundles.v1",
    schemaVersion: 1,
    build: {
      node: packageJson.engines.node,
      lockfileSha256: sha256(packageLock),
    },
    samples,
    excluded,
  };
}

async function loadSchema() {
  return JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
}

export async function validateSampleBundleManifest(manifest, { catalog } = {}) {
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
  const excludedSeen = new Set();
  for (const excludedSample of manifest.excluded) {
    invariant(!seen.has(excludedSample.id), `${excludedSample.id}: listed in both samples and excluded`);
    invariant(!excludedSeen.has(excludedSample.id), `duplicate excluded sample id in manifest: ${excludedSample.id}`);
    excludedSeen.add(excludedSample.id);
  }
  if (catalog) {
    invariant(
      manifest.samples.length + manifest.excluded.length === catalog.samples.length,
      `manifest accounts for ${manifest.samples.length + manifest.excluded.length} of ${catalog.samples.length} catalog samples`,
    );
    for (const catalogSample of catalog.samples) {
      invariant(
        seen.has(catalogSample.id) || excludedSeen.has(catalogSample.id),
        `${catalogSample.id}: catalog sample is neither bundled nor excluded in the manifest`,
      );
    }
  }
  return manifest;
}

async function verifyOnDisk() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const catalog = await readJson("samples/catalog.v2.json");
  await validateSampleBundleManifest(manifest, { catalog });
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
    const catalog = await readJson("samples/catalog.v2.json");
    const manifest = await buildSampleBundleManifest();
    await validateSampleBundleManifest(manifest, { catalog });
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
      `Wrote ${path.relative(PROJECT_ROOT, MANIFEST_PATH)} (${manifest.samples.length} samples, ${totalFiles} files, ${(totalBytes / 1024).toFixed(1)} KiB; ${manifest.excluded.length} excluded)\n`,
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
