import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import type {
  HonuaFeature,
  HonuaLayerMetadata,
  HonuaOgcFeatureCollectionResponse,
  HonuaOgcFeatureResponse,
  HonuaQueryResponse,
  HonuaServiceMetadata,
  HonuaServicesResponse,
} from "@honua/sdk-js/honua";

export interface MockHonuaRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly headers: http.IncomingHttpHeaders;
}

export interface MockHonuaServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly transientFailures?: Record<string, number>;
}

export interface MockHonuaServer {
  readonly server: http.Server;
  readonly url: string;
  readonly calls: readonly MockHonuaRequest[];
  count(method: string, pathname: string): number;
  close(): Promise<void>;
}

const SERVICE_ID = "CivicRequests";
const LAYER_ID = 0;
const OGC_COLLECTION_ID = "civic-requests";

const FIELDS: HonuaLayerMetadata["fields"] = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID" },
  { name: "name", type: "esriFieldTypeString", alias: "Name" },
  { name: "priority", type: "esriFieldTypeString", alias: "Priority" },
  { name: "status", type: "esriFieldTypeString", alias: "Status" },
];

const FEATURES: readonly HonuaFeature[] = [
  {
    attributes: {
      OBJECTID: 1,
      name: "Harbor access debris",
      priority: "high",
      status: "open",
    },
    geometry: {
      x: -157.8583,
      y: 21.3069,
      spatialReference: { wkid: 4326 },
    },
  },
  {
    attributes: {
      OBJECTID: 2,
      name: "Trailhead sign repair",
      priority: "medium",
      status: "triaged",
    },
    geometry: {
      x: -157.8015,
      y: 21.2767,
      spatialReference: { wkid: 4326 },
    },
  },
  {
    attributes: {
      OBJECTID: 3,
      name: "Drainage inspection",
      priority: "low",
      status: "scheduled",
    },
    geometry: {
      x: -157.7395,
      y: 21.397,
      spatialReference: { wkid: 4326 },
    },
  },
];

export async function startMockHonuaServer(options: MockHonuaServerOptions = {}): Promise<MockHonuaServer> {
  const calls: MockHonuaRequest[] = [];
  const transientFailures = new Map(Object.entries(options.transientFailures ?? {}));
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    calls.push({
      method,
      pathname: requestUrl.pathname,
      search: requestUrl.search,
      headers: req.headers,
    });

    const routeKey = `${method} ${requestUrl.pathname}`;
    const failuresRemaining = transientFailures.get(routeKey) ?? 0;
    if (failuresRemaining > 0) {
      transientFailures.set(routeKey, failuresRemaining - 1);
      serveJson(res, 503, {
        error: {
          code: "fixture_transient_failure",
          message: "Fixture backend asked the SDK retry path to retry this request.",
        },
      });
      return;
    }

    if (!isAuthorized(req, options)) {
      serveJson(res, 401, {
        error: {
          code: "unauthorized",
          message: "Missing or invalid fixture auth header.",
        },
      });
      return;
    }

    if (method !== "GET") {
      serveJson(res, 405, { error: { code: "method_not_allowed" } });
      return;
    }

    if (requestUrl.pathname === "/rest/services") {
      serveJson(res, 200, servicesResponse());
      return;
    }

    if (requestUrl.pathname === `/rest/services/${SERVICE_ID}/FeatureServer`) {
      serveJson(res, 200, serviceMetadata());
      return;
    }

    if (requestUrl.pathname === `/rest/services/${SERVICE_ID}/FeatureServer/${LAYER_ID}`) {
      serveJson(res, 200, layerMetadata());
      return;
    }

    if (requestUrl.pathname === `/rest/services/${SERVICE_ID}/FeatureServer/${LAYER_ID}/query`) {
      serveJson(res, 200, queryResponse(requestUrl.searchParams));
      return;
    }

    if (requestUrl.pathname === "/ogc/features/collections") {
      serveJson(res, 200, {
        collections: [
          {
            id: OGC_COLLECTION_ID,
            title: "Civic requests",
            itemType: "feature",
          },
        ],
      });
      return;
    }

    if (requestUrl.pathname === `/ogc/features/collections/${OGC_COLLECTION_ID}/items`) {
      serveJson(res, 200, ogcItemsResponse(requestUrl.searchParams));
      return;
    }

    serveJson(res, 404, {
      error: {
        code: "not_found",
        message: `No fixture route for ${requestUrl.pathname}`,
      },
    });
  });

  await listen(server, options.port ?? 0, options.host ?? "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock Honua server.");
  }

  return {
    server,
    url: `http://${address.address}:${address.port}`,
    calls,
    count(method: string, pathname: string) {
      return calls.filter((call) => call.method === method && call.pathname === pathname).length;
    },
    async close() {
      await closeServer(server);
    },
  };
}

function isAuthorized(req: http.IncomingMessage, options: MockHonuaServerOptions): boolean {
  if (options.apiKey && req.headers["x-api-key"] !== options.apiKey) {
    return false;
  }
  if (options.bearerToken && req.headers.authorization !== `Bearer ${options.bearerToken}`) {
    return false;
  }
  return true;
}

function servicesResponse(): HonuaServicesResponse {
  return {
    services: [
      {
        name: SERVICE_ID,
        type: "FeatureServer",
      },
    ],
  };
}

function serviceMetadata(): HonuaServiceMetadata {
  return {
    serviceDescription: "Fixture-safe civic request FeatureServer for the Node backend quickstart.",
    layers: [{ id: LAYER_ID, name: "requests" }],
    spatialReference: { wkid: 4326 },
    fullExtent: {
      xmin: -158,
      ymin: 21.2,
      xmax: -157.7,
      ymax: 21.45,
      spatialReference: { wkid: 4326 },
    },
  };
}

function layerMetadata(): HonuaLayerMetadata {
  return {
    id: LAYER_ID,
    name: "requests",
    type: "Feature Layer",
    geometryType: "esriGeometryPoint",
    fields: FIELDS,
    spatialReference: { wkid: 4326 },
    maxRecordCount: 100,
    supportsAttachments: false,
  };
}

function queryResponse(searchParams: URLSearchParams): HonuaQueryResponse {
  const limit = readLimit(searchParams.get("resultRecordCount"), FEATURES.length);
  const returnGeometry = searchParams.get("returnGeometry") !== "false";
  const where = searchParams.get("where") ?? "1=1";
  const features = filterByWhere(where)
    .slice(0, limit)
    .map((feature) => {
      if (returnGeometry) {
        return feature;
      }
      return { attributes: feature.attributes };
    });
  return {
    objectIdFieldName: "OBJECTID",
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326 },
    fields: FIELDS,
    features,
  };
}

function ogcItemsResponse(searchParams: URLSearchParams): HonuaOgcFeatureCollectionResponse {
  const limit = readLimit(searchParams.get("limit"), FEATURES.length);
  const features: HonuaOgcFeatureResponse[] = FEATURES.slice(0, limit).map((feature) => ({
    type: "Feature",
    id: String(feature.attributes.OBJECTID),
    geometry: {
      type: "Point",
      coordinates: [(feature.geometry as { x: number }).x, (feature.geometry as { y: number }).y],
    },
    properties: {
      ...feature.attributes,
    },
  }));
  return {
    type: "FeatureCollection",
    features,
    numberMatched: FEATURES.length,
    numberReturned: features.length,
  };
}

function filterByWhere(where: string): readonly HonuaFeature[] {
  if (/priority\s*=\s*'high'/i.test(where)) {
    return FEATURES.filter((feature) => feature.attributes.priority === "high");
  }
  if (/status\s*=\s*'open'/i.test(where)) {
    return FEATURES.filter((feature) => feature.attributes.status === "open");
  }
  return FEATURES;
}

function readLimit(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function serveJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiKey = process.env.HONUA_MOCK_EXPECT_API_KEY;
  const bearerToken = process.env.HONUA_MOCK_EXPECT_BEARER_TOKEN;
  const port = process.env.HONUA_MOCK_PORT ? Number(process.env.HONUA_MOCK_PORT) : 4455;
  const server = await startMockHonuaServer({
    port,
    apiKey,
    bearerToken,
  });
  const address = server.server.address() as AddressInfo;
  process.stdout.write(`mockHonuaUrl=http://${address.address}:${address.port}\n`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
