import { afterEach, describe, expect, it } from "vitest";

import { type MockHonuaServer, startMockHonuaServer } from "../examples/node-backend-quickstart/src/mock-honua.js";
import {
  type NodeBackendLogger,
  type NodeBackendQuickstartServer,
  createNodeBackendQuickstartConfig,
  startNodeBackendQuickstartServer,
} from "../examples/node-backend-quickstart/src/server.js";

interface MemoryLogEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const startedServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  const servers = startedServers.splice(0);
  await Promise.all(servers.map((server) => server.close()));
});

describe("Node backend quickstart sample", () => {
  it("proxies service discovery with backend-held API key auth and structured logs", async () => {
    const logger = createMemoryLogger();
    const { mock, app } = await startFixturePair({
      logger,
      apiKey: "fixture-api-key",
    });

    const response = await fetch(`${app.url}/api/services`, {
      headers: { "x-request-id": "services-test" },
    });
    const body = (await response.json()) as {
      services: Array<{ name: string; type: string }>;
    };

    expect(response.status).toBe(200);
    expect(body.services).toEqual([{ name: "CivicRequests", type: "FeatureServer" }]);
    expect(mock.calls.find((call) => call.pathname === "/rest/services")?.headers["x-api-key"]).toBe("fixture-api-key");
    expect(logger.entries.some((entry) => entry.message === "honua.auth.credentials")).toBe(true);
    expect(logger.entries.some((entry) => entry.message === "honua.request.complete")).toBe(true);
    expect(logger.entries.find((entry) => entry.message === "http.request.complete")?.fields).toMatchObject({
      requestId: "services-test",
      path: "/api/services",
      statusCode: 200,
    });
  });

  it("exposes FeatureServer and OGC API Features routes from the SDK in Node", async () => {
    expect("window" in globalThis).toBe(false);
    const { app } = await startFixturePair();

    const featureResponse = await fetch(`${app.url}/api/features?where=priority%20%3D%20'high'&limit=1`);
    const features = (await featureResponse.json()) as {
      source: string;
      serviceId: string;
      layerId: number;
      features: Array<{ attributes: { priority: string } }>;
    };

    expect(featureResponse.status).toBe(200);
    expect(features).toMatchObject({
      source: "FeatureServer",
      serviceId: "CivicRequests",
      layerId: 0,
    });
    expect(features.features).toHaveLength(1);
    expect(features.features[0]?.attributes.priority).toBe("high");

    const ogcResponse = await fetch(`${app.url}/api/ogc/items?limit=2`);
    const ogc = (await ogcResponse.json()) as {
      source: string;
      collectionId: string;
      featureCollection: { type: string; features: Array<{ type: string }> };
    };

    expect(ogcResponse.status).toBe(200);
    expect(ogc.source).toBe("ogc-features");
    expect(ogc.collectionId).toBe("civic-requests");
    expect(ogc.featureCollection.type).toBe("FeatureCollection");
    expect(ogc.featureCollection.features).toHaveLength(2);
  });

  it("uses SDK retry settings for transient Honua failures", async () => {
    const { mock, app } = await startFixturePair({
      transientFailures: {
        "GET /rest/services": 1,
      },
      retryMaxRetries: 1,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    const response = await fetch(`${app.url}/api/services`);
    const body = (await response.json()) as { services: unknown[] };

    expect(response.status).toBe(200);
    expect(body.services).toHaveLength(1);
    expect(mock.count("GET", "/rest/services")).toBe(2);
  });

  it("returns problem JSON for validation and upstream SDK errors", async () => {
    const { app } = await startFixturePair({
      serviceId: "MissingService",
    });

    const invalidLimitResponse = await fetch(`${app.url}/api/features?limit=abc`, {
      headers: { "x-request-id": "bad-limit" },
    });
    const invalidLimit = (await invalidLimitResponse.json()) as {
      error: { status: number; code: string; requestId: string };
    };

    expect(invalidLimitResponse.status).toBe(400);
    expect(invalidLimit.error).toMatchObject({
      status: 400,
      code: "invalid_limit",
      requestId: "bad-limit",
    });

    const upstreamResponse = await fetch(`${app.url}/api/features?limit=1`, {
      headers: { "x-request-id": "upstream-error" },
    });
    const upstream = (await upstreamResponse.json()) as {
      error: { status: number; code: string; upstreamStatus: number; requestId: string };
    };

    expect(upstreamResponse.status).toBe(502);
    expect(upstream.error).toMatchObject({
      status: 502,
      code: "honua_upstream_error",
      upstreamStatus: 404,
      requestId: "upstream-error",
    });
  });
});

async function startFixturePair(
  options: {
    readonly logger?: MemoryLogger;
    readonly apiKey?: string;
    readonly transientFailures?: Record<string, number>;
    readonly serviceId?: string;
    readonly retryMaxRetries?: number;
    readonly retryBaseDelayMs?: number;
    readonly retryMaxDelayMs?: number;
  } = {},
): Promise<{ mock: MockHonuaServer; app: NodeBackendQuickstartServer }> {
  const mock = await startMockHonuaServer({
    apiKey: options.apiKey,
    transientFailures: options.transientFailures,
  });
  const configOverrides = createNodeBackendQuickstartConfig({
    port: 0,
    honuaBaseUrl: mock.url,
    apiKey: options.apiKey,
    retryMaxRetries: options.retryMaxRetries ?? 2,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 1,
    retryMaxDelayMs: options.retryMaxDelayMs ?? 1,
    ...(options.serviceId ? { serviceId: options.serviceId } : {}),
  });
  const app = await startNodeBackendQuickstartServer({
    config: configOverrides,
    logger: options.logger ?? createMemoryLogger(),
  });
  startedServers.push(app, mock);
  return { mock, app };
}

interface MemoryLogger extends NodeBackendLogger {
  readonly entries: readonly MemoryLogEntry[];
}

function createMemoryLogger(): MemoryLogger {
  const entries: MemoryLogEntry[] = [];
  return {
    entries,
    info(message, fields = {}) {
      entries.push({ level: "info", message, fields });
    },
    warn(message, fields = {}) {
      entries.push({ level: "warn", message, fields });
    },
    error(message, fields = {}) {
      entries.push({ level: "error", message, fields });
    },
  };
}
