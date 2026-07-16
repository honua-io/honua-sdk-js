/**
 * Tree-shaking regression fixture for the managed application kernel.
 *
 * Importing only `createHonua` may retain reviewed discovery and lifecycle
 * code, but it must not pull renderer, planner, plugin, or app-platform
 * systems into an application that only inspects sources.
 */
import { createHonua } from "../../dist/src/index.js";

export { createHonua };
