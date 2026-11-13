import type { CapabilityAwareSource, Query, Source } from "../contract/types.js";
import { type DuckDbDriverFactory, type GeoparquetRuntime, geoparquetSource } from "../geoparquet/index.js";
import { settleOrAbort, sharedTask } from "./abort.js";
import { publicationRuntime } from "./engine.js";
import { HonuaPublicationError } from "./errors.js";
import { csvDocument, featureCollection } from "./export.js";
import { type PublicFieldGuard, publicFieldGuard } from "./guard.js";
import {
  type LookupContext,
  PUBLICATION_LOOKUP_BUDGET,
  type PublicationLookup,
  type PublicationLookupOptions,
  type PublicationLookupPlan,
  type PublicationQueryBudget,
  lookupIdentity,
  planLookup,
} from "./lookup.js";
import type { Publication } from "./open.js";
import { publicationParquet } from "./parquet.js";

/** A feature as a map renderer reports it; only its properties are read, never its geometry. */
export interface RenderedPublicationFeature {
  readonly properties?: Readonly<Record<string, unknown>> | null;
}

export type PublicationExportFormat = "csv" | "geojson";

export interface PublicationSourceOptions {
  readonly id?: string;
  /** Fetch used for the GeoParquet range reads of identity lookups. */
  readonly fetch?: typeof fetch;
  readonly runtime?: GeoparquetRuntime;
  readonly driverFactory?: DuckDbDriverFactory;
  readonly budget?: PublicationQueryBudget;
  /** Live source serving the same records; lookups over budget are answered by it. */
  readonly serverSource?: Source;
}

/** The query half of a paired publication: GeoParquet records, public fields only, identity lookups within a budget. */
export interface PublicationSource<T = Record<string, unknown>> extends CapabilityAwareSource<T> {
  readonly publication: Publication;
  planLookup(identity: string, options?: PublicationLookupOptions): Promise<PublicationLookupPlan>;
  lookup(identity: string, options?: PublicationLookupOptions): Promise<PublicationLookup<T>>;
  /** Resolve a rendered tile feature to its full GeoParquet record through the stable identity. */
  select(feature: RenderedPublicationFeature, options?: PublicationLookupOptions): Promise<PublicationLookup<T>>;
  exportFeatures(format: PublicationExportFormat, query?: Query<T>): Promise<string>;
  verifyGeoParquetArtifact(options?: PublicationLookupOptions): Promise<void>;
}

/** Engine settings for an immutable artifact: its footer and HTTP metadata never change within a version. */
function engineSettings(runtime: GeoparquetRuntime) {
  return sharedTask(async (signal) => {
    await runtime.query("SET parquet_metadata_cache = true", { signal });
    await runtime.query("SET enable_http_metadata_cache = true", { signal });
  });
}

function renderedIdentity(publication: Publication, feature: RenderedPublicationFeature): string {
  const { pmtilesProperty } = publication.identity;
  const value = feature.properties?.[pmtilesProperty];
  if (typeof value === "string") return value;
  throw new HonuaPublicationError(
    "artifact-mismatch",
    `The selected feature has no text ${pmtilesProperty} property, so it cannot be resolved to a ${publication.descriptor.publicationId} record.`,
    { detail: { property: pmtilesProperty, received: value === undefined ? "missing" : typeof value } },
  );
}

async function exportPublicFeatures<T>(
  source: Pick<Source<T>, "queryAll">,
  guard: PublicFieldGuard,
  request: {
    readonly format: PublicationExportFormat;
    readonly query: Query<T> | undefined;
    readonly identityColumn: string;
  },
): Promise<string> {
  const { format, query } = request;
  if (format !== "csv" && format !== "geojson") throw new TypeError(`Unsupported export format ${String(format)}`);
  const result = guard.result(
    await source.queryAll(guard.query({ ...(query ?? {}), returnGeometry: format === "geojson" })),
  );
  const columns = (query?.outFields?.length ? query.outFields : guard.names).filter((name) => guard.has(name));
  return format === "geojson"
    ? JSON.stringify(featureCollection(result, columns, request.identityColumn))
    : csvDocument(result, columns);
}

interface PairedParts<T> {
  readonly inner: CapabilityAwareSource<T>;
  readonly guard: PublicFieldGuard;
  readonly prepareEngine: (signal?: AbortSignal) => Promise<void>;
  readonly identityColumn: string;
}

/** The Source query methods of the paired source: public fields only, after the artifact check. */
function guardedQueries<T>({ inner, guard, prepareEngine, identityColumn }: PairedParts<T>) {
  const guarded = async <R>(query: Query<T> | undefined, run: (request: Query<T>) => Promise<R>): Promise<R> => {
    const request = guard.query(query);
    await prepareEngine(request.signal);
    return run(request);
  };
  return {
    query: (query?: Query<T>) => guarded(query, async (request) => guard.result(await inner.query(request))),
    queryAll: (query?: Query<T>) => guarded(query, async (request) => guard.result(await inner.queryAll(request))),
    queryAggregate: (query: Parameters<Source<T>["queryAggregate"]>[0]) =>
      guarded(query, (request) => inner.queryAggregate({ ...request, aggregation: query.aggregation })),
    queryExtent: (query?: Query<T>) => guarded(query, (request) => inner.queryExtent(request)),
    async *stream(query?: Query<T>) {
      const request = guard.query(query);
      await prepareEngine(request.signal);
      for await (const page of inner.stream(request)) yield guard.result(page);
    },
    exportFeatures: (format: PublicationExportFormat, query?: Query<T>) =>
      guarded(query, (request) => exportPublicFeatures(inner, guard, { format, query: request, identityColumn })),
  };
}

/** Build the paired source over a publication's GeoParquet artifact. */
export function publicationSource<T = Record<string, unknown>>(
  publication: Publication,
  options: PublicationSourceOptions = {},
): PublicationSource<T> {
  const sourceDescriptor = publication.sourceDescriptors(options.id).query;
  const runtime = publicationRuntime(options);
  const inner = geoparquetSource<T>(sourceDescriptor, { runtime });
  const guard = publicFieldGuard(publication, sourceDescriptor.id);
  const parquet = publicationParquet(publication, options.fetch ?? ((input, init) => globalThis.fetch(input, init)));
  const settings = engineSettings(runtime);
  const prepareEngine = async (signal?: AbortSignal) => {
    await parquet.verify(signal);
    await settings(signal);
  };
  const queries = guardedQueries({
    inner,
    guard,
    prepareEngine,
    identityColumn: publication.identity.geoparquetColumn,
  });
  const context: LookupContext = {
    publication,
    sourceId: sourceDescriptor.id,
    parquet,
    guard,
    budget: options.budget ?? PUBLICATION_LOOKUP_BUDGET,
    serverSource: options.serverSource,
  };
  const lookup = (value: string, lookupOptions?: PublicationLookupOptions) =>
    lookupIdentity(context, value, lookupOptions);
  return Object.freeze({
    ...inner,
    ...queries,
    publication,
    protocol: () => undefined,
    adapter: () => undefined,
    supports: inner.supports,
    planLookup: (value: string, lookupOptions?: PublicationLookupOptions) =>
      settleOrAbort(planLookup(context, value, lookupOptions?.signal), lookupOptions?.signal),
    lookup,
    select: async (feature: RenderedPublicationFeature, lookupOptions?: PublicationLookupOptions) =>
      lookup(renderedIdentity(publication, feature), lookupOptions),
    verifyGeoParquetArtifact: (lookupOptions?: PublicationLookupOptions) => parquet.verify(lookupOptions?.signal),
  }) as unknown as PublicationSource<T>;
}
