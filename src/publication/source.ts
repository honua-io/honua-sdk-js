import type { CapabilityAwareSource, Query, Result, Source } from "../contract/types.js";
import { stringLiteral } from "../core/geoparquet-sql.js";
import { type DuckDbDriverFactory, GeoparquetRuntime, geoparquetSource } from "../geoparquet/index.js";
import { settleOrAbort } from "./abort.js";
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
import { PUBLICATION_STAMP_KEY, type Publication, assertArtifactStamp } from "./open.js";

/** A feature as a map renderer reports it; only its properties are read, never its geometry. */
export interface RenderedPublicationFeature {
  readonly properties?: Readonly<Record<string, unknown>> | null;
}

export type PublicationExportFormat = "csv" | "geojson";

export interface PublicationSourceOptions {
  readonly id?: string;
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

/**
 * Checks the GeoParquet artifact's embedded stamp once per source. The shared
 * check runs without any caller's signal; each caller only stops waiting.
 */
function geoParquetVerification(runtime: GeoparquetRuntime, publication: Publication) {
  let verified: Promise<void> | undefined;
  const url = stringLiteral(publication.geoparquetUrl);
  async function check(): Promise<void> {
    // Artifact paths are immutable per publication version, so caching their
    // HEAD and footer metadata cannot serve a stale read.
    await runtime.query("SET parquet_metadata_cache = true");
    await runtime.query("SET enable_http_metadata_cache = true");
    const rows = await runtime.query(
      `SELECT decode(value) AS value FROM parquet_kv_metadata(${url}) WHERE decode(key) = ${stringLiteral(PUBLICATION_STAMP_KEY)}`,
    );
    const stamp = typeof rows[0]?.value === "string" ? JSON.parse(rows[0].value) : undefined;
    assertArtifactStamp(publication, "geoparquet", stamp);
  }
  return (signal?: AbortSignal): Promise<void> => {
    verified ??= check().catch((error) => {
      verified = undefined;
      throw error;
    });
    return settleOrAbort(verified, signal);
  };
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

/** Build the paired source over a publication's GeoParquet artifact. */
export function publicationSource<T = Record<string, unknown>>(
  publication: Publication,
  options: PublicationSourceOptions = {},
): PublicationSource<T> {
  const sourceDescriptor = publication.sourceDescriptors(options.id).query;
  const runtime =
    options.runtime ?? new GeoparquetRuntime(options.driverFactory ? { driverFactory: options.driverFactory } : {});
  const inner = geoparquetSource<T>(sourceDescriptor, { runtime });
  const guard = publicFieldGuard(publication, sourceDescriptor.id);
  const verify = geoParquetVerification(runtime, publication);
  const guarded = async <R>(query: Query<T> | undefined, run: (request: Query<T>) => Promise<R>): Promise<R> => {
    const request = guard.query(query);
    await verify(request.signal);
    return run(request);
  };
  const context: LookupContext<T> = {
    publication,
    sourceId: sourceDescriptor.id,
    runtime,
    guard,
    budget: options.budget ?? PUBLICATION_LOOKUP_BUDGET,
    serverSource: options.serverSource,
    verify,
    queryBrowser: (query) => guarded(query, async (request) => guard.result(await inner.query(request))),
  };
  const lookup = (value: string, lookupOptions?: PublicationLookupOptions) =>
    lookupIdentity(context, value, lookupOptions);

  return Object.freeze({
    ...inner,
    publication,
    query: (query?: Query<T>) => context.queryBrowser(query ?? {}),
    queryAll: (query?: Query<T>) => guarded(query, async (request) => guard.result(await inner.queryAll(request))),
    queryAggregate: (query: Parameters<Source<T>["queryAggregate"]>[0]) =>
      guarded(query, (request) => inner.queryAggregate({ ...request, aggregation: query.aggregation })) as Promise<
        Result<T>
      >,
    queryExtent: (query?: Query<T>) => guarded(query, (request) => inner.queryExtent(request)),
    async *stream(query?: Query<T>) {
      const request = guard.query(query);
      await verify(request.signal);
      for await (const page of inner.stream(request)) yield guard.result(page);
    },
    protocol: () => undefined,
    adapter: () => undefined,
    supports: inner.supports,
    planLookup: (value: string, lookupOptions?: PublicationLookupOptions) =>
      planLookup(context, value, lookupOptions?.signal),
    lookup,
    select: async (feature: RenderedPublicationFeature, lookupOptions?: PublicationLookupOptions) =>
      lookup(renderedIdentity(publication, feature), lookupOptions),
    exportFeatures: (format: PublicationExportFormat, query?: Query<T>) =>
      guarded(undefined, () =>
        exportPublicFeatures(inner, guard, { format, query, identityColumn: publication.identity.geoparquetColumn }),
      ),
    verifyGeoParquetArtifact: (lookupOptions?: PublicationLookupOptions) => verify(lookupOptions?.signal),
  }) as unknown as PublicationSource<T>;
}
