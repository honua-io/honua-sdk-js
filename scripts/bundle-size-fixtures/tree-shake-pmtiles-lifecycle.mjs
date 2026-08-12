/**
 * Tree-shaking regression fixture for the managed PMTiles lifecycle.
 *
 * The lifecycle must remain usable without retaining direct archive discovery,
 * renderer integrations, or their optional runtime dependencies.
 */
import { createHonuaPmtilesLifecycle } from "../../dist/src/pmtiles/index.js";

export { createHonuaPmtilesLifecycle };
