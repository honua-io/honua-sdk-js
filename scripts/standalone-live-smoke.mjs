// Live smoke for the standalone quickstart's public endpoints.
//
// This is the ONLY thing in the repo that hits the live third-party services,
// and it is wired into a scheduled (never PR) workflow so it can never block a
// pull request. It exercises the SDK's GeoServices request paths (layer
// metadata + `/query`) against the real endpoints and link-checks the full
// documented endpoint list, writing a loud PASS/FAIL table to the workflow
// summary. A real regression turns the scheduled run red.
//
//   node scripts/standalone-live-smoke.mjs
//
// Keep this endpoint list in sync with docs/standalone-quickstart.md and
// docs/standalone-capability-matrix.md.

import fs from "node:fs";

const TIMEOUT_MS = 30_000;

// The documented public endpoints. `probe` describes how we exercise each one.
const ENDPOINTS = [
  {
    label: "Esri Living Atlas FeatureServer (services.arcgis.com) — layer metadata",
    url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0?f=json",
    expect: (body) => typeof body?.name === "string" && Array.isArray(body?.fields),
  },
  {
    label: "Esri Living Atlas FeatureServer (services.arcgis.com) — SDK query path",
    url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0/query?where=1%3D1&outFields=NAME&returnGeometry=false&resultRecordCount=1&f=json",
    expect: (body) => Array.isArray(body?.features) && body.features.length > 0,
  },
  {
    label: "Esri sample server MapServer (sampleserver6) — SDK query path",
    url: "https://sampleserver6.arcgisonline.com/arcgis/rest/services/SampleWorldCities/MapServer/0/query?where=1%3D1&outFields=CITY_NAME&returnGeometry=false&resultRecordCount=1&f=json",
    expect: (body) => Array.isArray(body?.features) && body.features.length > 0,
  },
  {
    label: "pygeoapi demo — OGC API Features collections",
    url: "https://demo.pygeoapi.io/master/collections?f=json",
    expect: (body) => Array.isArray(body?.collections),
  },
  {
    label: "pygeoapi demo — OGC API Features items",
    url: "https://demo.pygeoapi.io/master/collections/lakes/items?f=json&limit=1",
    expect: (body) => body?.type === "FeatureCollection" && Array.isArray(body?.features),
  },
];

async function probe(endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      return { ok: false, ms, detail: `HTTP ${response.status}` };
    }
    const body = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      return { ok: false, ms, detail: `service error: ${JSON.stringify(body.error).slice(0, 120)}` };
    }
    if (!endpoint.expect(body)) {
      return { ok: false, ms, detail: "response shape check failed" };
    }
    return { ok: true, ms, detail: "ok" };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, detail: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const rows = [];
  let failures = 0;
  for (const endpoint of ENDPOINTS) {
    const result = await probe(endpoint);
    if (!result.ok) {
      failures += 1;
    }
    const status = result.ok ? "✅ PASS" : "❌ FAIL";
    rows.push(`| ${status} | ${endpoint.label} | ${result.ms} ms | ${result.detail} |`);
    process.stdout.write(`${status}  ${endpoint.label}  (${result.ms} ms)  ${result.detail}\n`);
  }

  const summary = [
    "## Standalone live-endpoint smoke",
    "",
    `Checked ${ENDPOINTS.length} public endpoint(s); ${failures} failure(s).`,
    "",
    "| Result | Endpoint | Latency | Detail |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    failures === 0
      ? "All documented public endpoints responded and matched the expected shape."
      : "One or more public endpoints failed. This does NOT block PRs — investigate the upstream service or refresh the documented endpoint list.",
    "",
  ].join("\n");

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${summary}\n`);
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`Live smoke crashed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
