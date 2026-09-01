#!/usr/bin/env node

/**
 * Build prebuilt browser bundles for build-less / CDN consumers (issue #263).
 *
 * Produces two additive artifacts under `dist/browser/` from the public entry
 * (`src/index.ts`) without touching the canonical ESM + types output emitted by
 * `tsc`:
 *
 *   - `dist/browser/honua-sdk.min.js`  — minified IIFE, exposes `window.HonuaSDK`
 *     (for `<script>` / unpkg / jsdelivr usage).
 *   - `dist/browser/honua-sdk.esm.js`  — minified ESM bundle (for esm.sh /
 *     native `<script type="module">` imports).
 *
 * The heavy runtime peers (maplibre-gl, cesium, the @bufbuild / @connectrpc
 * stack) are kept EXTERNAL so the bundle stays focused on the core SDK and does
 * not inline multi-megabyte map/protobuf runtimes. The stable-core dependency,
 * `@maplibre/maplibre-gl-style-spec`, is bundled with the temporary Node 20 pin
 * of its existing transitive parser. The package's migration-forwarder
 * dependency is outside this browser graph.
 *
 * esbuild is a declared `devDependency` so the publish pipeline and CI can
 * build this artifact deterministically (the published root package ships the
 * resulting `dist/browser/*`). If the import below fails, install dev deps with
 * `npm ci`.
 *
 * Run with: `npm run build:browser`
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const ENTRY = path.join(PROJECT_ROOT, "src", "index.ts");
const OUT_DIR = path.join(PROJECT_ROOT, "dist", "browser");

const GLOBAL_NAME = "HonuaSDK";

/**
 * Runtime peers that consumers are expected to provide themselves (matches the
 * `peerDependencies` in package.json). Marking them external keeps the bundle
 * lean and avoids inlining map/protobuf runtimes that ship separately.
 */
const EXTERNAL = [
  "maplibre-gl",
  "cesium",
  "pmtiles",
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-web",
  "@duckdb/duckdb-wasm",
  "apache-arrow",
  "terra-draw",
  "terra-draw-maplibre-gl-adapter",
];

const SHARED_OPTIONS = {
  entryPoints: [ENTRY],
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: "browser",
  target: ["es2020"],
  external: EXTERNAL,
  legalComments: "none",
  metafile: true,
};

function assertNoDirectCogRetention(result, label) {
  const retained = Object.keys(result.metafile.inputs).find((input) => {
    const normalized = input.replaceAll("\\", "/");
    return normalized.includes("src/cog/") || normalized.includes("node_modules/geotiff/");
  });
  if (retained) throw new Error(`${label} unexpectedly retained the opt-in direct COG graph: ${retained}`);
}

/**
 * The declared runtime peers must stay out of the emitted graph (#1004). This
 * is not only a size guard: MapLibre 6 is ESM-only, so a bundler that inlined
 * it into the IIFE would be shipping a renderer copy that conflicts with the
 * host's own — and would pin build-less consumers to whatever major happened to
 * be installed when the artifact was built.
 */
function assertRuntimePeersExternal(result, label) {
  for (const peer of EXTERNAL) {
    const prefix = `node_modules/${peer}/`;
    const inlined = Object.keys(result.metafile.inputs).find((input) =>
      input.replaceAll("\\", "/").includes(prefix),
    );
    if (inlined) throw new Error(`${label} unexpectedly inlined the runtime peer ${peer}: ${inlined}`);
  }
}

/**
 * esbuild's `legalComments: "none"` intentionally removes comments from these
 * minified artifacts. That is safe only while every bundled input is our own
 * source. A third-party input may carry a notice that must ship with its code,
 * so fail closed until the build supplies and verifies that notice explicitly.
 */
function assertBundledInputsAreFirstParty(result, label) {
  const thirdPartyInput = Object.keys(result.metafile.inputs).find((input) =>
    input.replaceAll("\\", "/").includes("/node_modules/"),
  );
  if (thirdPartyInput) {
    throw new Error(
      `${label} bundles third-party input while legalComments is \"none\": ${thirdPartyInput}. ` +
        "Preserve and verify its required notice before bundling it.",
    );
  }
}

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const iifeOut = path.join(OUT_DIR, "honua-sdk.min.js");
  const esmOut = path.join(OUT_DIR, "honua-sdk.esm.js");

  const iifeResult = await esbuild.build({
    ...SHARED_OPTIONS,
    format: "iife",
    globalName: GLOBAL_NAME,
    outfile: iifeOut,
  });

  const esmResult = await esbuild.build({
    ...SHARED_OPTIONS,
    format: "esm",
    outfile: esmOut,
  });
  assertNoDirectCogRetention(iifeResult, "Browser IIFE");
  assertNoDirectCogRetention(esmResult, "Browser ESM");
  assertRuntimePeersExternal(iifeResult, "Browser IIFE");
  assertRuntimePeersExternal(esmResult, "Browser ESM");
  assertBundledInputsAreFirstParty(iifeResult, "Browser IIFE");
  assertBundledInputsAreFirstParty(esmResult, "Browser ESM");

  // Smoke check: the IIFE bundle must declare the global the docs promise.
  const iifeSource = fs.readFileSync(iifeOut, "utf8");
  if (!iifeSource.includes(GLOBAL_NAME)) {
    throw new Error(`Expected IIFE bundle to define the "${GLOBAL_NAME}" global, but it was not found.`);
  }

  for (const file of [iifeOut, esmOut]) {
    const { size } = fs.statSync(file);
    process.stdout.write(`  ${path.relative(PROJECT_ROOT, file)}  ${formatSize(size)}\n`);
  }
  process.stdout.write(`Browser bundles written to ${path.relative(PROJECT_ROOT, OUT_DIR)}/\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
