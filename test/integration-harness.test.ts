/**
 * Pure unit coverage for the integration harness module. The
 * `tryResolveIntegrationConfig` cache lives at module scope, so each
 * test resets the module registry to ensure a clean read.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "HONUA_INTEGRATION_BASE_URL",
  "HONUA_INTEGRATION_SERVICE_ID",
  "HONUA_INTEGRATION_LAYER_ID",
  "HONUA_INTEGRATION_COLLECTION_ID",
  "HONUA_INTEGRATION_TILE_MATRIX_SET",
  "HONUA_INTEGRATION_SEED_PROFILE",
  "HONUA_INTEGRATION_API_KEY",
  "HONUA_INTEGRATION_BEARER_TOKEN",
  "HONUA_INTEGRATION_TIMEOUT_MS",
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

async function loadHarness(): Promise<typeof import("./integration/harness.js")> {
  return import("./integration/harness.js");
}

describe("integration harness env resolution", () => {
  it("returns undefined when HONUA_INTEGRATION_BASE_URL is absent", { timeout: 30_000 }, async () => {
    const mod = await loadHarness();
    expect(mod.tryResolveIntegrationConfig()).toBeUndefined();
  });

  it("applies seeded defaults when only the base URL is set", async () => {
    process.env.HONUA_INTEGRATION_BASE_URL = "http://localhost:5555";
    const mod = await loadHarness();
    const config = mod.tryResolveIntegrationConfig();
    expect(config).toBeDefined();
    expect(config?.baseUrl).toBe("http://localhost:5555");
    expect(config?.serviceId).toBe("test_service_gw0");
    expect(config?.layerId).toBe(1000);
    expect(config?.collectionId).toBe("1000");
    expect(config?.tileMatrixSetId).toBe("WebMercatorQuad");
    expect(config?.seedProfile).toBe("places-roads-v1");
    expect(config?.timeoutMs).toBe(30_000);
    expect(config?.apiKey).toBeUndefined();
    expect(config?.bearerToken).toBeUndefined();
  });

  it("honors overrides for every public env var", async () => {
    process.env.HONUA_INTEGRATION_BASE_URL = "http://server:8080";
    process.env.HONUA_INTEGRATION_SERVICE_ID = "my-svc";
    process.env.HONUA_INTEGRATION_LAYER_ID = "42";
    process.env.HONUA_INTEGRATION_COLLECTION_ID = "roads";
    process.env.HONUA_INTEGRATION_TILE_MATRIX_SET = "WorldCRS84Quad";
    process.env.HONUA_INTEGRATION_SEED_PROFILE = "ogc";
    process.env.HONUA_INTEGRATION_API_KEY = "k";
    process.env.HONUA_INTEGRATION_BEARER_TOKEN = "t";
    process.env.HONUA_INTEGRATION_TIMEOUT_MS = "10000";
    const mod = await loadHarness();
    const config = mod.tryResolveIntegrationConfig();
    expect(config?.serviceId).toBe("my-svc");
    expect(config?.layerId).toBe(42);
    expect(config?.collectionId).toBe("roads");
    expect(config?.tileMatrixSetId).toBe("WorldCRS84Quad");
    expect(config?.seedProfile).toBe("ogc");
    expect(config?.apiKey).toBe("k");
    expect(config?.bearerToken).toBe("t");
    expect(config?.timeoutMs).toBe(10_000);
  });

  it("throws from resolveIntegrationConfig when the base URL is absent", async () => {
    const mod = await loadHarness();
    expect(() => mod.resolveIntegrationConfig()).toThrowError(/HONUA_INTEGRATION_BASE_URL/);
  });
});
