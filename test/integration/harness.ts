/**
 * Shared integration-test harness. The test code connects to a running Honua
 * Server via `HONUA_INTEGRATION_BASE_URL`; it does not own the server bootstrap
 * itself. CI provides that server: the `Integration + Conformance` job in
 * `.github/workflows/integration.yml` spins the pinned `honua-server:nightly`
 * plus Redis and Postgres inside the workflow (self-contained mode) and seeds
 * it, or connects to an external deployment when a base URL is configured.
 *
 *   - `HONUA_INTEGRATION_BASE_URL` points at that server (CI's in-workflow
 *     container, or a local dev's `http://localhost:5555` produced by
 *     `honua-server/tests/python/shared/js_test_server.py`).
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

import { HonuaCapabilityNotSupportedError, HonuaClient, HonuaHttpError } from "@honua/sdk-js";
import { beforeAll, describe, it } from "vitest";
import { type DiagnosticsContext, createDiagnosticsInterceptor } from "./diagnostics.js";
import { recordSurface } from "./reporter.js";

export { runWithDiagnostics, formatFailureContext } from "./diagnostics.js";
export type { DiagnosticsContext } from "./diagnostics.js";
export { recordSurface } from "./reporter.js";

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
  /** Optional ImageServer service ID for raster catalog / export coverage. */
  imageServiceId: string | undefined;
  /** Optional GPServer service ID for submit / job status coverage. */
  gpServiceId: string | undefined;
  /** Optional GPServer task name when the seed registers task-scoped jobs. */
  gpTaskName: string | undefined;
  /** STAC collection ID used for collection/item probes. Defaults to `collectionId`. */
  stacCollectionId: string;
  /** Optional WFS endpoint URL; set with `HONUA_INTEGRATION_WFS_ENDPOINT_URL`. */
  wfsEndpointUrl: string | undefined;
  /** Optional WFS feature type; set with `HONUA_INTEGRATION_WFS_TYPE_NAME`. */
  wfsTypeName: string | undefined;
  /** OData service root path. Defaults to Honua Server's `/odata`. */
  odataBasePath: string;
  /** OData entity set / navigation path. Defaults to the configured layer's features. */
  odataEntitySet: string;
  /** Optional GeocodeServer locator name; set when the seed exposes a locator. */
  geocodingLocatorName: string | undefined;
  /** Probe text used by geocoding coverage when a locator is configured. */
  geocodingProbeText: string;
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
const DEFAULT_ODATA_BASE_PATH = "/odata";
const DEFAULT_GEOCODING_PROBE_TEXT = "Honolulu";

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
  const layerId = parseIntOrDefault(process.env.HONUA_INTEGRATION_LAYER_ID, DEFAULT_LAYER_ID);
  const collectionId = process.env.HONUA_INTEGRATION_COLLECTION_ID?.trim() || DEFAULT_COLLECTION_ID;
  cachedConfig = {
    baseUrl,
    serviceId: process.env.HONUA_INTEGRATION_SERVICE_ID?.trim() || DEFAULT_SERVICE_ID,
    layerId,
    collectionId,
    tileMatrixSetId: process.env.HONUA_INTEGRATION_TILE_MATRIX_SET?.trim() || DEFAULT_TILE_MATRIX_SET,
    imageServiceId: trimToUndefined(process.env.HONUA_INTEGRATION_IMAGE_SERVICE_ID),
    gpServiceId: trimToUndefined(process.env.HONUA_INTEGRATION_GP_SERVICE_ID),
    gpTaskName: trimToUndefined(process.env.HONUA_INTEGRATION_GP_TASK_NAME),
    stacCollectionId: process.env.HONUA_INTEGRATION_STAC_COLLECTION_ID?.trim() || collectionId,
    wfsEndpointUrl: trimToUndefined(process.env.HONUA_INTEGRATION_WFS_ENDPOINT_URL),
    wfsTypeName: trimToUndefined(process.env.HONUA_INTEGRATION_WFS_TYPE_NAME),
    odataBasePath: process.env.HONUA_INTEGRATION_ODATA_BASE_PATH?.trim() || DEFAULT_ODATA_BASE_PATH,
    odataEntitySet: process.env.HONUA_INTEGRATION_ODATA_ENTITY_SET?.trim() || `Layers(${String(layerId)})/Features`,
    geocodingLocatorName: trimToUndefined(process.env.HONUA_INTEGRATION_GEOCODING_LOCATOR),
    geocodingProbeText: process.env.HONUA_INTEGRATION_GEOCODING_PROBE_TEXT?.trim() || DEFAULT_GEOCODING_PROBE_TEXT,
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
      `${INTEGRATION_BASE_URL_ENV} is not set. The integration suites connect to a running Honua Server — start one (CI spins a self-contained container; see .github/workflows/integration.yml) and set ${INTEGRATION_BASE_URL_ENV}.`,
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

/**
 * HTTP statuses that mean "this protocol surface is not published on the
 * target seed" rather than "the request was malformed / the server is
 * broken". A surface probe that fails with one of these is a clean,
 * expected capability gap and should skip with a reason; any other failure
 * is a real defect and must surface loudly.
 */
const CAPABILITY_GAP_STATUSES = new Set([404, 405, 501]);

/** A classified capability gap: the surface is legitimately absent. */
export interface CapabilityGap {
  reason: string;
}

/**
 * Decide whether a thrown SDK error means the target server simply does not
 * publish the probed surface (a clean skip) versus a genuine failure (which
 * must be re-thrown so the lane fails loudly). Returns a {@link CapabilityGap}
 * with an explicit reason for the former and `undefined` for the latter.
 *
 * Used by the runtime-gated surfaces (`ogc-records`, `grpc`, `realtime`) that
 * can only discover capability by probing the live server, unlike the
 * env-gated surfaces that decide at module load.
 */
export function classifyCapabilityGap(label: string, error: unknown): CapabilityGap | undefined {
  if (error instanceof HonuaCapabilityNotSupportedError) {
    return { reason: `${label}: ${error.message}` };
  }
  if (error instanceof HonuaHttpError && CAPABILITY_GAP_STATUSES.has(error.statusCode)) {
    return {
      reason: `${label}: server responded HTTP ${error.statusCode} — surface not published on this seed`,
    };
  }
  return undefined;
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
