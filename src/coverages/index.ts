/**
 * `@honua/sdk-js/coverages` - bounded OGC API Coverages and WCS 2.0.1 clients.
 *
 * The subpath provides metadata discovery, normalized domain/range models,
 * subset and content-negotiation helpers, structured WCS errors, and a small
 * MapLibre image projection. All requests reuse an existing `HonuaClient` so
 * its authentication, cancellation, retry, timeout, and interceptor policy
 * remains the single transport boundary.
 *
 * @experimental
 * @module
 */

export * from "./client.js";
export * from "./errors.js";
export * from "./maplibre.js";
export type * from "./types.js";
