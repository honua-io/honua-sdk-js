import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");
const locatorName = "World";
const geocodeBasePath = `/rest/services/${locatorName}/GeocodeServer`;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const FIXTURE_BUILD_ENV = {
  VITE_HONUA_GEOCODING_LOCATOR_NAME: locatorName,
  VITE_HONUA_GEOCODING_INITIAL_QUERY: "Honolulu Hale",
  VITE_HONUA_GEOCODING_COUNTRY_CODES: "US",
  VITE_HONUA_GEOCODING_MAX_RESULTS: "5",
  VITE_HONUA_GEOCODING_MAX_SUGGESTIONS: "5",
};

const PLACES = [
  {
    name: "Honolulu Hale",
    address: "Honolulu Hale, 530 S King St, Honolulu, HI 96813",
    longitude: -157.85833,
    latitude: 21.30455,
    score: 100,
    attributes: {
      Addr_type: "POI",
      City: "Honolulu",
      Region: "HI",
      PlaceName: "Honolulu Hale",
    },
  },
  {
    name: "Ala Moana Center",
    address: "Ala Moana Center, 1450 Ala Moana Blvd, Honolulu, HI 96814",
    longitude: -157.84365,
    latitude: 21.29118,
    score: 98,
    attributes: {
      Addr_type: "POI",
      City: "Honolulu",
      Region: "HI",
      PlaceName: "Ala Moana Center",
    },
  },
  {
    name: "Daniel K. Inouye International Airport",
    address: "Daniel K. Inouye International Airport, 300 Rodgers Blvd, Honolulu, HI 96819",
    longitude: -157.92507,
    latitude: 21.31869,
    score: 96,
    attributes: {
      Addr_type: "POI",
      City: "Honolulu",
      Region: "HI",
      PlaceName: "Daniel K. Inouye International Airport",
    },
  },
  {
    name: "Kapiolani Park",
    address: "Kapiolani Park, 3840 Paki Ave, Honolulu, HI 96815",
    longitude: -157.81983,
    latitude: 21.26772,
    score: 94,
    attributes: {
      Addr_type: "POI",
      City: "Honolulu",
      Region: "HI",
      PlaceName: "Kapiolani Park",
    },
  },
];

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:geocoding:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(FIXTURE_BUILD_ENV),
  });

  if (result.status !== 0) {
    throw new Error("Failed to build the geocoding quickstart before starting the mock server.");
  }
}

function serveBuffer(res, buffer, filePath) {
  const extension = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function serveJson(res, body) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function normalizedTokens(value) {
  return value
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function matchesPlace(place, query) {
  const haystack = `${place.name} ${place.address}`.toLowerCase();
  return normalizedTokens(query).every((token) => haystack.includes(token));
}

function findPlaces(query, limit) {
  const matches = PLACES.filter((place) => matchesPlace(place, query));
  return matches.slice(0, limit);
}

function toCandidate(place) {
  return {
    address: place.address,
    location: { x: place.longitude, y: place.latitude },
    score: place.score,
    attributes: place.attributes,
  };
}

function distanceSquared(place, longitude, latitude) {
  return (place.longitude - longitude) ** 2 + (place.latitude - latitude) ** 2;
}

function nearestPlace(longitude, latitude) {
  return PLACES.reduce(
    (best, place) => {
      const distance = distanceSquared(place, longitude, latitude);
      return distance < best.distance ? { place, distance } : best;
    },
    { place: PLACES[0], distance: Number.POSITIVE_INFINITY },
  );
}

function maybeServeGeocodingFixture(requestUrl, res) {
  if (requestUrl.pathname === `${geocodeBasePath}/findAddressCandidates`) {
    const query = requestUrl.searchParams.get("singleLine") ?? "";
    const maxLocations = Number(requestUrl.searchParams.get("maxLocations") ?? "5");
    serveJson(res, {
      spatialReference: { wkid: 4326 },
      candidates: findPlaces(query, Number.isFinite(maxLocations) ? maxLocations : 5).map(toCandidate),
    });
    return true;
  }

  if (requestUrl.pathname === `${geocodeBasePath}/suggest`) {
    const query = requestUrl.searchParams.get("text") ?? "";
    const maxSuggestions = Number(requestUrl.searchParams.get("maxSuggestions") ?? "5");
    serveJson(res, {
      suggestions: findPlaces(query, Number.isFinite(maxSuggestions) ? maxSuggestions : 5).map((place) => ({
        text: place.address,
        magicKey: `fixture:${place.name.toLowerCase().replaceAll(" ", "-")}`,
        isCollection: false,
      })),
    });
    return true;
  }

  if (requestUrl.pathname === `${geocodeBasePath}/reverseGeocode`) {
    const [longitudeText, latitudeText] = (requestUrl.searchParams.get("location") ?? "").split(",");
    const longitude = Number(longitudeText);
    const latitude = Number(latitudeText);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      serveJson(res, {
        error: { code: 400, message: "Invalid reverse geocode location", details: [] },
      });
      return true;
    }

    const { place, distance } = nearestPlace(longitude, latitude);
    if (distance > 0.004) {
      serveJson(res, {
        error: { code: 400, message: "No address found", details: [] },
      });
      return true;
    }

    serveJson(res, {
      address: {
        Match_addr: place.address,
        ...place.attributes,
      },
      location: { x: place.longitude, y: place.latitude },
    });
    return true;
  }

  return false;
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.join(distRoot, requestedPath);
  if (!absolutePath.startsWith(distRoot)) return undefined;
  return absolutePath;
}

export async function startGeocodingFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (maybeServeGeocodingFixture(requestUrl, res)) {
      return;
    }

    const staticPath = resolveStaticPath(requestUrl.pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveBuffer(res, fs.readFileSync(staticPath), staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (requestUrl.pathname === "/" || !path.extname(requestUrl.pathname)) {
      serveBuffer(res, fs.readFileSync(indexPath), indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the geocoding fixture server.");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startGeocodingFixtureServer();
  process.stdout.write(`geocodingMockUrl=${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
