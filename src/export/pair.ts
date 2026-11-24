import type { SourceDescriptor } from "../contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../contract/types.js";
import type { PublicationGeometry } from "./descriptor.js";

/** The PMTiles display and GeoParquet query descriptors of a paired publication, for `createDataset`. */
export function pairedSourceDescriptors(
  id: string,
  pair: { readonly pmtilesUrl: string; readonly geoparquetUrl: string; readonly geometry: PublicationGeometry },
): { readonly display: SourceDescriptor; readonly query: SourceDescriptor } {
  const { geometry } = pair;
  return Object.freeze({
    display: Object.freeze({
      id: `${id}-display`,
      protocol: "pmtiles",
      locator: Object.freeze({ url: pair.pmtilesUrl }),
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
    }),
    query: Object.freeze({
      id,
      protocol: "geoparquet",
      locator: Object.freeze({
        url: pair.geoparquetUrl,
        geoparquet: Object.freeze({
          geometryColumn: geometry.column,
          ...(geometry.bboxColumn ? { bboxColumn: geometry.bboxColumn } : {}),
        }),
      }),
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
    }),
  });
}
