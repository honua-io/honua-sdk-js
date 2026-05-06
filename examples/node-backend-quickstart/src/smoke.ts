import { startMockHonuaServer } from "./mock-honua.js";
import { startNodeBackendQuickstartServer } from "./server.js";

const SMOKE_API_KEY = "node-backend-smoke-key";

const mock = await startMockHonuaServer({ apiKey: SMOKE_API_KEY });
const app = await startNodeBackendQuickstartServer({
  config: {
    port: 0,
    honuaBaseUrl: mock.url,
    apiKey: SMOKE_API_KEY,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
  },
});

try {
  const services = await readJson(`${app.url}/api/services`);
  const features = await readJson(`${app.url}/api/features?where=priority%20%3D%20'high'&limit=1`);
  const ogc = await readJson(`${app.url}/api/ogc/items?limit=2`);

  const serviceList = readArray(services, "services");
  const featureList = readArray(features, "features");
  const ogcFeatureCollection = readRecord(ogc, "featureCollection");
  const ogcFeatureList = readArray(ogcFeatureCollection, "features");

  assertArrayLength(serviceList, 1, "services");
  assertArrayLength(featureList, 1, "features");
  assertArrayLength(ogcFeatureList, 2, "ogc features");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      backendUrl: app.url,
      honuaCalls: mock.calls.length,
      services: serviceList.length,
      features: featureList.length,
      ogcFeatures: ogcFeatureList.length,
    })}\n`,
  );
} finally {
  await app.close();
  await mock.close();
}

async function readJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      "x-request-id": "node-backend-smoke",
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`Smoke request failed ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = source[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an array.`);
  }
  return value;
}

function assertArrayLength(value: unknown, expected: number, label: string): void {
  if (!Array.isArray(value) || value.length !== expected) {
    throw new Error(`Expected ${label} length ${expected}, received ${JSON.stringify(value)}`);
  }
}
