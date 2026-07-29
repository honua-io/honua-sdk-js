import {
  geoParquetSourceSchemaV2,
  geoServicesSourceSchemaV2,
  odataSourceSchemaV2,
  wmsSourceSchemaV2,
  wmtsSourceSchemaV2,
} from "./connect-schema.js";
import type { ConnectSourceSchemaProjection } from "./connect.js";
import { createSourceSchemaV2, parseSourceSchemaV2 } from "./contract/schema.js";
import type { SourceProtocol } from "./contract/schema.js";

function unavailableSchema(protocol: SourceProtocol, source: string) {
  return createSourceSchemaV2({
    fields: [],
    key: { state: "unknown", reason: "metadata-unavailable" },
    geometry: { state: "unknown", reason: "metadata-unavailable" },
    temporal: { state: "unknown", reason: "metadata-unavailable" },
    openContent: "unknown",
    provenance: [{ method: "unavailable", protocol, source }],
  });
}

/** @internal Shared only by focused schema/capability discovery entrypoints. */
export const SOURCE_SCHEMA_V2_CONNECT_PROJECTION = Object.freeze<ConnectSourceSchemaProjection>({
  cacheIdentity: "honua.source-schema@2.0",
  parseCached: parseSourceSchemaV2,
  stac: (context) => unavailableSchema("stac", context.source),
  geoServices: (metadata, context) => geoServicesSourceSchemaV2(metadata, context),
  odata: (metadata, entitySet, context) => odataSourceSchemaV2(metadata, entitySet, context),
  geoParquet: (profile, context) => geoParquetSourceSchemaV2(profile, context),
  geoservicesImage: (metadata, context) => unavailableSchema("geoservices-image-service", context.source),
  pmtiles: (context) => unavailableSchema("pmtiles", context.source),
  wfs: (context) => unavailableSchema("wfs", context.source),
  ogcFeatures: (context) => unavailableSchema("ogc-features", context.source),
  ogcRecords: (context) => unavailableSchema("ogc-records", context.source),
  ogcTiles: (context) => unavailableSchema("ogc-tiles", context.source),
  ogcMaps: (context) => unavailableSchema("ogc-maps", context.source),
  wms: (metadata, context) => wmsSourceSchemaV2(metadata, context),
  wmts: (metadata, context) => wmtsSourceSchemaV2(metadata, context),
});
