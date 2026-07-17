import { describe, expect, it } from "vitest";

import { normalizeGeoServicesEndpoint, parseGeoServicesEndpoint } from "../src/geoservices-endpoint.js";

describe("GeoServices endpoint normalization", () => {
  it.each([
    ["FeatureServer", "feature", "geoservices-feature-service"],
    ["MapServer", "map", "geoservices-map-service"],
    ["ImageServer", "image", "geoservices-image-service"],
    ["GeometryServer", "geometry", "geoservices-geometry-service"],
    ["GPServer", "geoprocessing", "geoservices-gp-service"],
  ] as const)("classifies %s exactly", (path, serviceKind, protocol) => {
    expect(
      normalizeGeoServicesEndpoint(`https://example.test/arcgis/rest/services/Utilities/Test/${path}`),
    ).toMatchObject({
      endpoint: `https://example.test/arcgis/rest/services/Utilities/Test/${path}`,
      clientBaseUrl: "https://example.test/arcgis",
      serviceUrl: `https://example.test/arcgis/rest/services/Utilities/Test/${path}`,
      serviceId: "Utilities/Test",
      serviceKind,
      protocol,
    });
  });

  it("normalizes folder names, casing, selected resources, and removable format queries", () => {
    expect(
      normalizeGeoServicesEndpoint(
        "https://example.test/Honua/rest/services/Public%20Works/%C4%80ina/featureserver/007/?F=PJSON",
      ),
    ).toEqual({
      endpoint: "https://example.test/Honua/rest/services/Public%20Works/%C4%80ina/FeatureServer/7",
      clientBaseUrl: "https://example.test/Honua",
      serviceUrl: "https://example.test/Honua/rest/services/Public%20Works/%C4%80ina/FeatureServer",
      serviceId: "Public Works/Āina",
      serviceKind: "feature",
      protocol: "geoservices-feature-service",
      layerId: 7,
    });
    expect(
      normalizeGeoServicesEndpoint(
        "https://example.test/arcgis/rest/services/Analysis/Printing/GPServer/Export%20Web%20Map%20Task",
      ).taskName,
    ).toBe("Export Web Map Task");
  });

  it("matches the terminal service kind when a service-id segment resembles a service kind", () => {
    expect(
      normalizeGeoServicesEndpoint("https://example.test/arcgis/rest/services/Foo/FeatureServer/MapServer"),
    ).toEqual({
      endpoint: "https://example.test/arcgis/rest/services/Foo/FeatureServer/MapServer",
      clientBaseUrl: "https://example.test/arcgis",
      serviceUrl: "https://example.test/arcgis/rest/services/Foo/FeatureServer/MapServer",
      serviceId: "Foo/FeatureServer",
      serviceKind: "map",
      protocol: "geoservices-map-service",
    });

    expect(
      normalizeGeoServicesEndpoint("https://example.test/rest/services/Foo/MapServer/FeatureServer/7"),
    ).toMatchObject({
      serviceId: "Foo/MapServer",
      serviceKind: "feature",
      protocol: "geoservices-feature-service",
      layerId: 7,
    });
  });

  it("returns undefined for other layouts without guessing a service kind", () => {
    expect(parseGeoServicesEndpoint("https://example.test/ogc/features")).toBeUndefined();
    expect(parseGeoServicesEndpoint("https://example.test/rest/services/Parcels/FeatureServerish")).toBeUndefined();
    expect(
      parseGeoServicesEndpoint("https://example.test/rest/services/Parcels/FeatureServer/0/query"),
    ).toBeUndefined();
  });

  it("rejects an oversized endpoint before applying the service-path classifier", () => {
    const oversized = `https://example.test/rest/services/${"x".repeat(17_000)}/FeatureServer`;
    expect(() => normalizeGeoServicesEndpoint(oversized)).toThrowError(
      expect.objectContaining({
        name: "HonuaDiscoveryError",
        code: "invalid-endpoint",
        message: "GeoServices endpoint exceeds the URL length limit.",
      }),
    );
  });

  it.each([
    "https://user:secret@example.test/rest/services/Parcels/FeatureServer",
    "https://example.test/rest/services/Parcels/FeatureServer?token=secret",
    "https://example.test/rest/services/Parcels/FeatureServer#fragment",
    "https://example.test/rest/services/../FeatureServer",
    "https://example.test/rest/services/Parcels/GeometryServer/project",
    "https://example.test/rest/services/Parcels/ImageServer/catalog",
    "https://example.test/rest/services/Parcels/ImageServer/7",
    "https://example.test/rest/services/Parcels/FeatureServer/9007199254740992",
    "https://example.test/rest/services/Parcels/GPServer/%2F",
  ])("rejects unsafe canonical input %s", (endpoint) => {
    expect(() => normalizeGeoServicesEndpoint(endpoint)).toThrowError(
      expect.objectContaining({ name: "HonuaDiscoveryError", code: "invalid-endpoint" }),
    );
  });
});
