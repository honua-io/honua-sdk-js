import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");
const serviceId = "OahuTerrain";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
};

const TERRAIN_RGB_TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mO8ePHifwYGBgYmBiQAAAcYApK+mIzmAAAAAElFTkSuQmCC",
  "base64",
);

const FIXTURE_LINE = [
  [-157.965, 21.354],
  [-157.91, 21.385],
  [-157.84, 21.422],
  [-157.78, 21.446],
];

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:terrain-elevation:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_HONUA_TERRAIN_SERVICE_ID: serviceId,
    },
  });
  if (result.status !== 0) throw new Error("Failed to build the Terrain-RGB Elevation sample.");
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
  res.end(TERRAIN_RGB_TILE_PNG);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function elevationSample(coordinate, endpointPath, distanceMeters) {
  const [longitude, latitude] = coordinate;
  return {
    longitude,
    latitude,
    elevationMeters: estimateFixtureElevationMeters(coordinate),
    verticalDatum: "EGM96",
    resolutionMeters: 10,
    source: "fixture-terrain-rgb",
    endpointPath,
    ...(distanceMeters === undefined ? {} : { distanceMeters }),
  };
}

function profileForLine(line, endpointPath, sampleCount = 8) {
  const sampledLine = sampleLine(line, sampleCount);
  const samples = sampledLine.map((sample) => elevationSample(sample.coordinate, endpointPath, sample.distanceMeters));
  const elevations = samples.map((sample) => sample.elevationMeters);
  let gainMeters = 0;
  let lossMeters = 0;
  for (let index = 1; index < elevations.length; index += 1) {
    const delta = elevations[index] - elevations[index - 1];
    if (delta > 0) {
      gainMeters += delta;
    } else {
      lossMeters += Math.abs(delta);
    }
  }
  return {
    line,
    samples,
    minElevationMeters: Math.min(...elevations),
    maxElevationMeters: Math.max(...elevations),
    gainMeters: Math.round(gainMeters * 10) / 10,
    lossMeters: Math.round(lossMeters * 10) / 10,
    source: "fixture-terrain-rgb",
  };
}

function estimateFixtureElevationMeters([longitude, latitude]) {
  const eastRamp = (longitude + 158.02) * 960;
  const northRamp = (latitude - 21.28) * 2200;
  const ridge = Math.sin((longitude + 157.91) * 19) * 160 + Math.cos((latitude - 21.39) * 24) * 85;
  return Math.round(Math.max(12, 260 + eastRamp + northRamp + ridge) * 10) / 10;
}

function sampleLine(line, count) {
  const segmentLengths = line.slice(1).map((point, index) => haversineMeters(line[index], point));
  const total = segmentLengths.reduce((sum, value) => sum + value, 0);
  const safeCount = Math.max(2, count);
  return Array.from({ length: safeCount }, (_, index) => {
    const targetDistance = total * (index / (safeCount - 1));
    return {
      coordinate: interpolateLine(line, segmentLengths, targetDistance),
      distanceMeters: Math.round(targetDistance),
    };
  });
}

function interpolateLine(line, segmentLengths, targetDistance) {
  let traversed = 0;
  for (let index = 0; index < segmentLengths.length; index += 1) {
    const segmentLength = segmentLengths[index];
    if (targetDistance <= traversed + segmentLength || index === segmentLengths.length - 1) {
      const start = line[index];
      const end = line[index + 1];
      const ratio = segmentLength === 0 ? 0 : (targetDistance - traversed) / segmentLength;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    traversed += segmentLength;
  }
  return line.at(-1);
}

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const phi1 = degreesToRadians(lat1);
  const phi2 = degreesToRadians(lat2);
  const deltaPhi = degreesToRadians(lat2 - lat1);
  const deltaLambda = degreesToRadians(lon2 - lon1);
  const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function degreesToRadians(value) {
  return (value * Math.PI) / 180;
}

async function maybeServeHonuaFixture(req, requestUrl, res) {
  if (requestUrl.pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (requestUrl.pathname === `/rest/services/${serviceId}/ImageServer`) {
    serveJson(res, {
      serviceDescription: "Oahu Terrain-RGB Elevation ImageServer",
      layers: [{ id: 0, name: "oahu_10m_dem_terrain_rgb" }],
      spatialReference: { wkid: 4326 },
      fullExtent: { xmin: -158.08, ymin: 21.28, xmax: -157.72, ymax: 21.52, spatialReference: { wkid: 4326 } },
      pixelType: "U8",
      bandCount: 3,
      terrainEncoding: "mapbox-terrain-rgb",
      cache: {
        scope: "metadata",
        status: "hit",
        ageMs: 18_000,
        ttlMs: 600_000,
        keyFingerprint: "fixture-oahu-terrain-rgb",
      },
    });
    return true;
  }

  if (new RegExp(`^/rest/services/${serviceId}/ImageServer/tile/\\d+/\\d+/\\d+$`).test(requestUrl.pathname)) {
    servePng(res);
    return true;
  }

  const valuePath = `/api/v1/terrain/${serviceId}/elevation/value`;
  if (requestUrl.pathname === valuePath) {
    const longitude = Number(requestUrl.searchParams.get("longitude") ?? requestUrl.searchParams.get("x"));
    const latitude = Number(requestUrl.searchParams.get("latitude") ?? requestUrl.searchParams.get("y"));
    serveJson(res, elevationSample([longitude, latitude], valuePath));
    return true;
  }

  const profilePath = `/api/v1/terrain/${serviceId}/elevation/profile`;
  if (requestUrl.pathname === profilePath) {
    const body = req.method === "POST" ? await readJsonBody(req) : {};
    const line =
      body?.geometry?.type === "LineString" && Array.isArray(body.geometry.coordinates)
        ? body.geometry.coordinates
        : FIXTURE_LINE;
    const sampleCount = Number.isInteger(body?.sampleCount) ? body.sampleCount : 8;
    serveJson(res, profileForLine(line, profilePath, sampleCount));
    return true;
  }

  return false;
}

export async function startTerrainElevationFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    try {
      if (await maybeServeHonuaFixture(req, requestUrl, res)) {
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
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "Unknown fixture server error");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind Terrain-RGB fixture server.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startTerrainElevationFixtureServer();
  process.stdout.write(`terrainElevationUrl=${server.url}\n`);
}
