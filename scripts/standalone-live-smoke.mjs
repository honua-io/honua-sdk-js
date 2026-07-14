// Live smoke for the standalone quickstart's public endpoints.
//
// This is the ONLY thing in the repo that hits the live third-party services,
// and it is wired into a scheduled (never PR) workflow so it can never block a
// pull request. It exercises the SDK's standalone lanes against the real
// endpoints — GeoServices (services.arcgis.com / sampleserver6) plus the
// backend-agnostic OGC API Features / WFS 2.0 / STAC targets that the raw-layout
// support in `src/core/ogc-endpoint-layout.ts`, `wfs.ts`, and `stac-static.ts`
// were built and fixture-recorded against: pygeoapi (demo.pygeoapi.io),
// ldproxy (demo.ldproxy.net), a GeoServer instance (ahocevar.com/geoserver),
// and Earth Search STAC (earth-search.aws.element84.com). A loud PASS/FAIL
// table is written to the workflow summary; a real regression turns the run red.
//
//   node scripts/standalone-live-smoke.mjs
//
// Keep this endpoint list in sync with docs/standalone-quickstart.md,
// docs/standalone-capability-matrix.md, and the recorded fixtures under
// test/fixtures/backend-agnostic/.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateEvidenceEnvelope } from "./sample-contract.mjs";

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
    label: "pygeoapi demo — OGC API Features landing (layout discovery)",
    url: "https://demo.pygeoapi.io/master?f=json",
    // The backend-agnostic layout resolver reads the `data` / `conformance`
    // links from here; assert they are present so discovery stays valid.
    expect: (body) =>
      Array.isArray(body?.links) &&
      body.links.some((l) => l?.rel === "data") &&
      body.links.some((l) => l?.rel === "conformance"),
  },
  {
    label: "pygeoapi demo — OGC API Features collections",
    url: "https://demo.pygeoapi.io/master/collections?f=json",
    expect: (body) => Array.isArray(body?.collections),
  },
  {
    label: "pygeoapi demo — OGC API Features items (discovered path)",
    url: "https://demo.pygeoapi.io/master/collections/lakes/items?f=json&limit=1",
    expect: (body) => body?.type === "FeatureCollection" && Array.isArray(body?.features),
  },
  {
    label: "ldproxy demo — OGC API Features landing (layout discovery)",
    url: "https://demo.ldproxy.net/vineyards?f=json",
    expect: (body) => Array.isArray(body?.links) && body.links.some((l) => l?.rel === "data"),
  },
  {
    label: "ldproxy demo — OGC API Features items (discovered path)",
    url: "https://demo.ldproxy.net/vineyards/collections/vineyards/items?f=json&limit=1",
    expect: (body) => body?.type === "FeatureCollection" && Array.isArray(body?.features),
  },
  {
    label: "GeoServer demo — WFS 2.0 GetCapabilities (DCP operation URLs)",
    url: "https://ahocevar.com/geoserver/ows?service=wfs&version=2.0.0&request=GetCapabilities",
    accept: "application/xml, text/xml",
    // Raw XML: assert it is a WFS_Capabilities document that advertises an
    // operation DCP href (the URL the SDK actually posts GetFeature to).
    expectText: (text) => /WFS_Capabilities/.test(text) && /xlink:href=/.test(text),
  },
  {
    label: "GeoServer demo — WFS 2.0 GetFeature (GeoJSON)",
    url: "https://ahocevar.com/geoserver/ows?service=WFS&version=2.0.0&request=GetFeature&typeNames=ne:ne_10m_admin_0_countries&count=1&outputFormat=application/json",
    expect: (body) => body?.type === "FeatureCollection" && Array.isArray(body?.features),
  },
  {
    label: "Earth Search STAC API — landing (conformsTo)",
    url: "https://earth-search.aws.element84.com/v1",
    expect: (body) => Array.isArray(body?.conformsTo) && Array.isArray(body?.links),
  },
  {
    label: "Earth Search STAC API — item search",
    url: "https://earth-search.aws.element84.com/v1/search?collections=sentinel-2-l2a&limit=1",
    expect: (body) => body?.type === "FeatureCollection" && Array.isArray(body?.features),
  },
];

async function probe(endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      headers: { accept: endpoint.accept ?? "application/json" },
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    if (!response.ok) {
      return { ok: false, ms, detail: `HTTP ${response.status}` };
    }
    // Text-shape endpoints (WFS GetCapabilities XML) assert on the raw body.
    if (endpoint.expectText) {
      const text = await response.text();
      if (!endpoint.expectText(text)) {
        return { ok: false, ms, detail: "response text check failed" };
      }
      return { ok: true, ms, detail: "ok" };
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
  const observedAt = new Date().toISOString();
  const rows = [];
  let failures = 0;
  let totalMs = 0;
  for (const endpoint of ENDPOINTS) {
    const result = await probe(endpoint);
    totalMs += result.ms;
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

  const evidenceOutput = process.env.HONUA_SAMPLE_LIVE_OUTPUT;
  if (evidenceOutput) {
    if (process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID !== "standalone-quickstart") {
      throw new Error(`Standalone live smoke cannot satisfy ${process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID ?? "an unnamed sample"}`);
    }
    let revision = process.env.HONUA_SAMPLE_SOURCE_REVISION;
    if (!/^[a-f0-9]{40}$/.test(revision ?? "")) {
      revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    }
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const producerPath = "scripts/standalone-live-smoke.mjs";
    const producerBytes = fs.readFileSync(fileURLToPath(import.meta.url));
    const evidence = validateEvidenceEnvelope({
      format: "honua.sdk.sample-evidence.v1",
      schemaVersion: 1,
      sampleId: "standalone-quickstart",
      lane: "live",
      status: failures === 0 ? "executed" : "failed",
      reason: failures === 0 ? null : `${failures} documented public endpoint probe(s) failed`,
      observedAt,
      authMode: "anonymous",
      sdk: { package: packageJson.name, version: packageJson.version, gitCommit: revision },
      source: {
        provider: "documented-public-endpoints",
        identity: "standalone-live-smoke",
        endpoint: "https://services.arcgis.com/",
        deploymentVersion: null,
        dataVersion: null,
      },
      provenance:
        failures === 0
          ? {
              sourceId: "standalone-live-smoke",
              observedAt,
              validAt: null,
              state: "live",
              attribution: "Public endpoint providers listed by the standalone quickstart.",
            }
          : null,
      semantics: {
        operation: "standalone-public-endpoint-probe",
        outcome: failures === 0 ? "all-documented-endpoints-responded" : null,
        itemCount: failures === 0 ? ENDPOINTS.length : null,
        assertions: failures === 0 ? ["all-response-shapes-matched", "no-server-required"] : [],
      },
      timing: {
        totalMs,
        firstSuccessfulInteractionMs: failures < ENDPOINTS.length ? totalMs / ENDPOINTS.length : null,
      },
      degradation: {
        state: failures === 0 ? "none" : "unexpected",
        reasons: failures === 0 ? [] : ["public-endpoint-probe-failed"],
      },
      artifacts: [
        {
          kind: "producer-generator",
          path: producerPath,
          sha256: createHash("sha256").update(producerBytes).digest("hex"),
        },
      ],
    });
    fs.mkdirSync(path.dirname(evidenceOutput), { recursive: true });
    fs.writeFileSync(evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`Live smoke crashed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
