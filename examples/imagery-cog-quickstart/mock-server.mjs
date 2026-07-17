import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
};

const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mO8ePHifwYGBgYmBiQAAAcYApK+mIzmAAAAAElFTkSuQmCC",
  "base64",
);

// This deliberately tiny fixture proves HTTP range semantics and the TIFF
// signature only. It is not a renderable COG and must not be used to claim the
// direct STAC-to-COG rendering capability tracked by #537.
const COG_RANGE_FIXTURE = Buffer.concat([
  Buffer.from([0x49, 0x49, 0x2a, 0x00]),
  Buffer.from("Honua deterministic COG range transport fixture v1"),
  Buffer.alloc(80, 0x2e),
]);
const COG_RANGE_CHECKSUM = `sha256:${createHash("sha256").update(COG_RANGE_FIXTURE).digest("hex")}`;
const COG_RANGE_ETAG = '"oahu-range-fixture-v1"';

const OAHU_FOOTPRINT = [
  [-158.08, 21.25],
  [-157.71, 21.25],
  [-157.71, 21.47],
  [-158.08, 21.47],
  [-158.08, 21.25],
];

function rasterAsset(href, overrides = {}) {
  return {
    href,
    title: "Oahu visual COG transport fixture",
    type: "image/tiff; application=geotiff; profile=cloud-optimized",
    roles: ["data", "visual"],
    "proj:code": "EPSG:4326",
    "raster:bands": [
      { name: "red", common_name: "red", data_type: "uint16", nodata: 0, spatial_resolution: 10 },
      { name: "green", common_name: "green", data_type: "uint16", nodata: 0, spatial_resolution: 10 },
      { name: "blue", common_name: "blue", data_type: "uint16", nodata: 0, spatial_resolution: 10 },
    ],
    "file:size": COG_RANGE_FIXTURE.byteLength,
    "file:checksum": COG_RANGE_CHECKSUM,
    ...overrides,
  };
}

const STAC_ITEMS = [
  {
    type: "Feature",
    stac_version: "1.1.0",
    id: "S2A_20260412T211901_OAHU_RANGE_01",
    collection: "sentinel-2-l2a",
    bbox: [-158.08, 21.25, -157.71, 21.47],
    geometry: { type: "Polygon", coordinates: [OAHU_FOOTPRINT] },
    properties: {
      title: "Oahu south shore clear pass",
      datetime: "2026-04-12T21:19:01Z",
      "eo:cloud_cover": 4,
      platform: "sentinel-2a",
      "honua:provider": "Copernicus Sentinel-2 fixture",
      "honua:attribution": "Contains modified Copernicus Sentinel data (fixture metadata only)",
      "honua:license": "CC-BY-4.0 fixture terms",
      "honua:version": "fixture-2026.04.12-v1",
    },
    assets: {
      cog: rasterAsset("/fixtures/imagery/cog/oahu-range-ready.tif"),
      "slow-cog": rasterAsset("/fixtures/imagery/cog/oahu-range-slow.tif", { title: "Slow switch fixture" }),
      "cors-cog": rasterAsset("https://blocked.example.test/oahu-cross-origin.tif", {
        title: "Cross-origin CORS fixture",
      }),
      "no-range-cog": rasterAsset("/fixtures/imagery/cog/oahu-no-range.tif", {
        title: "Server without range support",
      }),
      "unsupported-crs": rasterAsset("/fixtures/imagery/cog/oahu-utm.tif", {
        title: "UTM reprojection-required fixture",
        "proj:code": "EPSG:32604",
      }),
      "unsupported-format": rasterAsset("/fixtures/imagery/cog/oahu-netcdf.nc", {
        title: "Unsupported NetCDF fixture",
        type: "application/x-netcdf",
      }),
      "missing-nodata": rasterAsset("/fixtures/imagery/cog/oahu-missing-nodata.tif", {
        title: "Raster metadata without nodata",
        "raster:bands": [{ name: "red", data_type: "uint16", spatial_resolution: 10 }],
      }),
    },
  },
  {
    type: "Feature",
    stac_version: "1.1.0",
    id: "S2B_20260418T212029_OAHU_CLOUDY_02",
    collection: "sentinel-2-l2a",
    bbox: [-158.02, 21.31, -157.68, 21.63],
    geometry: { type: "Polygon", coordinates: [OAHU_FOOTPRINT] },
    properties: {
      title: "Windward cloudy comparison",
      datetime: "2026-04-18T21:20:29Z",
      "eo:cloud_cover": 64,
      platform: "sentinel-2b",
    },
    assets: { cog: rasterAsset("/fixtures/imagery/cog/oahu-cloudy.tif") },
  },
];

const WMS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service>
    <Title>Oahu Honua Imagery WMS</Title>
    <Abstract>Fixture-safe WMS surface for the Honua imagery and COG quickstart.</Abstract>
  </Service>
  <Capability>
    <Request>
      <GetMap><Format>image/png</Format></GetMap>
      <GetLegendGraphic><Format>image/png</Format></GetLegendGraphic>
    </Request>
    <Layer queryable="0">
      <Name>natural_color</Name>
      <Title>Oahu Natural Color</Title>
      <CRS>EPSG:3857</CRS>
      <CRS>EPSG:4326</CRS>
      <BoundingBox CRS="EPSG:4326" minx="-158.22" miny="21.21" maxx="-157.66" maxy="21.64"/>
      <Style>
        <Name>default</Name>
        <Title>Default natural color</Title>
      </Style>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:imagery-cog:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(),
  });
  if (result.status !== 0) throw new Error("Failed to build the Imagery and COG Quickstart sample.");
}

function serveFile(res, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

function serveJson(res, body) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function servePng(res) {
  res.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "no-store",
  });
  res.end(TILE_PNG);
}

function serveStacSearch(requestUrl, res) {
  const collections = (requestUrl.searchParams.get("collections") ?? "").split(",").filter(Boolean);
  const bbox = (requestUrl.searchParams.get("bbox") ?? "").split(",").map(Number).filter(Number.isFinite);
  const datetime = requestUrl.searchParams.get("datetime");
  const filter = requestUrl.searchParams.get("filter") ?? "";
  const cloudMatch = /eo:cloud_cover["']?\s*<=\s*(\d+(?:\.\d+)?)/i.exec(filter);
  const maxCloudCover = cloudMatch ? Number(cloudMatch[1]) : Number.POSITIVE_INFINITY;
  const limit = Math.max(0, Number(requestUrl.searchParams.get("limit") ?? 20));

  const matches = STAC_ITEMS.filter((item) => {
    if (collections.length > 0 && !collections.includes(item.collection)) return false;
    if ((item.properties["eo:cloud_cover"] ?? Number.POSITIVE_INFINITY) > maxCloudCover) return false;
    if (bbox.length === 4 && !intersectsBbox(item.bbox, bbox)) return false;
    if (datetime && !withinDatetime(item.properties.datetime, datetime)) return false;
    return true;
  });

  serveJson(res, {
    type: "FeatureCollection",
    features: matches.slice(0, limit),
    numberMatched: matches.length,
    numberReturned: Math.min(matches.length, limit),
    links: [],
  });
}

function intersectsBbox(itemBbox, searchBbox) {
  return (
    itemBbox[0] <= searchBbox[2] &&
    itemBbox[2] >= searchBbox[0] &&
    itemBbox[1] <= searchBbox[3] &&
    itemBbox[3] >= searchBbox[1]
  );
}

function withinDatetime(value, interval) {
  const [start, end = start] = interval.split("/");
  const timestamp = Date.parse(value);
  return timestamp >= Date.parse(start) && timestamp <= Date.parse(end);
}

function serveCogRangeFixture(req, res, { supportsRange }) {
  const range = req.headers.range;
  if (!supportsRange || typeof range !== "string") {
    res.writeHead(200, {
      "content-type": "image/tiff",
      "content-length": COG_RANGE_FIXTURE.byteLength,
      etag: COG_RANGE_ETAG,
      "cache-control": "public, max-age=3600",
    });
    res.end(COG_RANGE_FIXTURE);
    return;
  }

  const match = /^bytes=(\d+)-(\d+)?$/.exec(range);
  const start = match ? Number(match[1]) : Number.NaN;
  const requestedEnd = match?.[2] ? Number(match[2]) : COG_RANGE_FIXTURE.byteLength - 1;
  const end = Math.min(requestedEnd, COG_RANGE_FIXTURE.byteLength - 1);
  if (!Number.isInteger(start) || start < 0 || start > end) {
    res.writeHead(416, { "content-range": `bytes */${COG_RANGE_FIXTURE.byteLength}` });
    res.end();
    return;
  }

  const body = COG_RANGE_FIXTURE.subarray(start, end + 1);
  res.writeHead(206, {
    "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${COG_RANGE_FIXTURE.byteLength}`,
    "content-type": "image/tiff",
    "content-length": body.byteLength,
    etag: COG_RANGE_ETAG,
    "cache-control": "public, max-age=3600",
  });
  res.end(body);
}

function serveElevationValue(requestUrl, res) {
  const longitude = Number(requestUrl.searchParams.get("longitude"));
  const latitude = Number(requestUrl.searchParams.get("latitude"));
  const noData = !Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -158.5;
  const elevationMeters = noData
    ? null
    : Math.round((900 + (longitude + 157.9) * 1000 + (latitude - 21.35) * 500) * 10) / 10;
  serveJson(res, {
    longitude,
    latitude,
    elevationMeters,
    noData,
    source: "oahu-terrain-rgb-fixture",
    version: "dem-fixture-v1",
    attribution: "Honua deterministic Terrain-RGB fixture",
    verticalDatum: "EGM96",
    resolutionMeters: 10,
    checksum: "sha256:terrain-rgb-fixture-v1",
    cache: {
      status: "revalidated",
      etag: '"terrain-dem-v1"',
      cacheControl: "private, max-age=60",
    },
  });
}

function maybeServeHonuaFixture(req, requestUrl, res) {
  if (requestUrl.pathname === "/stac/search") {
    serveStacSearch(requestUrl, res);
    return true;
  }

  if (requestUrl.pathname === "/api/v1/terrain/OahuTerrain/elevation/value") {
    serveElevationValue(requestUrl, res);
    return true;
  }

  if (requestUrl.pathname === "/fixtures/imagery/cog/oahu-range-ready.tif") {
    serveCogRangeFixture(req, res, { supportsRange: true });
    return true;
  }

  if (requestUrl.pathname === "/fixtures/imagery/cog/oahu-range-slow.tif") {
    setTimeout(() => {
      if (!res.destroyed) serveCogRangeFixture(req, res, { supportsRange: true });
    }, 150);
    return true;
  }

  if (requestUrl.pathname === "/fixtures/imagery/cog/oahu-no-range.tif") {
    serveCogRangeFixture(req, res, { supportsRange: false });
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuImagery/MapServer/WMS") {
    const request = (requestUrl.searchParams.get("REQUEST") ?? "GetCapabilities").toLowerCase();
    if (request === "getcapabilities") {
      res.writeHead(200, {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(WMS_CAPABILITIES);
      return true;
    }
    servePng(res);
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuCog/ImageServer") {
    serveJson(res, {
      serviceDescription: "Oahu Sentinel-2 COG ImageServer",
      layers: [{ id: 0, name: "oahu_sentinel2_cog" }],
      spatialReference: { wkid: 4326 },
      fullExtent: { xmin: -158.22, ymin: 21.21, xmax: -157.66, ymax: 21.64, spatialReference: { wkid: 4326 } },
      cache: {
        scope: "metadata",
        status: "hit",
        ageMs: 25_000,
        ttlMs: 600_000,
        keyFingerprint: "fixture-oahu-cog",
      },
    });
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuCog/ImageServer/legend") {
    serveJson(res, {
      layers: [
        {
          layerId: 0,
          layerName: "oahu_sentinel2_cog",
          legend: [{ label: "Sentinel-2 visual", imageData: TILE_PNG.toString("base64"), contentType: "image/png" }],
        },
      ],
    });
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuCog/ImageServer/exportImage") {
    serveJson(res, {
      href: "/fixtures/imagery/export/oahu-cog-preview.png",
      width: 512,
      height: 512,
      extent: { xmin: -158.22, ymin: 21.21, xmax: -157.66, ymax: 21.64, spatialReference: { wkid: 4326 } },
      scale: 144_000,
    });
    return true;
  }

  if (/^\/rest\/services\/OahuCog\/ImageServer\/tile\/\d+\/\d+\/\d+$/.test(requestUrl.pathname)) {
    servePng(res);
    return true;
  }

  if (requestUrl.pathname.startsWith("/fixtures/imagery/")) {
    servePng(res);
    return true;
  }

  return false;
}

export async function startImageryCogFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (maybeServeHonuaFixture(req, requestUrl, res)) {
      return;
    }

    const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const staticPath = path.join(distRoot, requestedPath);

    if (staticPath.startsWith(distRoot) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveFile(res, staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (!path.extname(requestUrl.pathname) && fs.existsSync(indexPath)) {
      serveFile(res, indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind Imagery COG fixture server.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeAllConnections?.();
      });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startImageryCogFixtureServer();
  process.stdout.write(`imageryCogUrl=${server.url}\n`);
}
