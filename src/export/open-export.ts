import type { SourceDescriptor } from "../contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../contract/types.js";
import { HonuaAbortError } from "../core/errors.js";
import { type ExportCollection, PARQUET_MEDIA_TYPE, readExportCollection } from "./collection.js";
import { HonuaPublicationError } from "./errors.js";
import {
  type OpenPublicationOptions,
  type Publication,
  type PublicationDisplay,
  pairedSourceDescriptors,
} from "./open.js";

/** How a map draws the Export: its PMTiles `visual` asset, or the `data` asset itself. */
export type ExportRenderPath = "visual" | "data";

/** Source descriptors for `createDataset`; `query` is present when the data asset is GeoParquet. */
export interface ExportSourceDescriptors {
  readonly display: SourceDescriptor | undefined;
  readonly query: SourceDescriptor | undefined;
}

/** An opened Export: one Portolan STAC collection document and the files it names. */
export interface HonuaExport {
  /** The collection document URL, after redirects. */
  readonly url: string;
  readonly collection: ExportCollection;
  readonly renderPath: ExportRenderPath;
  /** PMTiles display settings, when the render path is `visual`. */
  readonly display?: ExportDisplay;
  /**
   * The paired PMTiles + GeoParquet view with identity lookups, selection and
   * public-field guards. Present when the collection is a Honua Export
   * (`honua:` extension) with a GeoParquet data asset of recorded size and a PMTiles visual.
   */
  readonly publication?: Publication;
  sourceDescriptors(id?: string): ExportSourceDescriptors;
}

export type OpenExportOptions = OpenPublicationOptions;

/** PMTiles display settings of an Export; `promoteId` is set on a Honua Export, whose tiles carry the identity. */
export type ExportDisplay = Omit<PublicationDisplay, "promoteId"> & { readonly promoteId?: string };

function displayOf(collection: ExportCollection): ExportDisplay | undefined {
  const pmtilesUrl = collection.visual?.url ?? collection.pmtiles?.url;
  if (!pmtilesUrl) return undefined;
  const sourceLayer = collection.pmtiles?.layers[0];
  if (!sourceLayer) {
    throw new HonuaPublicationError(
      "invalid-descriptor",
      'Export collection registers PMTiles without a rel "pmtiles" link naming its layers.',
      { detail: { path: "links[rel=pmtiles]" } },
    );
  }
  return Object.freeze({
    pmtilesUrl,
    sourceLayer,
    ...(collection.honua ? { promoteId: collection.honua.identity.pmtilesProperty } : {}),
    bounds: collection.bounds,
    ...(collection.attribution ? { attribution: collection.attribution } : {}),
  });
}

function queryDescriptor(collection: ExportCollection, id: string): SourceDescriptor | undefined {
  if (collection.data.type !== PARQUET_MEDIA_TYPE) return undefined;
  const geometry = collection.honua?.geometry;
  return Object.freeze({
    id,
    protocol: "geoparquet",
    locator: Object.freeze({
      url: collection.data.url,
      ...(geometry
        ? {
            geoparquet: Object.freeze({
              geometryColumn: geometry.column,
              ...(geometry.bboxColumn ? { bboxColumn: geometry.bboxColumn } : {}),
            }),
          }
        : {}),
    }),
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  });
}

function displayDescriptor(display: ExportDisplay | undefined, id: string): SourceDescriptor | undefined {
  if (!display) return undefined;
  return Object.freeze({
    id: `${id}-display`,
    protocol: "pmtiles",
    locator: Object.freeze({ url: display.pmtilesUrl }),
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
  });
}

function publicationOf(
  url: string,
  collection: ExportCollection,
  display: ExportDisplay | undefined,
): Publication | undefined {
  const { honua, data } = collection;
  if (!honua || !display?.promoteId || data.type !== PARQUET_MEDIA_TYPE || data.bytes === undefined) return undefined;
  const version = collection.version ?? collection.updated ?? honua.captureId;
  const publicFields = collection.fields.filter((field) => field.public);
  return Object.freeze({
    url,
    id: collection.id,
    geometry: honua.geometry,
    queryArtifact: Object.freeze({ url: data.url, bytes: data.bytes, fields: honua.publicFields }),
    stamp: Object.freeze({ publicationId: collection.id, version, captureId: honua.captureId }),
    publicFields: Object.freeze(
      publicFields.length > 0
        ? publicFields
        : honua.publicFields.map((name) => Object.freeze({ name, type: "string" as const, public: true })),
    ),
    identity: Object.freeze({ ...honua.identity, type: "string" as const }),
    freshness: Object.freeze({
      version,
      captureId: honua.captureId,
      capturedAt: honua.capturedAt,
      publishedAt: collection.updated ?? honua.capturedAt,
      sourceRevision: honua.sourceRevision,
    }),
    display: display as PublicationDisplay,
    geoparquetUrl: data.url,
    sourceDescriptors: (id = collection.id) =>
      pairedSourceDescriptors(id, {
        pmtilesUrl: display.pmtilesUrl,
        geoparquetUrl: data.url,
        geometry: honua.geometry,
      }),
  });
}

/** Build an Export from a collection document already fetched (fixtures, caches). */
export function exportFromCollection(document: unknown, url: string): HonuaExport {
  const collection = readExportCollection(document, url);
  const display = displayOf(collection);
  const publication = publicationOf(url, collection, display);
  return Object.freeze({
    url,
    collection,
    renderPath: display ? "visual" : "data",
    ...(display ? { display } : {}),
    ...(publication ? { publication } : {}),
    sourceDescriptors: (id = collection.id) =>
      Object.freeze({ display: displayDescriptor(display, id), query: queryDescriptor(collection, id) }),
  });
}

/**
 * Open an Export from its STAC collection document (Portolan profile). Public
 * Exports need no sign-in; pass `headers` for a signed-in route. Any Portolan
 * collection opens for display and queries; identity lookups and selection
 * need a Honua Export, whose `publication` view is then set.
 *
 * Files are read by HTTP range requests at the `file:size` the document
 * records, so their host needs to answer a ranged GET with 206 but not a HEAD request.
 *
 * @example
 * ```ts
 * import { openExport, publicationSource } from "@honua/sdk-js/export";
 *
 * const parcels = await openExport("https://data.example.gov/exports/parcels/v3/collection.json");
 * if (parcels.display) {
 *   map.addSource("parcels", { type: "vector", url: `pmtiles://${parcels.display.pmtilesUrl}`, promoteId: parcels.display.promoteId });
 * }
 * if (parcels.publication) {
 *   const { result } = await publicationSource(parcels.publication).lookup("234030888");
 * }
 * ```
 */
export async function openExport(collectionUrl: string, options: OpenExportOptions = {}): Promise<HonuaExport> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (options.signal?.aborted) throw new HonuaAbortError();
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetchImpl(collectionUrl, { headers, ...(options.signal ? { signal: options.signal } : {}) });
  if (!response.ok) {
    throw new HonuaPublicationError(
      "invalid-descriptor",
      `Export collection request failed with HTTP ${response.status}.`,
      { detail: { url: collectionUrl, status: response.status } },
    );
  }
  let document: unknown;
  try {
    document = await response.json();
  } catch (cause) {
    throw new HonuaPublicationError("invalid-descriptor", "Export collection is not JSON.", {
      detail: { url: collectionUrl },
      cause,
    });
  }
  return exportFromCollection(document, response.url || collectionUrl);
}
