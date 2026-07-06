#!/usr/bin/env node
// Re-records the platform-free (standalone) fixtures from a live PUBLIC
// FeatureServer, then regenerates the committed `src/certification/census-data.ts`
// source module the offline standalone certification + eval replay against.
//
// CI never runs this and never touches the network — the committed data module
// is what the fixture client replays. Run it by hand to refresh the recording
// when the upstream schema changes:
//
//   node mcp/scripts/record-census-fixtures.mjs
//
// The recorder hits a public Esri Living Atlas GeoServices FeatureServer
// (services.arcgis.com) — anonymous, read-only, US Census (public-domain) data.
// It records the raw upstream GeoServices JSON under test/fixtures/arcgis-census/
// (audit trail) AND rewrites the typed data module used by the in-process fixture
// client. See mcp/README.md ("Platform-free mode") for the endpoint + licensing.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(mcpRoot, "test", "fixtures", "arcgis-census");
const dataModule = path.join(mcpRoot, "src", "certification", "census-data.ts");

const ENDPOINT =
  process.env.STANDALONE_FEATURE_LAYER_URL ??
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
const SERVICE_ID = "2020_Census_State_Apportionment";
const OUT_FIELDS = "OBJECTID,NAME,STUSPS,Total_Pop_2020,Seats_2020";
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const body = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      throw new Error(`GeoServices error for ${url}: ${JSON.stringify(body.error)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const query = (params) =>
  fetchJson(`${ENDPOINT}/query?${new URLSearchParams({ f: "json", ...params }).toString()}`);

async function writeRaw(name, value) {
  await fs.writeFile(path.join(fixtureDir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  await fs.mkdir(fixtureDir, { recursive: true });
  process.stdout.write(`Recording platform-free fixtures from ${ENDPOINT}\n`);

  const layerMetadata = await fetchJson(`${ENDPOINT}?f=json`);
  const serviceMetadata = await fetchJson(`${ENDPOINT.replace(/\/\d+$/, "")}?f=json`);
  const all = await query({
    where: "1=1",
    outFields: OUT_FIELDS,
    returnGeometry: "false",
    orderByFields: "NAME ASC",
    resultRecordCount: "100",
  });
  all.exceededTransferLimit = false;
  const extent = await query({ where: "1=1", returnExtentOnly: "true" });

  // Parity fixtures: the in-process evaluator is asserted against these live
  // recordings in test/certification/census-fixture-client.test.ts.
  const countAll = await query({ where: "1=1", returnCountOnly: "true" });
  const countBigStates = await query({ where: "Seats_2020>=20", returnCountOnly: "true" });
  const sumPop = await query({
    where: "1=1",
    returnGeometry: "false",
    outStatistics: JSON.stringify([
      { statisticType: "sum", onStatisticField: "Total_Pop_2020", outStatisticFieldName: "sum_Total_Pop_2020" },
    ]),
  });

  await writeRaw("layer-metadata.json", layerMetadata);
  await writeRaw("service-metadata.json", serviceMetadata);
  await writeRaw("features-all.json", all);
  await writeRaw("extent.json", extent);
  await writeRaw("count.json", countAll);
  await writeRaw("count-seats-ge-20.json", countBigStates);
  await writeRaw("stat-sum-pop.json", sumPop);

  const rows = all.features.map((f) => ({
    OBJECTID: f.attributes.OBJECTID,
    NAME: f.attributes.NAME,
    STUSPS: f.attributes.STUSPS,
    Total_Pop_2020: f.attributes.Total_Pop_2020,
    Seats_2020: f.attributes.Seats_2020,
  }));
  const fields = (layerMetadata.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    alias: f.alias ?? f.name,
  }));

  const banner = `// AUTO-RECORDED FIXTURE DATA — do not hand-edit.
//
// Recorded from the public Esri Living Atlas FeatureServer (services.arcgis.com):
//   ${ENDPOINT}
// US Census 2020 apportionment (public-domain data), publicly shared by Esri —
// anonymous, read-only. Re-record with mcp/scripts/record-census-fixtures.mjs.
//
// This is the platform-free proof corpus: 52 rows (50 states + DC + Puerto Rico),
// used to certify and eval @honua/mcp-server against a plain public FeatureServer
// with ZERO Honua-server surfaces. Known aggregate anchors (verified live):
//   rows=52  sum(pop)=335085841  sum(seats)=435  max(pop)=California(39576757)
//   min(pop)=Wyoming(577719)  seats>=20 => 4 states (CA,TX,FL,NY).
`;

  const module = `${banner}
export interface CensusRow {
  OBJECTID: number;
  NAME: string;
  STUSPS: string;
  Total_Pop_2020: number | null;
  // District of Columbia and Puerto Rico carry no apportioned seats (null),
  // exactly as the upstream layer records them.
  Seats_2020: number | null;
}

/** The public FeatureServer this fixture was recorded from. */
export const CENSUS_ENDPOINT =
  "${ENDPOINT}";

/** Service id (as it appears under /rest/services) for the recorded service. */
export const CENSUS_SERVICE_ID = "${SERVICE_ID}";

/** Human layer name as advertised by the live layer metadata. */
export const CENSUS_LAYER_NAME = ${JSON.stringify(layerMetadata.name)};

/** Recorded layer extent (Web Mercator, wkid 102100). */
export const CENSUS_EXTENT = ${JSON.stringify(extent.extent)} as const;

/** Recorded field list for layer 0 (all ${fields.length} fields, verbatim). */
export const CENSUS_FIELDS: ReadonlyArray<{ name: string; type: string; alias: string }> = ${JSON.stringify(fields, null, 2)};

/** All ${rows.length} recorded rows (attribute-only; geometry omitted to keep the fixture small). */
export const CENSUS_ROWS: ReadonlyArray<CensusRow> = ${JSON.stringify(rows, null, 2)};
`;

  await fs.writeFile(dataModule, module, "utf8");
  process.stdout.write(`Done. Recorded ${rows.length} rows -> src/certification/census-data.ts\n`);
}

main().catch((error) => {
  process.stderr.write(`Fixture recording failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
