/**
 * Tree-shaking regression fixture for the accepted-plan MapLibre workflow.
 *
 * Importing this one public adapter must not retain unrelated `/map` exports.
 * Its budget measures the deliberate query-plan validation, feature execution,
 * GeoJSON projection, and lifecycle implementation consumers actually pay for.
 */
import { mountSourceToMapLibre } from "../../dist/src/map/index.js";

export { mountSourceToMapLibre };
