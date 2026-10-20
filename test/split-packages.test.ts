import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("split package manifests", () => {
  it("keeps root package scripts for split build artifacts", () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["build:split-packages"]).toContain("prepare-split-packages.mjs");
    expect(packageJson.scripts?.["verify:split-packages"]).toContain("verify-split-packages.mjs");
    expect(packageJson.scripts?.["pack:split-packages"]).toContain("dist/packages/honua-sdk");
    expect(packageJson.scripts?.["pack:split-packages"]).toContain("dist/packages/honua-sdk-esri-compat");
    expect(packageJson.scripts?.["pack:split-packages"]).not.toContain("dist/packages/honua-migrate");
  });

  it("ships internal modules imported by the split SDK root", () => {
    const prepareScript = fs.readFileSync(path.join(process.cwd(), "scripts/prepare-split-packages.mjs"), "utf8");

    expect(prepareScript).toContain('DIST_SRC_ROOT, "connect-geoservices.js"');
    expect(prepareScript).toContain('packageRoot, "connect-geoservices.js"');
    expect(prepareScript).toContain('DIST_SRC_ROOT, "connect-geoservices.d.ts"');
    expect(prepareScript).toContain('packageRoot, "connect-geoservices.d.ts"');
    expect(prepareScript).toContain('DIST_SRC_ROOT, "connect-wfs.js"');
    expect(prepareScript).toContain('packageRoot, "connect-wfs.js"');
    expect(prepareScript).toContain('DIST_SRC_ROOT, "connect-wfs.d.ts"');
    expect(prepareScript).toContain('packageRoot, "connect-wfs.d.ts"');
  });

  it("preserves optional Buf/Connect peers and exercises the installed gRPC-Web path", () => {
    const prepareScript = fs.readFileSync(path.join(process.cwd(), "scripts/prepare-split-packages.mjs"), "utf8");
    const verifier = fs.readFileSync(path.join(process.cwd(), "scripts/verify-split-packages.mjs"), "utf8");
    const sdkFactory = prepareScript.slice(
      prepareScript.indexOf("function createSdkPackage()"),
      prepareScript.indexOf("function createCompatPackage()"),
    );

    expect(sdkFactory).toContain("...optionalGrpcRuntimePeerDependencies()");
    expect(sdkFactory).toContain("...optionalGrpcRuntimePeerDependenciesMeta()");
    expect(sdkFactory).not.toContain('rootPackageJson.dependencies["@bufbuild/protobuf"]');
    expect(sdkFactory).not.toContain('rootPackageJson.dependencies["@connectrpc/connect"]');
    expect(sdkFactory).not.toContain('rootPackageJson.dependencies["@connectrpc/connect-web"]');
    expect(verifier).toContain('transport: "grpc-web"');
    expect(verifier).toContain("geospatial.v1.FeatureService/QueryFeatures");
    expect(verifier).toContain("packed-grpc-smoke");
    expect(verifier).toContain("splitPackageGrpcSmoke=ok");
    expect(verifier).toContain("verify-rest-clean-install.mjs");
    expect(verifier).toContain("missingRelativeImports");
    const compatFactory = prepareScript.slice(
      prepareScript.indexOf("function createCompatPackage()"),
      prepareScript.indexOf("function createGeometryPackage()"),
    );
    expect(compatFactory).toContain("...optionalGrpcRuntimePeerDependencies()");
    expect(compatFactory).toContain('"maplibre-gl": rootPackageJson.peerDependencies["maplibre-gl"]');
    expect(compatFactory).not.toContain('rootPackageJson.dependencies["@bufbuild/protobuf"]');
    const restProof = fs.readFileSync(path.join(process.cwd(), "scripts/verify-rest-clean-install.mjs"), "utf8");
    expect(restProof).toContain("installed-quickstart-budget.json");
    expect(restProof).toContain("temporary sample workaround");
    expect(restProof).toContain('ROOT_PACKAGE_LOCK.packages?.["node_modules/@playwright/test"]?.version');
    expect(restProof).toContain('"@playwright/test": PLAYWRIGHT_VERSION');
  });

  it("verifies discoverability metadata for every generated package", () => {
    const verifier = fs.readFileSync(path.join(process.cwd(), "scripts/verify-split-packages.mjs"), "utf8");
    const discoverability = fs.readFileSync(
      path.join(process.cwd(), "scripts/lib/package-discoverability.mjs"),
      "utf8",
    );

    expect(verifier).toContain('"@honua/app-platform"');
    expect(verifier).toContain("splitPackageDiscoverabilityErrors");
    expect(discoverability).toContain('"@honua/sdk-esri-compat"');
    expect(discoverability).toContain('"@honua/app-platform"');
    expect(discoverability).toContain('"arcgis-migration"');
    expect(discoverability).toContain('"maplibre"');
  });

  it("qualifies the installed app-platform component consumer and fail-closed export path", () => {
    const verifier = fs.readFileSync(path.join(process.cwd(), "scripts/verify-split-packages.mjs"), "utf8");
    const fixture = fs.readFileSync(
      path.join(process.cwd(), "test/fixtures/packed-app-platform-component-smoke.mjs"),
      "utf8",
    );

    expect(verifier).toContain("packed-app-platform-component-smoke.mjs");
    expect(fixture).toContain('await import("@honua/app-platform/web-components")');
    expect(fixture).toContain('"core.capability-not-supported"');
    expect(fixture).toContain("HonuaFeatureEditorElement");
    expect(fixture).toContain("packed-consumer-secret");
  });

  it("qualifies Cesium imagery through the installed app-platform scene entrypoint", () => {
    const prepareScript = fs.readFileSync(path.join(process.cwd(), "scripts/prepare-split-packages.mjs"), "utf8");
    const verifier = fs.readFileSync(path.join(process.cwd(), "scripts/verify-split-packages.mjs"), "utf8");
    const appPlatformFactory = prepareScript.slice(prepareScript.indexOf("function createAppPlatformPackage()"));

    expect(appPlatformFactory).toContain('DIST_SRC_ROOT, "connect-url-safety.js"');
    expect(appPlatformFactory).toContain('DIST_SRC_ROOT, "connect-url-safety.d.ts"');
    expect(verifier).toContain("addCesiumImageryLayer");
    expect(verifier).toContain("CESIUM_SCENE_CAPABILITIES.imagery");
    expect(verifier).toContain("SceneImageryLayerPrimitive");
  });

  it("qualifies the Cesium model-layer contract through the installed app-platform scene entrypoint", () => {
    const verifier = fs.readFileSync(path.join(process.cwd(), "scripts/verify-split-packages.mjs"), "utf8");

    expect(verifier).toContain("addCesium3DTileset");
    expect(verifier).toContain("addCesiumModel");
    expect(verifier).toContain("CESIUM_SCENE_CAPABILITIES.modelLayer?.materializedFormats");
    expect(verifier).toContain("scene-primitive-model-credentials-forbidden");
  });

  it("ships the query planner imported by the React map runtime closure", () => {
    const prepareScript = fs.readFileSync(path.join(process.cwd(), "scripts/prepare-split-packages.mjs"), "utf8");
    const reactPackageFactory = prepareScript.slice(
      prepareScript.indexOf("function createReactPackage()"),
      prepareScript.indexOf("function createAppPlatformPackage()"),
    );

    expect(reactPackageFactory).toContain('"map",');
    expect(reactPackageFactory).toContain('"query-planner",');
    expect(reactPackageFactory).toContain('"filter-registry",');
    expect(reactPackageFactory).toContain('"runtime",');
  });

  it("copies the relative-import closure each split package reaches", () => {
    const prepareScript = fs.readFileSync(path.join(process.cwd(), "scripts/prepare-split-packages.mjs"), "utf8");
    const between = (start: string, end: string) =>
      prepareScript.slice(prepareScript.indexOf(start), prepareScript.indexOf(end));
    const sdk = between("function createSdkPackage()", "function createCompatPackage()");
    const compat = between("function createCompatPackage()", "function createGeometryPackage()");
    const geometry = between("function createGeometryPackage()", "function createReactPackage()");
    const react = between("function createReactPackage()", "function createAppPlatformPackage()");
    const appPlatform = prepareScript.slice(prepareScript.indexOf("function createAppPlatformPackage()"));

    expect(sdk).toContain('DIST_SRC_ROOT, "geometry"');
    expect(sdk).toContain('copyEmittedModule(packageRoot, "widget-capabilities")');
    expect(sdk).toContain('copyEmittedModule(packageRoot, "replica-sync/types")');
    expect(compat).toContain("copyContractRuntimeClosure(packageRoot)");
    expect(geometry).toContain("copyContractRuntimeClosure(packageRoot)");
    expect(react).toContain("copyColumnarRuntimeClosure(packageRoot)");
    expect(react).toContain('"geocoding",');
    expect(react).toContain('"geometry",');
    expect(react).toContain('copyEmittedModule(packageRoot, "widget-capabilities")');
    expect(react).toContain('copyEmittedModule(packageRoot, "kernel/renderer")');
    expect(appPlatform).toContain('"columnar",');
    expect(appPlatform).toContain('"offline",');
    expect(appPlatform).toContain('copyEmittedModule(packageRoot, "kernel/renderer")');
    expect(prepareScript).toContain('DIST_SRC_ROOT, "query-planner"');
    expect(prepareScript).toContain('DIST_SRC_ROOT, "columnar"');
    expect(prepareScript).toContain('"offline/digest"');
    expect(prepareScript).toContain('"offline/quota"');
    expect(prepareScript).toContain('"offline/types"');
  });
});
