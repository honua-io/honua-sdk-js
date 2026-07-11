import { describe, expect, it } from "vitest";

import {
  HONUA_DISCOVERY_ADAPTER_VERSION,
  HONUA_DISCOVERY_PROJECTION_VERSION,
  HonuaDiscoveryError,
  PROTOCOL_DEFAULT_CAPABILITIES,
  capabilities,
  createDiscoveryCacheIdentity,
  inspectDiscoveredSource,
  normalizeDiscoveryEndpoint,
  resolveDiscoveryCapabilities,
} from "../../src/contract/index.js";
import { isHonuaError } from "../../src/core/errors.js";

describe("contract / discovery capability truth", () => {
  it("intersects adapter defaults with metadata and caller policy", () => {
    const resolution = resolveDiscoveryCapabilities(
      "geoservices-feature-service",
      { kind: "metadata", capabilities: ["query", "queryAggregate", "applyEdits", "render"] },
      { allow: ["query", "queryAggregate", "render"], deny: ["queryAggregate"] },
    );

    expect([...resolution.capabilities]).toEqual(["query"]);
    expect(resolution.decisions.find((decision) => decision.capability === "queryAggregate")).toMatchObject({
      code: "policy-denied",
      positiveEvidence: true,
    });
    expect(resolution.decisions.find((decision) => decision.capability === "render")).toMatchObject({
      code: "adapter-unsupported",
      positiveEvidence: true,
    });
    expect(resolution.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "evidence-exceeds-adapter",
      "capability-policy-restricted",
    ]);
  });

  it("does not invent protocol defaults when discovery is unavailable", () => {
    const resolution = resolveDiscoveryCapabilities("ogc-features", {
      kind: "unavailable",
      reason: "The optional conformance endpoint returned 503.",
    });

    expect([...resolution.capabilities]).toEqual([]);
    expect(resolution.decisions.find((decision) => decision.capability === "query")).toMatchObject({
      code: "discovery-unavailable",
      effective: false,
    });
    expect(resolution.diagnostics).toEqual([
      expect.objectContaining({ code: "discovery-unavailable", severity: "warning" }),
    ]);
  });

  it("preserves explicitly declared known-safe operations", () => {
    const resolution = resolveDiscoveryCapabilities("wfs", {
      kind: "declared",
      capabilities: ["query", "queryObjectIds"],
      provenance: [{ source: "source configuration v7" }],
    });

    expect([...resolution.capabilities]).toEqual(["query", "queryObjectIds"]);
    expect(resolution.decisions.find((decision) => decision.capability === "applyEdits")?.code).toBe("not-advertised");
  });

  it("requires explicit acceptance before inferred capabilities become effective", () => {
    const evidence = {
      kind: "inferred" as const,
      capabilities: ["render", "tiles"] as const,
      reason: "A TileJSON extension was inferred from the asset suffix.",
    };
    const strict = resolveDiscoveryCapabilities("maplibre-vector", evidence);
    const accepted = resolveDiscoveryCapabilities("maplibre-vector", evidence, { acceptInferred: true });

    expect([...strict.capabilities]).toEqual([]);
    expect(strict.diagnostics[0]?.code).toBe("inferred-capabilities-rejected");
    expect(strict.decisions.find((decision) => decision.capability === "render")).toMatchObject({
      positiveEvidence: true,
      effective: false,
      code: "inferred-not-accepted",
    });
    expect([...accepted.capabilities]).toEqual(["render", "tiles"]);
  });

  it("merges partial evidence per capability and preserves provenance", () => {
    const resolution = resolveDiscoveryCapabilities("geoservices-feature-service", [
      {
        kind: "declared",
        capabilities: ["query"],
        scope: ["query"],
        provenance: [{ source: "source-config:v7" }],
      },
      {
        kind: "metadata",
        capabilities: ["queryAggregate"],
        scope: ["queryAggregate"],
        provenance: [{ source: "GET layer?f=json", validator: 'etag:"stats-v3"' }],
      },
      {
        kind: "unavailable",
        scope: ["applyEdits"],
        reason: "The optional edit-capabilities endpoint returned 503.",
        provenance: [{ source: "GET /editingInfo" }],
      },
    ]);

    expect(resolution.discovery).toBe("mixed");
    expect([...resolution.capabilities]).toEqual(["query", "queryAggregate"]);
    expect(resolution.provenance.map((entry) => entry.source)).toEqual([
      "source-config:v7",
      "GET layer?f=json",
      "GET /editingInfo",
    ]);
    expect(resolution.decisions.find((decision) => decision.capability === "queryAggregate")?.evidence).toEqual([
      expect.objectContaining({
        kind: "metadata",
        supported: true,
        provenance: [expect.objectContaining({ validator: 'etag:"stats-v3"' })],
      }),
    ]);
    expect(resolution.decisions.find((decision) => decision.capability === "applyEdits")?.code).toBe(
      "discovery-unavailable",
    );
    expect(resolution.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "discovery-unavailable",
      "partial-discovery",
    ]);
  });

  it("resolves conflicting metadata conservatively with both provenance records", () => {
    const resolution = resolveDiscoveryCapabilities("ogc-features", [
      {
        kind: "metadata",
        capabilities: ["query"],
        scope: ["query"],
        provenance: [{ source: "GET /conformance" }],
      },
      {
        kind: "metadata",
        capabilities: [],
        scope: ["query"],
        provenance: [{ source: "GET /collections/parcels" }],
      },
    ]);

    expect([...resolution.capabilities]).toEqual([]);
    expect(resolution.decisions.find((decision) => decision.capability === "query")).toMatchObject({
      code: "not-advertised",
      positiveEvidence: true,
      effective: false,
      evidence: [
        { supported: true, provenance: [{ source: "GET /conformance" }] },
        { supported: false, provenance: [{ source: "GET /collections/parcels" }] },
      ],
    });
    expect(resolution.diagnostics).toContainEqual(expect.objectContaining({ code: "conflicting-evidence" }));
  });

  it("lets an authoritative declaration conservatively disable metadata-positive support", () => {
    const resolution = resolveDiscoveryCapabilities("geoservices-feature-service", [
      { kind: "metadata", capabilities: ["applyEdits"], scope: ["applyEdits"] },
      { kind: "declared", capabilities: [], scope: ["applyEdits"] },
    ]);

    expect(resolution.capabilities.has("applyEdits")).toBe(false);
    expect(resolution.decisions.find((decision) => decision.capability === "applyEdits")?.code).toBe("not-advertised");
    expect(resolution.diagnostics).toContainEqual(expect.objectContaining({ code: "conflicting-evidence" }));
  });

  it("uses a private immutable adapter maximum even if exported defaults are mutated", () => {
    const exported = PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"] as Set<string>;
    exported.add("render");
    try {
      const resolution = resolveDiscoveryCapabilities("ogc-features", {
        kind: "metadata",
        capabilities: ["render"],
        scope: ["render"],
      });
      expect(resolution.capabilities.has("render")).toBe(false);
      expect(resolution.decisions.find((decision) => decision.capability === "render")).toMatchObject({
        code: "adapter-unsupported",
        positiveEvidence: true,
      });
    } finally {
      exported.delete("render");
    }
  });

  it("projects only the reviewed capability set onto the source descriptor", () => {
    const resolution = resolveDiscoveryCapabilities("ogc-features", {
      kind: "metadata",
      capabilities: ["query"],
    });
    const locator = { url: "https://geo.example.test/collections/parcels", collectionId: "parcels" };
    const schema = {
      fields: [{ name: "status", type: "esriFieldTypeString" as const, alias: "Status" }],
      primaryKey: "id",
    };
    const analytics = { histogram: { fields: ["value"], maxBins: 20 } };
    const inspection = inspectDiscoveredSource(
      {
        id: "parcels",
        protocol: "ogc-features",
        locator,
        capabilities: capabilities(["query", "queryObjectIds", "applyEdits", "stream"]),
        schema,
        analytics,
      },
      resolution,
    );

    expect([...inspection.descriptor.capabilities]).toEqual(["query"]);
    expect(inspection.discovery).toBe("metadata");
    expect(() => inspectDiscoveredSource({ ...inspection.descriptor, protocol: "stac" }, resolution)).toThrowError(
      expect.objectContaining({ code: "protocol-mismatch" }),
    );

    expect(() => (resolution.capabilities as Set<string>).add("applyEdits")).toThrow(TypeError);
    expect([...resolution.capabilities]).toEqual(["query"]);
    expect(() => {
      (inspection.descriptor.locator as { url: string }).url = "https://evil.test";
    }).toThrow(TypeError);
    expect(() => (inspection.descriptor.schema?.fields as unknown[]).push({})).toThrow(TypeError);
    expect(() => {
      (inspection.descriptor.analytics?.histogram as { maxBins: number }).maxBins = 999;
    }).toThrow(TypeError);
    locator.url = "https://caller-mutated.test";
    schema.fields[0]!.alias = "Caller mutated";
    analytics.histogram.fields.push("caller-mutated");
    expect(inspection.descriptor.locator.url).toBe("https://geo.example.test/collections/parcels");
    expect(inspection.descriptor.schema?.fields?.[0]?.alias).toBe("Status");
    expect(inspection.descriptor.analytics?.histogram).toEqual({ fields: ["value"], maxBins: 20 });
  });

  it("rejects non-plain nested descriptor metadata instead of returning mutable objects", () => {
    const resolution = resolveDiscoveryCapabilities("ogc-features", {
      kind: "metadata",
      capabilities: ["query"],
    });
    expect(() =>
      inspectDiscoveredSource(
        {
          id: "non-plain",
          protocol: "ogc-features",
          locator: { url: "https://geo.example.test" },
          capabilities: capabilities(["query"]),
          schema: {
            fields: [{ name: "value", type: "esriFieldTypeString", defaultValue: new Map([["mutable", true]]) }],
          },
        },
        resolution,
      ),
    ).toThrowError(expect.objectContaining({ code: "invalid-capability" }));
  });

  it("deep-freezes diagnostic capability arrays", () => {
    const resolution = resolveDiscoveryCapabilities("ogc-features", {
      kind: "declared",
      capabilities: ["render"],
      scope: ["render"],
    });
    const diagnostic = resolution.diagnostics.find((entry) => entry.code === "evidence-exceeds-adapter");
    expect(diagnostic?.capabilities).toEqual(["render"]);
    expect(() => (diagnostic?.capabilities as string[]).push("tiles")).toThrow(TypeError);
  });

  it("rejects unknown runtime capability strings", () => {
    try {
      resolveDiscoveryCapabilities("ogc-features", {
        kind: "metadata",
        capabilities: ["query", "teleport"] as never,
      });
      throw new Error("expected discovery validation to fail");
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ code: "invalid-capability" }));
      expect(isHonuaError(error)).toBe(true);
    }
  });

  it("rejects unknown runtime evidence kinds before reading the record payload", () => {
    const evidence = {
      kind: "metdata",
      get capabilities(): never {
        throw new Error("capabilities must not be read for an invalid evidence kind");
      },
    };

    expect(() => resolveDiscoveryCapabilities("ogc-features", evidence as never)).toThrowError(
      expect.objectContaining({ name: "HonuaDiscoveryError", code: "invalid-capability" }),
    );
  });
});

describe("contract / discovery cache identity", () => {
  it("normalizes stable query order and removes URL credentials and transient secrets", () => {
    const normalized = normalizeDiscoveryEndpoint(
      "HTTPS://user:password@Geo.Example.test:443/ogc/?token=secret&f=json&b=2&a=1&X-Amz-Signature=signed#section",
    );

    expect(normalized).toBe("https://geo.example.test/ogc?a=1&b=2&f=json");
    expect(normalized).not.toContain("secret");
    expect(normalized).not.toContain("password");
    expect(normalized).not.toContain("signed");
  });

  it("redacts OAuth, session, key, subscription, auth, and cloud signing aliases from display", () => {
    const secrets = normalizeDiscoveryEndpoint(
      "https://geo.example.test/data?client_secret=c&refresh_token=r&id_token=i&password=p&sessionid=s&key=k&api-key=a&subscription-key=u&auth=h&X-Goog-Signature=g&layer=roads",
    );
    const roads = normalizeDiscoveryEndpoint("https://geo.example.test/data?key=roads");
    const buildings = normalizeDiscoveryEndpoint("https://geo.example.test/data?key=buildings");

    expect(secrets).toBe("https://geo.example.test/data?layer=roads");
    expect(roads).toBe(buildings);
    expect(roads).toBe("https://geo.example.test/data");
  });

  it("redacts complete Azure SAS and CloudFront signing families without changing logical cache identity", async () => {
    const base = {
      protocol: "auto" as const,
      authorizationScopeFingerprint: "scope:cdn-reader:v1",
    };
    const azureFirst = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://storage.example.test/container/roads.pmtiles?dataset=roads&sv=2024-11-04&se=2026-07-10T23%3A00Z&sp=r&sr=b&st=2026-07-10T22%3A00Z&spr=https&sip=192.0.2.1&skoid=object-one&sktid=tenant-one&skt=one&ske=two&sks=b&skv=2024-11-04&sig=AZURE_SECRET_ONE",
    });
    const azureRotated = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://storage.example.test/container/roads.pmtiles?sig=AZURE_SECRET_TWO&skv=2025-01-05&sks=c&ske=four&skt=three&sktid=tenant-two&skoid=object-two&sip=198.51.100.2&spr=https&st=2026-07-11T00%3A00Z&sr=c&sp=rw&se=2026-07-12T00%3A00Z&sv=2025-01-05&dataset=roads",
    });
    const cloudFrontFirst = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://cdn.example.test/tiles/archive.pmtiles?variant=web&Expires=1780000000&Policy=POLICY_ONE&Signature=CLOUDFRONT_SECRET_ONE&Key-Pair-Id=KONE",
    });
    const cloudFrontRotated = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://cdn.example.test/tiles/archive.pmtiles?Key-Pair-Id=KTWO&Signature=CLOUDFRONT_SECRET_TWO&Policy=POLICY_TWO&Expires=1790000000&variant=web",
    });

    expect(azureFirst).toEqual(azureRotated);
    expect(azureFirst.endpoint).toBe("https://storage.example.test/container/roads.pmtiles?dataset=roads");
    expect(cloudFrontFirst).toEqual(cloudFrontRotated);
    expect(cloudFrontFirst.endpoint).toBe("https://cdn.example.test/tiles/archive.pmtiles?variant=web");
    for (const identity of [azureFirst, azureRotated, cloudFrontFirst, cloudFrontRotated]) {
      expect(JSON.stringify(identity)).not.toMatch(
        /AZURE_SECRET|CLOUDFRONT_SECRET|object-|tenant-|POLICY_|KONE|KTWO|Expires|Policy|Key-Pair-Id/,
      );
    }
  });

  it("normalizes AWS and GCS v2 signed URLs while preserving unsigned resource query distinctions", async () => {
    const base = {
      protocol: "auto" as const,
      authorizationScopeFingerprint: "scope:object-reader:v1",
    };
    const awsFirst = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://objects.example.test/roads?resource=roads&AWSAccessKeyId=AKIA_FIRST&Expires=1780000000&Signature=AWS_SECRET_ONE",
    });
    const awsRotated = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://objects.example.test/roads?Signature=AWS_SECRET_TWO&Expires=1790000000&AWSAccessKeyId=AKIA_SECOND&resource=roads",
    });
    const gcsFirst = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://storage.googleapis.test/roads?resource=roads&GoogleAccessId=first@example.test&Expires=1780000000&Signature=GCS_SECRET_ONE",
    });
    const gcsRotated = await createDiscoveryCacheIdentity({
      ...base,
      endpoint:
        "https://storage.googleapis.test/roads?Signature=GCS_SECRET_TWO&Expires=1790000000&GoogleAccessId=second@example.test&resource=roads",
    });
    const unsignedRoads = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.example.test/data?sv=resource-v1&Expires=revision-one&dataset=roads",
    });
    const unsignedBuildings = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.example.test/data?sv=resource-v2&Expires=revision-two&dataset=buildings",
    });

    expect(awsFirst).toEqual(awsRotated);
    expect(gcsFirst).toEqual(gcsRotated);
    expect(awsFirst.endpoint).toBe("https://objects.example.test/roads?resource=roads");
    expect(gcsFirst.endpoint).toBe("https://storage.googleapis.test/roads?resource=roads");
    expect(unsignedRoads.endpoint).toContain("sv=resource-v1");
    expect(unsignedRoads.endpoint).toContain("Expires=revision-one");
    expect(unsignedRoads.key).not.toBe(unsignedBuildings.key);
  });

  it("creates stable scope- and resource-separated keys", async () => {
    const shared = {
      endpoint: "https://geo.example.test/ogc?token=one&f=json",
      protocol: "ogc-features" as const,
      authorizationScopeFingerprint: "scope:reader:v2",
      collectionId: "parcels",
      adapterVersion: "ogc-features@1",
      projectionVersion: "source-inspection@1",
    };
    const first = await createDiscoveryCacheIdentity(shared);
    const same = await createDiscoveryCacheIdentity({
      ...shared,
      endpoint: "https://geo.example.test/ogc?f=json&access_token=two",
    });
    const otherScope = await createDiscoveryCacheIdentity({
      ...shared,
      authorizationScopeFingerprint: "scope:admin:v2",
    });
    const otherCollection = await createDiscoveryCacheIdentity({ ...shared, collectionId: "buildings" });

    expect(first).toEqual(same);
    expect(first.key).not.toContain("token");
    expect(first.key).not.toContain("one");
    expect(first.authorizationScopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain("scope:reader:v2");
    expect(otherScope.key).not.toBe(first.key);
    expect(otherCollection.key).not.toBe(first.key);
  });

  it("partitions WFS and WMS layers by typeName without weakening secret or version partitioning", async () => {
    const base = {
      endpoint: "https://geo.example.test/ows?service=WFS&access_token=first",
      protocol: "wfs" as const,
      authorizationScopeFingerprint: "scope:reader:v2",
      adapterVersion: "wfs@1",
      projectionVersion: "source-inspection@1",
    };
    const parcels = await createDiscoveryCacheIdentity({ ...base, typeName: "cadastre:parcels" });
    const roads = await createDiscoveryCacheIdentity({ ...base, typeName: "transport:roads" });
    const sameParcelsWithRotatedSecret = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.example.test/ows?access_token=second&service=WFS",
      typeName: "cadastre:parcels",
    });
    const upgradedAdapter = await createDiscoveryCacheIdentity({
      ...base,
      typeName: "cadastre:parcels",
      adapterVersion: "wfs@2",
    });

    expect(parcels.endpoint).toBe(roads.endpoint);
    expect(parcels.key).not.toBe(roads.key);
    expect(parcels).toEqual(sameParcelsWithRotatedSecret);
    expect(parcels.key).not.toContain("first");
    expect(parcels.key).not.toContain("second");
    expect(upgradedAdapter.key).not.toBe(parcels.key);
  });

  it("keeps custom stable query values collision-safe and hashes caller-classified transient values", async () => {
    const base = {
      protocol: "auto" as const,
      authorizationScopeFingerprint: "scope:anonymous:v1",
    };
    const roads = await createDiscoveryCacheIdentity({ ...base, endpoint: "https://geo.test/data?key=roads" });
    const buildings = await createDiscoveryCacheIdentity({ ...base, endpoint: "https://geo.test/data?key=buildings" });
    const firstBust = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.test/data?cacheBust=one",
      transientQueryParameters: ["cacheBust"],
    });
    const secondBust = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.test/data?cacheBust=two",
      transientQueryParameters: ["cacheBust"],
    });
    const codeRoads = await createDiscoveryCacheIdentity({ ...base, endpoint: "https://geo.test/data?code=roads" });
    const codeBuildings = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.test/data?code=buildings",
    });
    const subscriptionRoads = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.test/data?subscription-key=roads",
    });
    const subscriptionBuildings = await createDiscoveryCacheIdentity({
      ...base,
      endpoint: "https://geo.test/data?subscription-key=buildings",
    });

    expect(roads.endpoint).toBe(buildings.endpoint);
    expect(roads.key).not.toBe(buildings.key);
    expect(codeRoads.endpoint).toBe(codeBuildings.endpoint);
    expect(codeRoads.key).not.toBe(codeBuildings.key);
    expect(subscriptionRoads.endpoint).toBe(subscriptionBuildings.endpoint);
    expect(subscriptionRoads.key).not.toBe(subscriptionBuildings.key);
    expect(firstBust).toEqual(secondBust);
    expect(firstBust.key).not.toContain("one");
  });

  it("always partitions cache identity by stable adapter and projection versions", async () => {
    const base = {
      endpoint: "https://geo.test/data",
      protocol: "auto" as const,
      authorizationScopeFingerprint: "scope:anonymous:v1",
    };
    const omitted = await createDiscoveryCacheIdentity(base);
    const explicitDefaults = await createDiscoveryCacheIdentity({
      ...base,
      adapterVersion: HONUA_DISCOVERY_ADAPTER_VERSION,
      projectionVersion: HONUA_DISCOVERY_PROJECTION_VERSION,
    });
    const adapterUpgrade = await createDiscoveryCacheIdentity({ ...base, adapterVersion: "adapter@2" });
    const projectionUpgrade = await createDiscoveryCacheIdentity({ ...base, projectionVersion: "projection@2" });

    expect(omitted).toEqual(explicitDefaults);
    expect(omitted.key).toContain("adapterVersion=");
    expect(omitted.key).toContain("projectionVersion=");
    expect(adapterUpgrade.key).not.toBe(omitted.key);
    expect(projectionUpgrade.key).not.toBe(omitted.key);
    await expect(createDiscoveryCacheIdentity({ ...base, adapterVersion: " " })).rejects.toMatchObject({
      code: "invalid-cache-identity",
    });
  });

  it("rejects relative endpoints and missing auth-scope identity", async () => {
    const rawInvalid = "https://[invalid]/?token=TOP_SECRET_TOKEN";
    try {
      normalizeDiscoveryEndpoint(rawInvalid);
      throw new Error("expected invalid endpoint");
    } catch (error) {
      expect(error).toBeInstanceOf(HonuaDiscoveryError);
      expect(String(error)).not.toContain(rawInvalid);
      expect(String(error)).not.toContain("TOP_SECRET_TOKEN");
      expect((error as Error).cause).toBeUndefined();
      expect((error as HonuaDiscoveryError).detail).toBeUndefined();
    }
    await expect(
      createDiscoveryCacheIdentity({
        endpoint: "https://geo.example.test",
        protocol: "auto",
        authorizationScopeFingerprint: " ",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "invalid-cache-identity" }));
  });
});
