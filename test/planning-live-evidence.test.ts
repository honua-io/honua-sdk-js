import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  PLANNING_LIVE_PRODUCER_ARTIFACT,
  createPlanningBoundedFetch,
  isPlanningLiveEvidenceEnabled,
  runPlanningLiveEvidence,
} from "../scripts/planning-live-evidence.mjs";
import { validateEvidenceEnvelope } from "../scripts/sample-contract.mjs";
import { nominatimGeocodingProvider } from "../src/geocoding/index.js";
import { HonuaClient } from "../src/honua.js";

const SOURCE_REVISION = "a".repeat(40);
const OBSERVED_AT = "2026-07-17T17:00:00.000Z";
const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org/search?q=Honolulu+Hale%2C+Honolulu&limit=1&countrycodes=us&format=jsonv2";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function successfulPublicFetch() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("manual");
    if (url.origin === "https://nominatim.openstreetmap.org") {
      return jsonResponse([
        {
          place_id: 379206388,
          osm_type: "way",
          osm_id: 61956010,
          lat: "21.3052679",
          lon: "-157.8570082",
          display_name: "Honolulu Hale, Honolulu, Hawaii, United States",
          importance: 0.319,
        },
      ]);
    }
    if (url.pathname.endsWith("/MapServer/3")) {
      return jsonResponse({
        currentVersion: 11.5,
        name: "County Zoning - City and County of Honolulu",
        type: "Feature Layer",
        capabilities: "Map,Query,Data",
        copyrightText: "City and County of Honolulu; Hawaii Statewide GIS Program",
        fields: ["objectid", "zone_class", "zoning_des", "zoning_lab", "loaddate"].map((name) => ({
          name,
          type: name === "objectid" ? "esriFieldTypeOID" : "esriFieldTypeString",
        })),
      });
    }
    if (url.pathname.endsWith("/MapServer/3/query")) {
      return jsonResponse({
        displayFieldName: "ZONE_CLASS",
        fields: [],
        features: [
          {
            attributes: {
              objectid: 1676,
              zone_class: "B-2",
              zoning_des: "B-2 Community Business District",
              zoning_lab: "B-2",
              loaddate: 1694772000000,
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected test URL: ${url.href}`);
  });
}

describe("planning and permitting public-live evidence", () => {
  it("accepts only the explicit scheduled or sample-runner network gate", () => {
    expect(isPlanningLiveEvidenceEnabled({})).toBe(false);
    expect(isPlanningLiveEvidenceEnabled({ HONUA_PLANNING_LIVE_ENABLED: "true" })).toBe(true);
    expect(isPlanningLiveEvidenceEnabled({ HONUA_SAMPLE_LIVE_ENABLED: "1" })).toBe(true);
  });

  it("is opt-in and returns a valid skipped envelope without loading the SDK or network", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const evidence = await runPlanningLiveEvidence({
      enabled: false,
      fetchFn,
      observedAt: OBSERVED_AT,
      sourceRevision: SOURCE_REVISION,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      sampleId: "planning-permitting-workbench",
      lane: "live",
      status: "skipped",
      degradation: { state: "unavailable", reasons: ["live-network-gate-disabled"] },
    });
    expect(validateEvidenceEnvelope(evidence, { now: OBSERVED_AT })).toBe(evidence);
  });

  it("uses public SDK geocoding and GeoServices reads with bounded, explicit partial truth", async () => {
    const fetchFn = successfulPublicFetch();
    const evidence = await runPlanningLiveEvidence({
      enabled: true,
      fetchFn,
      observedAt: OBSERVED_AT,
      sourceRevision: SOURCE_REVISION,
      sdk: { HonuaClient, nominatimGeocodingProvider, mode: "source" },
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(evidence).toMatchObject({
      sampleId: "planning-permitting-workbench",
      status: "executed",
      authMode: "anonymous",
      sdk: { gitCommit: SOURCE_REVISION },
      source: {
        endpoint: "https://geodata.hawaii.gov/arcgis/rest/services/ParcelsZoning/MapServer/3",
        deploymentVersion: "11.5",
      },
      semantics: {
        operation: "public-address-to-zoning-read-check",
        outcome: "address-resolved-and-bounded-zoning-context-returned",
        itemCount: 1,
      },
      degradation: {
        state: "expected",
        reasons: expect.arrayContaining(["edit-attachment-conflict-and-rollback-remain-fixture-only"]),
      },
    });
    expect(evidence.semantics.assertions).toEqual(
      expect.arrayContaining([
        "observed-requests=3/3",
        "credentials-sent=false",
        "redirects-followed=0",
        "sdk-mode=source",
        "edits-attachments-conflicts-not-executed",
      ]),
    );
    expect(JSON.stringify(evidence)).not.toMatch(/Bearer\s|[?&](?:token|key|signature)=/iu);
    expect(validateEvidenceEnvelope(evidence, { now: OBSERVED_AT })).toBe(evidence);
  });

  it("content-binds the only live producer generator", async () => {
    const bytes = await readFile(PLANNING_LIVE_PRODUCER_ARTIFACT.path);
    expect(PLANNING_LIVE_PRODUCER_ARTIFACT).toEqual({
      kind: "producer-generator",
      path: "scripts/planning-live-evidence.mjs",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it("rejects unreviewed hosts, credential material, writes, and redirects before replay", async () => {
    const upstream = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const transport = createPlanningBoundedFetch({ fetchFn: upstream });

    await expect(transport.fetch("https://example.com/search")).rejects.toThrow("unreviewed public host");
    await expect(transport.fetch(`${NOMINATIM_URL}&token=not-a-real-value`)).rejects.toThrow(
      "credential-bearing query",
    );
    await expect(transport.fetch(NOMINATIM_URL, { method: "POST" })).rejects.toThrow("read-only GET");
    await expect(
      transport.fetch(NOMINATIM_URL, { headers: { Authorization: "credential-placeholder" } }),
    ).rejects.toThrow("credential header");
    expect(upstream).not.toHaveBeenCalled();

    const redirecting = createPlanningBoundedFetch({
      fetchFn: vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location: "https://example.com/" } }),
      ),
    });
    await expect(redirecting.fetch(NOMINATIM_URL)).rejects.toThrow("refuses all redirects");
  });

  it("cancels decoded responses at the byte ceiling and enforces aggregate request count", async () => {
    const cancel = vi.fn();
    const oversized = createPlanningBoundedFetch({
      limits: { maxRequests: 1, maxResponseBytes: 4, maxTotalBytes: 8, requestTimeoutMs: 100 },
      fetchFn: vi.fn<typeof fetch>(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(5));
              },
              cancel,
            }),
            { status: 200 },
          ),
      ),
    });
    await expect(oversized.fetch(NOMINATIM_URL)).rejects.toThrow("4-byte ceiling");
    expect(cancel).toHaveBeenCalledTimes(1);

    const oneRequest = createPlanningBoundedFetch({
      limits: { maxRequests: 1, maxResponseBytes: 32, maxTotalBytes: 32, requestTimeoutMs: 100 },
      fetchFn: vi.fn<typeof fetch>(async () => jsonResponse({ ok: true })),
    });
    await oneRequest.fetch(NOMINATIM_URL);
    await expect(oneRequest.fetch(NOMINATIM_URL)).rejects.toThrow("1-request ceiling");
  });

  it("aborts a stalled response within the per-request deadline", async () => {
    const stalled = createPlanningBoundedFetch({
      limits: { maxRequests: 1, maxResponseBytes: 32, maxTotalBytes: 32, requestTimeoutMs: 5 },
      fetchFn: vi.fn<typeof fetch>(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      ),
    });

    await expect(stalled.fetch(NOMINATIM_URL)).rejects.toThrow("exceeded 5 ms");
  });
});
