import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  isPmtilesLiveEvidenceEnabled,
  resolvePmtilesArchive,
  runPmtilesLiveEvidence,
} from "../scripts/pmtiles-live-evidence.mjs";

const MANIFEST_URL = "https://demo.honua.io/demo-services.v1.json";
const ARCHIVE_URL = "https://demo.honua.io/api/v1/tiles/pmtiles/maui-basemap";

function manifest(path = "/api/v1/tiles/pmtiles/maui-basemap") {
  return {
    format: "honua.demo-services.v1",
    schemaVersion: "1.1.0",
    baseUrl: "https://demo.honua.io",
    publishUrl: MANIFEST_URL,
    services: [{ id: "maui-basemap", protocols: { pmtiles: { archiveId: "maui-basemap", path } } }],
  };
}

function fixtureAsset() {
  const fixture = new Uint8Array(fs.readFileSync(new URL("./fixtures/pmtiles/sample-vector.pmtiles", import.meta.url)));
  const asset = new Uint8Array(64 * 1024);
  asset.set(fixture.slice(0, 152), 0);
  asset.set(fixture.slice(152, 352), 20_000);
  const view = new DataView(asset.buffer);
  view.setBigUint64(24, 20_000n, true);
  view.setBigUint64(32, 200n, true);
  return asset;
}

describe("scheduled direct PMTiles evidence", () => {
  it("is disabled in deterministic CI unless its dedicated live gate is set", () => {
    expect(isPmtilesLiveEvidenceEnabled({})).toBe(false);
    expect(isPmtilesLiveEvidenceEnabled({ HONUA_PMTILES_LIVE_ENABLED: "true" })).toBe(true);
  });

  it("returns a scoped skipped receipt without touching the network", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const evidence = await runPmtilesLiveEvidence({ enabled: false, fetchFn, observedAt: "2026-08-11T00:00:00.000Z" });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      format: "honua.sdk.pmtiles-direct-live-evidence.v1",
      status: "skipped",
      lane: "scheduled-only",
      authMode: "anonymous",
      scope: { directInspection: true, managedPublicationLifecycle: false },
    });
  });

  it("resolves the manifest and proves exact anonymous partial-range inspection through the public API", async () => {
    const asset = fixtureAsset();
    const requests: Array<{ url: string; range: string | null; authorization: string | null }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      const headers = new Headers(init?.headers);
      requests.push({ url, range: headers.get("range"), authorization: headers.get("authorization") });
      if (url === MANIFEST_URL) return Response.json(manifest());
      expect(url).toBe(ARCHIVE_URL);
      const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      if (!match) throw new Error("fixture expected one range");
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), asset.byteLength - 1);
      return new Response(asset.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${asset.byteLength}`,
          "Content-Type": "application/vnd.pmtiles",
          ETag: '"fixture-v1"',
        },
      });
    });

    const evidence = await runPmtilesLiveEvidence({
      enabled: true,
      fetchFn,
      observedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(evidence).toMatchObject({
      status: "executed",
      manifest: { url: MANIFEST_URL, format: "honua.demo-services.v1", schemaVersion: "1.1.0" },
      service: { id: "maui-basemap", archiveId: "maui-basemap", archiveUrl: ARCHIVE_URL },
      inspection: {
        specVersion: 3,
        tileKind: "mvt",
        archiveLength: 65_536,
        validator: 'etag:"fixture-v1"',
        transfer: { requests: 2, bytesFetched: 16_584 },
      },
      scope: { directInspection: true, managedPublicationLifecycle: false },
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({ url: MANIFEST_URL, range: null, authorization: null });
    expect(requests.slice(1).map((request) => request.range)).toEqual(["bytes=0-16383", "bytes=20000-20199"]);
    expect(requests.every((request) => request.authorization === null)).toBe(true);
  });

  it("rejects a manifest path that can escape the public deployment origin", () => {
    expect(() => resolvePmtilesArchive(manifest("https://attacker.test/archive.pmtiles"), MANIFEST_URL)).toThrow(
      "root-relative",
    );
  });
});
