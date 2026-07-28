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
    expect(packageJson.scripts?.["pack:split-packages"]).toContain("dist/packages/honua-migrate");
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
});
