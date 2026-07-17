/**
 * Tree-shaking regression fixture for the managed application kernel.
 *
 * Importing only `createHonua` retains reviewed discovery, lifecycle, and
 * accepted-plan execution code, but it must not pull renderer, plugin,
 * application-platform, or optional analytics-engine systems into the app.
 */
import { createHonua } from "../../dist/src/index.js";

export { createHonua };
