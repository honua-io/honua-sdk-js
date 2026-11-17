import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import {
  HonuaPublicationError,
  exportFromCollection,
  openExport,
  publicationSource,
  verifyPmtilesArtifact,
} from "../src/export/index.js";
import { mauiExportCollection, serveExport } from "./helpers/export-fixture.js";
import { MERGED_MULTIPART_PARCEL, NON_PUBLIC_FIELDS, nodeDriver } from "./helpers/publication-fixture.js";

const PORTOLAN_EXAMPLE = JSON.parse(
  readFileSync(new URL("./fixtures/export/portolan-v0.3.0/vector-collection.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const THIRD_PARTY_URL = "https://data.example.org/andalusia/municipal-boundaries/collection.json";

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((entry) => entry.close()));
});

async function served(collection: Record<string, unknown>, options: { head?: boolean } = {}) {
  const host = await serveExport(collection, options);
  open.push(host);
  return host;
}

function invalidPath(document: unknown): string | undefined {
  try {
    exportFromCollection(document, THIRD_PARTY_URL);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(HonuaPublicationError);
    return (error as HonuaPublicationError).detail?.path as string;
  }
}

describe("a third-party Portolan collection", () => {
  it("opens for display and queries without the honua: extension", () => {
    const opened = exportFromCollection(PORTOLAN_EXAMPLE, THIRD_PARTY_URL);
    const base = "https://data.example.org/andalusia/municipal-boundaries/";

    expect(opened.renderPath).toBe("visual");
    expect(opened.display).toEqual({
      pmtilesUrl: `${base}municipal-boundaries.pmtiles`,
      sourceLayer: "municipal-boundaries",
      bounds: [-7.523, 35.938, -1.63, 38.729],
      attribution: "Instituto de Estadística y Cartografía de Andalucía",
    });
    expect(opened.publication).toBeUndefined();
    expect(opened.collection.data).toMatchObject({ url: `${base}municipal-boundaries.parquet`, bytes: 18874368 });
    expect(opened.collection.styles.map((style) => style.url)).toEqual([`${base}styles/default.json`]);
    expect(opened.collection.thumbnail?.url).toBe(`${base}thumbnail.png`);
    expect(opened.collection.fields.map((field) => [field.name, field.type, field.public])).toEqual([
      ["municipio_id", "string", true],
      ["nombre", "string", true],
      ["provincia", "string", true],
      ["superficie_km2", "number", true],
    ]);
    const { display, query } = opened.sourceDescriptors();
    expect(display).toMatchObject({ id: "municipal-boundaries-display", protocol: "pmtiles" });
    expect(query).toMatchObject({ protocol: "geoparquet", locator: { url: `${base}municipal-boundaries.parquet` } });
  });
});

describe("a third-party Portolan collection without a PMTiles visual or with errors", () => {
  it("draws the data asset when there is no PMTiles visual", () => {
    const { visual: _visual, ...assets } = PORTOLAN_EXAMPLE.assets as Record<string, unknown>;
    const links = (PORTOLAN_EXAMPLE.links as Array<{ rel: string }>).filter((link) => link.rel !== "pmtiles");
    const opened = exportFromCollection({ ...PORTOLAN_EXAMPLE, assets, links }, THIRD_PARTY_URL);
    expect(opened.renderPath).toBe("data");
    expect(opened.display).toBeUndefined();
    expect(opened.sourceDescriptors().display).toBeUndefined();
  });

  it("names the rule a malformed collection breaks", () => {
    const extensions = PORTOLAN_EXAMPLE.stac_extensions as string[];
    const assets = PORTOLAN_EXAMPLE.assets as Record<string, Record<string, unknown>>;
    expect(invalidPath({ ...PORTOLAN_EXAMPLE, type: "Feature" })).toBe("type");
    expect(invalidPath({ ...PORTOLAN_EXAMPLE, stac_extensions: extensions.slice(1) })).toBe("stac_extensions");
    expect(invalidPath({ ...PORTOLAN_EXAMPLE, assets: { visual: assets.visual } })).toBe("assets");
    expect(invalidPath({ ...PORTOLAN_EXAMPLE, extent: { spatial: { bbox: [[0, 50, 1, 40]] } } })).toBe(
      "extent.spatial.bbox[0]",
    );
    expect(invalidPath({ ...PORTOLAN_EXAMPLE, assets: { ...assets, data: { ...assets.data, "file:size": -1 } } })).toBe(
      "assets.data.file:size",
    );
    expect(invalidPath({ ...PORTOLAN_EXAMPLE, "honua:capture_id": "x" })).toBe("stac_extensions");
  });
});

describe("a Honua Export", () => {
  it("opens the paired view from one collection document, with identity and freshness", async () => {
    const host = await served(mauiExportCollection());
    const opened = await openExport(host.url);
    const publication = opened.publication!;

    expect(opened.renderPath).toBe("visual");
    expect(publication.id).toBe("maui-county-parcels-fixture");
    expect(publication.display).toMatchObject({
      pmtilesUrl: `${host.server.origin}/exports/maui/parcels.pmtiles`,
      sourceLayer: "parcels",
      promoteId: "tmk_txt",
    });
    expect(publication.freshness).toMatchObject({
      version: "20261113T062701Z",
      publishedAt: "2026-11-13T17:31:12.026Z",
    });
    expect(publication.publicFields.map((field) => field.name)).not.toContain("internal_note");
    await verifyPmtilesArtifact(publication);
  });
});

describe("Honua Export lookups", () => {
  it("answers an identity lookup from a host that refuses HEAD, reading only ranges", async () => {
    const host = await served(mauiExportCollection(), { head: false });
    const opened = await openExport(host.url);
    const source = publicationSource(opened.publication!, { driverFactory: nodeDriver });

    const { result, answeredBy } = await source.lookup(MERGED_MULTIPART_PARCEL);

    expect(answeredBy).toBe("geoparquet");
    expect(result.features[0]?.attributes).toMatchObject({ tmk_txt: MERGED_MULTIPART_PARCEL, plat: "030" });
    for (const name of NON_PUBLIC_FIELDS) expect(result.features[0]?.attributes).not.toHaveProperty(name);
    const parquetReads = host.server.requests.filter((entry) => entry.path === "/exports/maui/parcels.parquet");
    expect(parquetReads.length).toBeGreaterThan(0);
    expect(parquetReads.every((entry) => entry.method === "GET" && entry.status === 206)).toBe(true);
    expect(host.server.requests.some((entry) => entry.method === "HEAD")).toBe(false);
  });

  it("refuses a GeoParquet file from another capture", async () => {
    const host = await served(mauiExportCollection({ "honua:capture_id": "sha256:other-capture" }));
    const source = publicationSource((await openExport(host.url)).publication!, { driverFactory: nodeDriver });
    await expect(source.lookup(MERGED_MULTIPART_PARCEL)).rejects.toMatchObject({ code: "artifact-mismatch" });
  });
});

describe("Honua Export collection rules", () => {
  it("has no paired view when the data asset does not record its size", () => {
    const collection = mauiExportCollection();
    const assets = collection.assets as Record<string, Record<string, unknown>>;
    const { "file:size": _size, ...data } = assets.data!;
    const opened = exportFromCollection({ ...collection, assets: { ...assets, data } }, THIRD_PARTY_URL);
    expect(opened.publication).toBeUndefined();
    expect(opened.display?.promoteId).toBe("tmk_txt");
    expect(opened.sourceDescriptors().query).toBeUndefined();
  });

  it("rejects a honua: extension whose public fields leave out the identity", () => {
    expect(invalidPath(mauiExportCollection({ "honua:public_fields": ["zone"] }))).toBe("honua:public_fields");
    expect(invalidPath(mauiExportCollection({ "honua:geometry": { column: "geometry", encoding: "svg" } }))).toBe(
      "honua:geometry.encoding",
    );
  });
});
