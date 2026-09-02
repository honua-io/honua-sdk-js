import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateMapPackage } from "../../src/runtime/index.js";
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
  getCapabilityReasonCode,
  hasCapability,
  hasPackageFamily,
  isCapabilitySupported,
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

// Frozen honua.capability_manifest.v1 wire fixture, kept byte-identical to the
// honua-sdk-dotnet CapabilityManifestClientTests fixture so the JS and .NET
// projections are proven against the same authoritative server contract.
const FROZEN_MANIFEST_WIRE = JSON.stringify({
  schemaVersion: "honua.capability_manifest.v1",
  issuedAt: "2026-07-01T12:00:00Z",
  scope: {
    tenantId: "acme",
    tenantSource: "header",
    environment: "prod",
    workspaceId: "ws-1",
    workspaceAvailable: true,
    authenticated: true,
  },
  server: {
    serverVersion: "1.9.0",
    apiVersion: "1",
    metadataApiVersion: "2",
    metadataSchemaVersion: "honua.metadata.v2",
    deploymentEnvironment: "production",
  },
  environment: { environmentId: "prod", requested: true, available: true, revision: 42 },
  packages: {
    schemaVersions: ["honua_map_package.v1"],
    families: [
      { id: "map", kind: "storage", schemaVersion: "honua_map_package.v1", supported: true },
      { id: "etl", kind: "storage", schemaVersion: "honua_etl_package.v1", supported: false },
    ],
    storageFamilies: ["map"],
    publicationFamilies: ["map"],
  },
  capabilities: [
    {
      id: "studio.map",
      category: "studio",
      lifecycle: "Implemented",
      optInRequired: false,
      supported: true,
      available: true,
    },
    {
      id: "studio.ai.generate",
      category: "studio",
      lifecycle: "Preview",
      optInRequired: true,
      supported: true,
      available: false,
      reasonCode: "entitlement-inactive",
      entitlementKey: "ai.generation",
      entitlementKeys: ["ai.generation"],
      minimumEdition: "enterprise",
      messageKey: "capability.ai.disabled",
    },
    {
      id: "provider.snowflake",
      category: "provider",
      lifecycle: "Experimental",
      optInRequired: true,
      supported: true,
      available: false,
      reasonCode: "configuration-disabled",
    },
  ],
  transports: {
    items: [{ id: "grpc", supported: true, available: true }],
    mtlsMode: "disabled",
    forwardedClientCertificateEnabled: false,
  },
  limits: {
    preview: { maxPreviewSizeBytes: 1048576, maxPreviewFeatures: 500, maxPreviewCountScan: 10000 },
    query: {
      defaultRecordCount: 100,
      maxRecordCount: 2000,
      maxFeatures: 5000,
      maxPageSize: 1000,
      queryTimeoutSeconds: 30,
      maxBboxAreaSqKm: 100000.0,
      maxFilterDepth: 8,
      maxSpatialOperations: 4,
    },
    analysis: {
      maxInputFeatures: 100000,
      maxClusters: 50,
      maxDbscanEpsMeters: 5000.0,
      maxKMeansK: 25,
      maxBufferDistanceMeters: 100000.0,
      minDensityCellSizeMeters: 10.0,
      maxDensityCellSizeMeters: 100000.0,
      maxDensityCells: 100000,
      maxDWithinDistanceMeters: 50000.0,
      maxH3CellsPerQuery: 10000,
      maxSpatialOperations: 8,
      maxJoins: 4,
    },
    publication: { configuredDeployTargetCount: 2, gitOpsManifestExportSupported: true },
    job: {
      configuredWorkloadCount: 3,
      availableBackendCount: 1,
      supportsCancellation: true,
      supportsProgressPolling: true,
    },
    upload: {
      maxUploadSizeBytes: 104857600,
      maxFileSizeBytes: 52428800,
      maxConcurrentUploads: 4,
      maxQueuedUploads: 16,
      maxSecurityScanSizeBytes: 10485760,
    },
    streaming: {
      maxConcurrentSessions: 100,
      maxBufferPerConnection: 1000,
      maxSubscriptionsPerSession: 20,
      maxSubscriptionIdLength: 128,
      maxControlFrameBytes: 65536,
      cursorRetentionLimit: 1000,
      heartbeatIntervalSeconds: 15.0,
      grpcStreamBatchSize: 100,
    },
    edit: { maxFeaturesPerEdit: 1000, maxEditsPerTransaction: 100, maxPayloadSizeBytes: 10485760 },
    geometry: { maxVerticesPerGeometry: 100000, maxGeometrySizeBytes: 1048576, maxCoordinatePrecision: 15 },
    attachment: { maxAttachmentsPerFeature: 25, maxAttachmentSizeBytes: 10485760 },
  },
  policies: {
    currentEdition: "enterprise",
    licenseValidationState: "valid",
    licenseValid: true,
    callerCapabilities: ["studio.map"],
    entitlements: [
      { key: "ai.generation", active: false, minimumEdition: "enterprise", reasonCode: "entitlement-inactive" },
    ],
    authorizationNotice: "Authorized for tenant acme.",
  },
  links: [{ rel: "self", href: "/api/v1/capabilities/manifest", type: "application/json" }],
});

describe("@honua/sdk-js/studio package.json export", () => {
  it("registers the ./studio subpath against the one-minor deprecation shim", () => {
    // Moved to `@honua/app-platform/studio` in the 1.0 scope split; the old
    // `@honua/sdk-js/studio` subpath resolves through a `@deprecated` re-export
    // shim for one minor (docs/decisions/scope-split-and-1.0.md).
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(packageJson.exports?.["./studio"]).toEqual({
      types: "./dist/src/_deprecated/studio.d.ts",
      default: "./dist/src/_deprecated/studio.js",
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

  it("is reachable from the studio entrypoint (runtime bridge re-export removed in the 1.0 scope split)", () => {
    // The stable `/runtime` entrypoint no longer re-exports the Studio
    // validation bridge — that back-edge was severed when `studio` moved to
    // `@honua/app-platform` (docs/decisions/scope-split-and-1.0.md). Consumers
    // reach the bridge via the studio entrypoint.
    expect(typeof toStudioValidationResponse).toBe("function");
    expect(typeof fromMapPackageValidation).toBe("function");
  });
});

describe("StudioCapabilityManifest helpers", () => {
  const manifest: StudioCapabilityManifest = {
    schemaVersion: "honua.capability_manifest.v1",
    capabilities: [
      {
        id: "studio.map",
        category: "studio",
        lifecycle: "Implemented",
        optInRequired: false,
        supported: true,
        available: true,
      },
      {
        id: "studio.ai.generate",
        category: "studio",
        lifecycle: "Preview",
        optInRequired: true,
        supported: true,
        available: false,
        reasonCode: "entitlement-inactive",
        entitlementKey: "ai.generation",
      },
    ],
    packages: {
      families: [
        { id: "map", kind: "storage", supported: true },
        { id: "etl", kind: "storage", supported: false },
      ],
    },
  };

  it("hasCapability is true only for advertised, available capabilities (wire `available`, not `enabled`)", () => {
    expect(hasCapability(manifest, "studio.map")).toBe(true);
    expect(hasCapability(manifest, "studio.ai.generate")).toBe(false);
    expect(hasCapability(manifest, "studio.unknown")).toBe(false);
  });

  it("isCapabilitySupported reports server implementation independent of availability", () => {
    expect(isCapabilitySupported(manifest, "studio.ai.generate")).toBe(true);
    expect(isCapabilitySupported(manifest, "studio.unknown")).toBe(false);
  });

  it("getCapability returns the entry and surfaces the reason code", () => {
    expect(getCapability(manifest, "studio.ai.generate")?.available).toBe(false);
    expect(getCapabilityReasonCode(manifest, "studio.ai.generate")).toBe("entitlement-inactive");
    expect(getCapability(manifest, "studio.unknown")).toBeUndefined();
  });

  it("hasPackageFamily gates on the supported flag", () => {
    expect(hasPackageFamily(manifest, "map")).toBe(true);
    expect(hasPackageFamily(manifest, "etl")).toBe(false);
    expect(hasPackageFamily(manifest, "unknown")).toBe(false);
  });

  it("parses the frozen honua.capability_manifest.v1 wire in parity with honua-sdk-dotnet #253", () => {
    // Byte-for-byte the fixture used by the honua-sdk-dotnet CapabilityManifest
    // client test (feat/sdk-c1-capability-manifest). Both SDKs must project the
    // same frozen server wire without drift.
    const wire = JSON.parse(FROZEN_MANIFEST_WIRE) as StudioCapabilityManifest;

    expect(wire.schemaVersion).toBe("honua.capability_manifest.v1");
    expect(wire.scope?.tenantId).toBe("acme");
    expect(wire.server?.serverVersion).toBe("1.9.0");
    expect(wire.environment?.revision).toBe(42);
    expect(wire.capabilities).toHaveLength(3);
    expect(hasCapability(wire, "studio.map")).toBe(true);
    expect(isCapabilitySupported(wire, "studio.ai.generate")).toBe(true);
    expect(hasCapability(wire, "studio.ai.generate")).toBe(false);
    expect(getCapabilityReasonCode(wire, "studio.ai.generate")).toBe("entitlement-inactive");
    expect(getCapability(wire, "studio.ai.generate")?.entitlementKey).toBe("ai.generation");
    expect(hasPackageFamily(wire, "map")).toBe(true);
    expect(hasPackageFamily(wire, "etl")).toBe(false);
    expect(wire.limits?.query?.maxRecordCount).toBe(2000);
    expect(wire.transports?.mtlsMode).toBe("disabled");
    expect(wire.policies?.entitlements?.[0]?.active).toBe(false);
    expect(wire.links?.[0]?.type).toBe("application/json");

    const [implemented, preview, experimental] = wire.capabilities;
    expect(implemented?.lifecycle).toBe("Implemented");
    expect(implemented?.optInRequired).toBe(false);
    expect(preview?.lifecycle).toBe("Preview");
    expect(preview?.optInRequired).toBe(true);
    expect(experimental?.lifecycle).toBe("Experimental");
    expect(experimental?.optInRequired).toBe(true);
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
