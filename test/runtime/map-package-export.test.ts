/**
 * Portable export / import of the canonical map artifact (#1426).
 *
 * The two properties under test are the ones the issue names as the price of
 * portability, and both are asserted as *observable outcomes* rather than as
 * "the sanitizer was called": a credential-bearing package must come out the
 * other side with no credential anywhere in the serialized bytes, and a package
 * carrying unbounded inline data must be refused rather than emitted.
 */

import { describe, expect, test } from "vitest";

import {
  HONUA_MAP_PACKAGE_EXPORT_KIND_V1,
  HONUA_MAP_PACKAGE_FORMAT_V1,
  HonuaExportSafetyError,
  type HonuaMapPackage,
  HonuaMapPackageError,
  exportMapPackage,
  importMapPackage,
  mapPackageFingerprint,
} from "../../src/runtime/index.js";

function basePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-1426",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    status: "Ready",
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://gis.example.com/arcgis/rest/services/Parcels/FeatureServer", layerId: 0 },
        attribution: "City of Example",
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [{ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } }],
    },
    initialView: { center: [-122.4, 37.8], zoom: 11 },
    attribution: [{ text: "City of Example", url: "https://example.com/credits", required: true }],
    widgets: [{ widgetId: "legend", type: "legend", position: "bottom-right" }],
    dependencies: [{ name: "maplibre-gl", versionRange: "^6", kind: "renderer" }],
    provenance: { generatedBy: "honua-cli", generatorVersion: "0.1.0", generatedAt: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  } as HonuaMapPackage;
}

describe("exportMapPackage / importMapPackage round trip", () => {
  test("a clean package round-trips unchanged and carries a matching fingerprint", () => {
    const pkg = basePackage();
    const envelope = exportMapPackage(pkg, { exportedAt: "2026-01-02T00:00:00.000Z" });

    expect(envelope.kind).toBe(HONUA_MAP_PACKAGE_EXPORT_KIND_V1);
    expect(envelope.format).toBe(HONUA_MAP_PACKAGE_FORMAT_V1);
    expect(envelope.redactions).toEqual([]);
    expect(envelope.fingerprint).toBe(mapPackageFingerprint(envelope.mapPackage));
    expect(envelope.mapPackage).toEqual(pkg);

    // Cross the boundary the way a real client would: serialize, re-parse.
    const imported = importMapPackage(JSON.parse(JSON.stringify(envelope)));
    expect(imported.mapPackage).toEqual(pkg);
    expect(imported.fingerprint).toBe(envelope.fingerprint);
    expect(imported.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  test("the exporter does not mutate the caller's package", () => {
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: { url: "https://gis.example.com/ogc/collections/parcels?token=abcdef1234567890" },
        },
      ],
    });
    const before = JSON.stringify(pkg);
    exportMapPackage(pkg);
    expect(JSON.stringify(pkg)).toBe(before);
  });
});

describe("credentials never survive an export", () => {
  test("a signed locator URL is stripped, recorded, and absent from the bytes", () => {
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: {
            url: "https://gis.example.com/ogc/collections/parcels?f=json&token=s3cr3tT0ken0123456789",
          },
        },
      ],
    });

    const envelope = exportMapPackage(pkg);
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain("s3cr3tT0ken0123456789");
    expect(envelope.redactions.map((r) => r.reason)).toContain("signed-url");
    // The operational part of the query survives: a portable map that lost
    // `?f=json` would import as a map that no longer renders.
    const locator = envelope.mapPackage.sourceBindings[0]?.locator as { url: string };
    expect(locator.url).toContain("f=json");
    expect(locator.url).not.toContain("token=");
  });

  test("embedded basic-auth userinfo is removed", () => {
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "wms",
          locator: { url: "https://alice:hunter2pass@gis.example.com/wms?service=WMS" },
        },
      ],
    });
    const envelope = exportMapPackage(pkg);
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("hunter2pass");
    expect(serialized).not.toContain("alice:");
  });

  test("a credential-named metadata key is dropped entirely", () => {
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: { url: "https://gis.example.com/ogc/collections/parcels" },
          metadata: { apiKey: "AIzaSyExampleKeyValue0123456789", region: "us-west" },
        },
      ],
    });

    const envelope = exportMapPackage(pkg);
    const metadata = envelope.mapPackage.sourceBindings[0]?.metadata as Record<string, string>;
    expect(metadata).toEqual({ region: "us-west" });
    expect(envelope.redactions).toContainEqual({
      path: "sourceBindings[0].metadata.apiKey",
      reason: "sensitive-key",
    });
    expect(JSON.stringify(envelope)).not.toContain("AIzaSyExampleKeyValue0123456789");
  });

  test("a bearer token hiding in free text is refused rather than emitted", () => {
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: { url: "https://gis.example.com/ogc/collections/parcels" },
          attribution: "Fetched with Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature",
        },
      ],
    });
    const envelope = exportMapPackage(pkg);
    expect(JSON.stringify(envelope)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(envelope.redactions.map((r) => r.reason)).toContain("credential-pattern");
  });

  test('credentials: "reject" refuses instead of quietly cleaning', () => {
    const pkg = basePackage({
      sourceBindings: [
        {
          sourceId: "parcels",
          protocol: "ogc_features",
          locator: { url: "https://gis.example.com/ogc/collections/parcels?api_key=abcdef1234567890" },
        },
      ],
    });
    expect(() => exportMapPackage(pkg, { credentials: "reject" })).toThrow(HonuaExportSafetyError);
  });

  test("an import of a hand-edited, credential-bearing envelope fails closed", () => {
    const envelope = exportMapPackage(basePackage());
    const tampered = JSON.parse(JSON.stringify(envelope));
    tampered.mapPackage.sourceBindings[0].locator.url =
      "https://gis.example.com/ogc?sig=Zm9vYmFyYmF6cXV4c2VjcmV0dmFsdWVoZXJlMTIzNDU2Nzg5MA";
    tampered.fingerprint = mapPackageFingerprint(tampered.mapPackage);
    expect(() => importMapPackage(tampered)).toThrow(HonuaExportSafetyError);
  });

  test("a percent-encoded data: URI payload is scanned, not waved through", () => {
    // `scrubDataUriPayloads` blanks every data-URI payload before the
    // whole-envelope text scan, so a payload the exporter does not decode
    // itself is a payload nothing scans. A non-base64 `data:` URI used to take
    // that route and carry its secret all the way into the emitted bytes.
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
        sprite: "data:text/plain,Bearer%20eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature",
      },
    } as Partial<HonuaMapPackage>);
    expect(() => exportMapPackage(pkg)).toThrow(HonuaExportSafetyError);
  });

  test("the same secret is caught whether it is base64 or percent encoded", () => {
    const secret = "Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature";
    const encodings = [
      `data:text/plain;base64,${Buffer.from(secret, "utf8").toString("base64")}`,
      `data:text/plain,${encodeURIComponent(secret)}`,
    ];
    for (const sprite of encodings) {
      const pkg = basePackage({
        mapSpec: {
          version: 8,
          sources: {},
          layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
          sprite,
        },
      } as Partial<HonuaMapPackage>);
      expect(() => exportMapPackage(pkg), sprite.slice(0, 24)).toThrow(HonuaExportSafetyError);
    }
  });

  test("an undecodable data: URI payload is withheld rather than assumed safe", () => {
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
        // A lone `%` is not a valid percent escape, so the payload cannot be
        // decoded — and therefore cannot be proven credential-free.
        sprite: "data:text/plain,100%discount",
      },
    } as Partial<HonuaMapPackage>);
    const envelope = exportMapPackage(pkg);
    expect(envelope.mapPackage.mapSpec.sprite).toBeUndefined();
    expect(envelope.redactions.map((r) => r.path)).toContain("mapSpec.sprite");
    expect(JSON.stringify(envelope)).not.toContain("100%discount");
  });

  test("withholding a credential must not emit a package the importer rejects", () => {
    // `attribution[].text` is required by the schema. A credential-shaped
    // value there is withheld, which leaves the attribution object without its
    // required property: the exporter used to return that artifact happily and
    // let `importMapPackage` be the one to reject it.
    const pkg = basePackage({
      attribution: [{ text: "Bearer eyJhbGciOiJIUzI1NiJ9.payloadpayload.signature", url: "https://example.com/c" }],
    } as Partial<HonuaMapPackage>);
    expect(() => exportMapPackage(pkg)).toThrow(HonuaMapPackageError);
    expect(() => exportMapPackage(pkg)).toThrow(/no longer satisfies its schema/);
  });

  test("an export that survives sanitization intact still round-trips", () => {
    // The guard above must not fire for the ordinary case: a redaction that
    // removes an *optional* value leaves a valid package.
    const pkg = basePackage({
      attribution: [
        { text: "City of Example", url: "https://example.com/credits?sig=Zm9vYmFyYmF6cXV4c2VjcmV0MTIzNDU2Nzg5MA" },
      ],
    } as Partial<HonuaMapPackage>);
    const envelope = exportMapPackage(pkg);
    expect(envelope.redactions.length).toBeGreaterThan(0);
    expect(() => importMapPackage(JSON.parse(JSON.stringify(envelope)))).not.toThrow();
  });
});

describe("unbounded embedded data is refused", () => {
  test("an oversized inline GeoJSON body is rejected, not exported", () => {
    const features = Array.from({ length: 400 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [i / 10, i / 10] },
      properties: { name: `feature-${i}`, note: "x".repeat(64) },
    }));
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: { inline: { type: "geojson", data: { type: "FeatureCollection", features } } },
        layers: [{ id: "inline-points", type: "circle", source: "inline" }],
      },
    } as Partial<HonuaMapPackage>);

    expect(() => exportMapPackage(pkg, { maxEmbeddedBytes: 4096 })).toThrow(HonuaMapPackageError);
    expect(() => exportMapPackage(pkg, { maxEmbeddedBytes: 4096 })).toThrow(/references data, it does not carry it/);
  });

  test("an oversized data: URI is rejected", () => {
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
        sprite: `data:image/png;base64,${"QUJDRA".repeat(2000)}`,
      },
    } as Partial<HonuaMapPackage>);
    expect(() => exportMapPackage(pkg, { maxEmbeddedBytes: 1024 })).toThrow(HonuaMapPackageError);
  });

  test("a small inline sprite is allowed through and survives the round trip", () => {
    const sprite = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }],
        sprite,
      },
    } as Partial<HonuaMapPackage>);
    const envelope = exportMapPackage(pkg);
    expect(envelope.mapPackage.mapSpec.sprite).toBe(sprite);
    expect(importMapPackage(JSON.parse(JSON.stringify(envelope))).mapPackage.mapSpec.sprite).toBe(sprite);
  });

  test("the whole-envelope budget is enforced on import as well as export", () => {
    const envelope = exportMapPackage(basePackage());
    expect(() => importMapPackage(JSON.parse(JSON.stringify(envelope)), { maxPackageBytes: 64 })).toThrow(
      HonuaMapPackageError,
    );
  });
});

describe("import fails closed", () => {
  test("a foreign envelope kind is refused", () => {
    expect(() => importMapPackage({ kind: "honua.saved-workspace", format: HONUA_MAP_PACKAGE_FORMAT_V1 })).toThrow(
      /export kind must be/,
    );
  });

  test("a mismatched format is refused", () => {
    const envelope = exportMapPackage(basePackage());
    expect(() => importMapPackage({ ...envelope, format: "honua_map_package.v2" })).toThrow(/export format must be/);
  });

  test("a body that no longer matches its stamped fingerprint is refused", () => {
    const envelope = exportMapPackage(basePackage());
    const tampered = JSON.parse(JSON.stringify(envelope));
    tampered.mapPackage.initialView.zoom = 3;
    expect(() => importMapPackage(tampered)).toThrow(/fingerprint does not match/);
  });

  test("an envelope with no fingerprint stamp is refused, not silently trusted", () => {
    // Deleting the stamp used to skip the comparison entirely, so the cheapest
    // way past the integrity check was to remove the field that performs it.
    const envelope = exportMapPackage(basePackage());
    const unstamped = JSON.parse(JSON.stringify(envelope));
    unstamped.mapPackage.initialView.zoom = 3;
    delete unstamped.fingerprint;
    expect(() => importMapPackage(unstamped)).toThrow(/missing its fingerprint stamp/);

    // A non-string stamp is the same failure, not a different one.
    const misstamped = JSON.parse(JSON.stringify(envelope));
    misstamped.fingerprint = 42;
    expect(() => importMapPackage(misstamped)).toThrow(/missing its fingerprint stamp/);
  });

  test("skipFingerprintCheck is the only way to import an unstamped envelope", () => {
    const envelope = exportMapPackage(basePackage());
    const unstamped = JSON.parse(JSON.stringify(envelope));
    delete unstamped.fingerprint;
    const imported = importMapPackage(unstamped, { skipFingerprintCheck: true });
    expect(imported.fingerprint).toBe(envelope.fingerprint);
  });

  test("an invalid package is not exported in the first place", () => {
    const pkg = basePackage({
      mapSpec: {
        version: 8,
        sources: {},
        layers: [{ id: "dangling", type: "fill", source: "never-bound" }],
      },
    } as Partial<HonuaMapPackage>);
    expect(() => exportMapPackage(pkg)).toThrow(/does not validate/);
  });
});
