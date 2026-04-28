/**
 * Shared integration-test harness. The SDK does not own the Honua Server
 * bootstrap — instead the integration lane is connect-only:
 *
 *   - `HONUA_INTEGRATION_BASE_URL` points at a running server (CI uses
 *     Docker Compose, local devs typically point at `http://localhost:5555`
 *     produced by `honua-server/tests/python/shared/js_test_server.py`).
 *   - {@link integrationSuite} is the public entry point per surface
 *     test file. It calls `describe.skip(...)` when the env var is unset,
 *     so the suite degrades to a no-op rather than failing in
 *     environments that do not have a live server.
 *
 * Tests **must** call SDK methods through {@link runWithDiagnostics}
 * (re-exported here for convenience) so failures carry the standard
 * diagnostic block (request path, status, body excerpt).
 *
 * @module
 */

import { HonuaClient } from "@honua/sdk-js";
import { beforeAll, describe, it } from "vitest";
import {
  type DiagnosticsContext,
  createDiagnosticsInterceptor,
  formatFailureContext,
  runWithDiagnostics,
} from "./diagnostics.js";
import { recordSurface } from "./reporter.js";

export { runWithDiagnostics, formatFailureContext } from "./diagnostics.js";
export type { DiagnosticsContext } from "./diagnostics.js";

/** Env var that gates the entire integration lane. */
export const INTEGRATION_BASE_URL_ENV = "HONUA_INTEGRATION_BASE_URL";

/**
 * Resolved configuration for one integration test run. Defaults match
 * `honua-server/tests/python/shared/js_test_server.py` so a local
 * `python -m tests.python.shared.js_test_server` followed by
 * `HONUA_INTEGRATION_BASE_URL=http://localhost:5555 npm run test:integration`
 * Just Works without any other env wiring.
 */
export interface IntegrationConfig {
  baseUrl: string;
  serviceId: string;
  layerId: number;
  /**
   * OGC API Features collection ID for read tests. Defaults to the
   * numeric layer ID so it resolves through the server's
   * `ResourceValidator` numeric-id fallback against any seed that
   * exposes the configured layer (including the `js_test_server.py`
   * fixture, which names the layer "Test Layer"). Override when the
   * target seed exposes a friendlier collection name like `places`.
   */
  collectionId: string;
  /** OGC Tiles tile-matrix-set used for sparse-tile reads. */
  tileMatrixSetId: string;
  /**
   * Free-form label tying the run to a server seed configuration.
   * Recorded into `integration-meta.json` for telemetry; not sent on
   * the wire.
   */
  seedProfile: string;
  apiKey: string | undefined;
  bearerToken: string | undefined;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SERVICE_ID = "test_service_gw0";
const DEFAULT_LAYER_ID = 1000;
// honua-server resolves OGC collection IDs by layer name first and then by
// numeric layer ID. The js_test_server.py seed gives the layer name
// "Test Layer" (which contains a space and is not URL-friendly), so we use
// the numeric layer ID as the default collection ID — that path round-trips
// through ResourceValidator.ValidateCollectionAsync without depending on the
// human-readable layer name.
const DEFAULT_COLLECTION_ID = String(DEFAULT_LAYER_ID);
const DEFAULT_TILE_MATRIX_SET = "WebMercatorQuad";
const DEFAULT_SEED_PROFILE = "places-roads-v1";

let cachedConfig: IntegrationConfig | undefined;

/**
 * Read and validate every integration env var. Returns `undefined` when
 * `HONUA_INTEGRATION_BASE_URL` is not set so callers can branch on a
 * single value without scattering env reads. Memoized per process so the
 * suite never reparses on every test.
 */
export function tryResolveIntegrationConfig(): IntegrationConfig | undefined {
  if (cachedConfig) return cachedConfig;
  const baseUrl = process.env[INTEGRATION_BASE_URL_ENV]?.trim();
  if (!baseUrl) return undefined;
  cachedConfig = {
    baseUrl,
    serviceId: process.env.HONUA_INTEGRATION_SERVICE_ID?.trim() || DEFAULT_SERVICE_ID,
    layerId: parseIntOrDefault(process.env.HONUA_INTEGRATION_LAYER_ID, DEFAULT_LAYER_ID),
    collectionId: process.env.HONUA_INTEGRATION_COLLECTION_ID?.trim() || DEFAULT_COLLECTION_ID,
    tileMatrixSetId: process.env.HONUA_INTEGRATION_TILE_MATRIX_SET?.trim() || DEFAULT_TILE_MATRIX_SET,
    seedProfile: process.env.HONUA_INTEGRATION_SEED_PROFILE?.trim() || DEFAULT_SEED_PROFILE,
    apiKey: trimToUndefined(process.env.HONUA_INTEGRATION_API_KEY),
    bearerToken: trimToUndefined(process.env.HONUA_INTEGRATION_BEARER_TOKEN),
    timeoutMs: parseIntOrDefault(process.env.HONUA_INTEGRATION_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
  return cachedConfig;
}

/** Throws when the integration suite is not configured. */
export function resolveIntegrationConfig(): IntegrationConfig {
  const config = tryResolveIntegrationConfig();
  if (!config) {
    throw new Error(
      `${INTEGRATION_BASE_URL_ENV} is not set. The integration lane is connect-only — start a Honua Server and set ${INTEGRATION_BASE_URL_ENV}.`,
    );
  }
  return config;
}

/**
 * Build a {@link HonuaClient} bound to one shared diagnostics context.
 * Tests pass that context (returned via the `context` field) into
 * {@link runWithDiagnostics} when wrapping SDK calls.
 */
export interface IntegrationClient {
  client: HonuaClient;
  context: DiagnosticsContext;
  config: IntegrationConfig;
}

export function makeIntegrationClient(): IntegrationClient {
  const config = resolveIntegrationConfig();
  const context: DiagnosticsContext = {};
  const interceptor = createDiagnosticsInterceptor(context);
  const options: ConstructorParameters<typeof HonuaClient>[0] = {
    baseUrl: config.baseUrl,
    interceptors: [interceptor],
    timeoutMs: config.timeoutMs,
  };
  if (config.apiKey) options.apiKey = config.apiKey;
  if (config.bearerToken) options.bearerToken = config.bearerToken;
  const client = new HonuaClient(options);
  return { client, context, config };
}

/**
 * Wrap a per-surface test file. The body callback receives a fresh
 * {@link IntegrationClient} so the harness can defer client construction
 * until the suite is actually scheduled — when
 * `HONUA_INTEGRATION_BASE_URL` is unset the body is replaced by a noop
 * `describe.skip(...)` and `makeIntegrationClient()` is never called.
 *
 * `surface` is recorded into the integration metadata file so the
 * uploaded artifact lists exactly which protocol surfaces the lane
 * exercised on a given run.
 */
export function integrationSuite(name: string, surface: string, fn: (handle: IntegrationClient) => void): void {
  const config = tryResolveIntegrationConfig();
  if (!config) {
    describe.skip(`${name} [surface:${surface}]`, () => {
      it.skip("integration lane disabled (HONUA_INTEGRATION_BASE_URL unset)", () => undefined);
    });
    return;
  }
  describe(`${name} [surface:${surface}]`, () => {
    const handle = makeIntegrationClient();
    beforeAll(() => {
      recordSurface(surface);
    });
    fn(handle);
  });
}

/**
 * Wrap a surface test file whose surface is intentionally not exercised
 * yet (no public SDK adapter, missing seed data, etc.). Always registers
 * `describe.skip` and records the surface as `skipped:<reason>` in the
 * integration metadata so the unsupported list is visible alongside the
 * exercised list. The reason should reference an issue or a concrete
 * cause so future contributors can flip the gap when the dependency is
 * resolved.
 */
export function skippedIntegrationSuite(name: string, surface: string, reason: string, fn: () => void): void {
  if (tryResolveIntegrationConfig()) {
    recordSurface(surface, reason);
  }
  describe.skip(`${name} [surface:${surface}] (skipped: ${reason})`, fn);
}

/**
 * Issue a health probe against the configured base URL. The OGC landing
 * (`/api/v1/admin/capabilities` via {@link HonuaClient.getCompatibility})
 * is the canonical liveness signal because it returns the version
 * information the integration metadata file pins later.
 */
export async function probeServerHealth(client: HonuaClient): Promise<{
  serverVersion: string;
  releaseChannel: string;
}> {
  const compatibility = await client.getCompatibility();
  return {
    serverVersion: compatibility.serverVersion,
    releaseChannel: compatibility.releaseChannel,
  };
}

function parseIntOrDefault(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function trimToUndefined(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
