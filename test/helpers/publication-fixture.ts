import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";

import { createNodeDuckDbDriver } from "../../src/geoparquet/node.js";
import {
  type Publication,
  type PublicationSourceOptions,
  openPublication,
  publicationSource,
} from "../../src/publication/index.js";
import { startStaticRangeServer } from "./static-range-server.mjs";

export const FIXTURE_DIRECTORY = fileURLToPath(new URL("../fixtures/publication/maui-parcels/", import.meta.url));
export const MERGED_MULTIPART_PARCEL = "234030888";
export const LEADING_ZERO_PARCEL = "233001001";

export type RangeServer = Awaited<ReturnType<typeof startStaticRangeServer>>;

export interface FixtureOverrides {
  readonly parquet?: string;
  readonly descriptor?: string;
  readonly delayMs?: number;
}

export async function serveFixture(overrides: FixtureOverrides = {}): Promise<RangeServer> {
  return startStaticRangeServer({
    files: {
      "/maui/descriptor.json": overrides.descriptor ?? path.join(FIXTURE_DIRECTORY, "descriptor.json"),
      "/maui/parcels.parquet": overrides.parquet ?? path.join(FIXTURE_DIRECTORY, "parcels.parquet"),
      "/maui/parcels.pmtiles": path.join(FIXTURE_DIRECTORY, "parcels.pmtiles"),
    },
    ...(overrides.delayMs ? { delayMs: overrides.delayMs } : {}),
  });
}

export const nodeDriver = () => createNodeDuckDbDriver({ loadSpatial: false });

export async function openFixture(server: RangeServer): Promise<Publication> {
  return openPublication(`${server.origin}/maui/descriptor.json`);
}

export async function fixtureSource(server: RangeServer, options: PublicationSourceOptions = {}) {
  const publication = await openFixture(server);
  return publicationSource(publication, { driverFactory: nodeDriver, ...options });
}

export function parquetRequests(server: RangeServer) {
  return server.requests.filter((entry) => entry.path === "/maui/parcels.parquet");
}

/** Rewrite the fixture GeoParquet with `select` and a replacement publication stamp, into a temp file. */
export async function rewrittenParquet(
  select: string,
  stamp: Record<string, unknown>,
): Promise<{ file: string; cleanup(): void }> {
  const directory = mkdtempSync(path.join(tmpdir(), "honua-publication-"));
  const file = path.join(directory, "parcels.parquet");
  const source = path.join(FIXTURE_DIRECTORY, "parcels.parquet").replaceAll("'", "''");
  const geo = (await readKeyValue(source, "geo")).replaceAll("'", "''");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT ${select} FROM read_parquet('${source}')) TO '${file.replaceAll("'", "''")}'
       (FORMAT parquet, KV_METADATA {geo: '${geo}', 'honua:publication': '${JSON.stringify(stamp).replaceAll("'", "''")}'})`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return { file, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function readKeyValue(file: string, key: string): Promise<string> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(
      `SELECT decode(value) AS value FROM parquet_kv_metadata('${file}') WHERE decode(key) = '${key}'`,
    );
    return String(reader.getRowObjects()[0]?.value);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** The geometry stored for `identity` in the committed GeoParquet fixture, read without the SDK. */
export async function storedGeometry(identity: string): Promise<Array<Array<Array<{ x: number; y: number }>>>> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const file = path.join(FIXTURE_DIRECTORY, "parcels.parquet").replaceAll("'", "''");
    const reader = await connection.runAndReadAll(
      `SELECT to_json(geometry)::VARCHAR AS geometry FROM read_parquet('${file}') WHERE tmk_txt = '${identity}'`,
    );
    return JSON.parse(String(reader.getRowObjects()[0]?.geometry));
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
