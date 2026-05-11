import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

function getProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function readFixtureQueryResponse(projectRoot) {
  return JSON.parse(
    fs.readFileSync(
      path.join(projectRoot, "docs", "examples", "cesium-route-playback", "fixtures", "route-query-response.json"),
      "utf8",
    ),
  );
}

function createCapabilitiesEnvelope() {
  return {
    success: true,
    data: {
      metadataApiVersions: ["v1"],
      resourceKinds: [],
      manifestSupported: true,
      manifestDryRunSupported: true,
      manifestPruneSupported: true,
      compatibility: {
        serverVersion: "1.2.0",
        releaseChannel: "preview",
        controlPlaneApi: {
          major: 1,
          basePath: "/api/v1/admin",
          deprecated: false,
        },
        metadataSchemas: [
          {
            version: "v1",
            deprecated: false,
          },
        ],
        features: {
          metadataResources: true,
          manifestExport: true,
          manifestApply: true,
          manifestDryRun: true,
          manifestPrune: true,
        },
      },
    },
  };
}

function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function resolveStaticPath(projectRoot, requestPath) {
  const exampleRoot = path.join(projectRoot, "docs", "examples", "cesium-route-playback");
  if (requestPath === "/") {
    return path.join(exampleRoot, "index.html");
  }
  if (requestPath === "/app.mjs" || requestPath === "/data-path.mjs" || requestPath.startsWith("/fixtures/")) {
    return path.join(exampleRoot, requestPath.slice(1));
  }
  if (requestPath.startsWith("/dist/src/") || requestPath.startsWith("/node_modules/cesium/Build/Cesium/")) {
    return path.join(projectRoot, requestPath.slice(1));
  }
  return null;
}

function startServer(projectRoot) {
  const fixtureQueryResponse = readFixtureQueryResponse(projectRoot);
  const requestLog = [];

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/mock-honua/api/v1/admin/capabilities") {
      requestLog.push({
        path: requestUrl.pathname,
        search: requestUrl.searchParams.toString(),
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(createCapabilitiesEnvelope()));
      return;
    }

    if (requestUrl.pathname === "/mock-honua/rest/services/transport/FeatureServer/0/query") {
      requestLog.push({
        path: requestUrl.pathname,
        search: requestUrl.searchParams.toString(),
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(fixtureQueryResponse));
      return;
    }

    const filePath = resolveStaticPath(projectRoot, requestUrl.pathname);
    if (filePath && filePath.startsWith(projectRoot) && fs.existsSync(filePath)) {
      res.writeHead(200, { "content-type": mimeTypeFor(filePath) });
      res.end(fs.readFileSync(filePath));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, requestLog });
    });
  });
}

async function getServerUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind Cesium example smoke server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function loadExample(page, targetUrl) {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(targetUrl);
  await expect.poll(async () => page.evaluate(() => window.__cesiumRoutePlaybackDone === true)).toBe(true);

  const error = await page.evaluate(() => window.__cesiumRoutePlaybackError);
  const result = await page.evaluate(() => window.__cesiumRoutePlaybackResult);

  expect(pageErrors).toEqual([]);
  expect(error).toBeNull();
  return result;
}

test("Cesium route playback example runs in fixture mode", async ({ page }) => {
  const projectRoot = getProjectRoot();
  const { server } = await startServer(projectRoot);

  try {
    const serverUrl = await getServerUrl(server);
    const result = await loadExample(page, serverUrl);

    expect(result).toMatchObject({
      sourceMode: "fixture",
      routeName: "Honolulu Ridge Shuttle",
      routeId: "route-playback-demo",
      featureCount: 1,
      vertexCount: 8,
      hasZ: true,
      terrainEnabled: false,
      terrainMode: "ellipsoid",
      heightMode: "source-z-unverified",
      entityCount: 4,
    });
    expect(result.preprocessingSteps).toContain(
      "Loaded a checked-in Honua FeatureServer/query fixture for deterministic playback.",
    );
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});

test("Cesium route playback example exercises the live Honua query path", async ({ page }) => {
  const projectRoot = getProjectRoot();
  const { server, requestLog } = await startServer(projectRoot);

  try {
    const serverUrl = await getServerUrl(server);
    const params = new URLSearchParams({
      mode: "live",
      baseUrl: "/mock-honua",
      serviceId: "transport",
      layerId: "0",
      where: "route_id = 'route-playback-demo'",
    });

    const result = await loadExample(page, `${serverUrl}/?${params.toString()}`);

    expect(result.sourceMode).toBe("live");
    expect(result.compatibilitySupported).toBe(true);
    expect(typeof result.requestDurationMs).toBe("number");
    expect(result.queryRequest).toMatchObject({
      serviceId: "transport",
      layerId: 0,
      where: "route_id = 'route-playback-demo'",
      outSr: 4326,
      returnGeometry: true,
      resultRecordCount: 1,
      extraParams: {
        outSr: 4326,
        returnZ: true,
      },
    });

    expect(requestLog).toHaveLength(2);
    expect(requestLog[0]?.path).toBe("/mock-honua/api/v1/admin/capabilities");
    expect(requestLog[1]?.path).toBe("/mock-honua/rest/services/transport/FeatureServer/0/query");
    const query = new URLSearchParams(requestLog[1]?.search ?? "");
    expect(query.get("outSR") ?? query.get("outSr")).toBe("4326");
    expect(requestLog[1]?.search).toContain("returnGeometry=true");
    expect(requestLog[1]?.search).toContain("returnZ=true");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
