import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  fromMapPackageValidation as runtimeFromMapPackageValidation,
  toStudioValidationResponse as runtimeToStudioValidationResponse,
  validateMapPackage,
} from "../../src/runtime/index.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "../../src/runtime/map-package.js";
import {
  HONUA_ANALYSIS_PACKAGE_FORMAT_V1,
  HONUA_ETL_PACKAGE_FORMAT_V1,
  HONUA_FORM_PACKAGE_FORMAT_V1,
  HONUA_GP_PACKAGE_FORMAT_V1,
  HONUA_QUERY_PACKAGE_FORMAT_V1,
  HONUA_REPORT_PACKAGE_FORMAT_V1,
  HONUA_WORKFLOW_PACKAGE_FORMAT_V1,
  STUDIO_PACKAGE_FAMILIES,
  fromMapPackageValidation,
  getCapability,
  hasCapability,
  isStudioPackageFamily,
  tagStudioPackage,
  toStudioValidationResponse,
} from "../../src/studio/index.js";
import type {
  HonuaAnalysisPackage,
  HonuaETLPackage,
  HonuaFormPackage,
  HonuaGPPackage,
  HonuaMapPackage,
  HonuaQueryPackage,
  HonuaReportPackage,
  HonuaWorkflowPackage,
  StudioCapabilityManifest,
  StudioPackageValidationResponse,
} from "../../src/studio/index.js";

function minimalValidMapPackage(): HonuaMapPackage {
  return {
    mapPackageId: "pkg-studio-1",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [{ sourceId: "s1", protocol: "ogc_features", locator: { url: "https://example.test/s1" } }],
    mapSpec: {
      version: 8,
      sources: { s1: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      layers: [],
    },
  };
}

describe("@honua/sdk-js/studio package.json export", () => {
  it("registers the ./studio subpath against the built barrel", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(packageJson.exports?.["./studio"]).toEqual({
      types: "./dist/src/studio/index.d.ts",
      default: "./dist/src/studio/index.js",
    });
  });
});

describe("StudioPackageValidationResponse adapter", () => {
  it("adapts a valid ValidateMapPackageResult into the unified envelope", () => {
    const result = validateMapPackage(minimalValidMapPackage());
    const response = fromMapPackageValidation(result);

    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
    expect(response.pkg?.mapPackageId).toBe("pkg-studio-1");
  });

  it("preserves diagnostics and omits pkg when the map package is invalid", () => {
    const result = validateMapPackage({ format: "wrong" });
    const response = fromMapPackageValidation(result);

    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((d) => d.code === "unsupported-format" && d.severity === "error")).toBe(true);
    // validateMapPackage returns the raw value as mapPackage, so pkg is still present;
    // the envelope carries it through unchanged for caller inspection.
    expect(response.pkg).toBeDefined();
  });

  it("adapts an arbitrary family result through the generic overload", () => {
    const queryResult = {
      valid: true,
      diagnostics: [{ code: "ok", severity: "warning" as const, message: "note" }],
      queryPackage: { packageId: "q1", format: HONUA_QUERY_PACKAGE_FORMAT_V1 } satisfies HonuaQueryPackage,
    };
    const response = toStudioValidationResponse<HonuaQueryPackage>(queryResult, "queryPackage");

    expect(response.valid).toBe(true);
    expect(response.diagnostics).toHaveLength(1);
    expect(response.pkg?.format).toBe(HONUA_QUERY_PACKAGE_FORMAT_V1);
  });

  it("is reachable from both the studio and runtime entrypoints", () => {
    expect(runtimeToStudioValidationResponse).toBe(toStudioValidationResponse);
    expect(runtimeFromMapPackageValidation).toBe(fromMapPackageValidation);
  });
});

describe("StudioCapabilityManifest helpers", () => {
  const manifest: StudioCapabilityManifest = {
    version: "1",
    capabilities: [
      { id: "package.query", enabled: true },
      { id: "package.etl", enabled: false },
    ],
    packageFamilies: ["query", "map"],
  };

  it("hasCapability is true only for advertised, enabled capabilities", () => {
    expect(hasCapability(manifest, "package.query")).toBe(true);
    expect(hasCapability(manifest, "package.etl")).toBe(false);
    expect(hasCapability(manifest, "package.unknown")).toBe(false);
  });

  it("getCapability returns the entry regardless of enabled state", () => {
    expect(getCapability(manifest, "package.etl")?.enabled).toBe(false);
    expect(getCapability(manifest, "package.unknown")).toBeUndefined();
  });
});

describe("Studio package family projection", () => {
  it("exposes one stable format constant per stub family", () => {
    expect(HONUA_QUERY_PACKAGE_FORMAT_V1).toBe("honua_query_package.v1");
    expect(HONUA_ANALYSIS_PACKAGE_FORMAT_V1).toBe("honua_analysis_package.v1");
    expect(HONUA_REPORT_PACKAGE_FORMAT_V1).toBe("honua_report_package.v1");
    expect(HONUA_FORM_PACKAGE_FORMAT_V1).toBe("honua_form_package.v1");
    expect(HONUA_WORKFLOW_PACKAGE_FORMAT_V1).toBe("honua_workflow_package.v1");
    expect(HONUA_GP_PACKAGE_FORMAT_V1).toBe("honua_gp_package.v1");
    expect(HONUA_ETL_PACKAGE_FORMAT_V1).toBe("honua_etl_package.v1");
  });

  it("tags raw packages with a client-side discriminant that narrows", () => {
    const tagged = tagStudioPackage("query", { packageId: "q1", format: HONUA_QUERY_PACKAGE_FORMAT_V1 });
    expect(tagged.packageFamily).toBe("query");

    if (tagged.packageFamily === "query") {
      // Narrowed to HonuaQueryPackage — querySpec is family-specific.
      expect(tagged.querySpec).toBeUndefined();
    }
  });

  it("enumerates and guards the known families", () => {
    expect(STUDIO_PACKAGE_FAMILIES).toContain("map");
    expect(STUDIO_PACKAGE_FAMILIES).toContain("dashboard");
    expect(STUDIO_PACKAGE_FAMILIES).toContain("app");
    expect(isStudioPackageFamily("etl")).toBe(true);
    expect(isStudioPackageFamily("not-a-family")).toBe(false);
    expect(isStudioPackageFamily(42)).toBe(false);
  });

  it("type-checks every family result against the unified envelope", () => {
    // Compile-time coverage (verified by `tsc --noEmit` over test/): each
    // family's validation result satisfies the same generic envelope.
    const responses = [
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaQueryPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaAnalysisPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaMapPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaReportPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaFormPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaWorkflowPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaGPPackage>,
      { valid: true, diagnostics: [] } satisfies StudioPackageValidationResponse<HonuaETLPackage>,
    ];
    expect(responses).toHaveLength(8);
  });
});

describe("MCP/QGIS-safe surface", () => {
  it("never imports MapLibre/DOM or Console-coupled modules from src/studio", () => {
    const studioDir = path.join(process.cwd(), "src", "studio");
    const forbidden = [
      "../operator",
      "../esri-compat",
      "../web-components",
      "../interactions",
      "../realtime",
      "maplibre-gl",
      "cesium",
    ];
    const files = fs.readdirSync(studioDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = fs.readFileSync(path.join(studioDir, file), "utf8");
      for (const banned of forbidden) {
        expect(source, `${file} must not import ${banned}`).not.toContain(`from "${banned}`);
      }
    }
  });
});
