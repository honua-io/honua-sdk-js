import { type DescribePmtilesArchiveDeps, describePmtilesArchive } from "../contract/pmtiles.js";
import type { SourceDescriptor } from "../contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../contract/types.js";
import { HonuaAbortError } from "../core/errors.js";
import {
  type PublicationBounds,
  type PublicationDescriptorV1,
  type PublicationField,
  type PublicationIdentity,
  validatePublicationDescriptor,
} from "./descriptor.js";
import { HonuaPublicationError } from "./errors.js";

/** When the published data was read from its source and when this version went live. */
export interface PublicationFreshness {
  readonly version: string;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly publishedAt: string;
  readonly sourceRevision: string;
}

/** Everything a map needs to draw the PMTiles half of a publication. */
export interface PublicationDisplay {
  readonly pmtilesUrl: string;
  readonly sourceLayer: string;
  /** Tile property that carries the stable identity; use it as MapLibre `promoteId`. */
  readonly promoteId: string;
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly bounds: PublicationBounds;
  readonly attribution?: string;
}

/** An opened, validated paired publication. */
export interface Publication {
  readonly url: string;
  readonly descriptor: PublicationDescriptorV1;
  readonly publicFields: readonly PublicationField[];
  readonly identity: PublicationIdentity;
  readonly freshness: PublicationFreshness;
  readonly display: PublicationDisplay;
  readonly geoparquetUrl: string;
  /** The live layer that serves the same records, when the descriptor links one. */
  readonly liveSourceUrl?: string;
  /** Source descriptors for `createDataset`: PMTiles for display, GeoParquet for queries. */
  sourceDescriptors(id?: string): { readonly display: SourceDescriptor; readonly query: SourceDescriptor };
}

export interface OpenPublicationOptions {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

export const PUBLICATION_STAMP_KEY = "honua:publication";

function absoluteUrl(reference: string, base: string): string {
  return new URL(reference, base).href;
}

function publicationFrom(url: string, descriptor: PublicationDescriptorV1): Publication {
  const { artifacts, capture, identity } = descriptor;
  const display: PublicationDisplay = Object.freeze({
    pmtilesUrl: absoluteUrl(artifacts.pmtiles.href, url),
    sourceLayer: artifacts.pmtiles.vectorLayer,
    promoteId: identity.pmtilesProperty,
    minzoom: artifacts.pmtiles.minzoom,
    maxzoom: artifacts.pmtiles.maxzoom,
    bounds: descriptor.bounds,
    ...(descriptor.provenance?.attribution ? { attribution: descriptor.provenance.attribution } : {}),
  });
  const geoparquetUrl = absoluteUrl(artifacts.geoparquet.href, url);
  const geometry = descriptor.geometry;
  return Object.freeze({
    url,
    descriptor,
    publicFields: Object.freeze(descriptor.fields.filter((field) => field.public)),
    identity,
    freshness: Object.freeze({
      version: descriptor.version,
      captureId: capture.captureId,
      capturedAt: capture.capturedAt,
      publishedAt: descriptor.publishedAt,
      sourceRevision: capture.sourceRevision,
    }),
    display,
    geoparquetUrl,
    ...(descriptor.links.source ? { liveSourceUrl: descriptor.links.source } : {}),
    sourceDescriptors(id = descriptor.publicationId) {
      return Object.freeze({
        display: Object.freeze({
          id: `${id}-display`,
          protocol: "pmtiles",
          locator: Object.freeze({ url: display.pmtilesUrl }),
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
        }),
        query: Object.freeze({
          id,
          protocol: "geoparquet",
          locator: Object.freeze({
            url: geoparquetUrl,
            geoparquet: Object.freeze({
              geometryColumn: geometry.column,
              ...(geometry.bboxColumn ? { bboxColumn: geometry.bboxColumn } : {}),
            }),
          }),
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
        }),
      });
    },
  });
}

/**
 * Fetch and validate a publication descriptor v1. Rejects a descriptor that
 * fails the schema or its cross-field rules, or that did not pass validation.
 *
 * Artifacts are read by HTTP range requests, so their host must answer a
 * ranged GET with 206, allow the `Range` request header across origins and
 * expose the `Content-Range` response header.
 * Identity lookups read the GeoParquet with a small Parquet reader; other
 * queries load the optional DuckDB-WASM peer through `publicationDriverFactory`, whose
 * `PUBLICATION_ENGINE_FILESYSTEM` opens files on hosts that answer
 * `HEAD` with 200 (common on CDNs). A host without range support is refused
 * before any engine read, as a query over the byte budget.
 *
 * @example
 * ```ts
 * import { openPublication, publicationDriverFactory, publicationSource } from "@honua/sdk-js/publication";
 *
 * const parcels = await openPublication("https://data.example.gov/parcels/2026-11-13/descriptor.json");
 * map.addSource("parcels", { type: "vector", url: `pmtiles://${parcels.display.pmtilesUrl}`, promoteId: parcels.display.promoteId });
 * const source = publicationSource(parcels);
 * const { result, answeredBy, limit } = await source.lookup("234030888");
 *
 * // Self-hosted engine files: keep the publication file settings.
 * const selfHosted = publicationSource(parcels, {
 *   driverFactory: publicationDriverFactory({ bundle: { mainModule: "/duckdb/duckdb-eh.wasm", mainWorker: "/duckdb/duckdb-browser-eh.worker.js" } }),
 * });
 * ```
 */
export async function openPublication(url: string, options: OpenPublicationOptions = {}): Promise<Publication> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (options.signal?.aborted) throw new HonuaAbortError();
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetchImpl(url, {
    headers,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new HonuaPublicationError(
      "invalid-descriptor",
      `Publication descriptor request failed with HTTP ${response.status}.`,
      { detail: { url, status: response.status } },
    );
  }
  let document: unknown;
  try {
    document = await response.json();
  } catch (cause) {
    throw new HonuaPublicationError("invalid-descriptor", "Publication descriptor is not JSON.", {
      detail: { url },
      cause,
    });
  }
  return publicationFrom(response.url || url, validatePublicationDescriptor(document));
}

/** The publication stamp an artifact embeds in its own metadata. */
export interface PublicationStamp {
  readonly publicationId: string;
  readonly version: string;
  readonly captureId: string;
}

/** Throws unless `stamp` names this publication version and its capture. */
export function assertArtifactStamp(
  publication: Publication,
  artifact: "pmtiles" | "geoparquet",
  stamp: unknown,
): void {
  const expected = publication.descriptor;
  const actual = stamp as Partial<PublicationStamp> | undefined;
  if (
    actual?.captureId !== expected.capture.captureId ||
    actual.publicationId !== expected.publicationId ||
    actual.version !== expected.version
  ) {
    throw new HonuaPublicationError(
      "artifact-mismatch",
      `The ${artifact} artifact does not carry capture ${expected.capture.captureId} of ${expected.publicationId} ${expected.version}; it belongs to another capture or version.`,
      { detail: { artifact, expected: expected.capture.captureId, actual: actual?.captureId ?? null } },
    );
  }
}

/** Read the PMTiles archive metadata and confirm it came from the descriptor's capture. */
export async function verifyPmtilesArtifact(
  publication: Publication,
  deps: DescribePmtilesArchiveDeps = {},
): Promise<void> {
  const description = await describePmtilesArchive(publication.display.pmtilesUrl, deps);
  assertArtifactStamp(publication, "pmtiles", description.metadata[PUBLICATION_STAMP_KEY]);
}
