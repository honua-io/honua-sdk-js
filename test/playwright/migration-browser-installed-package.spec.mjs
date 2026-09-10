/**
 * Installed-package browser driver for #1662's 2026.1 codemod cohort.
 *
 * `migration-browser-real-sample.spec.mjs` proves the compat layer's
 * generated behavior is correct by serving `dist/src/**` straight from the
 * repository checkout. That is not proof the bytes a real consumer installs
 * work: the split-package boundary (`@honua/sdk` / `@honua/sdk-esri-compat`,
 * see `scripts/prepare-split-packages.mjs`) rewrites cross-package imports,
 * drops non-exported internals, and changes what actually ships. This spec
 * closes that gap:
 *
 *  1. `npm pack`s `dist/packages/honua-sdk` and `dist/packages/honua-sdk-esri-compat`
 *     and `npm install`s the tarballs into a throwaway consumer — the same
 *     bytes a registry install would deliver, never a directory reference
 *     into this checkout (`docs/oss-arcgis-corpus-post-codemod-build.md`
 *     uses the identical technique for third-party apps).
 *  2. Runs the codemod (`src/migration/codemod.ts`, unmodified, the same
 *     transform every other migration test in this repo shares) over each
 *     fixture with its DEFAULT `compatImportPath` (`@honua/sdk-esri-compat`)
 *     — real migrated-app output imports the published package by name, not
 *     a repo-relative path.
 *  3. Serves the installed package trees to a real browser with an import
 *     map resolving those bare specifiers to the installed bytes, and drives
 *     each migrated app to prove: rendering, querying/filtering, paging,
 *     popup/selection, layer controls, and (for `esri-real-sample-service-query-app`)
 *     a real HTTP round trip against a protocol-faithful FeatureServer
 *     fixture plus the documented auth-error-then-retry path, and editing.
 *
 * Full-conversion fixtures load zero `@arcgis`-origin bytes and issue zero
 * `@arcgis`-origin network requests — the assertion below is the "no hidden
 * @arcgis/core runtime" acceptance criterion, checked for real against the
 * requests Chromium actually issued, not inferred from the codemod's
 * manual-call-site count.
 *
 * Requires `npm run build:split-packages` to have produced `dist/packages/*`
 * first (`npm run test:playwright:migration-installed-driver` does this).
 * Skipped, not failed, otherwise, so the default `test:playwright` matrix —
 * which never runs that heavier build — stays green.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";
import * as esbuild from "esbuild";

import { startHonuaFeatureServerFixture } from "./honua-featureserver-fixture-server.mjs";
import { buildGeometryPeerVendors, serveVendorRequest } from "./vendor-geometry-peers.mjs";

function getProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

const PROJECT_ROOT = getProjectRoot();
const SPLIT_PACKAGE_DIRS = {
  sdk: path.join(PROJECT_ROOT, "dist/packages/honua-sdk"),
  esriCompat: path.join(PROJECT_ROOT, "dist/packages/honua-sdk-esri-compat"),
};

function npmPack(packageDir, destinationDir) {
  const result = spawnSync("npm", ["pack", packageDir, "--pack-destination", destinationDir, "--silent"], {
    cwd: destinationDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm pack ${packageDir} failed: ${(result.stderr ?? result.stdout ?? "").trim()}`);
  }
  const name = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!name) throw new Error(`npm pack ${packageDir} produced no tarball name`);
  return path.join(destinationDir, name);
}

/**
 * Packs both split packages and installs them into a throwaway consumer with
 * `--no-save` (never a registry, never a directory reference — see the
 * module header). Returns the installed package roots plus their versions.
 */
function packAndInstallSplitPackages(workDir) {
  for (const [label, dir] of Object.entries(SPLIT_PACKAGE_DIRS)) {
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      throw new Error(`missing ${dir} (${label}) — run "npm run build:split-packages" first.`);
    }
  }

  const tarballDir = path.join(workDir, "tarballs");
  fs.mkdirSync(tarballDir, { recursive: true });
  const tarballs = Object.values(SPLIT_PACKAGE_DIRS).map((dir) => npmPack(dir, tarballDir));

  const consumerDir = path.join(workDir, "consumer");
  fs.mkdirSync(consumerDir, { recursive: true });
  fs.writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
  const install = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", ...tarballs],
    { cwd: consumerDir, encoding: "utf8" },
  );
  if (install.status !== 0) {
    throw new Error(`npm install packed split packages failed: ${(install.stderr ?? install.stdout ?? "").trim()}`);
  }

  const sdkRoot = path.join(consumerDir, "node_modules", "@honua", "sdk");
  const compatRoot = path.join(consumerDir, "node_modules", "@honua", "sdk-esri-compat");
  const sdkPackageJson = JSON.parse(fs.readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
  const compatPackageJson = JSON.parse(fs.readFileSync(path.join(compatRoot, "package.json"), "utf8"));
  return {
    sdkRoot,
    compatRoot,
    sdkCoordinate: { name: sdkPackageJson.name, version: sdkPackageJson.version },
    compatCoordinate: { name: compatPackageJson.name, version: compatPackageJson.version },
  };
}

async function importInstalledCodemod() {
  const codemodPath = path.join(PROJECT_ROOT, "dist", "src", "migration", "codemod.js");
  return import(pathToFileURL(codemodPath).href);
}

function codemodFixture(runEsriCompatCodemod, fixtureName, fileExtension, tempRoot) {
  const fixtureFile = path.join(PROJECT_ROOT, "test", "fixtures", fixtureName, "src", `main.${fileExtension}`);
  const appRoot = path.join(tempRoot, "app");
  const appSrc = path.join(appRoot, "src");
  fs.mkdirSync(appSrc, { recursive: true });
  const appMain = path.join(appSrc, `main.${fileExtension}`);
  fs.copyFileSync(fixtureFile, appMain);

  // DEFAULT compatImportPath ("@honua/sdk-esri-compat"): real migrated-app
  // output, resolved through the import map below — not a repo URL rewrite.
  const result = runEsriCompatCodemod({ rootDir: appRoot, write: true });
  const source = fs.readFileSync(appMain, "utf8");
  return { result, source };
}

function transpileIfNeeded(source, fileExtension) {
  if (fileExtension === "js") return source;
  return esbuild.transformSync(source, { loader: "ts", format: "esm", target: "es2022" }).code;
}

function createIndexHtml(importMapTag, serviceUrl) {
  const serviceUrlScript = serviceUrl
    ? `<script>window.__HONUA_SERVICE_URL__ = ${JSON.stringify(serviceUrl)};</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Honua Installed-Package Migration Browser Driver</title>
    ${importMapTag}
    ${serviceUrlScript}
  </head>
  <body>
    <div id="viewDiv"></div>
    <script type="module">
      window.__migrationDone = false;
      window.__migrationResult = null;
      window.__migrationError = null;

      import("/app/main.js")
        .then((mod) => {
          window.__migrationResult = mod.default;
          window.__migrationDone = true;
        })
        .catch((error) => {
          window.__migrationError = String(error?.stack ?? error);
          window.__migrationDone = true;
          console.error(error);
        });
    </script>
  </body>
</html>`;
}

function serveStaticFile(res, filePath, contentType) {
  res.writeHead(200, { "content-type": contentType });
  res.end(fs.readFileSync(filePath));
}

function servePackageTree(requestUrl, res, mountPath, packageRoot) {
  if (!requestUrl.pathname.startsWith(mountPath)) return false;
  const relative = requestUrl.pathname.slice(mountPath.length);
  const filePath = path.join(packageRoot, relative);
  if (!filePath.startsWith(packageRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const contentType = filePath.endsWith(".json") ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8";
  serveStaticFile(res, filePath, contentType);
  return true;
}

function startServer({ appMainJs, sdkRoot, compatRoot, vendors, importMapTag, serviceUrl }) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (serveVendorRequest(requestUrl, res, vendors.outDir)) return;
    if (servePackageTree(requestUrl, res, "/pkg/sdk/", sdkRoot)) return;
    if (servePackageTree(requestUrl, res, "/pkg/esri-compat/", compatRoot)) return;

    if (requestUrl.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(createIndexHtml(importMapTag, serviceUrl));
      return;
    }

    if (requestUrl.pathname === "/app/main.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(appMainJs);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function serverUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind installed-package driver server.");
  return `http://127.0.0.1:${address.port}`;
}

let runEsriCompatCodemod;
let installed;
let workDir;
let vendors;

test.beforeAll(async () => {
  for (const dir of Object.values(SPLIT_PACKAGE_DIRS)) {
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      test.skip(true, `requires npm run build:split-packages first (missing ${dir})`);
      return;
    }
  }
  ({ runEsriCompatCodemod } = await importInstalledCodemod());
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "honua-installed-driver-"));
  installed = packAndInstallSplitPackages(workDir);
  vendors = await buildGeometryPeerVendors(PROJECT_ROOT, path.join(workDir, "vendor"));
});

test.afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

async function driveFixture(page, { fixtureName, fileExtension, expectedCallSites, assertResult, featureServer }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-installed-driver-fixture-"));
  try {
    const { result: codemodResult, source } = codemodFixture(runEsriCompatCodemod, fixtureName, fileExtension, tempRoot);
    expect(codemodResult.filesChanged).toBe(1);
    expect(codemodResult.metrics.totalCodemodScopedCallSites).toBe(expectedCallSites);
    expect(codemodResult.metrics.autoMigratedCallSites).toBe(expectedCallSites);
    expect(codemodResult.metrics.manualCallSites).toBe(0);

    const appMainJs = transpileIfNeeded(source, fileExtension);

    const importMapTag = `<script type="importmap">${JSON.stringify({
      imports: {
        "@honua/sdk": "/pkg/sdk/index.js",
        "@honua/sdk-esri-compat": "/pkg/esri-compat/index.js",
        ...vendors.imports,
      },
    })}</script>`;

    const pageErrors = [];
    const arcgisOriginRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = request.url();
      if (/arcgis/i.test(new URL(url).hostname)) arcgisOriginRequests.push(url);
    });

    const server = await startServer({
      appMainJs,
      sdkRoot: installed.sdkRoot,
      compatRoot: installed.compatRoot,
      vendors,
      importMapTag,
      serviceUrl: featureServer ? `${featureServer.url}/rest/services/parcels/FeatureServer/0` : undefined,
    });
    try {
      await page.goto(serverUrl(server));
      await expect.poll(async () => page.evaluate(() => window.__migrationDone === true)).toBe(true);

      const migrationError = await page.evaluate(() => window.__migrationError);
      const migrationResult = await page.evaluate(() => window.__migrationResult);

      expect(migrationError).toBeNull();
      expect(pageErrors).toEqual([]);
      expect(arcgisOriginRequests).toEqual([]);
      assertResult(migrationResult);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("installed-package: packed tarballs installed the coordinates dist/packages actually built", () => {
  expect(installed.sdkCoordinate.name).toBe("@honua/sdk");
  expect(installed.compatCoordinate.name).toBe("@honua/sdk-esri-compat");
  expect(installed.sdkCoordinate.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(installed.compatCoordinate.version).toBe(installed.sdkCoordinate.version);
});

test("installed-package: ops-center sample executes from published package bytes", async ({ page }) => {
  await driveFixture(page, {
    fixtureName: "esri-real-sample-ops-center-app",
    fileExtension: "js",
    expectedCallSites: 16,
    assertResult: (migrationResult) => {
      expect(migrationResult).toMatchObject({
        mapCtor: "MapCompat",
        viewCtor: "MapViewCompat",
        layerCtor: "FeatureLayerCompat",
        uiCount: 13,
        popupBefore: { id: "parcel-1" },
        popupAfterNext: { id: "parcel-2" },
        toggledBasemapId: "satellite",
        searchResultCount: 2,
      });
    },
  });
});

test("installed-package: feature-table relates sample executes from published package bytes", async ({ page }) => {
  await driveFixture(page, {
    fixtureName: "esri-demo-feature-table-relates-app",
    fileExtension: "js",
    expectedCallSites: 8,
    assertResult: (migrationResult) => {
      expect(migrationResult).toMatchObject({
        mapCtor: "MapCompat",
        viewCtor: "MapViewCompat",
        tableSizeBeforeFilter: 3,
        tableSizeAfterFilter: 2,
        selectedObjectIds: [101],
        relatedGroupCount: 1,
        relatedRecordCount: 2,
      });
    },
  });
});

test("installed-package: incident command sample executes from published package bytes", async ({ page }) => {
  await driveFixture(page, {
    fixtureName: "esri-real-sample-incident-command-app",
    fileExtension: "js",
    expectedCallSites: 28,
    assertResult: (migrationResult) => {
      expect(migrationResult).toMatchObject({
        mapCtor: "MapCompat",
        viewCtor: "MapViewCompat",
        routeTaskCount: 1,
        directionsStopCount: 2,
        activeBasemapId: "dark-gray",
      });
      expect(migrationResult.measuredDistanceMeters).toBeGreaterThan(0);
    },
  });
});

test("installed-package: TypeScript service-query sample proves real HTTP query, paging, edits, and the documented auth-error-then-retry path against a real FeatureServer", async ({
  page,
}) => {
  const featureServer = await startHonuaFeatureServerFixture();
  try {
    await driveFixture(page, {
      fixtureName: "esri-real-sample-service-query-app",
      fileExtension: "ts",
      expectedCallSites: 6,
      featureServer,
      assertResult: (migrationResult) => {
        expect(migrationResult).toMatchObject({
          mapCtor: "MapCompat",
          viewCtor: "MapViewCompat",
          layerCtor: "FeatureLayerCompat",
          layerListCtor: "LayerListCompat",
          popupCtor: "PopupCompat",
          anonymousLoadRejected: true,
          anonymousLoadErrorStatusCode: 498,
          layerFieldCount: 4,
          firstPageObjectIds: [1, 2],
          secondPageObjectIds: [3],
          totalActiveCount: 3,
          filteredCount: 3,
          addSucceeded: true,
          popupVisible: true,
        });
        expect(typeof migrationResult.addedObjectId).toBe("number");
      },
    });
  } finally {
    expect(featureServer.state.unauthorizedCount).toBeGreaterThan(0);
    await featureServer.close();
  }
});
