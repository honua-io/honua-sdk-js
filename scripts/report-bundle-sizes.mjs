#!/usr/bin/env node

/**
 * Per-entrypoint bundle-size report + budget gate (issue #350).
 *
 * Builds each public entrypoint from the `dist/` output the way a real consumer
 * would (esbuild --bundle --minify, target es2020, runtime peers external —
 * matching `scripts/build-browser-bundle.mjs`), records the minified and
 * gzipped byte sizes, and compares them to the ceilings in `bundle-budgets.json`.
 *
 * Two modes:
 *   - `report:bundle-sizes` (default): refresh `docs/bundle-sizes.md` with the
 *     current measured table (date + commit), then enforce budgets.
 *   - `verify:bundle-budgets` (`--check`): enforce budgets only; never writes
 *     files. This is the CI gate.
 *
 * Either mode exits non-zero when any entry exceeds its budget, printing a
 * per-entry delta table so the failure is actionable.
 *
 * Prerequisites (CI and local both do this): `npm run build` then
 * `npm run build:browser` so `dist/src/**` and `dist/browser/**` exist.
 *
 * Runs with: `npm run report:bundle-sizes` / `npm run verify:bundle-budgets`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const BUDGETS_FILE = path.join(PROJECT_ROOT, "bundle-budgets.json");
const DOCS_FILE = path.join(PROJECT_ROOT, "docs", "bundle-sizes.md");

/**
 * Runtime peers consumers provide themselves. Kept external so measurements
 * match `scripts/build-browser-bundle.mjs` and real consumer builds, instead of
 * inlining multi-megabyte map/protobuf runtimes.
 */
const EXTERNAL = [
  "maplibre-gl",
  "cesium",
  "pmtiles",
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-web",
  "@duckdb/duckdb-wasm",
  "@deck.gl/layers",
  "apache-arrow",
  "terra-draw",
  "terra-draw-maplibre-gl-adapter",
];

const SHARED_ESBUILD_OPTIONS = {
  bundle: true,
  minify: true,
  platform: "browser",
  target: ["es2020"],
  external: EXTERNAL,
  legalComments: "none",
  write: false,
};

/**
 * The measurable surface. Keys match `bundle-budgets.json`.
 *   - kind "bundle": bundled from a dist entry file.
 *   - kind "prebuilt": measured directly from an already-built artifact.
 *   - kind "fixture": bundled from a committed tree-shake fixture.
 */
const TARGETS = [
  { key: ".", kind: "bundle", entry: "dist/src/index.js", label: "`.` (root)" },
  { key: "/honua", kind: "bundle", entry: "dist/src/honua.js", label: "`/honua`" },
  { key: "/contract", kind: "bundle", entry: "dist/src/contract/index.js", label: "`/contract`" },
  {
    key: "/source-schema",
    kind: "bundle",
    entry: "dist/src/source-schema.js",
    label: "`/source-schema` (focused schema + pinned PROJJSON validator)",
  },
  {
    key: "/source-capabilities",
    kind: "bundle",
    entry: "dist/src/source-capabilities.js",
    label: "`/source-capabilities` (static evidence ingestion + lightweight evaluator)",
  },
  {
    key: "/source-capability-discovery",
    kind: "bundle",
    entry: "dist/src/source-capability-discovery.js",
    label: "`/source-capability-discovery` (GeoServices/OData schema-bound evaluation)",
  },
  { key: "/plugin", kind: "bundle", entry: "dist/src/plugin/index.js", label: "`/plugin` (registry + certification, no heavy peers)" },
  { key: "/agent-tools", kind: "bundle", entry: "dist/src/agent-tools/index.js", label: "`/agent-tools`" },
  { key: "/agent-safety", kind: "bundle", entry: "dist/src/agent-safety/index.js", label: "`/agent-safety`" },
  { key: "/nl-map-control", kind: "bundle", entry: "dist/src/nl-map-control/index.js", label: "`/nl-map-control`" },
  { key: "/runtime", kind: "bundle", entry: "dist/src/runtime/index.js", label: "`/runtime`" },
  { key: "/realtime", kind: "bundle", entry: "dist/src/realtime/index.js", label: "`/realtime`" },
  { key: "/offline", kind: "bundle", entry: "dist/src/offline/index.js", label: "`/offline`" },
  {
    key: "/query-planner",
    kind: "bundle",
    entry: "dist/src/query-planner/index.js",
    label: "`/query-planner` (worker runtime injected)",
  },
  {
    key: "/scene-workspace",
    kind: "bundle",
    entry: "dist/src/_deprecated/scene-workspace.js",
    label: "`/scene-workspace` (MapLibre/Cesium external — optional peers)",
  },
  { key: "/esri-compat", kind: "bundle", entry: "dist/src/esri-compat-entry.js", label: "`/esri-compat`" },
  { key: "/expr", kind: "bundle", entry: "dist/src/expr/index.js", label: "`/expr`" },
  { key: "/webmap", kind: "bundle", entry: "dist/src/webmap/index.js", label: "`/webmap`" },
  { key: "/geocoding", kind: "bundle", entry: "dist/src/geocoding/index.js", label: "`/geocoding`" },
  { key: "/routing", kind: "bundle", entry: "dist/src/routing/index.js", label: "`/routing`" },
  { key: "/auth", kind: "bundle", entry: "dist/src/core/auth/index.js", label: "`/auth`" },
  { key: "/style", kind: "bundle", entry: "dist/src/style/index.js", label: "`/style`" },
  { key: "/map", kind: "bundle", entry: "dist/src/map/index.js", label: "`/map`" },
  {
    key: "/geoparquet",
    kind: "bundle",
    entry: "dist/src/geoparquet/index.js",
    label: "`/geoparquet` (duckdb-wasm external — lazy peer)",
  },
  {
    key: "/deckgl",
    kind: "bundle",
    entry: "dist/src/deckgl/index.js",
    label: "`/deckgl` (deck.gl external — lazy peer)",
  },
  {
    key: "/react",
    kind: "bundle",
    entry: "dist/src/react/index.js",
    label: "`/react` (react/react-dom external)",
    external: ["react", "react-dom", "react/jsx-runtime"],
  },
  {
    key: "/geometry",
    kind: "bundle",
    entry: "dist/src/geometry/index.js",
    label: "`/geometry` (turf/proj4 bundled — real consumer cost)",
  },
  {
    key: "browser-iife",
    kind: "prebuilt",
    entry: "dist/browser/honua-sdk.min.js",
    label: "browser IIFE (`./browser` unpkg/jsdelivr)",
  },
  { key: "browser-esm", kind: "prebuilt", entry: "dist/browser/honua-sdk.esm.js", label: "browser ESM (`./browser`)" },
  {
    key: "tree-shake:HonuaClient",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-honua-client.mjs",
    label: "tree-shake guard (`{ HonuaClient }` only)",
  },
  {
    key: "tree-shake:root-connect",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-root-connect.mjs",
    label: "tree-shake guard (`{ connect }` from root, source-schema runtime excluded)",
  },
  {
    key: "tree-shake:source-capabilities-evaluate",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-source-capabilities-evaluate.mjs",
    label: "tree-shake guard (`{ evaluateCapabilityProfile }` only, CRS/PROJJSON validator excluded)",
    forbiddenInputs: ["dist/src/contract/schema.js", "dist/src/gen/projjson/"],
  },
  {
    key: "tree-shake:esri-compat-FeatureLayerCompat",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-esri-compat-feature-layer.mjs",
    label: "tree-shake guard (`{ FeatureLayerCompat }` from `/esri-compat`)",
  },
  {
    key: "tree-shake:geometry-buffer",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-geometry-buffer.mjs",
    label: "tree-shake guard (`{ buffer }` from `/geometry`, turf bundled)",
  },
  {
    key: "tree-shake:map-source-workflow",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-map-source-workflow.mjs",
    label: "tree-shake guard (`{ mountSourceToMapLibre }` from `/map`)",
  },
  {
    key: "tree-shake:runtime-terra-draw-sketch",
    kind: "fixture",
    entry: "scripts/bundle-size-fixtures/tree-shake-runtime-terra-draw-sketch.mjs",
    label: "tree-shake guard (`{ bindTerraDrawSketch }` from `/runtime`, terra-draw external)",
  },
];

function loadBudgets() {
  const raw = JSON.parse(fs.readFileSync(BUDGETS_FILE, "utf8"));
  const entrypoints = raw.entrypoints;
  if (!entrypoints || typeof entrypoints !== "object") {
    throw new Error(`bundle-budgets.json is missing an "entrypoints" object.`);
  }
  return entrypoints;
}

function gzipBytes(buffer) {
  return gzipSync(buffer, { level: 9 }).byteLength;
}

async function measureBundle(entryAbs, extraExternal = [], forbiddenInputs = []) {
  const result = await esbuild.build({
    ...SHARED_ESBUILD_OPTIONS,
    external: [...EXTERNAL, ...extraExternal],
    format: "esm",
    entryPoints: [entryAbs],
    metafile: forbiddenInputs.length > 0,
  });
  if (forbiddenInputs.length > 0) {
    const retainedInputs = Object.values(result.metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, metadata]) => metadata.bytesInOutput > 0)
        .map(([input]) => input.replaceAll("\\", "/")),
    );
    for (const forbiddenInput of forbiddenInputs) {
      const retained = retainedInputs.find((input) => input.includes(forbiddenInput));
      if (retained !== undefined) {
        throw new Error(`Tree-shake fixture ${entryAbs} unexpectedly retained ${retained}`);
      }
    }
  }
  const buffer = Buffer.from(result.outputFiles[0].contents);
  return { min: buffer.byteLength, gzip: gzipBytes(buffer) };
}

function measurePrebuilt(entryAbs) {
  const buffer = fs.readFileSync(entryAbs);
  return { min: buffer.byteLength, gzip: gzipBytes(buffer) };
}

async function measureAll() {
  const measurements = {};
  for (const target of TARGETS) {
    const entryAbs = path.resolve(PROJECT_ROOT, target.entry);
    if (!fs.existsSync(entryAbs)) {
      throw new Error(
        `Cannot measure "${target.key}": missing ${target.entry}. Run "npm run build" and "npm run build:browser" first.`,
      );
    }
    measurements[target.key] =
      target.kind === "prebuilt"
        ? measurePrebuilt(entryAbs)
        : await measureBundle(entryAbs, target.external ?? [], target.forbiddenInputs ?? []);
  }
  return measurements;
}

/**
 * Pure comparison used by both the CLI and the unit test. Returns per-entry
 * rows (with over/under deltas) and the list of failures (budget exceedances).
 */
export function evaluateBudgets(measurements, budgets) {
  const rows = [];
  const failures = [];
  const missingBudget = [];
  for (const key of Object.keys(measurements)) {
    const measured = measurements[key];
    const budget = budgets[key];
    if (!budget) {
      missingBudget.push(key);
      continue;
    }
    const minDelta = measured.min - budget.min;
    const gzipDelta = measured.gzip - budget.gzip;
    const overMin = minDelta > 0;
    const overGzip = gzipDelta > 0;
    const row = { key, measured, budget, minDelta, gzipDelta, overBudget: overMin || overGzip };
    rows.push(row);
    if (row.overBudget) {
      failures.push(row);
    }
  }
  return { rows, failures, missingBudget };
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function labelFor(key) {
  return TARGETS.find((t) => t.key === key)?.label ?? `\`${key}\``;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: PROJECT_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function renderDoc(rows) {
  const date = new Date().toISOString().slice(0, 10);
  const commit = gitCommit();
  const lines = [];
  lines.push("<!-- GENERATED FILE — do not edit by hand. -->");
  lines.push("<!-- Regenerate with: npm run report:bundle-sizes -->");
  lines.push("");
  lines.push("# Bundle sizes");
  lines.push("");
  lines.push(
    "Per-entrypoint bundle sizes for `@honua/sdk-js`, measured the way a real consumer builds them:",
  );
  lines.push(
    "esbuild `--bundle --minify`, target `es2020`, runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`,",
  );
  lines.push("`@connectrpc/*`) kept external. Ceilings are enforced in CI via `npm run verify:bundle-budgets`");
  lines.push("(budgets live in [`bundle-budgets.json`](../bundle-budgets.json), set to actual + ~10% headroom).");
  lines.push("");
  lines.push(`_Generated ${date} at commit \`${commit}\`._`);
  lines.push("");
  lines.push("| Entrypoint | Min | Min budget | Gzip | Gzip budget |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const row of rows) {
    lines.push(
      `| ${labelFor(row.key)} | ${formatKiB(row.measured.min)} | ${formatKiB(row.budget.min)} | ${formatKiB(
        row.measured.gzip,
      )} | ${formatKiB(row.budget.gzip)} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}`;
}

function printFailureTable(failures) {
  process.stderr.write("\nBundle-size budget EXCEEDED:\n\n");
  process.stderr.write("| Entrypoint | Metric | Measured | Budget | Delta |\n");
  process.stderr.write("| --- | --- | ---: | ---: | ---: |\n");
  for (const row of failures) {
    if (row.minDelta > 0) {
      process.stderr.write(
        `| ${row.key} | min | ${row.measured.min} | ${row.budget.min} | ${signed(row.minDelta)} |\n`,
      );
    }
    if (row.gzipDelta > 0) {
      process.stderr.write(
        `| ${row.key} | gzip | ${row.measured.gzip} | ${row.budget.gzip} | ${signed(row.gzipDelta)} |\n`,
      );
    }
  }
  process.stderr.write(
    "\nEither shrink the entrypoint, or (if the growth is legitimate) re-run\n" +
      '"npm run report:bundle-sizes" and reset the affected budget to actual + ~10% in the same PR.\n',
  );
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const budgets = loadBudgets();
  const measurements = await measureAll();
  const { rows, failures, missingBudget } = evaluateBudgets(measurements, budgets);

  if (missingBudget.length > 0) {
    process.stderr.write(`No budget declared for: ${missingBudget.join(", ")} (add them to bundle-budgets.json).\n`);
    process.exitCode = 1;
  }

  process.stdout.write(`Measured ${rows.length} entrypoints:\n`);
  for (const row of rows) {
    const flag = row.overBudget ? "  OVER BUDGET" : "";
    process.stdout.write(
      `  ${row.key.padEnd(24)} min ${formatKiB(row.measured.min).padStart(10)}  gzip ${formatKiB(
        row.measured.gzip,
      ).padStart(10)}${flag}\n`,
    );
  }

  if (!checkOnly) {
    fs.mkdirSync(path.dirname(DOCS_FILE), { recursive: true });
    fs.writeFileSync(DOCS_FILE, renderDoc(rows));
    process.stdout.write(`\nWrote ${path.relative(PROJECT_ROOT, DOCS_FILE)}\n`);
  }

  if (failures.length > 0) {
    printFailureTable(failures);
    process.exit(1);
  }

  process.stdout.write("\nAll entrypoints within budget.\n");
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
