/**
 * Tree-shaking regression fixture for lightweight default discovery.
 *
 * The experimental SourceSchemaV2 runtime and generated PROJJSON validator are
 * intentionally reachable only through `/source-schema`; importing root
 * `connect` must not retain that focused validation stack.
 */
import { connect } from "../../dist/src/index.js";

export { connect };
