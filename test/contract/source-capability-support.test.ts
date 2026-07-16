import { describe, expect, it } from "vitest";

import {
  type Capability,
  type Source,
  type SourceDescriptor,
  capabilities,
  createDataset,
  geoServicesFeatureSource,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { geoparquetSource } from "../../src/geoparquet/index.js";
import {
  type CapabilityEvidenceEntry,
  type CapabilityId,
  createCapabilityEvidenceProfile,
  evaluateCapabilityProfile,
} from "../../src/source-capabilities.js";

import { makeMockClient } from "./shared.js";

const SOURCE_FINGERPRINT = `sha256:${"a".repeat(64)}` as const;
const OBSERVED_AT = "2026-07-01T00:00:00Z";
const EXPIRES_AT = "2026-08-01T00:00:00Z";
const EVALUATED_AT = "2026-07-15T00:00:00Z";

function observedEntry(
  id: CapabilityId,
  observed: "supported" | "unsupported" | "unknown",
  options: Pick<CapabilityEvidenceEntry, "authorizationScopes" | "requirements"> = {},
): CapabilityEvidenceEntry {
  return {
    id,
    claimed: "supported",
    observed,
    evidence: [
      { kind: "protocol-default", truth: "supported", reference: `adapter:${id}` },
      {
        kind: "metadata",
        truth: observed,
        reference: `metadata:${id}`,
        observedAt: OBSERVED_AT,
        expiresAt: EXPIRES_AT,
      },
    ],
    ...options,
  };
}

function evaluatedProfile() {
  const evidence = createCapabilityEvidenceProfile(
    [
      observedEntry("query", "supported"),
      observedEntry("queryAggregate", "unsupported"),
      observedEntry("queryExtent", "unknown"),
      observedEntry("stream", "supported"),
      observedEntry("render", "supported", { requirements: { peers: ["maplibre-gl"] } }),
      observedEntry("applyEdits", "supported", { authorizationScopes: ["dataset:parcels:write"] }),
      observedEntry("io.honua.capability.export", "supported"),
    ],
    {
      sourceFingerprint: SOURCE_FINGERPRINT,
      sourceEndpoint: {
        endpoint: "https://mock/rest/services/Parcels/FeatureServer/0",
        protocol: "geoservices-feature-service",
        sourceId: "parcels",
      },
    },
  );
  return evaluateCapabilityProfile(evidence, {
    evaluatedAt: EVALUATED_AT,
    policy: { deny: ["stream"] },
    environment: "browser",
    availablePeers: [],
    authorization: { deniedScopes: ["dataset:parcels:write"] },
  });
}

function profileForThirdParty() {
  return evaluateCapabilityProfile(
    createCapabilityEvidenceProfile(
      [observedEntry("query", "supported"), observedEntry("queryAggregate", "unsupported")],
      {
        sourceFingerprint: SOURCE_FINGERPRINT,
        sourceEndpoint: {
          endpoint: "https://mock/data.geojson",
          protocol: "maplibre-geojson",
          sourceId: "third-party-profiled",
        },
      },
    ),
    { evaluatedAt: EVALUATED_AT },
  );
}

function profileForGeoparquet() {
  return evaluateCapabilityProfile(
    createCapabilityEvidenceProfile(
      [
        observedEntry("query", "supported"),
        observedEntry("queryAggregate", "unsupported"),
        observedEntry("stream", "supported"),
      ],
      {
        sourceFingerprint: SOURCE_FINGERPRINT,
        sourceEndpoint: {
          endpoint: "https://mock/parcels.parquet",
          protocol: "geoparquet",
          sourceId: "parcels-parquet",
        },
      },
    ),
    { evaluatedAt: EVALUATED_AT },
  );
}

function descriptor(declared: readonly Capability[], capabilityProfile = evaluatedProfile()): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock", serviceId: "Parcels", layerId: 0 },
    capabilities: capabilities(declared),
    schemaV2: {
      kind: "honua.source-schema",
      version: "2.0",
      fingerprint: SOURCE_FINGERPRINT,
    },
    capabilityProfile,
  };
}

describe("source.supports()", () => {
  it("uses only effective supported decisions and derives the legacy built-in set", async () => {
    const profile = evaluatedProfile();
    const dataset = createDataset({
      id: "parcels",
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      sources: [descriptor(["query", "queryAggregate", "queryExtent", "stream", "render", "applyEdits"], profile)],
    });

    const source = dataset.source("parcels")!;
    expect(source.capabilityProfile).toBe(profile);
    expect(source.descriptor.capabilityProfile).toBe(profile);
    expect([...source.capabilities]).toEqual(["query"]);
    expect([...dataset.sourceDescriptors[0]!.capabilities]).toEqual(["query"]);
    expect(() => (source.capabilities as Set<Capability>).add("queryAggregate")).toThrow(TypeError);
    expect(() => (dataset.sourceDescriptors[0]!.capabilities as Set<Capability>).add("queryAggregate")).toThrow(
      TypeError,
    );
    expect([...source.capabilities]).toEqual(["query"]);

    expect(source.supports("query")).toBe(true);
    expect(source.supports("io.honua.capability.export")).toBe(true);
    expect(source.supports("queryAggregate")).toBe(false);
    expect(source.supports("queryExtent")).toBe(false);
    expect(source.supports("stream")).toBe(false);
    expect(source.supports("render")).toBe(false);
    expect(source.supports("applyEdits")).toBe(false);
    expect(source.supports("io.honua.capability.missing")).toBe(false);

    expect(profile.entries.find((entry) => entry.id === "queryAggregate")).toMatchObject({
      effective: "unsupported",
      reasons: ["unsupported-by-observation"],
    });
    expect(profile.entries.find((entry) => entry.id === "stream")).toMatchObject({
      effective: "policy-disabled",
      reasons: ["policy-disabled"],
    });
    expect(profile.entries.find((entry) => entry.id === "render")).toMatchObject({
      effective: "peer-unavailable",
      reasons: ["peer-unavailable:maplibre-gl"],
    });
    expect(profile.entries.find((entry) => entry.id === "applyEdits")).toMatchObject({
      effective: "authorization-denied",
      reasons: ["authorization-denied:dataset:parcels:write"],
    });

    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "*", alias: "count" }] } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("never promotes a built-in operation beyond the adapter's declared maximum", () => {
    const source = createDataset({
      id: "parcels",
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      sources: [descriptor([])],
    }).source("parcels")!;

    expect(source.capabilityProfile?.entries.find((entry) => entry.id === "query")?.effective).toBe("supported");
    expect(source.supports("query")).toBe(false);
    expect([...source.capabilities]).toEqual([]);
  });

  it("exposes the same support contract from direct adapter factories", async () => {
    const source = geoServicesFeatureSource(
      descriptor(["query", "queryAggregate"]),
      makeMockClient({ routes: [] }),
      "strict",
    );

    expect(source.supports("query")).toBe(true);
    expect(source.supports("queryAggregate")).toBe(false);
    expect([...source.capabilities]).toEqual(["query"]);
    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "*" }] } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("exposes the same fail-closed contract from the public GeoParquet factory", async () => {
    const source = geoparquetSource({
      id: "parcels-parquet",
      protocol: "geoparquet",
      locator: { url: "https://mock/parcels.parquet" },
      capabilities: capabilities(["query", "queryAggregate", "stream"]),
      schemaV2: { kind: "honua.source-schema", version: "2.0", fingerprint: SOURCE_FINGERPRINT },
      capabilityProfile: profileForGeoparquet(),
    });

    expect([...source.capabilities]).toEqual(["query", "stream"]);
    expect(source.supports("query")).toBe(true);
    expect(source.supports("queryAggregate")).toBe(false);
    expect(source.supports("stream")).toBe(true);
    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "*" }] } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("preserves legacy set semantics and decorates third-party resolver results in place", () => {
    const legacyDescriptor: SourceDescriptor = {
      id: "third-party",
      protocol: "maplibre-geojson",
      locator: { url: "https://mock/data.geojson" },
      capabilities: capabilities(["query", "stream"]),
    };
    const legacy = {
      descriptor: legacyDescriptor,
      capabilities: legacyDescriptor.capabilities,
      async query() {
        return { features: [], exceededTransferLimit: false };
      },
    } as unknown as Source;
    const source = createDataset({
      id: "third-party",
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      sources: [legacyDescriptor],
      resolveSource: () => legacy,
    }).source("third-party")!;

    expect(source).toBe(legacy);
    expect(source.capabilityProfile).toBeUndefined();
    expect(source.supports("query")).toBe(true);
    expect(source.supports("stream")).toBe(true);
    expect(source.supports("applyEdits")).toBe(false);
    expect(source.supports("io.honua.capability.export")).toBe(false);
  });

  it("preserves private-field method receivers for non-extensible third-party sources", async () => {
    const legacyDescriptor: SourceDescriptor = {
      id: "frozen-third-party",
      protocol: "maplibre-geojson",
      locator: { url: "https://mock/frozen.geojson" },
      capabilities: capabilities(["query"]),
    };
    class FrozenThirdPartySource {
      readonly descriptor = legacyDescriptor;
      readonly capabilities = legacyDescriptor.capabilities;
      #queries = 0;

      async query() {
        this.#queries += 1;
        return { features: [], exceededTransferLimit: false };
      }

      queryCount() {
        return this.#queries;
      }
    }
    const legacy = Object.freeze(new FrozenThirdPartySource()) as unknown as Source;
    const source = createDataset({
      id: "frozen-third-party",
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      sources: [legacyDescriptor],
      resolveSource: () => legacy,
    }).source("frozen-third-party")!;

    expect(source).not.toBe(legacy);
    expect(source.supports("query")).toBe(true);
    await source.query();
    expect((legacy as unknown as FrozenThirdPartySource).queryCount()).toBe(1);
  });

  it("keeps normalized descriptor, legacy set, profile, and supports views consistent for hostile resolvers", async () => {
    const profile = profileForThirdParty();
    const originalDescriptor: SourceDescriptor = {
      id: "third-party-profiled",
      protocol: "maplibre-geojson",
      locator: { url: "https://mock/data.geojson" },
      capabilities: capabilities(["query", "queryAggregate"]),
      schemaV2: { kind: "honua.source-schema", version: "2.0", fingerprint: SOURCE_FINGERPRINT },
      capabilityProfile: profile,
    };
    const hostile = Object.freeze({
      descriptor: originalDescriptor,
      capabilities: originalDescriptor.capabilities,
      capabilityProfile: undefined,
      supports: () => true,
      async query() {
        return { features: [], exceededTransferLimit: false };
      },
    }) as unknown as Source;
    const dataset = createDataset({
      id: "third-party-profiled",
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      sources: [originalDescriptor],
      resolveSource: () => hostile,
    });
    const source = dataset.source("third-party-profiled")!;

    expect(source).not.toBe(hostile);
    expect(source.descriptor).toBe(dataset.sourceDescriptors[0]);
    expect(source.capabilities).toBe(source.descriptor.capabilities);
    expect([...source.capabilities]).toEqual(["query"]);
    expect(source.capabilityProfile).toBe(profile);
    expect(source.descriptor.capabilityProfile).toBe(profile);
    expect(source.supports("query")).toBe(true);
    expect(source.supports("queryAggregate")).toBe(false);
    expect((hostile as unknown as { supports(id: string): boolean }).supports("queryAggregate")).toBe(true);
    await expect(source.query()).resolves.toMatchObject({ features: [] });
  });

  it("rejects an unverified profile instead of trusting caller-shaped effective truth", () => {
    const forged = JSON.parse(JSON.stringify(evaluatedProfile())) as ReturnType<typeof evaluatedProfile>;
    expect(() =>
      createDataset({
        id: "parcels",
        client: makeMockClient({ routes: [] }),
        skipCompatibilityCheck: true,
        sources: [descriptor(["query"], forged)],
      }),
    ).toThrow(/must be evaluated or parsed by this SDK instance/);
  });

  it("rejects a registered profile replayed against another schema identity", () => {
    const replayed = descriptor(["query"]);
    replayed.schemaV2 = {
      kind: "honua.source-schema",
      version: "2.0",
      fingerprint: `sha256:${"b".repeat(64)}`,
    };
    expect(() =>
      createDataset({
        id: "parcels",
        client: makeMockClient({ routes: [] }),
        skipCompatibilityCheck: true,
        sources: [replayed],
      }),
    ).toThrow(/does not match its schemaV2 fingerprint/);
  });
});
