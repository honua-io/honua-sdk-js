import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HONUA_STAC_EXTENSION, PORTOLAN_SCHEMA } from "../../src/export/index.js";
import { FIXTURE_DESCRIPTOR, FIXTURE_DIRECTORY } from "./publication-fixture.js";
import { startStaticRangeServer } from "./static-range-server.mjs";

const TABLE_TYPES: Record<string, string> = { string: "string", integer: "int64", number: "double" };
const STAC_EXTENSIONS = [
  "https://stac-extensions.github.io/web-map-links/v1.3.0/schema.json",
  "https://stac-extensions.github.io/file/v2.1.0/schema.json",
  "https://stac-extensions.github.io/table/v1.2.0/schema.json",
  "https://stac-extensions.github.io/version/v1.2.0/schema.json",
];

type Descriptor = typeof FIXTURE_DESCRIPTOR;

function honuaExtension(d: Descriptor): Record<string, unknown> {
  return {
    "honua:capture_id": d.capture.captureId,
    "honua:captured_at": d.capture.capturedAt,
    "honua:source_revision": d.capture.sourceRevision,
    "honua:identity": {
      field: d.identity.field,
      pmtiles_property: d.identity.pmtilesProperty,
      geoparquet_column: d.identity.geoparquetColumn,
    },
    "honua:geometry": { column: d.geometry.column, encoding: d.geometry.encoding, bbox_column: d.geometry.bboxColumn },
    "honua:public_fields": d.artifacts.geoparquet.fields,
  };
}

function tableColumns(d: Descriptor): Array<Record<string, string>> {
  return [
    ...d.fields.map((field: { name: string; type: string }) => ({
      name: field.name,
      type: TABLE_TYPES[field.type] ?? field.type,
    })),
    { name: d.geometry.column, type: "binary" },
    { name: "internal_note", type: "string" },
  ];
}

function fileAsset(href: string, type: string, role: string): Record<string, unknown> {
  const bytes = statSync(path.join(FIXTURE_DIRECTORY, href.slice(2))).size;
  return { href, type, roles: [role], "file:size": bytes };
}

function exportLinks(d: Descriptor): Array<Record<string, unknown>> {
  return [
    { rel: "root", href: "../catalog.json", type: "application/json" },
    { rel: "parent", href: "../catalog.json", type: "application/json" },
    {
      rel: "pmtiles",
      href: "./parcels.pmtiles",
      type: "application/vnd.pmtiles",
      "pmtiles:layers": [d.artifacts.pmtiles.vectorLayer],
    },
  ];
}

/** The Maui pair fixture described as a Honua Export: one Portolan collection with the honua: extension. */
export function mauiExportCollection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const d = FIXTURE_DESCRIPTOR;
  return {
    type: "Collection",
    stac_version: "1.1.0",
    stac_extensions: [...STAC_EXTENSIONS, PORTOLAN_SCHEMA, HONUA_STAC_EXTENSION],
    id: d.publicationId,
    title: d.title,
    description: "Maui County parcels exported as GeoParquet and PMTiles (test fixture subset).",
    license: "CC-BY-4.0",
    version: d.version,
    updated: d.publishedAt,
    providers: [
      { name: "County of Maui", roles: ["producer", "licensor"] },
      { name: "Honua", roles: ["host"], url: "https://honua.io" },
    ],
    extent: { spatial: { bbox: [d.bounds] }, temporal: { interval: [[d.capture.capturedAt, null]] } },
    "table:columns": tableColumns(d),
    ...honuaExtension(d),
    assets: {
      data: fileAsset("./parcels.parquet", "application/vnd.apache.parquet", "data"),
      visual: fileAsset("./parcels.pmtiles", "application/vnd.pmtiles", "visual"),
      thumbnail: { href: "./thumbnail.png", type: "image/png", roles: ["thumbnail"] },
    },
    links: exportLinks(d),
    ...overrides,
  };
}

/** Serve the Maui pair beside a collection document; `head: false` makes the host refuse HEAD. */
export async function serveExport(collection: Record<string, unknown>, options: { head?: boolean } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "honua-export-"));
  const file = path.join(directory, "collection.json");
  writeFileSync(file, JSON.stringify(collection));
  const server = await startStaticRangeServer({
    files: {
      "/exports/maui/collection.json": file,
      "/exports/maui/parcels.parquet": path.join(FIXTURE_DIRECTORY, "parcels.parquet"),
      "/exports/maui/parcels.pmtiles": path.join(FIXTURE_DIRECTORY, "parcels.pmtiles"),
    },
    ...(options.head === false ? { head: false } : {}),
  });
  return {
    server,
    url: `${server.origin}/exports/maui/collection.json`,
    async close() {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
