import { describe, expect, it } from "vitest";
import {
  SourceRefError,
  isGeoServicesProtocol,
  legacyGeoServicesRef,
  ogcLayoutFor,
  parseSourceRef,
  resolveSource,
  resolveSourceRef,
  toSourceDescriptor,
  toSourceLocator,
} from "../../src/neutral/source-ref.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("protocol-neutral source references", () => {
  it("parses each supported protocol's address form", () => {
    expect(parseSourceRef("ogc-features:hotels")).toMatchObject({ protocol: "ogc-features", address: "hotels" });
    expect(parseSourceRef("stac:sentinel-2-l2a")).toMatchObject({ protocol: "stac", address: "sentinel-2-l2a" });
    expect(parseSourceRef("odata:People")).toMatchObject({ protocol: "odata", address: "People" });
    expect(parseSourceRef("geoservices-feature-service:Parks/0")).toMatchObject({
      protocol: "geoservices-feature-service",
      address: "Parks/0",
    });
  });

  it("keeps a namespace-qualified WFS type name intact", () => {
    const ref = parseSourceRef("wfs:topp:states");
    expect(ref.protocol).toBe("wfs");
    expect(ref.address).toBe("topp:states");
    expect(ref.ref).toBe("wfs:topp:states");
  });

  it("normalizes friendly protocol aliases to the canonical token", () => {
    expect(parseSourceRef("ogc:hotels").ref).toBe("ogc-features:hotels");
    expect(parseSourceRef("geoservices:Parks/0").ref).toBe("geoservices-feature-service:Parks/0");
    expect(parseSourceRef("MapServer:Basemap/2").ref).toBe("geoservices-map-service:Basemap/2");
  });

  it("fails closed on a missing or unknown protocol prefix instead of guessing", () => {
    expect(() => parseSourceRef("hotels")).toThrow(SourceRefError);
    expect(() => parseSourceRef("hotels")).toThrow(/missing its protocol prefix/);
    expect(() => parseSourceRef("cloud-tiles:hotels")).toThrow(/unknown protocol/);
    expect(() => parseSourceRef("ogc-features:")).toThrow(/missing its address/);
    expect(() => parseSourceRef("   ")).toThrow(SourceRefError);
  });

  it("projects references onto the SDK source locator", () => {
    expect(toSourceLocator(parseSourceRef("geoservices-feature-service:Parks/3"), "https://x.test")).toEqual({
      url: "https://x.test",
      serviceId: "Parks",
      layerId: 3,
    });
    expect(toSourceLocator(parseSourceRef("ogc-features:hotels", "ogc-api"), "https://x.test")).toEqual({
      url: "https://x.test",
      collectionId: "hotels",
      layout: "ogc-api",
    });
    expect(toSourceLocator(parseSourceRef("wfs:topp:states"), "https://x.test")).toEqual({
      url: "https://x.test",
      typeName: "topp:states",
    });
    expect(toSourceLocator(parseSourceRef("odata:People"), "https://x.test")).toEqual({
      url: "https://x.test",
      entitySet: "People",
    });
    expect(toSourceLocator(parseSourceRef("stac:s2", "honua-facade"), "https://x.test")).toEqual({
      url: "https://x.test",
      collectionId: "s2",
    });
  });

  it("rejects a GeoServices address that does not name a layer", () => {
    expect(() => toSourceLocator(parseSourceRef("geoservices-feature-service:Parks"), "https://x.test")).toThrow(
      /must address a layer/,
    );
    expect(() => toSourceLocator(parseSourceRef("geoservices-feature-service:Parks/main"), "https://x.test")).toThrow(
      /non-numeric layer id/,
    );
  });

  it("builds a descriptor carrying the protocol's default capabilities", () => {
    const descriptor = toSourceDescriptor(parseSourceRef("ogc-features:hotels"), "https://x.test");
    expect(descriptor.id).toBe("ogc-features:hotels");
    expect(descriptor.protocol).toBe("ogc-features");
    expect(descriptor.capabilities.has("query")).toBe(true);
    // OGC API Features has no server-side aggregation.
    expect(descriptor.capabilities.has("queryAggregate")).toBe(false);
  });

  it("maps the deprecated GeoServices pair onto a neutral reference", () => {
    expect(legacyGeoServicesRef("Parks", 0)).toBe("geoservices-feature-service:Parks/0");
    const resolved = resolveSourceRef({ serviceId: "Parks", layerId: 2 });
    expect(resolved.legacyAddressing).toBe(true);
    expect(resolved.ref.ref).toBe("geoservices-feature-service:Parks/2");
  });

  it("prefers the neutral reference when both addressing modes are supplied", () => {
    const resolved = resolveSourceRef({ source: "ogc-features:hotels", serviceId: "Parks", layerId: 0 });
    expect(resolved.legacyAddressing).toBe(false);
    expect(resolved.ref.protocol).toBe("ogc-features");
  });

  it("refuses a half-specified GeoServices pair rather than defaulting the layer", () => {
    expect(() => resolveSourceRef({ serviceId: "Parks" })).toThrow(/without layerId/);
    expect(() => resolveSourceRef({ layerId: 0 })).toThrow(/without serviceId/);
    expect(() => resolveSourceRef({})).toThrow(/no source was addressed/);
  });

  it("resolves a runtime Source through createDataset", () => {
    const resolved = resolveSource(asClient(createMockClient()), { source: "geoservices-feature-service:Parks/0" });
    expect(resolved.descriptor.protocol).toBe("geoservices-feature-service");
    expect(resolved.source.capabilities.has("query")).toBe(true);
    expect(resolved.legacyAddressing).toBe(false);
  });

  it("classifies GeoServices-family protocols", () => {
    expect(isGeoServicesProtocol("geoservices-feature-service")).toBe(true);
    expect(isGeoServicesProtocol("grpc")).toBe(true);
    expect(isGeoServicesProtocol("ogc-features")).toBe(false);
  });

  it("resolves an OGC layout only for the OGC API layouts", async () => {
    const resolveOgcFeaturesLayout = (mode: string) => Promise.resolve({ mode });
    const client = { resolveOgcFeaturesLayout } as unknown as Parameters<typeof ogcLayoutFor>[0];

    await expect(ogcLayoutFor(client, undefined)).resolves.toBeUndefined();
    await expect(ogcLayoutFor(client, "honua-facade")).resolves.toBeUndefined();
    await expect(ogcLayoutFor(client, "stac-api")).resolves.toBeUndefined();
    await expect(ogcLayoutFor(client, "ogc-api")).resolves.toEqual({ mode: "ogc-api" });
  });
});
