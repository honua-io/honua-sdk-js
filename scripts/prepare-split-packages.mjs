#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entrypointsInTier, loadPublicSurface } from "./lib/public-surface.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const DIST_SRC_ROOT = path.join(DIST_ROOT, "src");
const OUTPUT_ROOT = path.join(DIST_ROOT, "packages");

const rootPackageJsonPath = path.join(PROJECT_ROOT, "package.json");
const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
const publicSurface = loadPublicSurface();
const version = rootPackageJson.version;
const ROOT_LICENSE_PATH = path.join(PROJECT_ROOT, "LICENSE");
// Keep published package install support aligned with the SDK runtime floor,
// even when repo-only tooling or example dependencies need a newer Node patch.
const publishedEngines = { node: ">=20.0.0" };

if (!fs.existsSync(DIST_SRC_ROOT)) {
  process.stderr.write(
    `Missing build output at ${DIST_SRC_ROOT}. Run "npm run build" before split packaging.\n`,
  );
  process.exit(1);
}

// The `@honua/geometry` split package (and the geometryEngine compat shim it
// backs) depend on the individual `@turf/*` packages plus `proj4`. Sourced from
// the root manifest so the published pins track the workspace.
const GEOMETRY_TURF_PACKAGES = [
  "@turf/area",
  "@turf/bbox",
  "@turf/boolean-contains",
  "@turf/boolean-intersects",
  "@turf/boolean-within",
  "@turf/buffer",
  "@turf/centroid",
  "@turf/convex",
  "@turf/difference",
  "@turf/helpers",
  "@turf/intersect",
  "@turf/length",
  "@turf/nearest-point",
  "@turf/simplify",
  "@turf/union",
];

function geometryRuntimeDependencies() {
  const deps = {};
  for (const name of GEOMETRY_TURF_PACKAGES) {
    deps[name] = rootPackageJson.devDependencies[name];
  }
  deps.proj4 = rootPackageJson.devDependencies.proj4;
  return deps;
}

resetOutputRoot();

createSdkPackage();
createCompatPackage();
createMigrationPackage();
createReactPackage();
createGeometryPackage();
createAppPlatformPackage();

process.stdout.write(`splitPackagesWritten=${OUTPUT_ROOT}\n`);

function resetOutputRoot() {
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
}

function createSdkPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-sdk");
  fs.mkdirSync(packageRoot, { recursive: true });

  // Stable-tier closure only. App-platform surfaces (app*, scene-workspace,
  // collaboration, control-plane, replica-sync, share, operate, generated-app,
  // studio, operator, controls, web-components) and the deleted `console`
  // entrypoint moved out to `@honua/app-platform` in the 1.0 scope split
  // (docs/decisions/scope-split-and-1.0.md).
  copyDirectory(path.join(DIST_SRC_ROOT, "contract"), path.join(packageRoot, "contract"));
  copyDirectory(path.join(DIST_SRC_ROOT, "columnar"), path.join(packageRoot, "columnar"));
  copyDirectory(path.join(DIST_SRC_ROOT, "core"), path.join(packageRoot, "core"));
  copyDirectory(path.join(DIST_SRC_ROOT, "deckgl"), path.join(packageRoot, "deckgl"));
  copyDirectory(path.join(DIST_SRC_ROOT, "agent-tools"), path.join(packageRoot, "agent-tools"));
  copyDirectory(path.join(DIST_SRC_ROOT, "agent-safety"), path.join(packageRoot, "agent-safety"));
  copyDirectory(path.join(DIST_SRC_ROOT, "esri-compat"), path.join(packageRoot, "esri-compat"));
  copyDirectory(path.join(DIST_SRC_ROOT, "expr"), path.join(packageRoot, "expr"));
  copyDirectory(path.join(DIST_SRC_ROOT, "exploration"), path.join(packageRoot, "exploration"));
  copyDirectory(path.join(DIST_SRC_ROOT, "filter-registry"), path.join(packageRoot, "filter-registry"));
  copyDirectory(path.join(DIST_SRC_ROOT, "geocoding"), path.join(packageRoot, "geocoding"));
  copyDirectory(path.join(DIST_SRC_ROOT, "gen"), path.join(packageRoot, "gen"));
  copyDirectory(path.join(DIST_SRC_ROOT, "interactions"), path.join(packageRoot, "interactions"));
  copyDirectory(path.join(DIST_SRC_ROOT, "map"), path.join(packageRoot, "map"));
  copyDirectory(path.join(DIST_SRC_ROOT, "plugin"), path.join(packageRoot, "plugin"));
  copyDirectory(path.join(DIST_SRC_ROOT, "offline"), path.join(packageRoot, "offline"));
  // The production map adapter executes accepted plans and its emitted .d.ts
  // references the planner contract, so keep this dependency closure intact.
  copyDirectory(path.join(DIST_SRC_ROOT, "query-planner"), path.join(packageRoot, "query-planner"));
  copyDirectory(path.join(DIST_SRC_ROOT, "realtime"), path.join(packageRoot, "realtime"));
  copyDirectory(path.join(DIST_SRC_ROOT, "runtime"), path.join(packageRoot, "runtime"));
  copyDirectory(path.join(DIST_SRC_ROOT, "style"), path.join(packageRoot, "style"));
  copyDirectory(path.join(DIST_SRC_ROOT, "webmap"), path.join(packageRoot, "webmap"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-geoservices.js"), path.join(packageRoot, "connect-geoservices.js"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-geoservices.d.ts"), path.join(packageRoot, "connect-geoservices.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-wfs.js"), path.join(packageRoot, "connect-wfs.js"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-wfs.d.ts"), path.join(packageRoot, "connect-wfs.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-odata.js"), path.join(packageRoot, "connect-odata.js"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-odata.d.ts"), path.join(packageRoot, "connect-odata.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-geoparquet.js"), path.join(packageRoot, "connect-geoparquet.js"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-geoparquet.d.ts"), path.join(packageRoot, "connect-geoparquet.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-ogc.js"), path.join(packageRoot, "connect-ogc.js"));
  copyFile(path.join(DIST_SRC_ROOT, "connect-ogc.d.ts"), path.join(packageRoot, "connect-ogc.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "connect.js"), path.join(packageRoot, "connect.js"));
  copyFile(path.join(DIST_SRC_ROOT, "connect.d.ts"), path.join(packageRoot, "connect.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "honua.js"), path.join(packageRoot, "index.js"));
  copyFile(path.join(DIST_SRC_ROOT, "honua.d.ts"), path.join(packageRoot, "index.d.ts"));

  writePackageJson(packageRoot, {
    name: "@honua/sdk",
    description: "Honua JavaScript SDK core client",
    main: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./auth": {
        types: "./core/auth/index.d.ts",
        default: "./core/auth/index.js",
      },
      "./contract": {
        types: "./contract/index.d.ts",
        default: "./contract/index.js",
      },
      "./deckgl": {
        types: "./deckgl/index.d.ts",
        default: "./deckgl/index.js",
      },
      "./agent-tools": {
        types: "./agent-tools/index.d.ts",
        default: "./agent-tools/index.js",
      },
      "./agent-safety": {
        types: "./agent-safety/index.d.ts",
        default: "./agent-safety/index.js",
      },
      "./exploration": {
        types: "./exploration/index.d.ts",
        default: "./exploration/index.js",
      },
      "./filter-registry": {
        types: "./filter-registry/index.d.ts",
        default: "./filter-registry/index.js",
      },
      "./expr": {
        types: "./expr/index.d.ts",
        default: "./expr/index.js",
      },
      "./geocoding": {
        types: "./geocoding/index.d.ts",
        default: "./geocoding/index.js",
      },
      "./interactions": {
        types: "./interactions/index.d.ts",
        default: "./interactions/index.js",
      },
      "./realtime": {
        types: "./realtime/index.d.ts",
        default: "./realtime/index.js",
      },
      "./runtime": {
        types: "./runtime/index.d.ts",
        default: "./runtime/index.js",
      },
      "./map": {
        types: "./map/index.d.ts",
        default: "./map/index.js",
      },
      "./offline": {
        types: "./offline/index.d.ts",
        default: "./offline/index.js",
      },
      "./query-planner": {
        types: "./query-planner/index.d.ts",
        default: "./query-planner/index.js",
      },
      "./plugin": {
        types: "./plugin/index.d.ts",
        default: "./plugin/index.js",
      },
      "./style": {
        types: "./style/index.d.ts",
        default: "./style/index.js",
      },
      "./webmap": {
        types: "./webmap/index.d.ts",
        default: "./webmap/index.js",
      },
    },
    dependencies: {
      "@bufbuild/protobuf": rootPackageJson.dependencies["@bufbuild/protobuf"],
      "@connectrpc/connect": rootPackageJson.dependencies["@connectrpc/connect"],
      "@connectrpc/connect-web": rootPackageJson.dependencies["@connectrpc/connect-web"],
      "@maplibre/maplibre-gl-style-spec": rootPackageJson.dependencies["@maplibre/maplibre-gl-style-spec"],
    },
    peerDependencies: {
      "@deck.gl/layers": rootPackageJson.peerDependencies["@deck.gl/layers"],
    },
    peerDependenciesMeta: {
      "@deck.gl/layers": { optional: true },
    },
  });

  writeReadme(
    packageRoot,
    [
      "# @honua/sdk",
      "",
      "Core Honua JavaScript SDK client APIs.",
      "",
      "This package is generated from `@honua/sdk-js` build artifacts.",
    ].join("\n"),
  );
}

function createCompatPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-sdk-esri-compat");
  fs.mkdirSync(packageRoot, { recursive: true });

  copyDirectory(path.join(DIST_SRC_ROOT, "contract"), path.join(packageRoot, "contract"));
  copyDirectory(path.join(DIST_SRC_ROOT, "core"), path.join(packageRoot, "core"));
  copyDirectory(path.join(DIST_SRC_ROOT, "esri-compat"), path.join(packageRoot, "esri-compat"));
  copyDirectory(path.join(DIST_SRC_ROOT, "gen"), path.join(packageRoot, "gen"));
  // The geometryEngine compat shim (esri-compat/geometry-engine.js) imports the
  // geometry package, so the compat tarball ships it and pulls turf/proj4.
  copyDirectory(path.join(DIST_SRC_ROOT, "geometry"), path.join(packageRoot, "geometry"));
  copyDirectory(path.join(DIST_SRC_ROOT, "expr"), path.join(packageRoot, "expr"));
  copyFile(path.join(DIST_SRC_ROOT, "esri-compat-entry.js"), path.join(packageRoot, "index.js"));
  copyFile(path.join(DIST_SRC_ROOT, "esri-compat-entry.d.ts"), path.join(packageRoot, "index.d.ts"));

  writePackageJson(packageRoot, {
    name: "@honua/sdk-esri-compat",
    description: "Esri compatibility bridge APIs for Honua JavaScript migration",
    main: "./index.js",
    types: "./index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
    },
    dependencies: {
      "@bufbuild/protobuf": rootPackageJson.dependencies["@bufbuild/protobuf"],
      "@connectrpc/connect": rootPackageJson.dependencies["@connectrpc/connect"],
      "@connectrpc/connect-web": rootPackageJson.dependencies["@connectrpc/connect-web"],
      ...geometryRuntimeDependencies(),
    },
  });

  writeReadme(
    packageRoot,
    [
      "# @honua/sdk-esri-compat",
      "",
      "Compatibility bridge APIs for migrating ArcGIS JavaScript apps to Honua.",
      "",
      "This package is generated from `@honua/sdk-js` build artifacts.",
    ].join("\n"),
  );
}

function createGeometryPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-geometry");
  fs.mkdirSync(packageRoot, { recursive: true });

  // Runtime graph: geometry/*.js + core/esri-geojson.js (its type imports are
  // erased). contract/expr/core are copied so the shipped .d.ts references
  // resolve; only geometry + esri-geojson are actually loaded at runtime.
  copyDirectory(path.join(DIST_SRC_ROOT, "geometry"), path.join(packageRoot, "geometry"));
  copyDirectory(path.join(DIST_SRC_ROOT, "core"), path.join(packageRoot, "core"));
  copyDirectory(path.join(DIST_SRC_ROOT, "contract"), path.join(packageRoot, "contract"));
  copyDirectory(path.join(DIST_SRC_ROOT, "expr"), path.join(packageRoot, "expr"));
  copyDirectory(path.join(DIST_SRC_ROOT, "gen"), path.join(packageRoot, "gen"));

  writePackageJson(packageRoot, {
    name: "@honua/geometry",
    description: "Curated turf/proj4 client-side geometry operations for the Honua SDK",
    main: "./geometry/index.js",
    types: "./geometry/index.d.ts",
    exports: {
      ".": {
        types: "./geometry/index.d.ts",
        default: "./geometry/index.js",
      },
    },
    dependencies: geometryRuntimeDependencies(),
  });

  writeReadme(
    packageRoot,
    [
      "# @honua/geometry",
      "",
      "Curated, tree-shakeable client-side geometry operations (buffer, area,",
      "length, simplify, boolean predicates, union/intersect/difference,",
      "reprojection) wrapping the individual `@turf/*` packages and `proj4`,",
      "typed against the Honua SDK GeoJSON contract.",
      "",
      "This package is generated from `@honua/sdk-js` build artifacts.",
    ].join("\n"),
  );
}

function createMigrationPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-migrate");
  fs.mkdirSync(packageRoot, { recursive: true });

  copyDirectory(path.join(DIST_SRC_ROOT, "migration"), path.join(packageRoot, "migration"));
  copyDirectory(path.join(DIST_SRC_ROOT, "webmap"), path.join(packageRoot, "webmap"));
  // The codemod imports `../map/webmap-maplibre.js` (and its `../style/specification.js` types),
  // so the migration package needs those siblings to resolve at runtime.
  copyFile(
    path.join(DIST_SRC_ROOT, "map", "webmap-maplibre.js"),
    path.join(packageRoot, "map", "webmap-maplibre.js"),
  );
  copyFile(
    path.join(DIST_SRC_ROOT, "map", "webmap-maplibre.d.ts"),
    path.join(packageRoot, "map", "webmap-maplibre.d.ts"),
  );
  copyFile(
    path.join(DIST_SRC_ROOT, "style", "specification.js"),
    path.join(packageRoot, "style", "specification.js"),
  );
  copyFile(
    path.join(DIST_SRC_ROOT, "style", "specification.d.ts"),
    path.join(packageRoot, "style", "specification.d.ts"),
  );
  copyMigrationCoreTypeSupport(packageRoot);
  copyFile(path.join(DIST_SRC_ROOT, "migration-entry.js"), path.join(packageRoot, "index.js"));
  copyFile(path.join(DIST_SRC_ROOT, "migration-entry.d.ts"), path.join(packageRoot, "index.d.ts"));
  fs.chmodSync(path.join(packageRoot, "migration", "cli.js"), 0o755);

  writePackageJson(packageRoot, {
    name: "@honua/honua-migrate",
    description: "ArcGIS-to-Honua migration scanner, codemod, and reporting tools",
    main: "./index.js",
    types: "./index.d.ts",
    bin: {
      "honua-migrate": "migration/cli.js",
    },
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./cli": {
        default: "./migration/cli.js",
      },
    },
    dependencies: {
      typescript: rootPackageJson.devDependencies.typescript,
    },
  });

  writeReadme(
    packageRoot,
    [
      "# @honua/honua-migrate",
      "",
      "Migration tooling for ArcGIS JavaScript to Honua transitions.",
      "",
      "CLI:",
      "",
      "```bash",
      "npx @honua/honua-migrate scan ./src",
      "npx @honua/honua-migrate codemod ./src --write --report migration-report.json",
      "npx @honua/honua-migrate reconcile --source-base-url https://source.example --source-service-id parcels --target-base-url https://target.example --target-service-id parcels --layer-id 0 --report reconcile-report.json",
      "```",
      "",
      "This package is generated from `@honua/sdk-js` build artifacts.",
    ].join("\n"),
  );
}

function createReactPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-react");
  fs.mkdirSync(packageRoot, { recursive: true });

  // Precise import closure of `src/react` (react → contract + core + runtime,
  // transitively pulling the map/style/studio stack). Copied so the package is
  // self-contained, mirroring the esri-compat / migration split targets.
  const reactClosureDirectories = [
    "contract",
    "control-plane",
    "core",
    "esri-compat",
    "exploration",
    "expr",
    "gen",
    "generated-app",
    "interactions",
    "map",
    "react",
    "runtime",
    "studio",
    "style",
    "webmap",
  ];
  for (const directory of reactClosureDirectories) {
    copyDirectory(path.join(DIST_SRC_ROOT, directory), path.join(packageRoot, directory));
  }

  writePackageJson(packageRoot, {
    name: "@honua/react",
    description: "React bindings for the Honua SDK: provider, hooks, and map components",
    main: "./react/index.js",
    types: "./react/index.d.ts",
    exports: {
      ".": {
        types: "./react/index.d.ts",
        default: "./react/index.js",
      },
    },
    dependencies: {
      "@bufbuild/protobuf": rootPackageJson.dependencies["@bufbuild/protobuf"],
      "@connectrpc/connect": rootPackageJson.dependencies["@connectrpc/connect"],
      "@connectrpc/connect-web": rootPackageJson.dependencies["@connectrpc/connect-web"],
      "@maplibre/maplibre-gl-style-spec": rootPackageJson.dependencies["@maplibre/maplibre-gl-style-spec"],
    },
    peerDependencies: {
      react: rootPackageJson.peerDependencies.react,
      "react-dom": rootPackageJson.peerDependencies["react-dom"],
      "maplibre-gl": rootPackageJson.peerDependencies["maplibre-gl"],
    },
    peerDependenciesMeta: {
      react: { optional: true },
      "react-dom": { optional: true },
      "maplibre-gl": { optional: true },
    },
  });

  writeReadme(
    packageRoot,
    [
      "# @honua/react",
      "",
      "Idiomatic React bindings for the Honua SDK — `HonuaProvider`, hooks",
      "(`useDataset`, `useQuery`, `useCapabilities`, ...), and map components",
      "(`HonuaMap`, `HonuaLayer`, `HonuaPopup`).",
      "",
      "`react` / `react-dom` are optional peer dependencies.",
      "",
      "This package is generated from `@honua/sdk-js` build artifacts.",
    ].join("\n"),
  );
}

function createAppPlatformPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-app-platform");
  fs.mkdirSync(packageRoot, { recursive: true });

  // Application-platform surfaces evicted from the stable SDK in the 1.0 scope
  // split (docs/decisions/scope-split-and-1.0.md). Self-contained, mirroring the
  // esri-compat / migration / react split targets: the app-platform entrypoints
  // plus their downward stable-tier closure are copied so the package resolves
  // without a separate `@honua/sdk-js` install.
  const movedSubpaths = entrypointsInTier(publicSurface, "deprecated").map((entrypoint) => {
    const prefix = "@honua/app-platform/";
    if (!entrypoint.replacement.startsWith(prefix)) {
      throw new Error(
        `${entrypoint.subpath} has invalid app-platform replacement ${entrypoint.replacement}`,
      );
    }
    return entrypoint.replacement.slice(prefix.length);
  });
  const appPlatformDirectories = [...new Set(movedSubpaths.map((subpath) => subpath.split("/")[0]))];
  const stableClosureDirectories = [
    "contract",
    "core",
    "esri-compat",
    "exploration",
    "expr",
    "filter-registry",
    "gen",
    "geocoding",
    "interactions",
    "map",
    "query-planner",
    "realtime",
    "runtime",
    "style",
    "webmap",
  ];
  for (const directory of [...appPlatformDirectories, ...stableClosureDirectories]) {
    copyDirectory(path.join(DIST_SRC_ROOT, directory), path.join(packageRoot, directory));
  }

  const subpathExport = (dir) => ({
    types: `./${dir}/index.d.ts`,
    default: `./${dir}/index.js`,
  });
  const appPlatformExports = Object.fromEntries(
    movedSubpaths.map((subpath) => [`./${subpath}`, subpathExport(subpath)]),
  );

  writePackageJson(packageRoot, {
    name: "@honua/app-platform",
    description:
      "Honua application-platform surfaces: app-shell, workspace, scene, operator, studio, and hosted-product clients",
    main: "./app-workspace/index.js",
    types: "./app-workspace/index.d.ts",
    exports: {
      ".": subpathExport("app-workspace"),
      ...appPlatformExports,
    },
    dependencies: {
      "@bufbuild/protobuf": rootPackageJson.dependencies["@bufbuild/protobuf"],
      "@connectrpc/connect": rootPackageJson.dependencies["@connectrpc/connect"],
      "@connectrpc/connect-web": rootPackageJson.dependencies["@connectrpc/connect-web"],
      "@maplibre/maplibre-gl-style-spec": rootPackageJson.dependencies["@maplibre/maplibre-gl-style-spec"],
    },
    peerDependencies: {
      "maplibre-gl": rootPackageJson.peerDependencies["maplibre-gl"],
      cesium: rootPackageJson.peerDependencies.cesium,
    },
    peerDependenciesMeta: {
      "maplibre-gl": { optional: true },
      cesium: { optional: true },
    },
  });

  writeReadme(
    packageRoot,
    [
      "# @honua/app-platform",
      "",
      "Honua application-platform surfaces extracted from `@honua/sdk-js` in the",
      "1.0 scope split: app-shell bootstrap, framework-neutral workspace and scene",
      "state, the app-builder studio/generated-app contracts, operator controllers,",
      "native UI controls / web components, and hosted-product clients",
      "(control-plane, collaboration, share, operate, replica-sync).",
      "",
      "`maplibre-gl` and `cesium` are optional peer dependencies.",
      "",
      "This package is generated from `@honua/sdk-js` build artifacts.",
    ].join("\n"),
  );
}

function copyMigrationCoreTypeSupport(packageRoot) {
  const coreRoot = path.join(packageRoot, "core");
  copyFile(path.join(DIST_SRC_ROOT, "core", "types.js"), path.join(coreRoot, "types.js"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "types.d.ts"), path.join(coreRoot, "types.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "cache-state.js"), path.join(coreRoot, "cache-state.js"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "cache-state.d.ts"), path.join(coreRoot, "cache-state.d.ts"));
  // path-utils provides the linear slash/trim helpers used by migration/reconcile + content
  // (self-contained, no further core deps).
  copyFile(path.join(DIST_SRC_ROOT, "core", "path-utils.js"), path.join(coreRoot, "path-utils.js"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "path-utils.d.ts"), path.join(coreRoot, "path-utils.d.ts"));
}

function writePackageJson(packageRoot, overrides) {
  const packageJson = {
    name: overrides.name,
    version,
    description: overrides.description,
    license: rootPackageJson.license,
    // npm provenance (trusted publishing) rejects tarballs whose
    // repository.url does not match the repo the attestation names.
    repository: rootPackageJson.repository,
    type: "module",
    main: overrides.main,
    types: overrides.types,
    exports: overrides.exports,
    bin: overrides.bin,
    dependencies: overrides.dependencies,
    peerDependencies: overrides.peerDependencies,
    peerDependenciesMeta: overrides.peerDependenciesMeta,
    engines: publishedEngines,
  };

  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );

  // Ship the repository LICENSE alongside each published package so the
  // distributed Apache-2.0 artifacts carry both the `license` field and the
  // license text.
  copyFile(ROOT_LICENSE_PATH, path.join(packageRoot, "LICENSE"));
}

function writeReadme(packageRoot, contents) {
  fs.writeFileSync(path.join(packageRoot, "README.md"), `${contents}\n`, "utf8");
}

function copyFile(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyDirectory(sourceDirectory, destinationDirectory) {
  fs.cpSync(sourceDirectory, destinationDirectory, { recursive: true });
}
