/**
 * Companion to `tree-shake-error-leaf.mjs` (#583).
 *
 * A consumer that explicitly imports the canonical descriptive registry pays for
 * the full human-readable summary table on purpose. Measuring it alongside the
 * leaf-error guard proves the split is real: the descriptive summaries are
 * bundled only when requested, not pulled into every leaf error import.
 */
import { HONUA_ERROR_CODE_REGISTRY } from "../../dist/src/core/error-code-registry.js";

export { HONUA_ERROR_CODE_REGISTRY };
