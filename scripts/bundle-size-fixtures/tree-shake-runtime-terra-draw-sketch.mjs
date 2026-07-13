/**
 * Tree-shaking regression fixture for the terra-draw sketch binding.
 *
 * Importing the binding from `/runtime` must stay cheap and must never inline
 * the optional `terra-draw` / `terra-draw-maplibre-gl-adapter` peers (they are
 * external, reached only via dynamic import in `createTerraDrawSketch`).
 * Its budget measures the mode/tool adaptation, undo/redo mirroring, and
 * snapping bridge consumers actually pay for.
 */
import { bindTerraDrawSketch, createTerraDrawSnapping } from "../../dist/src/runtime/index.js";

export { bindTerraDrawSketch, createTerraDrawSnapping };
