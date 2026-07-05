/**
 * Tree-shaking regression fixture for `/geometry` (issue #351, NFR-001).
 *
 * Imports ONLY `buffer` from the geometry entry and re-exports it, bundled
 * with its turf backing INCLUDED (turf/proj4 are real consumer cost for the
 * geometry package, unlike renderer peers). The ceiling in
 * `bundle-budgets.json` under `tree-shake:geometry-buffer` enforces that a
 * single op never drags the full turf/proj4 surface into a consumer bundle.
 */
import { buffer } from "../../dist/src/geometry/index.js";

export { buffer };
