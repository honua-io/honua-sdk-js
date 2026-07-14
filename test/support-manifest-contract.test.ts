import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONNECT_SOURCE_PROTOCOLS } from "../src/connect.js";
import {
  CAPABILITIES,
  type Capability,
  PROTOCOLS,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type Source,
} from "../src/contract/types.js";
import type { HonuaOgcCollectionMap } from "../src/core/ogc-maps.js";
import type { HonuaOgcProcesses } from "../src/core/ogc-processes.js";
import type { HonuaOgcTileset } from "../src/core/ogc-tiles.js";
import type {
  HonuaFeatureLayer,
  HonuaGeometryService,
  HonuaGeoprocessingService,
  HonuaImageService,
} from "../src/core/surfaces.js";

interface OperationClaim {
  readonly operations: readonly string[];
  readonly executionMode: string;
}

interface ProtocolClaim {
  readonly id: Protocol;
  readonly operationClaims: readonly OperationClaim[];
}

interface SupportManifest {
  readonly connectProtocols: readonly Protocol[];
  readonly protocolOperations: readonly string[];
  readonly operationSurfaces: readonly OperationSurface[];
  readonly protocols: readonly ProtocolClaim[];
}

interface OperationSurface {
  readonly operation: Capability;
  readonly kind: "canonical-source" | "typed-adapter";
  readonly surface: string;
  readonly evidence: readonly string[];
}

type MethodKey<T> = Extract<
  {
    [K in keyof T]: T[K] extends (...args: infer _Args) => unknown ? K : never;
  }[keyof T],
  string
>;

function sourceSurface<K extends MethodKey<Source> | "attachments">(member: K): `Source.${K}` {
  return `Source.${member}`;
}

function typedSurface<T>(typeName: string) {
  return <K extends MethodKey<T>>(member: K): `${string}.${K}` => `${typeName}.${member}`;
}

const featureLayerSurface = typedSurface<HonuaFeatureLayer>("HonuaFeatureLayer");
const imageServiceSurface = typedSurface<HonuaImageService>("HonuaImageService");
const geometryServiceSurface = typedSurface<HonuaGeometryService>("HonuaGeometryService");
const geoprocessingServiceSurface = typedSurface<HonuaGeoprocessingService>("HonuaGeoprocessingService");
const ogcMapSurface = typedSurface<HonuaOgcCollectionMap>("HonuaOgcCollectionMap");
const ogcTilesSurface = typedSurface<HonuaOgcTileset>("HonuaOgcTileset");
const ogcProcessesSurface = typedSurface<HonuaOgcProcesses>("HonuaOgcProcesses");

const REVIEWED_OPERATION_SURFACES = [
  { operation: "query", kind: "canonical-source", surface: sourceSurface("query") },
  { operation: "queryAggregate", kind: "canonical-source", surface: sourceSurface("queryAggregate") },
  {
    operation: "spatialAggregate",
    kind: "typed-adapter",
    surface: featureLayerSurface("querySpatialAggregation"),
  },
  { operation: "queryExtent", kind: "canonical-source", surface: sourceSurface("queryExtent") },
  { operation: "queryObjectIds", kind: "canonical-source", surface: sourceSurface("queryObjectIds") },
  { operation: "queryRelated", kind: "canonical-source", surface: sourceSurface("queryRelated") },
  { operation: "applyEdits", kind: "canonical-source", surface: sourceSurface("applyEdits") },
  { operation: "attachments", kind: "canonical-source", surface: sourceSurface("attachments") },
  { operation: "render", kind: "typed-adapter", surface: ogcMapSurface("map") },
  { operation: "tiles", kind: "typed-adapter", surface: ogcTilesSurface("tile") },
  { operation: "sql", kind: "canonical-source", surface: sourceSurface("query") },
  { operation: "stream", kind: "canonical-source", surface: sourceSurface("stream") },
  { operation: "pbf", kind: "typed-adapter", surface: featureLayerSurface("queryFeatures") },
  { operation: "image", kind: "typed-adapter", surface: imageServiceSurface("exportImage") },
  { operation: "geometry", kind: "typed-adapter", surface: geometryServiceSurface("project") },
  { operation: "geoprocess", kind: "typed-adapter", surface: geoprocessingServiceSurface("submit") },
  { operation: "processes", kind: "typed-adapter", surface: ogcProcessesSurface("execute") },
] as const satisfies ReadonlyArray<{
  readonly operation: Capability;
  readonly kind: OperationSurface["kind"];
  readonly surface: string;
}>;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "config/support-manifest.v1.json"), "utf8"),
) as SupportManifest;

describe("support manifest contract parity", () => {
  it("tracks the canonical protocol and operation vocabularies in declaration order", () => {
    expect(manifest.protocols.map((protocol) => protocol.id)).toEqual(PROTOCOLS);
    expect(manifest.protocolOperations).toEqual(CAPABILITIES);
  });

  it("binds every operation vocabulary entry to a compile-checked Source or typed adapter member", () => {
    expect(manifest.operationSurfaces.map(({ operation, kind, surface }) => ({ operation, kind, surface }))).toEqual(
      REVIEWED_OPERATION_SURFACES,
    );
    expect(manifest.operationSurfaces.map(({ operation }) => operation)).toEqual(CAPABILITIES);
    for (const binding of manifest.operationSurfaces)
      expect(binding.evidence.length, binding.operation).toBeGreaterThan(0);
  });

  it("tracks every reviewed connect() adapter as product discovery rather than a Source capability", () => {
    expect(manifest.connectProtocols).toEqual(CONNECT_SOURCE_PROTOCOLS);
    expect(manifest.protocolOperations).not.toContain("connect");
    for (const protocol of manifest.protocols) {
      expect(
        protocol.operationClaims.flatMap((claim) => claim.operations),
        protocol.id,
      ).not.toContain("connect");
    }
  });

  it("tracks every native default capability without treating fallbacks as defaults", () => {
    for (const protocol of manifest.protocols) {
      const manifestedNativeOperations = protocol.operationClaims
        .filter((claim) => claim.executionMode === "native")
        .flatMap((claim) => claim.operations);
      expect(manifestedNativeOperations, protocol.id).toEqual([...PROTOCOL_DEFAULT_CAPABILITIES[protocol.id]]);
    }
  });
});
