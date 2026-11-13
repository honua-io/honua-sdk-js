import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";
import { FetchSource, PMTiles } from "pmtiles";
import { describe, expect, it } from "vitest";

import { queryFilter } from "../src/contract/query-filter.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { polygon } from "../src/core/spatial-filter.js";
import { GeoparquetRuntime } from "../src/geoparquet/index.js";
import {
  HonuaPublicationError,
  createPublicationDataset,
  openPublication,
  verifyPmtilesArtifact,
} from "../src/publication/index.js";
import {
  FIXTURE_DIRECTORY,
  LEADING_ZERO_PARCEL,
  MERGED_MULTIPART_PARCEL,
  fixtureSource,
  nodeDriver,
  openFixture,
  rewrittenParquet,
  storedGeometry,
} from "./helpers/publication-fixture.js";
import { cleanups, pairedSource, served } from "./helpers/publication-test-fixture.js";

const descriptor = JSON.parse(readFileSync(path.join(FIXTURE_DIRECTORY, "descriptor.json"), "utf8"));
const NON_PUBLIC = descriptor.fields
  .filter((field: { public: boolean }) => !field.public)
  .map((field: { name: string }) => field.name);
const stamp = {
  publicationId: descriptor.publicationId,
  version: descriptor.version,
  captureId: descriptor.capture.captureId,
};

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
      minzoom: 10,
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
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
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
    cleanups.push(() => paired.dispose());
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
    const layer = new VectorTile(new PbfReader(new Uint8Array(tile?.data ?? new ArrayBuffer(0)))).layers.parcels;
    const rendered = Array.from({ length: layer?.length ?? 0 }, (_, index) => layer!.feature(index)).find(
      (feature) => feature.properties.tmk_txt === MERGED_MULTIPART_PARCEL,
    );
    expect(rendered, "fixture tile must contain the parcel").toBeDefined();
    const tileGeometry = rendered!.toGeoJSON(x, y, z).geometry as { coordinates: unknown };

    const selected = await source.select({ properties: rendered!.properties });
    const geometry = featureGeometry(selected.result);
    expect(selected.answeredBy).toBe("geoparquet");
    expect(selected.result.features[0]?.attributes).toMatchObject({ tmk_txt: MERGED_MULTIPART_PARCEL, plat: "030" });
    expect(geometry.type).toBe("MultiPolygon");
    expect(JSON.stringify(geometry.coordinates)).not.toBe(JSON.stringify(tileGeometry.coordinates));

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

describe("non-public fields", () => {
  it("refuses to query, filter, sort or aggregate by a non-public field", async () => {
    const source = await pairedSource(await served());
    for (const query of [
      { outFields: ["landvalue"] },
      { filter: queryFilter.eq("homeowner", "Y") },
      { orderBy: [{ field: "bldgvalue" }] },
    ]) {
      await expect(source.query(query)).rejects.toMatchObject({ code: "non-public-field" });
    }
    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "sum", field: "landvalue" }] } }),
    ).rejects.toMatchObject({ code: "non-public-field" });
  });

  it("never returns or exports a non-public column even when the artifact carries one", async () => {
    const leaked = await rewrittenParquet("*, 123456 AS landvalue, 'Y' AS homeowner", stamp);
    cleanups.push(leaked.cleanup);
    const source = await pairedSource(await served({ parquet: leaked.file }));
    const everything = await source.queryAll({ outFields: undefined });
    const lookup = await source.lookup(MERGED_MULTIPART_PARCEL);
    const csv = await source.exportFeatures("csv");
    const geojson = await source.exportFeatures("geojson");
    for (const name of NON_PUBLIC) {
      expect(everything.features.every((feature) => !(name in (feature.attributes as object)))).toBe(true);
      expect(Object.keys(lookup.result.features[0]?.attributes as object)).not.toContain(name);
      expect(csv.split("\r\n")[0]?.split(",")).not.toContain(name);
      expect(geojson).not.toContain(`"${name}"`);
    }
  });
});

describe("guard rails", () => {
  it("refuses raw where clauses and exposes no unrestricted adapter", async () => {
    const source = await pairedSource(await served());
    await expect(source.query({ where: "landvalue > 0" })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.exportFeatures("csv", { where: "1=1" })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(source.protocol("geoparquet")).toBeUndefined();
    expect(source.adapter("geoparquet")).toBeUndefined();
  });

  it("cancelling one lookup leaves a concurrent lookup running", async () => {
    const source = await pairedSource(await served({ delayMs: 100 }));
    const cancelled = new AbortController();
    const first = source.lookup(MERGED_MULTIPART_PARCEL, { signal: cancelled.signal });
    const second = source.lookup(LEADING_ZERO_PARCEL);
    cancelled.abort();
    await expect(first).rejects.toBeInstanceOf(HonuaAbortError);
    expect((await second).result.features[0]?.attributes).toMatchObject({ tmk_txt: LEADING_ZERO_PARCEL });
  });

  it("lets callers cancel export and planning while the engine is still starting", async () => {
    const runtime = new GeoparquetRuntime({ driverFactory: () => new Promise(() => undefined) });
    cleanups.push(() => runtime.dispose());
    const source = await fixtureSource(await served(), { runtime });
    const controller = new AbortController();
    const exported = source.exportFeatures("csv", { signal: controller.signal });
    const planned = source.planLookup(MERGED_MULTIPART_PARCEL, { signal: controller.signal });
    controller.abort();
    await Promise.all([
      expect(exported).rejects.toBeInstanceOf(HonuaAbortError),
      expect(planned).rejects.toBeInstanceOf(HonuaAbortError),
    ]);
  });

  it("rejects planning for an already-cancelled signal without leaving work unobserved", async () => {
    const source = await pairedSource(await served());
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await expect(source.planLookup(MERGED_MULTIPART_PARCEL, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        HonuaAbortError,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("keeps caller headers when opening a descriptor", async () => {
    const server = await served();
    const seen: Headers[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      seen.push(new Headers(init?.headers));
      return fetch(input, init);
    };
    await openPublication(`${server.origin}/maui/descriptor.json`, {
      fetch: recordingFetch,
      headers: new Headers({ authorization: "Bearer test-token" }),
    });
    expect(seen[0]?.get("authorization")).toBe("Bearer test-token");
    expect(seen[0]?.get("accept")).toBe("application/json");
  });
});

describe("artifact consistency", () => {
  it("rejects a GeoParquet artifact from another capture", async () => {
    const other = await rewrittenParquet("*", { ...stamp, captureId: "sha256:another-capture" });
    cleanups.push(other.cleanup);
    const source = await pairedSource(await served({ parquet: other.file }));
    await expect(source.lookup(MERGED_MULTIPART_PARCEL)).rejects.toMatchObject({ code: "artifact-mismatch" });
    await expect(source.query({})).rejects.toThrow(/does not carry capture/);
  });

  it("rejects a PMTiles artifact from another capture", async () => {
    const publication = await openFixture(await served());
    const description = {
      url: publication.display.pmtilesUrl,
      tileKind: "mvt" as const,
      bounds: [0, 0, 0, 0] as [number, number, number, number],
      minZoom: 10,
      maxZoom: 15,
      center: [0, 0, 10] as [number, number, number],
      vectorLayers: [],
      metadata: { "honua:publication": { ...stamp, captureId: "sha256:another-capture" } },
    };
    await expect(verifyPmtilesArtifact(publication, { preloadedDescription: description })).rejects.toMatchObject({
      code: "artifact-mismatch",
    });
  });
});
