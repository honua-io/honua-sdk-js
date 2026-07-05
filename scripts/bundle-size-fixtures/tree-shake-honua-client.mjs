/**
 * Tree-shaking regression fixture (issue #350, REQ-005).
 *
 * Imports ONLY the primary public symbol (`HonuaClient`) from the root entry
 * and re-exports it. When this is bundled the same way a consumer would build
 * it (esbuild --bundle --minify, peers external), esbuild must be able to drop
 * every unrelated subsystem (map runtime, esri-compat, migration, studio, ...).
 *
 * The bundled size of this fixture is budgeted in `bundle-budgets.json` under
 * `tree-shake:HonuaClient`. If a change makes a single-symbol root import drag
 * the whole SDK in (e.g. a side-effectful top-level import, a barrel that
 * defeats tree-shaking), this fixture blows past its ceiling and CI fails.
 *
 * The import points at the built `dist/` output on purpose: `report-bundle-sizes`
 * runs after `npm run build`, so it measures exactly what ships to consumers.
 */
import { HonuaClient } from "../../dist/src/index.js";

export { HonuaClient };
