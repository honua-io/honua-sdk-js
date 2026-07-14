/**
 * Cross-protocol composition contract tests for `#22`. Covers:
 *
 *  - `intersectCapabilities` honesty across single-source / pair / triple
 *    / quadruple combinations of `PROTOCOL_DEFAULT_CAPABILITIES`,
 *  - the four canonical mixed-protocol scenarios (GeoServices + OGC +
 *    WMS + STAC; FeatureServer + OData; WMTS basemap + OGC Features
 *    overlay; partial-failure under `loadMapPackage`),
 *  - per-source `DegradedReason.sourceId` attribution so a fan-out can
 *    point to the failing source instead of parsing `reason` strings,
 *  - `loadMapPackage` partial-failure semantics: one bind failure
 *    surfaces `source-error` while remaining sources continue to
 *    render and query.
 *
 * The mocks here are intentionally minimal — the parametric per-adapter
 * conformance suite already covers each adapter's translation rules.
 * This file exists to prove the composition surface stitches them
 * together without smuggling in a new abstraction layer.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Protocol,
  type SourceDescriptor,
  capabilities,
  createDataset,
  intersectCapabilities,
  unionCapabilities,
} from "../../src/contract/index.js";
import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  type HonuaRuntimeEvent,
  type HonuaRuntimeTelemetrySpanResult,
  type MaplibreMap,
  loadMapPackage,
} from "../../src/runtime/index.js";

import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  ogcCollectionMetadata,
  ogcItemsResponse,
} from "./shared.js";

// ── intersectCapabilities ────────────────────────────────────

describe("contract / intersectCapabilities", () => {
  it("returns an empty set when given no participants", () => {
    expect(intersectCapabilities([]).size).toBe(0);
  });

  it("mirrors the single participant's capability set", () => {
    const fs = PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"];
    const intersected = intersectCapabilities([{ capabilities: fs }]);
    expect(intersected.size).toBe(fs.size);
    for (const cap of fs) expect(intersected.has(cap)).toBe(true);
  });

  it("computes the weakest set across a pair of protocols (FS + OGC Features)", () => {
    const intersected = intersectCapabilities([
      { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"] },
      { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"] },
    ]);
    // The intersection of FS (query, queryAggregate, queryExtent,
    // queryObjectIds, queryRelated, applyEdits, attachments, sql,
    // stream, pbf) and OGC Features (query, queryObjectIds,
    // applyEdits, stream) is exactly { query, queryObjectIds,
    // applyEdits, stream }.
    expect(intersected.has("query")).toBe(true);
    expect(intersected.has("queryObjectIds")).toBe(true);
    expect(intersected.has("applyEdits")).toBe(true);
    expect(intersected.has("stream")).toBe(true);
    expect(intersected.has("queryAggregate")).toBe(false);
    expect(intersected.has("queryExtent")).toBe(false);
    expect(intersected.has("attachments")).toBe(false);
    expect(intersected.has("render")).toBe(false);
  });

  it("yields query-only across the four canonical protocols (FS + OGC + WMS + STAC)", () => {
    const intersected = intersectCapabilities([
      { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"] },
      { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"] },
      { capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms },
      { capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac },
    ]);
    // WMS contributes only `render`, `tiles`, `query`; STAC contributes
    // `query`, `queryObjectIds`, `stream`. So query is the only
    // capability all four advertise.
    expect([...intersected]).toEqual(["query"]);
  });

  it("returns the empty set when one participant has zero capabilities", () => {
    expect(
      intersectCapabilities([
        { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"] },
        { capabilities: capabilities([]) },
      ]).size,
    ).toBe(0);
  });

  it("never reports a capability that the weakest source lacks (every protocol pair)", () => {
    // The single non-negotiable promise of mixed-source composition:
    // promising a capability the weakest source can't fulfill is the
    // worst possible failure (silent wrong result). Sweep every
    // ordered pair of declared protocols and verify the invariant.
    const protocols: Protocol[] = [
      "geoservices-feature-service",
      "geoservices-map-service",
      "geoservices-image-service",
      "geoservices-geometry-service",
      "geoservices-gp-service",
      "ogc-features",
      "ogc-tiles",
      "ogc-maps",
      "stac",
      "wfs",
      "wms",
      "wmts",
      "odata",
      "maplibre-vector",
      "maplibre-raster",
      "maplibre-geojson",
    ];
    for (const a of protocols) {
      for (const b of protocols) {
        const inter = intersectCapabilities([
          { capabilities: PROTOCOL_DEFAULT_CAPABILITIES[a] },
          { capabilities: PROTOCOL_DEFAULT_CAPABILITIES[b] },
        ]);
        for (const cap of inter) {
          expect(PROTOCOL_DEFAULT_CAPABILITIES[a].has(cap)).toBe(true);
          expect(PROTOCOL_DEFAULT_CAPABILITIES[b].has(cap)).toBe(true);
        }
      }
    }
  });

  it("accepts live `Source` instances structurally (capabilities is the only required field)", () => {
    // intersectCapabilities is structurally typed on `{ capabilities }`
    // so consumers can pass live `Source` handles after metadata
    // negotiation (e.g., OData $metadata downgrades) without unwrapping
    // them back to descriptors.
    const liveLikeA = { capabilities: capabilities(["query", "applyEdits"]) };
    const liveLikeB = { capabilities: capabilities(["query", "stream"]) };
    expect([...intersectCapabilities([liveLikeA, liveLikeB])]).toEqual(["query"]);
  });
});

describe("contract / unionCapabilities", () => {
  it("collects every capability across the participants", () => {
    const unioned = unionCapabilities([
      { capabilities: capabilities(["query", "queryObjectIds"]) },
      { capabilities: capabilities(["queryObjectIds", "stream"]) },
    ]);
    expect([...unioned].sort()).toEqual(["query", "queryObjectIds", "stream"]);
  });

  it("returns the empty set on no participants", () => {
    expect(unionCapabilities([]).size).toBe(0);
  });
});

// ── DegradedReason.sourceId attribution ──────────────────────

describe("contract / Result.degraded carries sourceId attribution", () => {
  it("OGC Features client-side aggregation tags the originating source id", async () => {
    const dataset = createDataset({
      id: "parcels",
      client: makeMockClient({
        routes: [
          ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
          ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
        ],
      }),
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "ogc-overlay",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source<ParcelAttrs>("ogc-overlay")!;
    const result = await source.queryAggregate({
      aggregation: { metrics: [{ fn: "sum", field: "ACRES", alias: "SUM_ACRES" }] },
    });
    expect(result.degraded?.[0]).toMatchObject({
      capability: "queryAggregate",
      protocol: "ogc-features",
      sourceId: "ogc-overlay",
    });
  });

  it("OData per-call fallback under rollbackOnFailure tags the OData source id", async () => {
    // Service explicitly DOES NOT advertise $batch — the spec default
    // for `BatchSupported` is `true`, so callers wanting the
    // rollbackOnFailure degrade path must set it to `false` explicitly.
    const metadataWithoutBatch = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Parcel">
        <Key><PropertyRef Name="OBJECTID"/></Key>
        <Property Name="OBJECTID" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.OData.Parcel">
          <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">
            <Record><PropertyValue Property="Updatable" Bool="true"/></Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.BatchSupported" Bool="false"/>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const dataset = createDataset({
      id: "ops",
      client: makeMockClient({
        routes: [
          [
            "/odata/$metadata",
            () =>
              new Response(metadataWithoutBatch, {
                status: 200,
                headers: { "Content-Type": "application/xml" },
              }),
          ],
          [
            "/odata/Parcels(",
            () =>
              new Response(JSON.stringify({ OBJECTID: 1, STATE: "CA" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
          ],
        ],
      }),
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "odata-ops",
          protocol: "odata",
          locator: { url: "https://mock/odata", entitySet: "Parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        },
      ],
    });
    const source = dataset.source<ParcelAttrs>("odata-ops")!;
    const result = await source.applyEdits({
      rollbackOnFailure: true,
      updates: [{ id: 1, attributes: { OBJECTID: 1, STATE: "CA" } as ParcelAttrs }],
    });
    expect(result.degraded?.find((d) => d.capability === "applyEdits")).toMatchObject({
      capability: "applyEdits",
      protocol: "odata",
      sourceId: "odata-ops",
    });
  });
});

// ── Composition scenarios ────────────────────────────────────

describe("contract / composition scenarios", () => {
  it("GeoServices + OGC + WMS + STAC: every source registers under one Dataset and per-source query works in isolation", async () => {
    const fsResponse = (): Response => jsonResponse(geoservicesQueryResponse());

    const dataset = createDataset({
      id: "mixed",
      client: makeMockClient({
        routes: [
          ["/rest/services/Parcels/FeatureServer/0/query", fsResponse],
          ["/ogc/features/collections/parcels/items", () => jsonResponse(ogcItemsResponse())],
          ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
          [
            "/stac/search",
            () =>
              jsonResponse({
                type: "FeatureCollection",
                features: [
                  {
                    type: "Feature",
                    id: "scene-1",
                    properties: { datetime: "2026-04-25T00:00:00Z" },
                    geometry: { type: "Point", coordinates: [-121, 38] },
                  },
                ],
                numberMatched: 1,
                numberReturned: 1,
              }),
          ],
        ],
      }),
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
        },
        {
          id: "ogc-overlay",
          protocol: "ogc-features",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
        },
        {
          id: "basemap-wms",
          protocol: "wms",
          locator: {
            url: "https://mock/wms",
            serviceId: "imagery",
            typeName: "imagery:base",
            styleId: "",
          },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
        },
        {
          id: "stac-imagery",
          protocol: "stac",
          locator: { url: "https://mock/stac" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
        },
      ],
    });

    expect(dataset.sourceIds()).toEqual(["parcels-fs", "ogc-overlay", "basemap-wms", "stac-imagery"]);

    // Composition-wide weakest set: every source supports `query`, but
    // not `applyEdits` (WMS lacks it) and not `tiles` (FS / OGC / STAC
    // lack it). The composition is honest about that.
    const weakest = intersectCapabilities(dataset.sourceDescriptors);
    expect(weakest.has("query")).toBe(true);
    expect(weakest.has("applyEdits")).toBe(false);
    expect(weakest.has("tiles")).toBe(false);

    const fs = dataset.source<ParcelAttrs>("parcels-fs")!;
    const ogc = dataset.source<ParcelAttrs>("ogc-overlay")!;
    const fsResult = await fs.query({ where: "1=1" });
    const ogcResult = await ogc.query({ where: "1=1" });
    expect(fsResult.features.length).toBe(PARCEL_FEATURES.length);
    expect(ogcResult.features.length).toBe(PARCEL_FEATURES.length);
  });

  it("FeatureServer + OData both expose applyEdits; OData $batch downgrade is per-source not per-composition", async () => {
    // FS unaffected, OData advertises edits but lacks $batch — the
    // degraded reason carries `sourceId: "odata-ops"`, not
    // `parcels-fs`, even though both sources participate in the same
    // composition.
    const odataMetadataNoBatch = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Parcel">
        <Key><PropertyRef Name="OBJECTID"/></Key>
        <Property Name="OBJECTID" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.OData.Parcel">
          <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">
            <Record><PropertyValue Property="Updatable" Bool="true"/></Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.BatchSupported" Bool="false"/>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const dataset = createDataset({
      id: "ops",
      client: makeMockClient({
        routes: [
          [
            "/rest/services/Parcels/FeatureServer/0/applyEdits",
            () =>
              jsonResponse({
                addResults: [{ objectId: 99, success: true }],
                updateResults: [],
                deleteResults: [],
              }),
          ],
          [
            "/odata/$metadata",
            () =>
              new Response(odataMetadataNoBatch, {
                status: 200,
                headers: { "Content-Type": "application/xml" },
              }),
          ],
          [
            "/odata/Parcels(",
            () =>
              new Response(JSON.stringify({ OBJECTID: 1, STATE: "CA" }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
          ],
        ],
      }),
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-fs",
          protocol: "geoservices-feature-service",
          locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
        },
        {
          id: "odata-ops",
          protocol: "odata",
          locator: { url: "https://mock/odata", entitySet: "Parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        },
      ],
    });

    const intersected = intersectCapabilities(dataset.sourceDescriptors);
    expect(intersected.has("applyEdits")).toBe(true);

    const fs = dataset.source<ParcelAttrs>("parcels-fs")!;
    const odata = dataset.source<ParcelAttrs>("odata-ops")!;

    const fsEdit = await fs.applyEdits({ adds: [{ attributes: { OBJECTID: 99, STATE: "CA", ACRES: 1 } }] });
    expect(fsEdit.added).toHaveLength(1);
    expect(fsEdit.added[0].success).toBe(true);
    expect(fsEdit.degraded ?? []).toEqual([]);

    const odataEdit = await odata.applyEdits({
      rollbackOnFailure: true,
      updates: [{ id: 1, attributes: { OBJECTID: 1, STATE: "CA" } as ParcelAttrs }],
    });
    const reason = odataEdit.degraded?.find((d) => d.sourceId === "odata-ops");
    expect(reason).toBeDefined();
    expect(reason?.protocol).toBe("odata");
    // Critical: only the OData source's edit reports degradation; FS
    // edit had no degraded entries.
    expect(reason?.sourceId).toBe("odata-ops");
  });

  it("WMTS basemap + OGC Features overlay: render+query intersection yields nothing (intentional)", () => {
    // The honest answer for a basemap+overlay pairing: render-only
    // sources do not contribute to the canonical Source query family.
    // Consumers that want a per-operation answer should partition
    // first, then intersect on the partition.
    const wmtsCaps = PROTOCOL_DEFAULT_CAPABILITIES.wmts;
    const ogcCaps = PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"];

    const fullIntersect = intersectCapabilities([{ capabilities: wmtsCaps }, { capabilities: ogcCaps }]);
    expect(fullIntersect.size).toBe(0);

    // Partitioned reasoning is a one-line helper away — only the OGC
    // partition contributes feature semantics, and its intersection
    // with itself is just the OGC capability set.
    const featurePartition = intersectCapabilities([{ capabilities: ogcCaps }]);
    expect(featurePartition.has("query")).toBe(true);

    // The render partition exposes `tiles` for the basemap.
    const renderPartition = intersectCapabilities([{ capabilities: wmtsCaps }]);
    expect(renderPartition.has("tiles")).toBe(true);
    expect(renderPartition.has("render")).toBe(true);
  });
});

// ── loadMapPackage partial-failure semantics ─────────────────

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface MockMap extends MaplibreMap {
  _calls: RecordedCall[];
  _style: unknown;
}

function makeMockMap(): MockMap {
  const calls: RecordedCall[] = [];
  const record = (method: string, args: unknown[]): void => {
    calls.push({ method, args });
  };
  const map: MockMap = {
    _calls: calls,
    _style: {},
    setStyle(next) {
      record("setStyle", [next]);
      map._style = next;
      return undefined;
    },
    getStyle() {
      return map._style;
    },
    addSource(id, source) {
      record("addSource", [id, source]);
    },
    removeSource(id) {
      record("removeSource", [id]);
    },
    addLayer(layer, beforeId) {
      record("addLayer", [layer, beforeId]);
    },
    removeLayer(id) {
      record("removeLayer", [id]);
    },
    setLayoutProperty(layerId, name, value) {
      record("setLayoutProperty", [layerId, name, value]);
    },
    setPaintProperty(layerId, name, value) {
      record("setPaintProperty", [layerId, name, value]);
    },
    setFilter(layerId, filter) {
      record("setFilter", [layerId, filter]);
    },
    fitBounds(bounds, options) {
      record("fitBounds", [bounds, options]);
    },
    jumpTo(options) {
      record("jumpTo", [options]);
    },
    setFeatureState() {
      // unused
    },
    getFeatureState() {
      return {};
    },
    removeFeatureState() {
      // unused
    },
    on() {
      // unused
    },
    off() {
      // unused
    },
  };
  return map;
}

function makeMixedPackage(overrides?: { ogcLocatorUrl?: string }): HonuaMapPackage {
  return {
    mapPackageId: "mixed-pkg",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [
      {
        sourceId: "parcels",
        protocol: "geoservices_feature_service",
        locator: { url: "https://example/rest/services/Parcels/FeatureServer/0" },
      },
      {
        sourceId: "imagery",
        protocol: "wms",
        locator: {
          url: "https://example/ogc/services/imagery/wms",
          typeName: "imagery:base",
          serviceId: "imagery",
        },
      },
      {
        sourceId: "ogc-overlay",
        protocol: "ogc_features",
        locator: {
          url: overrides?.ogcLocatorUrl ?? "https://example/ogc/features/collections/parcels",
        },
      },
      {
        sourceId: "basemap-tiles",
        protocol: "vector_tile",
        locator: { url: "https://example/tiles/{z}/{x}/{y}.pbf" },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        { id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#cccccc" } },
        { id: "imagery-raster", type: "raster", source: "imagery" },
        { id: "ogc-circle", type: "circle", source: "ogc-overlay", paint: { "circle-radius": 4 } },
        { id: "basemap-line", type: "line", source: "basemap-tiles", paint: { "line-color": "#000" } },
        { id: "background", type: "background", paint: { "background-color": "#fff" } },
      ],
    },
  };
}

describe("runtime / loadMapPackage partial-failure", () => {
  it("loads a 4-source mixed-protocol package and emits source-ready for each", async () => {
    const map = makeMockMap();
    const pkg = makeMixedPackage();
    const events: HonuaRuntimeEvent[] = [];

    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      applyInitialView: false,
      onEvent: (event) => events.push(event),
    });

    const readyIds = events.filter((e) => e.type === "source-ready").map((e) => (e as { sourceId: string }).sourceId);
    expect(readyIds.sort()).toEqual(["imagery", "ogc-overlay", "parcels"].sort());
    // basemap-tiles is a MapLibre-native source (vector_tile), not part
    // of dataset.sourceIds, so source-ready does not fire for it.
    expect(readyIds).not.toContain("basemap-tiles");
    expect(events.some((e) => e.type === "package-loaded")).toBe(true);
    expect(events.some((e) => e.type === "source-error")).toBe(false);

    // Composed style retains every layer (no failures).
    expect(runtime.composedStyle.layers.map((l) => l.id).sort()).toEqual([
      "background",
      "basemap-line",
      "imagery-raster",
      "ogc-circle",
      "parcels-fill",
    ]);
  });

  it("under tolerant policy: one failing source emits source-error + telemetry; remaining sources keep rendering", async () => {
    const map = makeMockMap();
    // OGC binding URL has no `/collections/<id>` segment, so projection
    // cannot backfill `collectionId` — `requireOgcLocator` will throw
    // when the source is materialized at bind time, exercising the
    // tolerant per-source error path through the built-in resolver.
    const pkg = makeMixedPackage({ ogcLocatorUrl: "https://example/ogc/features" });
    const events: HonuaRuntimeEvent[] = [];
    const telemetryErrors: HonuaRuntimeTelemetrySpanResult[] = [];

    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      applyInitialView: false,
      telemetry: {
        error: (span) => telemetryErrors.push(span),
      },
      onEvent: (event) => events.push(event),
    });

    // The composed style should be rebuilt without the failing source's
    // layers — `ogc-circle` is dropped because its `source` references
    // the failed `ogc-overlay`.
    const layerIds = runtime.composedStyle.layers.map((l) => l.id).sort();
    expect(layerIds).not.toContain("ogc-circle");
    expect(layerIds).toContain("parcels-fill");
    expect(layerIds).toContain("imagery-raster");
    expect(layerIds).toContain("basemap-line");
    // Background layer (no source) is unaffected.
    expect(layerIds).toContain("background");

    // Exactly one source-error event for the failed source, with the
    // original error attached.
    const sourceErrors = events.filter((e) => e.type === "source-error") as Array<{
      type: "source-error";
      sourceId: string;
      error: unknown;
    }>;
    expect(sourceErrors).toHaveLength(1);
    expect(sourceErrors[0].sourceId).toBe("ogc-overlay");
    expect((sourceErrors[0].error as Error).message).toMatch(/collectionId/);

    // Telemetry observes the same failure with a `source-bind` span.
    const bindSpans = telemetryErrors.filter((s) => s.kind === "source-bind");
    expect(bindSpans).toHaveLength(1);
    expect(bindSpans[0].detail).toEqual({ sourceId: "ogc-overlay" });
    expect(bindSpans[0].error).toBeInstanceOf(Error);

    // The remaining sources can still be queried — composition keeps
    // rendering even with one failure. (The descriptor for ogc-overlay
    // is still registered in the dataset; its materialization will
    // re-throw, which is the consumer's signal to fan-out around it.)
    expect(runtime.dataset.source("parcels")).toBeDefined();
    expect(runtime.dataset.source("imagery")).toBeDefined();

    // source-ready did NOT fire for the failing source.
    const readyIds = events.filter((e) => e.type === "source-ready").map((e) => (e as { sourceId: string }).sourceId);
    expect(readyIds).not.toContain("ogc-overlay");
    expect(readyIds).toContain("parcels");
    expect(readyIds).toContain("imagery");

    // package-loaded still fires after partial failure.
    expect(events.some((e) => e.type === "package-loaded")).toBe(true);
  });

  it("under fail-fast policy: a single source failure rejects the load", async () => {
    const map = makeMockMap();
    const pkg = makeMixedPackage({ ogcLocatorUrl: "https://example/ogc/features" });

    await expect(
      loadMapPackage(pkg, map, {
        client: makeMockClient({ routes: [] }),
        skipCompatibilityCheck: true,
        applyInitialView: false,
        sourceErrorPolicy: "fail-fast",
      }),
    ).rejects.toMatchObject({ stage: "source-bind" });
  });

  it("runtime.reportSourceError emits source-error and a telemetry span", async () => {
    const map = makeMockMap();
    const pkg = makeMixedPackage();
    const events: HonuaRuntimeEvent[] = [];
    const telemetryErrors: HonuaRuntimeTelemetrySpanResult[] = [];

    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      applyInitialView: false,
      telemetry: {
        error: (span) => telemetryErrors.push(span),
      },
      onEvent: (event) => events.push(event),
    });

    // Pretend a fan-out query against `parcels` rejected — the
    // operator-component layer would normally call this.
    const cause = new Error("simulated query rejection");
    runtime.reportSourceError("parcels", cause);

    const sourceErrors = events.filter((e) => e.type === "source-error") as Array<{
      type: "source-error";
      sourceId: string;
      error: unknown;
    }>;
    const lastError = sourceErrors[sourceErrors.length - 1];
    expect(lastError?.sourceId).toBe("parcels");
    expect(lastError?.error).toBe(cause);

    expect(
      telemetryErrors.some(
        (s) => s.kind === "source-bind" && (s.detail as { sourceId: string }).sourceId === "parcels",
      ),
    ).toBe(true);
  });

  it("runtime.reportSourceError no-ops on a disposed runtime", async () => {
    const map = makeMockMap();
    const pkg = makeMixedPackage();
    const events: HonuaRuntimeEvent[] = [];

    const runtime = await loadMapPackage(pkg, map, {
      client: makeMockClient({ routes: [] }),
      skipCompatibilityCheck: true,
      applyInitialView: false,
      onEvent: (event) => events.push(event),
    });

    runtime.dispose();
    events.length = 0;
    expect(() => runtime.reportSourceError("parcels", new Error("late"))).not.toThrow();
    expect(events.filter((e) => e.type === "source-error")).toHaveLength(0);
  });
});
