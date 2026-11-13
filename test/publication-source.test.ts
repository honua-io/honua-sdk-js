import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FetchSource, PMTiles } from "pmtiles";
import { describe, expect, it } from "vitest";

import { queryFilter } from "../src/contract/query-filter.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { polygon } from "../src/core/spatial-filter.js";
import { GeoparquetRuntime } from "../src/geoparquet/index.js";
import {
  HonuaPublicationError,
  createPublicationDataset,
  openPublication,
  verifyPmtilesArtifact,
} from "../src/publication/index.js";
import { decodeTileLayer } from "./helpers/mvt-decode.js";
import {
  FIXTURE_STAMP,
  LEADING_ZERO_PARCEL,
  MERGED_MULTIPART_PARCEL,
  NON_PUBLIC_FIELDS as NON_PUBLIC,
  FIXTURE_DESCRIPTOR as descriptor,
  nodeDriver,
  openFixture,
  publicationTestBed,
  rewrittenParquet,
  storedGeometry,
} from "./helpers/publication-fixture.js";

const { served, pairedSource, track } = publicationTestBed();

function tileContaining(lon: number, lat: number, z: number): [number, number, number] {
  const scale = 2 ** z;
  const radians = (lat * Math.PI) / 180;
  return [
    Math.floor(((lon + 180) / 360) * scale),
    Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale),
    z,
  ];
}

function featureGeometry(result: { features: ReadonlyArray<{ geometry?: unknown }> }) {
  return result.features[0]?.geometry as { type: string; coordinates: number[][][][] };
}

describe("openPublication", () => {
  it("returns a typed publication with absolute artifact links, identity and freshness", async () => {
    const server = await served();
    const publication = await openFixture(server);
    expect(publication.display).toMatchObject({
      pmtilesUrl: `${server.origin}/maui/parcels.pmtiles`,
      sourceLayer: "parcels",
      promoteId: "tmk_txt",
      minzoom: 8,
      maxzoom: 15,
    });
    expect(publication.geoparquetUrl).toBe(`${server.origin}/maui/parcels.parquet`);
    expect(publication.identity).toEqual({
      field: "tmk_txt",
      type: "string",
      pmtilesProperty: "tmk_txt",
      geoparquetColumn: "tmk_txt",
    });
    expect(publication.freshness).toEqual({
      version: descriptor.version,
      captureId: descriptor.capture.captureId,
      capturedAt: descriptor.capture.capturedAt,
      publishedAt: descriptor.publishedAt,
      sourceRevision: descriptor.capture.sourceRevision,
    });
    expect(publication.publicFields.map((field) => field.name)).not.toEqual(expect.arrayContaining(NON_PUBLIC));
  });

  it("rejects an invalid descriptor with an error that names the broken rule", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-descriptor-"));
    track(() => rmSync(directory, { recursive: true, force: true }));
    const broken = path.join(directory, "descriptor.json");
    writeFileSync(
      broken,
      JSON.stringify({
        ...descriptor,
        artifacts: { ...descriptor.artifacts, pmtiles: { ...descriptor.artifacts.pmtiles, captureId: "sha256:other" } },
      }),
    );
    const server = await served({ descriptor: broken });
    const opened = openPublication(`${server.origin}/maui/descriptor.json`);
    await expect(opened).rejects.toBeInstanceOf(HonuaPublicationError);
    await expect(opened).rejects.toThrow(/artifacts\/pmtiles\/captureId must equal capture.captureId/);
    await expect(openPublication(`${server.origin}/maui/missing.json`)).rejects.toThrow(/HTTP 404/);
  });
});

describe("paired source contract", () => {
  it("query returns the canonical Result envelope with GeoParquet features", async () => {
    const source = await pairedSource(await served());
    const result = await source.query({ pagination: { limit: 25 } });
    expect(result.features).toHaveLength(25);
    expect(result.exceededTransferLimit).toBe(true);
    expect(result.features[0]?.geometry).toMatchObject({ type: "MultiPolygon" });
  });

  it("descriptor exposes the GeoParquet capabilities", async () => {
    const source = await pairedSource(await served());
    expect(source.descriptor.protocol).toBe("geoparquet");
    for (const capability of PROTOCOL_DEFAULT_CAPABILITIES.geoparquet)
      expect(source.capabilities.has(capability)).toBe(true);
    expect(source.supports("query")).toBe(true);
  });

  it("queryAggregate and stream follow the shared contract; queryExtent is refused as GeoParquet refuses it", async () => {
    const source = await pairedSource(await served());
    await expect(source.queryExtent()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    const aggregate = await source.queryAggregate({
      aggregation: { groupBy: ["section"], metrics: [{ fn: "count", field: "tmk_txt", alias: "parcels" }] },
    });
    expect(aggregate.aggregateRows?.length).toBeGreaterThan(0);
    const total = aggregate.aggregateRows?.reduce((sum, row) => sum + Number(row.parcels), 0);
    expect(total).toBe(descriptor.capture.featureCount);
    for await (const page of source.stream({ pagination: { limit: 50 } })) {
      expect(page.features.length).toBeGreaterThan(0);
      break;
    }
  });

  it("refuses operations a static publication cannot perform instead of returning empty data", async () => {
    const source = await pairedSource(await served());
    await expect(source.applyEdits({ adds: [] })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.queryRelated({ relationshipId: 0, objectIds: [1] } as never)).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
  });

  it("reports a bounds filter it can only approximate", async () => {
    const source = await pairedSource(await served());
    const result = await source.query({
      spatialFilter: polygon([
        [
          [-156.49, 20.905],
          [-156.488, 20.905],
          [-156.488, 20.907],
          [-156.49, 20.905],
        ],
      ]),
    });
    expect(result.degraded?.[0]?.reason).toMatch(/bounding box/);
  });

  it("joins a Dataset with a PMTiles display source and the paired query source", async () => {
    const server = await served();
    const publication = await openFixture(server);
    const runtime = new GeoparquetRuntime({ driverFactory: nodeDriver });
    const paired = createPublicationDataset(publication, {
      client: new HonuaClient({ baseUrl: server.origin }),
      runtime,
    });
    track(() => paired.dispose());
    const display = paired.dataset.source(paired.displaySourceId);
    expect(display?.descriptor.protocol).toBe("pmtiles");
    const archive = await display?.protocol("pmtiles")?.describe();
    expect(archive?.vectorLayers.map((layer) => layer.id)).toContain("parcels");
    await verifyPmtilesArtifact(publication);
    const query = paired.dataset.source(paired.querySourceId) as unknown as {
      lookup(id: string): Promise<{ answeredBy: string }>;
    };
    expect((await query.lookup(MERGED_MULTIPART_PARCEL)).answeredBy).toBe("geoparquet");
  });
});

describe("selection through the stable identity", () => {
  it("returns the GeoParquet record for a rendered tile feature, not the tile geometry", async () => {
    const server = await served();
    const source = await pairedSource(server);
    const archive = new PMTiles(new FetchSource(`${server.origin}/maui/parcels.pmtiles`));
    const [lon, lat] = featureGeometry((await source.lookup(MERGED_MULTIPART_PARCEL)).result).coordinates[0]![0]![0]!;
    const [x, y, z] = tileContaining(lon!, lat!, 15);
    const tile = await archive.getZxy(z, x, y);
    const features = decodeTileLayer(new Uint8Array(tile?.data ?? new ArrayBuffer(0)), "parcels", { x, y, z });
    const rendered = features.find((feature) => feature.properties.tmk_txt === MERGED_MULTIPART_PARCEL);
    expect(rendered, "fixture tile must contain the parcel").toBeDefined();
    const tileRings = rendered!.rings;

    const selected = await source.select({ properties: rendered!.properties });
    const geometry = featureGeometry(selected.result);
    expect(selected.answeredBy).toBe("geoparquet");
    expect(selected.result.features[0]?.attributes).toMatchObject({ tmk_txt: MERGED_MULTIPART_PARCEL, plat: "030" });
    expect(geometry.type).toBe("MultiPolygon");
    expect(tileRings.length).toBeGreaterThan(0);
    expect(JSON.stringify(geometry.coordinates.flat())).not.toBe(JSON.stringify(tileRings));

    const stored = await storedGeometry(MERGED_MULTIPART_PARCEL);
    expect(geometry.coordinates[0]?.[0]?.[0]).toEqual([stored[0]?.[0]?.[0]?.x, stored[0]?.[0]?.[0]?.y]);
  });

  it("refuses a rendered feature that carries no text identity", async () => {
    const source = await pairedSource(await served());
    await expect(source.select({ properties: { tmk_txt: 234030888 } })).rejects.toThrow(/no text tmk_txt property/);
    await expect(source.select({ properties: null })).rejects.toBeInstanceOf(HonuaPublicationError);
  });
});

describe("parcel values survive lookup and export", () => {
  it("keeps the z coordinate of a three-dimensional native geometry", async () => {
    const withZ = await rewrittenParquet(
      "* REPLACE (list_transform(geometry, lambda p: list_transform(p, lambda r: list_transform(r, lambda c: {'x': c.x, 'y': c.y, 'z': 7.0}))) AS geometry)",
      FIXTURE_STAMP,
    );
    track(withZ.cleanup);
    const lookup = await (await pairedSource(await served(withZ.overrides))).lookup(MERGED_MULTIPART_PARCEL);
    expect(featureGeometry(lookup.result).coordinates[0]?.[0]?.[0]).toHaveLength(3);
    expect(featureGeometry(lookup.result).coordinates[0]?.[0]?.[0]?.[2]).toBe(7);
  });

  it("answers an identity lookup with the record the SQL engine returns for the same filter", async () => {
    const source = await pairedSource(await served());
    for (const identity of [MERGED_MULTIPART_PARCEL, LEADING_ZERO_PARCEL]) {
      const looked = await source.lookup(identity);
      const queried = await source.query({ filter: queryFilter.eq("tmk_txt", identity) });
      expect(looked.result.features).toEqual(queried.features);
    }
  });

  it("keeps leading zeros, multipart geometry and null attributes", async () => {
    const source = await pairedSource(await served());
    const merged = await source.lookup(MERGED_MULTIPART_PARCEL);
    expect(merged.result.features[0]?.attributes).toMatchObject({ plat: "030", parcel: "888", nhoodcode: null });
    expect(featureGeometry(merged.result).coordinates).toHaveLength(2);
    const leading = await source.lookup(LEADING_ZERO_PARCEL);
    expect(leading.result.features[0]?.attributes).toMatchObject({
      tmk_txt: LEADING_ZERO_PARCEL,
      plat: "001",
      parcel: "001",
    });

    const filter = queryFilter.isIn("tmk_txt", [MERGED_MULTIPART_PARCEL, LEADING_ZERO_PARCEL]);
    const csv = await source.exportFeatures("csv", { filter, orderBy: [{ field: "tmk_txt" }] });
    const [header, first, second] = csv.trimEnd().split("\r\n");
    expect(header).toBe("tmk_txt,zone,section,plat,parcel,nhoodcode,pittcode,taxacres,gisacres");
    expect(first).toMatch(/^233001001,3,3,001,001,/);
    expect(second).toMatch(/^234030888,3,4,030,888,,/);

    const geojson = JSON.parse(await source.exportFeatures("geojson", { filter }));
    const exported = geojson.features.find((feature: { id: string }) => feature.id === MERGED_MULTIPART_PARCEL);
    expect(exported.properties).toMatchObject({ plat: "030", nhoodcode: null });
    expect(exported.geometry.type).toBe("MultiPolygon");
    expect(exported.geometry.coordinates).toHaveLength(2);
  });
});
