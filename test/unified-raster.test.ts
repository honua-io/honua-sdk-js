import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { CogDecodedMetadata, CogDecoderFactory, CogNoDataValue } from "../src/cog/index.js";
import { HonuaClient } from "../src/core/client.js";
import {
  RASTER_FORMAT_MATURITY,
  UNIFIED_RASTER_CAPABILITY_MATRIX,
  directCogSource,
  openRasterSession,
  planRasterOperation,
} from "../src/raster/index.js";
import type { RasterStyle } from "../src/raster/index.js";

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

function decoder(
  format: CogDecodedMetadata["format"] = "cog",
  values: readonly number[] = [0, 10, 20, 30],
  nodata: CogNoDataValue = 0,
): CogDecoderFactory {
  return async () => ({
    async inspect({ readRange }) {
      await readRange({ offset: 0, length: 32 });
      return { ...metadata, format, bands: metadata.bands.map((band) => ({ ...band, nodata })) };
    },
    async readWindow(request, { readRange }) {
      await readRange({ offset: 4096, length: 16 });
      return {
        width: request.sampling?.width ?? request.width,
        height: request.sampling?.height ?? request.height,
        bands: [{ band: 1, values: new Uint8Array(values) }],
      };
    },
  });
}

function coverageFixture(name: string): string {
  return readFileSync(new URL(`fixtures/coverages/${name}`, import.meta.url), "utf8");
}

function rasterCoverageFetch(requests: URL[]): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    if (url.pathname === "/ogc/coverages/collections/7") {
      return new Response(coverageFixture("collection.json"), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/ogc/coverages/collections/7/schema") {
      return new Response(coverageFixture("schema.json"), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/ogc/coverages/collections/7/coverage") {
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { "Content-Type": "image/png" },
      });
    }
    if (url.pathname === "/ogc/services/7/wcs" && url.searchParams.get("REQUEST") === "DescribeCoverage") {
      return new Response(coverageFixture("wcs-description.xml"), { headers: { "Content-Type": "application/xml" } });
    }
    if (url.pathname === "/ogc/services/7/wcs" && url.searchParams.get("REQUEST") === "GetCoverage") {
      return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
        headers: { "Content-Type": "image/png" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("unified raster session", () => {
  it("keeps Honua and third-party ImageServer identities distinct without endpoint guessing", () => {
    const common = {
      kind: "image-server" as const,
      id: "imagery",
      baseUrl: "https://same.example.test/arcgis",
      serviceId: "Imagery",
    };
    const honua = planRasterOperation({ ...common, deployment: "honua" }, "render");
    const thirdParty = planRasterOperation({ ...common, deployment: "arcgis" }, "render");

    expect(honua.capability.identity).toBe("honua-service");
    expect(honua.capability.server).toBe("supported");
    expect(thirdParty.capability.identity).toBe("third-party-service");
    expect(thirdParty.capability.server).toBe("not-applicable");
  });

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

  it("honors numeric-string no-data metadata in statistics", async () => {
    const session = await openRasterSession(
      directCogSource({
        id: "string-nodata-cog",
        url: "https://assets.example/string-nodata",
        mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
      }),
      { decoderFactory: decoder("cog", [0, 10, 20, 30], "0"), clientOptions: { fetchFn: boundedFetch([]) } },
    );

    const result = await session.statistics(
      { space: "pixel", x: 0, y: 0, width: 2, height: 2, bands: [1] },
      { bins: 3 },
    );

    expect(result.bands[0]).toMatchObject({ band: 1, count: 3, noDataCount: 1, min: 10, max: 30, mean: 20 });
    await session.dispose();
  });

  it("emits one ordered histogram bin for a constant-valued band", async () => {
    const session = await openRasterSession(
      directCogSource({
        id: "constant-cog",
        url: "https://assets.example/constant",
        mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
      }),
      { decoderFactory: decoder("cog", [7, 7, 7, 7]), clientOptions: { fetchFn: boundedFetch([]) } },
    );

    const result = await session.statistics(
      { space: "pixel", x: 0, y: 0, width: 2, height: 2, bands: [1] },
      { bins: 4 },
    );

    expect(result.bands[0]).toMatchObject({ band: 1, count: 4, min: 7, max: 7, mean: 7 });
    expect(result.bands[0]?.histogram).toEqual([{ min: 7, max: 7, count: 4 }]);
    await session.dispose();
  });

  it("rejects every styling facade on direct COG windows before decoding", async () => {
    const ranges: string[] = [];
    const session = await openRasterSession(
      directCogSource({
        id: "unstyled-cog",
        url: "https://assets.example/unstyled",
        mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
      }),
      { decoderFactory: decoder(), clientOptions: { fetchFn: boundedFetch(ranges) } },
    );
    const styles: readonly RasterStyle[] = [
      { kind: "stretch", method: "min-max" },
      { kind: "colormap", stops: [{ value: 1, color: [255, 0, 0] }] },
      { kind: "hillshade" },
      { kind: "terrain" },
      { kind: "multiband", red: 3, green: 2, blue: 1 },
    ];

    for (const style of styles) {
      await expect(
        session.readWindow({ space: "pixel", x: 0, y: 0, width: 2, height: 2, bands: [1], style }),
      ).rejects.toMatchObject({ capability: "styled-window", protocol: "direct-cog" });
    }
    await expect(
      session.inspectValue({ space: "pixel", x: 0, y: 0, bands: [1], style: { kind: "stretch", method: "min-max" } }),
    ).rejects.toMatchObject({ capability: "styled-window", protocol: "direct-cog" });
    expect(ranges).toEqual(["bytes=0-31"]);
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
        baseUrl: "https://honua.example/arcgis",
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
      resampling: "bilinear",
    });

    expect(result).toMatchObject({ kind: "server-image", href: "https://images.example/subset.png" });
    expect(requests[0]).toContain("https://honua.example/arcgis/rest/services/Imagery/Oahu/ImageServer/exportImage");
    const requestUrl = new URL(requests[0] ?? "");
    expect(requestUrl.searchParams.get("size")).toBe("256,128");
    expect(requestUrl.searchParams.get("bandIds")).toBe("2,1,0");
    expect(requestUrl.searchParams.get("interpolation")).toBe("RSP_BilinearInterpolation");
  });

  it("rejects an injected ImageServer client bound to a different base URL", async () => {
    const fetchFn = vi.fn(async () => Response.json({})) as typeof fetch;
    const client = new HonuaClient({ baseUrl: "https://other.example/arcgis", fetchFn });

    await expect(
      openRasterSession(
        {
          kind: "image-server",
          deployment: "honua",
          id: "bound-imagery",
          baseUrl: "https://honua.example/arcgis",
          serviceId: "Imagery/Bound",
        },
        { client },
      ),
    ).rejects.toMatchObject({ capability: "source-client-base-url", protocol: "image-server" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("normalizes invalid ImageServer base URLs with adversarial slash runs", async () => {
    const slashRun = "/".repeat(100_000);
    const baseUrl = `${slashRun}fixture`;
    const client = new HonuaClient({ baseUrl: "https://client.example" });
    Object.defineProperty(client, "serverBaseUrl", { value: baseUrl });

    const session = await openRasterSession(
      {
        kind: "image-server",
        deployment: "honua",
        id: "adversarial-base-url",
        baseUrl: `${baseUrl}///`,
        serviceId: "Imagery/Adversarial",
      },
      { client },
    );

    await session.dispose();
  });

  it("maps nearest-neighbor resampling to the ImageServer wire value", async () => {
    let requested = "";
    const session = await openRasterSession(
      {
        kind: "image-server",
        id: "oahu-imagery",
        baseUrl: "https://honua.example/arcgis",
        serviceId: "Imagery/Oahu",
        deployment: "arcgis",
      },
      {
        clientOptions: {
          fetchFn: async (input) => {
            requested = String(input);
            return Response.json({ href: "https://images.example/subset.png" });
          },
        },
      },
    );

    await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.2, -157.7, 21.6],
      width: 64,
      height: 64,
      resampling: "nearest",
    });

    expect(new URL(requested).searchParams.get("interpolation")).toBe("RSP_NearestNeighbor");
  });

  it.each([
    ["min-max", 5],
    ["percent-clip", 6],
    ["standard-deviation", 3],
  ] as const)("maps the %s stretch facade to ImageServer StretchType %i", async (method, stretchType) => {
    let requested = "";
    const session = await openRasterSession(
      {
        kind: "image-server",
        deployment: "honua",
        id: "styled-imagery",
        baseUrl: "https://honua.example/arcgis",
        serviceId: "Imagery/Styled",
      },
      {
        clientOptions: {
          fetchFn: async (input) => {
            requested = String(input);
            return Response.json({ href: "https://images.example/styled.png" });
          },
        },
      },
    );

    await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.2, -157.7, 21.6],
      width: 64,
      height: 64,
      spatialReference: 4326,
      style: { kind: "stretch", method },
    });

    const encodedRule = new URL(requested).searchParams.get("renderingRule");
    expect(encodedRule).not.toBeNull();
    const rule = JSON.parse(encodedRule ?? "{}") as { rasterFunctionArguments?: { StretchType?: number } };
    expect(rule.rasterFunctionArguments?.StretchType).toBe(stretchType);
  });

  it("rejects ImageServer value inspection band selection before issuing identify", async () => {
    const fetchFn = vi.fn(async () => Response.json({ results: [] })) as typeof fetch;
    const session = await openRasterSession(
      {
        kind: "image-server",
        deployment: "honua",
        id: "banded-imagery",
        baseUrl: "https://honua.example/arcgis",
        serviceId: "Imagery/Banded",
      },
      { clientOptions: { fetchFn } },
    );

    await expect(
      session.inspectValue({ space: "coordinate", x: -157.8, y: 21.3, spatialReference: 4326, bands: [3, 2, 1] }),
    ).rejects.toMatchObject({ capability: "inspect-value-band-selection", protocol: "image-server" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails closed instead of passing projected or implicit native extents to browser renderers", async () => {
    const session = await openRasterSession(
      {
        kind: "image-server",
        deployment: "honua",
        id: "projected-imagery",
        baseUrl: "https://honua.example/arcgis",
        serviceId: "Imagery/Projected",
      },
      { clientOptions: { fetchFn: async () => Response.json({ href: "https://images.example/projected.png" }) } },
    );
    const projected = await session.readWindow({
      space: "bbox",
      bbox: [-17_594_000, 2_340_000, -17_482_000, 2_470_000],
      width: 256,
      height: 256,
      spatialReference: 3857,
    });
    const implicitNative = await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.2, -157.7, 21.6],
      width: 256,
      height: 256,
    });

    for (const result of [projected, implicitNative]) {
      expect(() => session.toMapLibreImageSource(result)).toThrowError(
        expect.objectContaining({ capability: "wgs84-presentation-extent" }),
      );
      expect(() => session.toDeckGlBitmap(result)).toThrowError(
        expect.objectContaining({ capability: "wgs84-presentation-extent" }),
      );
    }
    expect(
      session.toMapLibreImageSource(projected, [
        [-158.1, 21.6],
        [-157.7, 21.6],
        [-157.7, 21.2],
        [-158.1, 21.2],
      ]).coordinates,
    ).toEqual([
      [-158.1, 21.6],
      [-157.7, 21.6],
      [-157.7, 21.2],
      [-158.1, 21.2],
    ]);
  });

  it("uses explicitly WGS84 extents for MapLibre and deck.gl presentation", async () => {
    const session = await openRasterSession(
      {
        kind: "image-server",
        deployment: "honua",
        id: "geographic-imagery",
        baseUrl: "https://honua.example/arcgis",
        serviceId: "Imagery/Geographic",
      },
      { clientOptions: { fetchFn: async () => Response.json({ href: "https://images.example/geographic.png" }) } },
    );
    const result = await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.2, -157.7, 21.6],
      width: 256,
      height: 256,
      spatialReference: "EPSG:4326",
    });

    expect(session.toMapLibreImageSource(result).coordinates).toEqual([
      [-158.1, 21.6],
      [-157.7, 21.6],
      [-157.7, 21.2],
      [-158.1, 21.2],
    ]);
    expect(session.toDeckGlBitmap(result).bounds).toEqual([-158.1, 21.2, -157.7, 21.6]);
  });

  it("consumes a dynamic STAC COG handoff without weakening structural validation", async () => {
    const ranges: string[] = [];
    const session = await openRasterSession(
      {
        kind: "cog",
        id: "dynamic-stac-cog",
        candidate: {
          itemId: "oahu-item",
          key: "visual",
          href: "https://assets.example/dynamic-stac-cog",
          mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
          roles: ["visual"],
          format: "cog",
          maturity: "experimental",
          projection: {},
          bands: [],
          evidence: ["media-type:image/tiff; application=geotiff; profile=cloud-optimized"],
          handoff: {
            kind: "cog",
            href: "https://assets.example/dynamic-stac-cog",
            packageExport: "@honua/sdk-js/cog",
          },
        },
      },
      { decoderFactory: decoder(), clientOptions: { fetchFn: boundedFetch(ranges) } },
    );

    expect(ranges).toEqual(["bytes=0-31"]);
    await session.dispose();
  });

  it("uses the real bounded OGC API Coverages client with named range fields", async () => {
    const requests: URL[] = [];
    const source = {
      kind: "ogc-coverage",
      id: "temperature",
      endpoint: "https://coverage.example/ogc/coverages",
      collectionId: "7",
    } as const;
    const session = await openRasterSession(source, { clientOptions: { fetchFn: rasterCoverageFetch(requests) } });

    expect(planRasterOperation(source, "read-window")).toMatchObject({ mode: "server-operation", bounded: true });
    expect(await session.inspect()).toMatchObject({
      metadata: { domainSet: { collectionId: "7" }, rangeType: { collectionId: "7" } },
    });
    const result = await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.3, -157.9, 21.5],
      width: 256,
      height: 128,
      spatialReference: 4326,
      rangeFields: ["elevation", "quality"],
    });

    expect(result).toMatchObject({ kind: "coverage-image", width: 256, height: 128 });
    const requested = requests.find((url) => url.pathname.endsWith("/coverage"));
    expect(requested?.searchParams.get("bbox-crs")).toBe("EPSG:4326");
    expect(requested?.searchParams.get("properties")).toBe("elevation,quality");
    expect(requested?.searchParams.get("scale-size")).toBe("x(256),y(128)");
  });

  it("uses advertised WCS axes for exact bounded output sizing", async () => {
    const requests: URL[] = [];
    const source = {
      kind: "wcs",
      id: "temperature-wcs",
      endpoint: "https://coverage.example/ogc/services/7/wcs",
      coverageId: "7",
      scaleAxes: { width: "Long", height: "Lat" },
    } as const;
    const session = await openRasterSession(source, { clientOptions: { fetchFn: rasterCoverageFetch(requests) } });
    const result = await session.readWindow({
      space: "bbox",
      bbox: [-158.1, 21.3, -157.9, 21.5],
      width: 256,
      height: 128,
      spatialReference: "EPSG:4326",
      rangeFields: ["elevation"],
    });

    expect(result).toMatchObject({ kind: "coverage-image", width: 256, height: 128 });
    const requested = requests.find((url) => url.searchParams.get("REQUEST") === "GetCoverage");
    expect(requested?.searchParams.get("SCALESIZE")).toBe("Lat(128),Long(256)");
    expect(requested?.searchParams.get("RANGESUBSET")).toBe("elevation");
  });

  it("keeps unsupported coverage fields and future formats fail-closed", async () => {
    const requests: URL[] = [];
    const session = await openRasterSession(
      {
        kind: "ogc-coverage",
        id: "temperature",
        endpoint: "https://coverage.example/ogc/coverages",
        collectionId: "7",
      },
      { clientOptions: { fetchFn: rasterCoverageFetch(requests) } },
    );
    await expect(
      session.readWindow({
        space: "bbox",
        bbox: [-158.1, 21.3, -157.9, 21.5],
        width: 32,
        height: 32,
        bands: [1],
      }),
    ).rejects.toMatchObject({ capability: "named-range-fields", protocol: "ogc-coverage" });
    expect(requests).toHaveLength(0);
    expect(UNIFIED_RASTER_CAPABILITY_MATRIX["ogc-coverage"]).toMatchObject({
      client: "experimental",
      endToEnd: "experimental",
    });
    expect(RASTER_FORMAT_MATURITY).toMatchObject({ zarr: "experimental", netcdf: "unavailable" });
  });

  it("fails closed when a style has no legend implementation", async () => {
    const session = await openRasterSession(
      directCogSource({
        id: "legend-cog",
        url: "https://assets.example/legend",
        mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
      }),
      { decoderFactory: decoder(), clientOptions: { fetchFn: boundedFetch([]) } },
    );
    expect(() => session.legend({ kind: "stretch", method: "min-max" })).toThrowError(
      expect.objectContaining({ capability: "legend" }),
    );
    await session.dispose();
  });
});
