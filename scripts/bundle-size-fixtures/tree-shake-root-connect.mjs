/**
 * Tree-shaking regression fixture for lightweight default discovery.
 *
 * Experimental SourceSchemaV2 validation and static STAC graph/probe discovery
 * are intentionally reachable only through focused subpaths. Importing root
 * `connect` must not retain those opt-in runtimes.
 */
import { connect } from "../../dist/src/index.js";

export { connect };
