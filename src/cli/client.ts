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
import { type ResolveOptions, resolveConnection } from "./config.js";

/** Build a {@link HonuaClient} from CLI flags / env / saved config. */
export function createClient(options: ResolveOptions = {}): HonuaClient {
  const { baseUrl, apiKey } = resolveConnection(options);
  return new HonuaClient({ baseUrl, apiKey });
}

/**
 * Build a {@link HonuaCommandRuntime} from CLI flags / env / saved config.
 *
 * The runtime inherits exactly the credential the rest of the CLI uses — there
 * is no separate administrator credential for commands, and the CLI never adds
 * an authority header of its own.
 */
export function createCommandRuntime(options: ResolveOptions = {}): HonuaCommandRuntime {
  const { baseUrl, apiKey } = resolveConnection(options);
  assertAdminBaseUrl(baseUrl);
  return createHonuaCommandRuntime({ client: new HonuaClient({ baseUrl, apiKey }) });
}

/** Build a {@link HonuaGeocodingClient} from CLI flags / env / saved config. */
export function createGeocodingClient(options: ResolveOptions & { locatorName?: string } = {}): HonuaGeocodingClient {
  const { baseUrl, apiKey } = resolveConnection(options);
  return new HonuaGeocodingClient({ baseUrl, apiKey, locatorName: options.locatorName });
}
