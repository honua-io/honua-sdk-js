import {
  geoParquetSourceSchemaV2,
  geoServicesSourceSchemaV2,
  geoservicesImageSourceSchemaV2,
  odataSourceSchemaV2,
  ogcFeaturesSourceSchemaV2,
  ogcMapsSourceSchemaV2,
  ogcRecordsSourceSchemaV2,
  ogcTilesSourceSchemaV2,
  pmtilesSourceSchemaV2,
  stacSourceSchemaV2,
  wfsSourceSchemaV2,
  wmsSourceSchemaV2,
  wmtsSourceSchemaV2,
} from "./connect-schema.js";
import type { ConnectSourceSchemaProjection } from "./connect.js";
import { parseSourceSchemaV2 } from "./contract/schema.js";

/** @internal Shared only by focused schema/capability discovery entrypoints. */
export const SOURCE_SCHEMA_V2_CONNECT_PROJECTION = Object.freeze<ConnectSourceSchemaProjection>({
  cacheIdentity: "honua.source-schema@2.0",
  parseCached: parseSourceSchemaV2,
  geoServices: (metadata, context) => geoServicesSourceSchemaV2(metadata, context),
  odata: (metadata, entitySet, context) => odataSourceSchemaV2(metadata, entitySet, context),
  stac: (context) => stacSourceSchemaV2(context),
  geoservicesImage: (metadata, context) => geoservicesImageSourceSchemaV2(metadata, context),
  geoParquet: (profile, context) => geoParquetSourceSchemaV2(profile, context),
  wfs: (context) => wfsSourceSchemaV2(context),
  ogcFeatures: (context) => ogcFeaturesSourceSchemaV2(context),
  ogcRecords: (context) => ogcRecordsSourceSchemaV2(context),
  ogcTiles: (context) => ogcTilesSourceSchemaV2(context),
  ogcMaps: (context) => ogcMapsSourceSchemaV2(context),
  wms: (metadata, context) => wmsSourceSchemaV2(metadata, context),
  wmts: (metadata, context) => wmtsSourceSchemaV2(metadata, context),
  pmtiles: (context) => pmtilesSourceSchemaV2(context),
});
