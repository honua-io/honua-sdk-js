// Re-records the standalone-quickstart fixtures from the live PUBLIC endpoints.
//
// CI never runs this and never touches the network — the committed fixtures in
// `test/fixtures/standalone-quickstart-demo/` are what the mock server replays.
// Run it by hand to refresh those recordings when an upstream schema changes:
//
//   node examples/standalone-quickstart/refresh-fixtures.mjs
//   # or, from the repo root:
//   npm run demo:standalone:refresh-fixtures
//
// The recorder hits Esri's public sample/Living-Atlas GeoServices endpoints
// (see `examples/standalone-quickstart/README.md` for the endpoint list and
// licensing note). It records the raw upstream GeoServices JSON — the SDK's own
// query path is then exercised end-to-end against the recording by the mock
// server and the Playwright smoke.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const fixtureRoot = path.resolve(projectRoot, "test", "fixtures", "standalone-quickstart-demo");

// The pinned public FeatureServer layer. Esri Living Atlas, hosted on
// services.arcgis.com — public, anonymous, read-only. Census apportionment is
// US Census (public domain) data.
const LIVE_FEATURE_LAYER_URL =
  process.env.STANDALONE_FEATURE_LAYER_URL ??
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";

// A compact, deterministic slice: a handful of states with simplified geometry
// so the committed fixture stays small but still renders as recognisable
// polygons on MapLibre.
const FIXTURE_WHERE = "STUSPS IN ('HI','CA','TX','NY','FL','WA')";
const FIXTURE_OUT_FIELDS = "OBJECTID,NAME,STUSPS,Total_Pop_2020,Seats_2020";
const REQUEST_TIMEOUT_MS = 30_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
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

async function writeFixture(name, value) {
  const target = path.join(fixtureRoot, name);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  const { size } = await fs.stat(target);
  process.stdout.write(`  wrote ${name} (${(size / 1024).toFixed(1)} KiB)\n`);
}

async function main() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  process.stdout.write(`Recording standalone-quickstart fixtures from ${LIVE_FEATURE_LAYER_URL}\n`);

  const metadataUrl = `${LIVE_FEATURE_LAYER_URL}?f=json`;
  const metadata = await fetchJson(metadataUrl);
  await writeFixture("geoservices-layer-metadata.json", metadata);

  const queryParams = new URLSearchParams({
    where: FIXTURE_WHERE,
    outFields: FIXTURE_OUT_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    maxAllowableOffset: "0.2",
    geometryPrecision: "4",
    f: "json",
  });
  const query = await fetchJson(`${LIVE_FEATURE_LAYER_URL}/query?${queryParams.toString()}`);

  // The mock replays this one page for every `/query` call. Force
  // `exceededTransferLimit` off so the SDK's `queryFeaturesAll` pagination
  // halts after the first (only) page instead of looping.
  query.exceededTransferLimit = false;
  const featureCount = Array.isArray(query.features) ? query.features.length : 0;
  await writeFixture("geoservices-query.json", query);

  const provenance = {
    recordedAt: new Date().toISOString(),
    endpoint: LIVE_FEATURE_LAYER_URL,
    where: FIXTURE_WHERE,
    outFields: FIXTURE_OUT_FIELDS,
    featureCount,
    refreshCommand: "npm run demo:standalone:refresh-fixtures",
    note: "Public Esri Living Atlas FeatureServer (services.arcgis.com); US Census (public domain) data. Recorded raw GeoServices JSON; CI replays these files and never hits the network.",
  };
  await writeFixture("fixture-metadata.json", provenance);

  process.stdout.write(`Done. Recorded ${featureCount} features.\n`);
}

main().catch((error) => {
  process.stderr.write(`Fixture refresh failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
