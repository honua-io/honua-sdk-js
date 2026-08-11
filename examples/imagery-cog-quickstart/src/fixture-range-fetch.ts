import fixtureManifest from "../fixture-cog-manifest.v1.json" with { type: "json" };

interface Chunk {
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
interface Manifest {
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
  chunks: Chunk[];
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
const manifest = fixtureManifest as unknown as Manifest;
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
  const assets: Record<string, unknown> = {
    cog: {
      href: `./${manifest.asset.path}`,
      type: manifest.asset.mediaType,
      roles: ["data"],
      title: "Deterministic Oahu natural-color COG fixture",
      "file:size": manifest.asset.bytes,
      "checksum:multihash": `sha256:${manifest.asset.sha256}`,
    },
  };
  for (const key of ["cog-alt", "slow-cog", "no-range-cog", "cors-cog", "unsupported-crs", "unsupported-format"])
    assets[key] = { href: `./assets/${key}`, type: manifest.asset.mediaType, roles: ["data"] };
  return {
    type: "Feature",
    stac_version: "1.0.0",
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
      datetime: "2024-01-01T00:00:00Z",
      license: manifest.asset.license,
      "proj:epsg": 4326,
      "proj:shape": [manifest.asset.height, manifest.asset.width],
      "proj:bbox": [w, s, e, n],
    },
    links: [],
    assets,
  };
}

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
  const stacSearchUrl = new URL("stac/search", appRootUrl).href;
  const fixtureItemUrl = new URL("item.json", fixtureRootUrl).href;
  const fixtureAssetUrl = new URL(manifest.asset.path, fixtureRootUrl).href;
  const degradedAssetUrls = new Map(
    ["cog-alt", "slow-cog", "no-range-cog", "cors-cog", "unsupported-crs", "unsupported-format"].map((key) => [
      new URL(`assets/${key}`, fixtureRootUrl).href,
      key,
    ]),
  );
  const identity = (url: URL, pathname: string) =>
    url.origin === appRootUrl.origin && url.pathname === new URL(pathname, appRootUrl).pathname;
  const publishedFixtureRoot = "/sdk/imagery-cog-quickstart/app/fixtures/cog/";
  const imageFixture = manifest.renderFixtures.find((fixture) => fixture.id === "image-server-natural-color");
  if (!imageFixture) throw new Error("fixture.manifest: image-server-natural-color render fixture is missing.");

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method === "GET" && url.href === fixtureItemUrl) {
      serviceRequests.add("stac-item");
      return json(item());
    }
    if (method === "POST" && url.href === stacSearchUrl) {
      serviceRequests.add("stac-search");
      return json({ type: "FeatureCollection", features: [item()], links: [] });
    }
    const searchKeys = new Set(["bbox", "collections", "datetime", "filter", "filter-lang", "limit"]);
    if (
      method === "GET" &&
      fixtureRootUrl.pathname === publishedFixtureRoot &&
      identity(url, "/stac/search") &&
      [...url.searchParams.keys()].every((key) => searchKeys.has(key)) &&
      [...searchKeys].every((key) => url.searchParams.has(key))
    ) {
      serviceRequests.add("stac-search");
      return json({ type: "FeatureCollection", features: [item()], links: [] });
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
    if ((!degradedAssetKey && url.href !== fixtureAssetUrl) || (method !== "GET" && method !== "HEAD"))
      return fetchImpl(request);
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
      return new Response(null, {
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
    for (const chunk of manifest.chunks.filter(
      (candidate) => candidate.offset <= end && candidate.offset + candidate.bytes > start,
    )) {
      let bytes = cache.get(chunk.path);
      if (!bytes) {
        const response = await fetchImpl(new URL(chunk.path, fixtureRootUrl), { signal: request.signal });
        if (!response.ok) throw new Error(`fixture.transport: ${chunk.path} returned ${response.status}.`);
        const storedBytes = new Uint8Array(await response.arrayBuffer());
        if (storedBytes.length !== chunk.storage.bytes)
          throw new Error(`fixture.integrity: ${chunk.path} stored length mismatch.`);
        await verify(storedBytes, chunk.storage.sha256);
        bytes = await inflateChunk(storedBytes);
        if (bytes.length !== chunk.bytes) throw new Error(`fixture.integrity: ${chunk.path} length mismatch.`);
        await verify(bytes, chunk.sha256);
        cache.set(chunk.path, bytes);
        telemetry.chunkRequests += 1;
        telemetry.chunkBytes += storedBytes.length;
      }
      const copyStart = Math.max(start, chunk.offset);
      const copyEnd = Math.min(end + 1, chunk.offset + chunk.bytes);
      output.set(bytes.subarray(copyStart - chunk.offset, copyEnd - chunk.offset), copyStart - start);
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
