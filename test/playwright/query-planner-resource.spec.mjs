import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const distRoot = path.join(projectRoot, "dist", "src");

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>opaque GeoParquet plan</title>");
      return;
    }
    if (!pathname.startsWith("/dist/src/")) {
      response.writeHead(404).end("Not found");
      return;
    }
    const filePath = path.resolve(projectRoot, pathname.slice(1));
    if (!filePath.startsWith(`${distRoot}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(fs.readFileSync(filePath));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("browser planning and execution use the same opaque GeoParquet resolver contract", async ({ page }) => {
  const server = await startServer();
  const pageErrors = [];
  const requests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    const evidence = await page.evaluate(async (baseUrl) => {
      const planner = await import(`${baseUrl}/dist/src/query-planner/index.js`);
      const contract = await import(`${baseUrl}/dist/src/contract/types.js`);
      const authorizationContextId = "tenant:browser/role:analyst";
      const privateSource =
        "https://browser-secret@example.test/parcels.parquet?X-Amz-Signature=browser-signature-secret";
      const registry = planner.createGeoParquetResourceRegistry({ resolver: "io.honua.browser-test" });
      const handle = registry.register({
        id: "parcels:browser",
        authorizationContextId,
        resourceVersion: "snapshot:3",
        sources: [privateSource],
      });
      const descriptor = {
        id: "descriptor-id",
        protocol: "geoparquet",
        locator: {
          url: privateSource,
          geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb" },
        },
        capabilities: contract.capabilities(["query", "queryAggregate"]),
      };
      const plan = planner.explainQuery({
        descriptor,
        geoparquetResource: handle,
        authorizationScope: ["data:read"],
        schemaVersion: "schema:2",
        sourceVersion: "source:8",
        query: { where: "population > 10", pagination: { limit: 1 } },
      });
      let receivedPrivateSource = false;
      const adapter = {
        async executeResolvedQuery(input) {
          receivedPrivateSource = input.sources.length === 1 && input.sources[0] === privateSource;
          return { features: [{ attributes: { id: 7 } }], exceededTransferLimit: false };
        },
      };
      const source = {
        descriptor,
        capabilities: descriptor.capabilities,
        protocol() {
          return adapter;
        },
      };
      const execution = await planner.executeQueryPlan(plan, source, {
        authorizationContextId,
        geoParquetResourceResolver: registry.resolver,
        authorizationScope: ["data:read"],
        schemaVersion: "schema:2",
        sourceVersion: "source:8",
      });
      const surfaces = [JSON.stringify(plan), planner.serializeQueryPlan(plan), planner.queryPlanCacheKey(plan)];
      const markers = ["browser-secret", "browser-signature-secret", "X-Amz-Signature"];
      registry.dispose();
      return {
        planVersion: plan.version,
        compiler: plan.steps[0]?.compiled.compiler,
        resultId: execution.result.features[0]?.attributes.id,
        receivedPrivateSource,
        surfacesRedacted: surfaces.every((surface) => markers.every((marker) => !surface.includes(marker))),
      };
    }, origin);

    expect(evidence).toEqual({
      planVersion: "2.0",
      compiler: "duckdb-sql-v2",
      resultId: 7,
      receivedPrivateSource: true,
      surfacesRedacted: true,
    });
    expect(pageErrors).toEqual([]);
    expect(requests.every((requestUrl) => new URL(requestUrl).origin === origin)).toBe(true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
