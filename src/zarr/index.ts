/**
 * `@honua/sdk-js/zarr` - experimental Honua Server Zarr registration and tile handoff.
 *
 * The client targets only the versioned `/api/v1` server contract. Metadata and
 * PNG responses are byte-bounded and flow through an existing `HonuaClient` so
 * authentication, cancellation, retry, timeout, and request interceptors remain active.
 * Direct object-store chunk decoding is intentionally unavailable in this slice.
 *
 * @experimental
 * @module
 */

export { createZarrClient, HonuaZarrClient } from "./client.js";
export { HonuaZarrError, HonuaZarrServiceError, type HonuaZarrErrorCode } from "./errors.js";
export type * from "./types.js";
