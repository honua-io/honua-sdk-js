#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_ROOT = path.join(PROJECT_ROOT, "dist");
const DIST_SRC_ROOT = path.join(DIST_ROOT, "src");
const OUTPUT_ROOT = path.join(DIST_ROOT, "packages");

const rootPackageJsonPath = path.join(PROJECT_ROOT, "package.json");
const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
const version = rootPackageJson.version;
// Keep published package install support aligned with the SDK runtime floor,
// even when repo-only tooling or example dependencies need a newer Node patch.
const publishedEngines = { node: ">=20.0.0" };

if (!fs.existsSync(DIST_SRC_ROOT)) {
  process.stderr.write(
    `Missing build output at ${DIST_SRC_ROOT}. Run "npm run build" before split packaging.\n`,
  );
  process.exit(1);
}

resetOutputRoot();

createSdkPackage();
createCompatPackage();
createMigrationPackage();

process.stdout.write(`splitPackagesWritten=${OUTPUT_ROOT}\n`);

function resetOutputRoot() {
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
}

function createSdkPackage() {
  const packageRoot = path.join(OUTPUT_ROOT, "honua-sdk");
  fs.mkdirSync(packageRoot, { recursive: true });

  copyDirectory(path.join(DIST_SRC_ROOT, "contract"), path.join(packageRoot, "contract"));
  copyDirectory(path.join(DIST_SRC_ROOT, "control-plane"), path.join(packageRoot, "control-plane"));
  copyDirectory(path.join(DIST_SRC_ROOT, "collaboration"), path.join(packageRoot, "collaboration"));
  copyDirectory(path.join(DIST_SRC_ROOT, "console"), path.join(packageRoot, "console"));
  copyDirectory(path.join(DIST_SRC_ROOT, "core"), path.join(packageRoot, "core"));
  copyDirectory(path.join(DIST_SRC_ROOT, "agent-tools"), path.join(packageRoot, "agent-tools"));
  copyDirectory(path.join(DIST_SRC_ROOT, "app"), path.join(packageRoot, "app"));
  copyDirectory(path.join(DIST_SRC_ROOT, "esri-compat"), path.join(packageRoot, "esri-compat"));
  copyDirectory(path.join(DIST_SRC_ROOT, "expr"), path.join(packageRoot, "expr"));
  copyDirectory(path.join(DIST_SRC_ROOT, "exploration"), path.join(packageRoot, "exploration"));
  copyDirectory(path.join(DIST_SRC_ROOT, "filter-registry"), path.join(packageRoot, "filter-registry"));
  copyDirectory(path.join(DIST_SRC_ROOT, "geocoding"), path.join(packageRoot, "geocoding"));
  copyDirectory(path.join(DIST_SRC_ROOT, "gen"), path.join(packageRoot, "gen"));
  copyDirectory(path.join(DIST_SRC_ROOT, "generated-app"), path.join(packageRoot, "generated-app"));
  copyDirectory(path.join(DIST_SRC_ROOT, "studio"), path.join(packageRoot, "studio"));
  copyDirectory(path.join(DIST_SRC_ROOT, "interactions"), path.join(packageRoot, "interactions"));
  copyDirectory(path.join(DIST_SRC_ROOT, "app-controller"), path.join(packageRoot, "app-controller"));
  copyDirectory(path.join(DIST_SRC_ROOT, "app-workspace"), path.join(packageRoot, "app-workspace"));
  copyDirectory(path.join(DIST_SRC_ROOT, "map"), path.join(packageRoot, "map"));
  copyDirectory(path.join(DIST_SRC_ROOT, "operator"), path.join(packageRoot, "operator"));
  copyDirectory(path.join(DIST_SRC_ROOT, "realtime"), path.join(packageRoot, "realtime"));
  copyDirectory(path.join(DIST_SRC_ROOT, "runtime"), path.join(packageRoot, "runtime"));
  copyDirectory(path.join(DIST_SRC_ROOT, "scene-workspace"), path.join(packageRoot, "scene-workspace"));
  copyDirectory(path.join(DIST_SRC_ROOT, "style"), path.join(packageRoot, "style"));
  copyDirectory(path.join(DIST_SRC_ROOT, "web-components"), path.join(packageRoot, "web-components"));
  copyDirectory(path.join(DIST_SRC_ROOT, "webmap"), path.join(packageRoot, "webmap"));
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
      "./contract": {
        types: "./contract/index.d.ts",
        default: "./contract/index.js",
      },
      "./control-plane": {
        types: "./control-plane/index.d.ts",
        default: "./control-plane/index.js",
      },
      "./collaboration": {
        types: "./collaboration/index.d.ts",
        default: "./collaboration/index.js",
      },
      "./console": {
        types: "./console/index.d.ts",
        default: "./console/index.js",
      },
      "./agent-tools": {
        types: "./agent-tools/index.d.ts",
        default: "./agent-tools/index.js",
      },
      "./app": {
        types: "./app/index.d.ts",
        default: "./app/index.js",
      },
      "./web-components": {
        types: "./web-components/index.d.ts",
        default: "./web-components/index.js",
      },
      "./generated-app": {
        types: "./generated-app/index.d.ts",
        default: "./generated-app/index.js",
      },
      "./studio": {
        types: "./studio/index.d.ts",
        default: "./studio/index.js",
      },
      "./operator": {
        types: "./operator/index.d.ts",
        default: "./operator/index.js",
      },
      "./operator/controllers": {
        types: "./operator/controllers/index.d.ts",
        default: "./operator/controllers/index.js",
      },
      "./operator/workspace": {
        types: "./operator/workspace/index.d.ts",
        default: "./operator/workspace/index.js",
      },
      "./operator/theming": {
        types: "./operator/theming/index.d.ts",
        default: "./operator/theming/index.js",
      },
      "./operator/i18n": {
        types: "./operator/i18n/index.d.ts",
        default: "./operator/i18n/index.js",
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
      "./app-controller": {
        types: "./app-controller/index.d.ts",
        default: "./app-controller/index.js",
      },
      "./app-workspace": {
        types: "./app-workspace/index.d.ts",
        default: "./app-workspace/index.js",
      },
      "./realtime": {
        types: "./realtime/index.d.ts",
        default: "./realtime/index.js",
      },
      "./runtime": {
        types: "./runtime/index.d.ts",
        default: "./runtime/index.js",
      },
      "./scene-workspace": {
        types: "./scene-workspace/index.d.ts",
        default: "./scene-workspace/index.js",
      },
      "./map": {
        types: "./map/index.d.ts",
        default: "./map/index.js",
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

function copyMigrationCoreTypeSupport(packageRoot) {
  const coreRoot = path.join(packageRoot, "core");
  copyFile(path.join(DIST_SRC_ROOT, "core", "types.js"), path.join(coreRoot, "types.js"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "types.d.ts"), path.join(coreRoot, "types.d.ts"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "cache-state.js"), path.join(coreRoot, "cache-state.js"));
  copyFile(path.join(DIST_SRC_ROOT, "core", "cache-state.d.ts"), path.join(coreRoot, "cache-state.d.ts"));
}

function writePackageJson(packageRoot, overrides) {
  const packageJson = {
    name: overrides.name,
    version,
    description: overrides.description,
    type: "module",
    main: overrides.main,
    types: overrides.types,
    exports: overrides.exports,
    bin: overrides.bin,
    dependencies: overrides.dependencies,
    engines: publishedEngines,
  };

  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
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
