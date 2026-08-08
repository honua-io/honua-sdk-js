import { describe, expect, it, vi } from "vitest";

import type { CogDecodedMetadata, CogDecoderFactory } from "../src/cog/index.js";
import {
  RASTER_FORMAT_MATURITY,
  UNIFIED_RASTER_CAPABILITY_MATRIX,
  directCogSource,
  openRasterSession,
  planRasterOperation,
} from "../src/raster/index.js";

const metadata: CogDecodedMetadata = {
  format: "cog",
  width: 1024,
  height: 1024,
  crs: { kind: "known", authority: "EPSG", code: "4326" },
  bands: [{ index: 1, dataType: "uint8", nodata: 0 }],
  resolution: { x: 0.01, y: 0.01, unit: "degree" },
  footprint: {
    type: "Polygon",
    coordinates: [
      [
        [-158, 21],
        [-157, 21],
        [-157, 22],
        [-158, 22],
        [-158, 21],
      ],
    ],
  },
  overviewDecimations: [2, 4, 8],
};

function boundedFetch(ranges: string[]): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("range");
    if (!range) throw new Error("A full-file request escaped the raster session.");
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) throw new Error(`Unexpected range: ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    return new Response(new Uint8Array(length), {
      status: 206,
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(length),
        "content-range": `bytes ${start}-${end}/1000000000`,
        etag: '"pinned-cog-v1"',
      },
    });
  }) as typeof fetch;
}

function decoder(format: CogDecodedMetadata["format"] = "cog"): CogDecoderFactory {
  return async () => ({
    async inspect({ readRange }) {
      await readRange({ offset: 0, length: 32 });
      return { ...metadata, format };
    },
    async readWindow(request, { readRange }) {
      await readRange({ offset: 4096, length: 16 });
      return {
        width: request.sampling?.width ?? request.width,
        height: request.sampling?.height ?? request.height,
        bands: [{ band: 1, values: new Uint8Array([0, 10, 20, 30]) }],
      };
    },
  });
}

describe("unified raster session", () => {
  it("structurally validates direct COG input and never requests the whole large asset", async () => {
    const ranges: string[] = [];
    const source = directCogSource({
      id: "pinned-oahu-cog",
      url: "https://assets.example/pinned-oahu",
      mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
    });
    const session = await openRasterSession(source, {
      decoderFactory: decoder(),
      clientOptions: { fetchFn: boundedFetch(ranges), bearerToken: "fixture-token" },
      limits: { maxRangeBytes: 64, maxTotalBytes: 128 },
    });

    const result = await session.readWindow({ space: "pixel", x: 0, y: 0, width: 2, height: 2, bands: [1] });

    expect(result.kind).toBe("decoded-window");
    expect(ranges).toEqual(["bytes=0-31", "bytes=4096-4111"]);
    expect(session.transfer()).toMatchObject({ requests: 2, bytesFetched: 48 });
    await session.dispose();
  });

  it("rejects an ordinary GeoTIFF even when the URL and media type look like a COG", async () => {
    const source = directCogSource({
      id: "not-actually-cog",
      url: "https://assets.example/not-actually-cog.tif",
      mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
    });

    await expect(
      openRasterSession(source, { decoderFactory: decoder("geotiff"), clientOptions: { fetchFn: boundedFetch([]) } }),
    ).rejects.toMatchObject({ code: "unsupported-format" });
  });

  it("computes no-data-aware statistics and a bounded histogram", async () => {
    const session = await openRasterSession(
      directCogSource({
        id: "statistics-cog",
        url: "https://assets.example/statistics",
        mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
      }),
      { decoderFactory: decoder(), clientOptions: { fetchFn: boundedFetch([]) } },
    );

    const result = await session.statistics(
      { space: "pixel", x: 0, y: 0, width: 2, height: 2, bands: [1] },
      { bins: 3 },
    );

    expect(result.bands[0]).toMatchObject({ band: 1, count: 3, noDataCount: 1, min: 10, max: 30, mean: 20 });
    expect(result.bands[0]?.histogram).toHaveLength(3);
    await session.dispose();
  });

  it("routes bounded ImageServer exports through the Honua request pipeline", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ href: "https://images.example/subset.png", width: 256, height: 128 });
    }) as typeof fetch;
    const session = await openRasterSession(
      {
        kind: "image-server",
        id: "oahu-imagery",
        baseUrl: "https://honua.example",
        serviceId: "Imagery/Oahu",
        deployment: "honua",
      },
      { clientOptions: { fetchFn, apiKey: "fixture-key" } },
    );

    const result = await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.2, -157.7, 21.6],
      width: 256,
      height: 128,
      spatialReference: 4326,
      bands: [3, 2, 1],
    });

    expect(result).toMatchObject({ kind: "server-image", href: "https://images.example/subset.png" });
    expect(requests[0]).toContain("/rest/services/Imagery/Oahu/ImageServer/exportImage");
    expect(requests[0]).toContain("size=256%2C128");
  });

  it("keeps coverage execution and future formats explicit", () => {
    const coverage = { kind: "ogc-coverage", id: "temperature", endpoint: "https://coverage.example/subset" } as const;
    expect(planRasterOperation(coverage, "read-window")).toMatchObject({ mode: "unavailable", bounded: true });
    expect(UNIFIED_RASTER_CAPABILITY_MATRIX["ogc-coverage"]).toMatchObject({
      client: "metadata-only",
      endToEnd: "unavailable",
    });
    expect(RASTER_FORMAT_MATURITY).toMatchObject({ zarr: "metadata-only", netcdf: "metadata-only" });
  });
});
