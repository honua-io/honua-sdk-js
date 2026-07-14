/**
 * Tree-shaking regression fixture for repeat capability evaluation.
 *
 * Static evidence ingestion deliberately owns CRS/PROJJSON validation. A
 * consumer importing only the evaluator must retain the dynamic evaluator and
 * evidence-profile brand registry, but not the heavy static validation stack.
 */
import { evaluateCapabilityProfile } from "../../dist/src/source-capabilities.js";

export { evaluateCapabilityProfile };
