import { describe, expect, it } from "vitest";

import {
  HonuaDiscoveryError,
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
      endpointSupported: true,
    });
    expect(resolution.decisions.find((decision) => decision.capability === "render")).toMatchObject({
      code: "adapter-unsupported",
      endpointSupported: true,
    });
    expect(resolution.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "metadata-exceeds-adapter",
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

  it("projects only the reviewed capability set onto the source descriptor", () => {
    const resolution = resolveDiscoveryCapabilities("ogc-features", {
      kind: "metadata",
      capabilities: ["query"],
    });
    const inspection = inspectDiscoveredSource(
      {
        id: "parcels",
        protocol: "ogc-features",
        locator: { url: "https://geo.example.test/collections/parcels", collectionId: "parcels" },
        capabilities: capabilities(["query", "queryObjectIds", "applyEdits", "stream"]),
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

  it("redacts OAuth, session, and cloud signing parameters without collapsing generic resource keys", () => {
    const secrets = normalizeDiscoveryEndpoint(
      "https://geo.example.test/data?client_secret=c&refresh_token=r&id_token=i&password=p&sessionid=s&X-Goog-Signature=g&layer=roads",
    );
    const roads = normalizeDiscoveryEndpoint("https://geo.example.test/data?key=roads");
    const buildings = normalizeDiscoveryEndpoint("https://geo.example.test/data?key=buildings");

    expect(secrets).toBe("https://geo.example.test/data?layer=roads");
    expect(roads).not.toBe(buildings);
    expect(roads).toContain("key=roads");
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

    expect(roads.key).not.toBe(buildings.key);
    expect(codeRoads.endpoint).toBe(codeBuildings.endpoint);
    expect(codeRoads.key).not.toBe(codeBuildings.key);
    expect(firstBust).toEqual(secondBust);
    expect(firstBust.key).not.toContain("one");
  });

  it("rejects relative endpoints and missing auth-scope identity", async () => {
    expect(() => normalizeDiscoveryEndpoint("/collections/parcels")).toThrowError(HonuaDiscoveryError);
    await expect(
      createDiscoveryCacheIdentity({
        endpoint: "https://geo.example.test",
        protocol: "auto",
        authorizationScopeFingerprint: " ",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "invalid-cache-identity" }));
  });
});
