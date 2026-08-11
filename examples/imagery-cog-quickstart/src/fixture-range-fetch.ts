import fixtureManifest from "../fixture-cog-manifest.v1.json" with { type: "json" };

export interface FixtureCogChunk {
  path: string;
  offset: number;
  bytes: number;
  sha256: string;
  storage: {
    encoding: "deflate-raw";
    bytes: number;
    sha256: string;
  };
}
interface RenderFixture {
  id: string;
  path: string;
}
export interface FixtureCogManifest {
  asset: {
    path: string;
    mediaType: string;
    bytes: number;
    sha256: string;
    etag: string;
    license: string;
    width: number;
    height: number;
    bbox: [number, number, number, number];
  };
  chunks: FixtureCogChunk[];
  renderFixtures: RenderFixture[];
}
export interface FixtureCogTransportSnapshot {
  virtualRangeRequests: number;
  virtualRangeBytes: number;
  chunkRequests: number;
  chunkBytes: number;
  fullAssetRequests: number;
  verifiedChunks: number;
  serviceRequests: readonly string[];
}
const manifest = fixtureManifest as unknown as FixtureCogManifest;
const cache = new Map<string, Uint8Array>();
const serviceRequests = new Set<string>();
const telemetry = {
  virtualRangeRequests: 0,
  virtualRangeBytes: 0,
  chunkRequests: 0,
  chunkBytes: 0,
  fullAssetRequests: 0,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=31536000, immutable" },
  });

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("The fixture request was aborted.", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("The fixture request was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
const WMS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service><Title>Oahu Honua Imagery WMS</Title><Abstract>Bundle-local deterministic imagery fixture.</Abstract></Service>
  <Capability><Request><GetMap><Format>image/png</Format></GetMap></Request><Layer queryable="0">
    <Name>natural_color</Name><Title>Oahu Natural Color</Title><CRS>EPSG:3857</CRS><CRS>EPSG:4326</CRS>
    <BoundingBox CRS="EPSG:4326" minx="-158.22" miny="21.21" maxx="-157.66" maxy="21.64"/>
    <Style><Name>default</Name><Title>Default natural color</Title></Style>
  </Layer></Capability>
</WMS_Capabilities>`;

function item() {
  const [w, s, e, n] = manifest.asset.bbox;
  const cogRasterBands = [
    { name: "red", common_name: "red", data_type: "uint8", nodata: 0 },
    { name: "green", common_name: "green", data_type: "uint8", nodata: 0 },
    { name: "blue", common_name: "blue", data_type: "uint8", nodata: 0 },
  ];
  const assets: Record<string, unknown> = {
    cog: {
      href: `./${manifest.asset.path}`,
      type: manifest.asset.mediaType,
      roles: ["data"],
      title: "Deterministic Oahu natural-color COG fixture",
      "file:size": manifest.asset.bytes,
      "file:checksum": `1220${manifest.asset.sha256}`,
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "cog-alt": { href: "./assets/cog-alt", type: manifest.asset.mediaType, roles: ["data"], "proj:code": "EPSG:4326", "raster:bands": cogRasterBands },
    "slow-cog": { href: "./assets/slow-cog", type: manifest.asset.mediaType, roles: ["data"], "proj:code": "EPSG:4326", "raster:bands": cogRasterBands },
    "no-range-cog": {
      href: "./assets/no-range-cog",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "cors-cog": {
      href: "https://fixture-cors.invalid/cors-cog",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "oversized-cog": {
      href: "./assets/oversized-cog",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "chunked-oversized-cog": {
      href: "./assets/chunked-oversized-cog",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "credential-cog": {
      href: "./assets/credential-cog?token=fixture-super-secret",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "userinfo-cog": {
      href: "https://fixture-user:fixture-password@fixture-credentials.invalid/userinfo-cog",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": cogRasterBands,
    },
    "unsupported-crs": {
      href: "./assets/unsupported-crs",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:32604",
      "raster:bands": cogRasterBands,
    },
    "unsupported-format": { href: "./assets/unsupported-format", type: "application/x-netcdf", roles: ["data"] },
    "missing-nodata": {
      href: "./assets/missing-nodata",
      type: manifest.asset.mediaType,
      roles: ["data"],
      "proj:code": "EPSG:4326",
      "raster:bands": [{ name: "red", data_type: "uint16", spatial_resolution: 10 }],
    },
  };
  return {
    type: "Feature",
    stac_version: "1.0.0",
    stac_extensions: [
      "https://stac-extensions.github.io/file/v2.1.0/schema.json",
      "https://stac-extensions.github.io/projection/v1.1.0/schema.json",
      "https://stac-extensions.github.io/raster/v1.1.0/schema.json",
    ],
    id: "oahu-natural-color-fixture-v1",
    bbox: [w, s, e, n],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
    properties: {
      title: "Deterministic Oahu natural-color fixture",
      description: "Synthetic georeferenced RGB imagery generated by the Honua SDK fixture generator.",
      datetime: "2024-01-01T00:00:00Z",
      license: manifest.asset.license,
      providers: [{ name: "Honua SDK fixture generator", roles: ["producer"] }],
      "proj:epsg": 4326,
      "proj:shape": [manifest.asset.height, manifest.asset.width],
      "proj:bbox": [w, s, e, n],
    },
    links: [],
    assets,
  };
}

function itemAtFixtureRoot(fixtureRootUrl: URL): Record<string, unknown> {
  const document = item();
  const assets = document.assets as Record<string, Record<string, unknown>>;
  return {
    ...document,
    assets: Object.fromEntries(
      Object.entries(assets).map(([key, asset]) => [
        key,
        {
          ...asset,
          ...(typeof asset.href === "string" ? { href: new URL(asset.href, fixtureRootUrl).href } : {}),
        },
      ]),
    ),
  };
}

export function validateFixtureChunkLayout(candidate: FixtureCogManifest): void {
  const paths = new Set<string>();
  let expectedOffset = 0;
  for (const chunk of candidate.chunks) {
    if (paths.has(chunk.path)) throw new Error(`fixture.manifest: duplicate chunk path ${chunk.path}.`);
    paths.add(chunk.path);
    if (!Number.isSafeInteger(chunk.offset) || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0) {
      throw new Error(`fixture.manifest: invalid chunk bounds for ${chunk.path}.`);
    }
    if (chunk.offset > expectedOffset) throw new Error(`fixture.manifest: gap before ${chunk.path}.`);
    if (chunk.offset < expectedOffset) throw new Error(`fixture.manifest: overlap at ${chunk.path}.`);
    expectedOffset += chunk.bytes;
    if (expectedOffset > candidate.asset.bytes) throw new Error(`fixture.manifest: ${chunk.path} exceeds asset bounds.`);
  }
  if (expectedOffset !== candidate.asset.bytes) throw new Error("fixture.manifest: chunks do not cover the asset exactly.");
}

validateFixtureChunkLayout(manifest);

async function verify(bytes: Uint8Array, expected: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
  const actual = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) throw new Error(`fixture.integrity: chunk digest mismatch (${actual}).`);
}

async function inflateChunk(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice().buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function elevationResponse(url: URL) {
  const longitude = Number(url.searchParams.get("longitude"));
  const latitude = Number(url.searchParams.get("latitude"));
  const noData = !Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -158.5;
  return {
    longitude,
    latitude,
    elevationMeters: noData
      ? null
      : Math.round((900 + (longitude + 157.9) * 1000 + (latitude - 21.35) * 500) * 10) / 10,
    noData,
    source: "oahu-terrain-rgb-fixture",
    version: "dem-fixture-v1",
    attribution: "Honua deterministic Terrain-RGB fixture",
    verticalDatum: "EGM96",
    resolutionMeters: 10,
    checksum: "sha256:terrain-rgb-fixture-v1",
    cache: {
      status: longitude === -157.8888 ? "miss" : "revalidated",
      etag: '"terrain-dem-v1"',
      cacheControl: "private, max-age=60",
    },
  };
}

function delayedJson(value: unknown, request: Request, delay: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(json(value)), delay);
    request.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

export const fixtureCogTransportSnapshot = (): FixtureCogTransportSnapshot => ({
  ...telemetry,
  verifiedChunks: cache.size,
  serviceRequests: [...serviceRequests],
});

export function createFixtureCogFetch({
  appRootUrl,
  fixtureRootUrl,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: { appRootUrl: URL; fixtureRootUrl: URL; fetchImpl?: typeof fetch }): typeof fetch {
  const stacSearchUrl = new URL("stac/search", appRootUrl);
  const fixtureItemUrl = new URL("item.json", fixtureRootUrl).href;
  const fixtureItem = itemAtFixtureRoot(fixtureRootUrl);
  const fixtureAssetUrl = new URL(manifest.asset.path, fixtureRootUrl).href;
  const degradedAssetUrls = new Map(
    [
      "cog-alt",
      "slow-cog",
      "no-range-cog",
      "oversized-cog",
      "chunked-oversized-cog",
      "unsupported-crs",
      "missing-nodata",
    ].map((key) => [
      new URL(`assets/${key}`, fixtureRootUrl).href,
      key,
    ]),
  );
  const identity = (url: URL, pathname: string) =>
    url.origin === appRootUrl.origin && url.pathname === new URL(pathname, appRootUrl).pathname;
  const imageFixture = manifest.renderFixtures.find((fixture) => fixture.id === "image-server-natural-color");
  if (!imageFixture) throw new Error("fixture.manifest: image-server-natural-color render fixture is missing.");
  const allowedStaticUrls = new Set([
    ...manifest.chunks.map((chunk) => new URL(chunk.path, fixtureRootUrl).href),
    ...manifest.renderFixtures.map((fixture) => new URL(fixture.path, fixtureRootUrl).href),
    ...["LICENSE.txt", "manifest.json", "item.json", "search.json"].map((path) => new URL(path, fixtureRootUrl).href),
  ]);

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === "GET" && url.href === fixtureItemUrl) {
      serviceRequests.add("stac-item");
      return json(fixtureItem);
    }
    if (method === "POST" && url.origin === stacSearchUrl.origin && url.pathname === stacSearchUrl.pathname) {
      serviceRequests.add("stac-search");
      return json({ type: "FeatureCollection", features: [fixtureItem], links: [] });
    }
    const searchKeys = new Set(["bbox", "collections", "datetime", "filter", "filter-lang", "limit"]);
    if (
      method === "GET" &&
      identity(url, "/stac/search") &&
      [...url.searchParams.keys()].every((key) => searchKeys.has(key)) &&
      [...searchKeys].every((key) => url.searchParams.has(key))
    ) {
      serviceRequests.add("stac-search");
      if (url.searchParams.get("collections") === "malformed-fixture") {
        return new Response('{"type":"FeatureCollection"', {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.searchParams.get("collections") === "empty-fixture") {
        return json({ type: "FeatureCollection", features: [], numberMatched: 0, numberReturned: 0, links: [] });
      }
      return json({ type: "FeatureCollection", features: [fixtureItem], links: [] });
    }
    if (
      method === "GET" &&
      identity(url, "/rest/services/OahuImagery/MapServer/WMS") &&
      (url.searchParams.get("REQUEST") ?? "GetCapabilities").toLowerCase() === "getcapabilities"
    ) {
      serviceRequests.add("wms-capabilities");
      return new Response(WMS_CAPABILITIES, { headers: { "content-type": "text/xml; charset=utf-8" } });
    }
    if (method === "GET" && identity(url, "/rest/services/OahuCog/ImageServer")) {
      serviceRequests.add("image-server-metadata");
      return json({
        serviceDescription: "Oahu Sentinel-2 COG ImageServer",
        layers: [{ id: 0, name: "oahu_sentinel2_cog" }],
        spatialReference: { wkid: 4326 },
        fullExtent: {
          xmin: -158.22,
          ymin: 21.21,
          xmax: -157.66,
          ymax: 21.64,
          spatialReference: { wkid: 4326 },
        },
        cache: { scope: "metadata", status: "hit", ageMs: 25_000, ttlMs: 600_000, keyFingerprint: "fixture-oahu-cog" },
      });
    }
    if (method === "GET" && identity(url, "/rest/services/OahuCog/ImageServer/legend")) {
      serviceRequests.add("image-server-legend");
      return json({
        layers: [
          {
            layerId: 0,
            layerName: "oahu_sentinel2_cog",
            legend: [{ label: "Sentinel-2 visual", imageData: "", contentType: "image/png" }],
          },
        ],
      });
    }
    if (method === "GET" && identity(url, "/rest/services/OahuCog/ImageServer/exportImage")) {
      serviceRequests.add("image-server-export");
      return json({
        href: new URL(imageFixture.path, fixtureRootUrl).href,
        width: 512,
        height: 512,
        extent: {
          xmin: -158.22,
          ymin: 21.21,
          xmax: -157.66,
          ymax: 21.64,
          spatialReference: { wkid: 4326 },
        },
        scale: 144_000,
      });
    }
    if (method === "GET" && identity(url, "/rest/services/OahuTerrain/ImageServer")) {
      serviceRequests.add("terrain-metadata");
      return json({
        serviceDescription: "Oahu Terrain-RGB Elevation ImageServer",
        layers: [{ id: 0, name: "oahu_10m_dem_terrain_rgb" }],
        spatialReference: { wkid: 4326 },
        fullExtent: {
          xmin: -158.08,
          ymin: 21.28,
          xmax: -157.72,
          ymax: 21.52,
          spatialReference: { wkid: 4326 },
        },
        pixelType: "U8",
        bandCount: 3,
        terrainEncoding: "mapbox-terrain-rgb",
      });
    }
    if (method === "GET" && identity(url, "/api/v1/terrain/OahuTerrain/elevation/value")) {
      serviceRequests.add("elevation-value");
      const response = elevationResponse(url);
      return response.longitude === -157.7777 ? delayedJson(response, request, 250) : json(response);
    }
    const degradedAssetKey = degradedAssetUrls.get(url.href);
    if ((!degradedAssetKey && url.href !== fixtureAssetUrl) || (method !== "GET" && method !== "HEAD")) {
      if ((method === "GET" || method === "HEAD") && allowedStaticUrls.has(url.href)) return fetchImpl(request);
      throw new TypeError(`fixture.transport: blocked unmatched request ${method} ${url.href}.`);
    }
    if (degradedAssetKey === "slow-cog") await delay(450, request.signal);
    if (degradedAssetKey === "no-range-cog" && method === "HEAD") {
      return new Response(null, {
        headers: {
          "content-length": String(manifest.asset.bytes),
          "content-type": manifest.asset.mediaType,
          etag: '"fixture-no-range-cog-v1"',
        },
      });
    }
    if (method === "HEAD")
      return new Response(null, {
        headers: {
          "accept-ranges": "bytes",
          "content-length": String(manifest.asset.bytes),
          "content-type": manifest.asset.mediaType,
          etag: manifest.asset.etag,
        },
      });
    if (degradedAssetKey === "no-range-cog")
      return new Response(new Uint8Array(manifest.asset.bytes), {
        headers: {
          "content-length": String(manifest.asset.bytes),
          "content-type": manifest.asset.mediaType,
          etag: `"fixture-${degradedAssetKey}-v1"`,
        },
      });
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (!match) {
      telemetry.fullAssetRequests += 1;
      return new Response("Range-only fixture", {
        status: 413,
        headers: { "content-range": `bytes */${manifest.asset.bytes}` },
      });
    }
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= manifest.asset.bytes ||
      length > 64 * 1024
    )
      return new Response("Invalid range", {
        status: 416,
        headers: { "content-range": `bytes */${manifest.asset.bytes}` },
      });
    const output = new Uint8Array(length);
    let coveredBytes = 0;
    for (const chunk of manifest.chunks.filter(
      (candidate) => candidate.offset <= end && candidate.offset + candidate.bytes > start,
    )) {
      const chunkUrl = new URL(chunk.path, fixtureRootUrl);
      let bytes = cache.get(chunkUrl.href);
      if (!bytes) {
        const response = await fetchImpl(chunkUrl, { signal: request.signal });
        if (!response.ok) throw new Error(`fixture.transport: ${chunk.path} returned ${response.status}.`);
        const storedBytes = new Uint8Array(await response.arrayBuffer());
        if (storedBytes.length !== chunk.storage.bytes)
          throw new Error(`fixture.integrity: ${chunk.path} stored length mismatch.`);
        await verify(storedBytes, chunk.storage.sha256);
        bytes = await inflateChunk(storedBytes);
        if (bytes.length !== chunk.bytes) throw new Error(`fixture.integrity: ${chunk.path} length mismatch.`);
        await verify(bytes, chunk.sha256);
        cache.set(chunkUrl.href, bytes);
        telemetry.chunkRequests += 1;
        telemetry.chunkBytes += storedBytes.length;
      }
      const copyStart = Math.max(start, chunk.offset);
      const copyEnd = Math.min(end + 1, chunk.offset + chunk.bytes);
      output.set(bytes.subarray(copyStart - chunk.offset, copyEnd - chunk.offset), copyStart - start);
      coveredBytes += copyEnd - copyStart;
    }
    if (coveredBytes !== length) throw new Error(`fixture.manifest: requested range covered ${coveredBytes} of ${length} bytes.`);
    if (degradedAssetKey === "oversized-cog" || degradedAssetKey === "chunked-oversized-cog") {
      const oversized = new Uint8Array(length + 32);
      oversized.set(output);
      oversized.fill(0x7f, length);
      const headers = {
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${manifest.asset.bytes}`,
        "content-type": manifest.asset.mediaType,
        etag: '"lying-range-fixture-v1"',
      };
      if (degradedAssetKey === "chunked-oversized-cog") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized.subarray(0, Math.min(48, oversized.length)));
            controller.enqueue(oversized.subarray(Math.min(48, oversized.length)));
            controller.close();
          },
        });
        return new Response(stream, { status: 206, headers });
      }
      return new Response(oversized, {
        status: 206,
        headers: { ...headers, "content-length": String(oversized.length) },
      });
    }
    telemetry.virtualRangeRequests += 1;
    telemetry.virtualRangeBytes += length;
    return new Response(output, {
      status: 206,
      headers: {
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${manifest.asset.bytes}`,
        "content-length": String(length),
        "content-type": manifest.asset.mediaType,
        etag: manifest.asset.etag,
      },
    });
  }) as typeof fetch;
}
export const fixtureCogManifest = manifest;
