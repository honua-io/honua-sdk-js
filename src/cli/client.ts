/**
 * Thin factory that turns resolved CLI connection settings into the SDK clients
 * the commands use. Reusing the published SDK means the CLI never hand-rolls
 * HTTP — it inherits retries, auth, PBF decoding, and error types for free.
 *
 * @packageDocumentation
 */

import { type HonuaCommandRuntime, assertAdminBaseUrl, createHonuaCommandRuntime } from "../control-plane/index.js";
import { HonuaClient } from "../core/client.js";
import { HonuaGeocodingClient } from "../geocoding/index.js";
import { HonuaStudioLifecycleClient } from "../studio/lifecycle-client.js";
import { type ResolveOptions, resolveAdminConnection, resolveConnection } from "./config.js";

/** Build a {@link HonuaClient} from CLI flags / env / saved config. */
export function createClient(options: ResolveOptions = {}): HonuaClient {
  const { baseUrl, apiKey, bearerToken } = resolveConnection(options);
  return new HonuaClient({ baseUrl, apiKey, bearerToken });
}

/**
 * Build a {@link HonuaClient} for admin endpoints (`/api/v1/admin/*`).
 * Resolves `--admin-key` / `HONUA_ADMIN_KEY` / profile `adminKey` with fallback to
 * `--api-key`, preserves caller bearer tokens without overriding them, and enforces
 * HTTPS or exact loopback HTTP before sending credentials.
 */
export function createAdminClient(options: ResolveOptions & { adminKey?: string } = {}): HonuaClient {
  const { baseUrl, adminKey, apiKey, bearerToken } = resolveAdminConnection(options);
  assertAdminBaseUrl(baseUrl);
  return new HonuaClient({ baseUrl, apiKey: bearerToken ? undefined : (adminKey ?? apiKey), bearerToken });
}

/**
 * Build a {@link HonuaCommandRuntime} from CLI flags / env / saved config.
 *
 * The runtime inherits exactly the credential the rest of the CLI uses — there
 * is no separate administrator credential for commands, and the CLI never adds
 * an authority header of its own.
 */
export function createCommandRuntime(options: ResolveOptions = {}): HonuaCommandRuntime {
  const { baseUrl, apiKey, bearerToken } = resolveConnection(options);
  assertAdminBaseUrl(baseUrl);
  const client = new HonuaClient({ baseUrl, apiKey, bearerToken });
  return createHonuaCommandRuntime({ client, studio: new HonuaStudioLifecycleClient({ client }) });
}

/** Build a {@link HonuaGeocodingClient} from CLI flags / env / saved config. */
export function createGeocodingClient(options: ResolveOptions & { locatorName?: string } = {}): HonuaGeocodingClient {
  const { baseUrl, apiKey, bearerToken } = resolveConnection(options);
  return new HonuaGeocodingClient({ baseUrl, apiKey, bearerToken, locatorName: options.locatorName });
}
