/**
 * Tree-shaking regression fixture for a representative leaf error class (#583).
 *
 * The unified error envelope (#524) gives every public error a stable domain,
 * category, retryability, and governed code. A consumer that imports only one
 * leaf error class must retain the compact runtime classification table and the
 * envelope serializer, but NOT the human-readable descriptive registry (the
 * ~100-code summary table in `error-code-registry.js`). The `forbiddenInputs`
 * guard in `report-bundle-sizes.mjs` enforces that exclusion; this fixture keeps
 * the leaf runtime cost proportional to what a small subpath actually needs.
 */
import { HonuaTimeoutError } from "../../dist/src/core/errors.js";

export { HonuaTimeoutError };
