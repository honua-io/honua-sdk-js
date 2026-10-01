/**
 * `@honua/sdk-js/zarr` - experimental Honua Server Zarr registration and tile handoff.
 *
 * The client targets only the versioned `/api/v1` server contract. Metadata and
 * PNG responses are byte-bounded and flow through an existing `HonuaClient` so
 * authentication, cancellation, retry, timeout, and request interceptors remain active.
 * `HonuaZarrClient` does not read object stores. `openDirectZarrStore` is a separate
 * bounded reader for reviewed static HTTP and object-store layouts.
 *
 * @experimental
 * @module
 */

export { createZarrClient, HonuaZarrClient } from "./client.js";
export {
  DirectZarrSession,
  ZARR_DIRECT_CAPABILITY,
  ZARR_DIRECT_DEFAULT_LIMITS,
  ZARR_DIRECT_LIMIT_CEILINGS,
  normalizeZarrDirectLimits,
  openDirectZarrStore,
  zarrCogDataType,
} from "./direct-session.js";
export { HonuaZarrError, HonuaZarrServiceError, type HonuaZarrErrorCode } from "./errors.js";
export type * from "./direct-types.js";
export type * from "./types.js";
