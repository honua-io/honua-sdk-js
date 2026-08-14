/**
 * `@honua/sdk-js/zarr` — experimental Zarr registration and tile handoff client.
 *
 * The `HonuaZarrClient` provides guarded server-side registration and tile
 * contract operations for versioned Zarr coverage metadata and bounded tile
 * handoffs. It reuses the canonical `HonuaClient` auth/token/circuit-breaker
 * path, while preserving an independent experimental code surface.
 *
 * @experimental
 * @module
 */

export { HonuaZarrClient, createZarrClient } from "./client.js";
export { HonuaZarrError, HonuaZarrServiceError } from "./errors.js";
export type * from "./types.js";
