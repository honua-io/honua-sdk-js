import { geoParquetSourceSchemaV2, geoServicesSourceSchemaV2, odataSourceSchemaV2 } from "./connect-schema.js";
import type { ConnectSourceSchemaProjection } from "./connect.js";
import { parseSourceSchemaV2 } from "./contract/schema.js";

/** @internal Shared only by focused schema/capability discovery entrypoints. */
export const SOURCE_SCHEMA_V2_CONNECT_PROJECTION = Object.freeze<ConnectSourceSchemaProjection>({
  cacheIdentity: "honua.source-schema@2.0",
  parseCached: parseSourceSchemaV2,
  geoServices: (metadata, context) => geoServicesSourceSchemaV2(metadata, context),
  odata: (metadata, entitySet, context) => odataSourceSchemaV2(metadata, entitySet, context),
  geoParquet: (profile, context) => geoParquetSourceSchemaV2(profile, context),
});
