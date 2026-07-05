/**
 * Tree-shaking regression fixture for `/esri-compat` (issue #351 follow-on).
 *
 * The geometryEngine compat shim added turf/proj4 to the esri-compat entry's
 * full-bundle cost. This fixture imports ONLY `FeatureLayerCompat` and proves
 * that compat consumers who never touch geometryEngine do not pay for the
 * geometry backing (src/geometry must stay side-effect-free).
 */
import { FeatureLayerCompat } from "../../dist/src/esri-compat-entry.js";

export { FeatureLayerCompat };
