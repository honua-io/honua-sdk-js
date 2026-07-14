/**
 * Focused experimental SourceSchemaV2 runtime and opt-in discovery wrapper.
 *
 * This subpath intentionally owns the schema validator and protocol
 * normalizers so ordinary root, browser, `/honua`, `/contract`, and query
 * planner imports do not pay for the pinned PROJJSON validator.
 *
 * @experimental
 * @module
 */

import { geoParquetSourceSchemaV2, geoServicesSourceSchemaV2, odataSourceSchemaV2 } from "./connect-schema.js";
import { type ConnectSourceSchemaProjection, connectWithSourceSchemaProjection } from "./connect.js";
import type { ConnectOptions, HonuaConnection } from "./connect.js";
import { parseSourceSchemaV2 } from "./contract/schema.js";

export {
  geoParquetSourceSchemaV2,
  geoServicesSourceSchemaV2,
  odataSourceSchemaV2,
} from "./connect-schema.js";
export type { SchemaNormalizationContext } from "./connect-schema.js";

export {
  SOURCE_SCHEMA_V2_FINGERPRINT_DOMAIN,
  SOURCE_SCHEMA_V2_KIND,
  SOURCE_SCHEMA_V2_VERSION,
  cloneSourceSchemaV2,
  createSourceSchemaV2,
  parseSourceSchemaV2,
  serializeSourceSchemaV2,
  sourceSchemaIdentity,
} from "./contract/schema.js";
export type * from "./contract/schema.js";

const SOURCE_SCHEMA_V2_CONNECT_PROJECTION = Object.freeze<ConnectSourceSchemaProjection>({
  cacheIdentity: "honua.source-schema@2.0",
  parseCached: parseSourceSchemaV2,
  geoServices: (metadata, context) => geoServicesSourceSchemaV2(metadata, context),
  odata: (metadata, entitySet, context) => odataSourceSchemaV2(metadata, entitySet, context),
  geoParquet: (profile, context) => geoParquetSourceSchemaV2(profile, context),
});

/**
 * Run the normal one-pass connection discovery with SourceSchemaV2 enrichment.
 * Metadata is fetched once; the focused projection participates in cache
 * identity and revalidates every cached schema fingerprint before use.
 */
export function connectWithSourceSchemaV2(options: ConnectOptions): Promise<HonuaConnection> {
  return connectWithSourceSchemaProjection(options, SOURCE_SCHEMA_V2_CONNECT_PROJECTION);
}
