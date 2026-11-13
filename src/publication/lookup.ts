import { queryFilter } from "../contract/query-filter.js";
import type { DegradedReason, Query, Result, Source } from "../contract/types.js";
import { HonuaAbortError } from "../core/errors.js";
import { stringLiteral } from "../core/geoparquet-sql.js";
import type { GeoparquetRuntime } from "../geoparquet/index.js";
import { settleOrAbort } from "./abort.js";
import { HonuaPublicationError } from "./errors.js";
import type { PublicFieldGuard } from "./guard.js";
import type { Publication } from "./open.js";

/** Most a browser identity lookup may cost before it is answered elsewhere. */
export interface PublicationQueryBudget {
  readonly maxBytes: number;
  readonly maxTimeToFirstResultMs: number;
}

/** Budget for a parcel-identity lookup, set from the county-scale browser measurement. */
export const PUBLICATION_LOOKUP_BUDGET: PublicationQueryBudget = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxTimeToFirstResultMs: 2_000,
});

/** Why a lookup left the browser path, in words an app can show as they are. */
export interface PublicationQueryLimit {
  readonly kind: "bytes" | "time";
  readonly budget: number;
  readonly observed: number;
  readonly message: string;
}

/** GeoParquet row groups an identity lookup must read, and what reading them costs. */
export interface PublicationLookupPlan {
  readonly rowGroups: readonly number[];
  readonly footerBytes: number;
  readonly plannedBytes: number;
}

export interface PublicationLookup<T = Record<string, unknown>> {
  readonly result: Result<T>;
  readonly answeredBy: "geoparquet" | "server";
  readonly plan: PublicationLookupPlan;
  readonly elapsedMs: number;
  readonly limit?: PublicationQueryLimit;
}

export interface PublicationLookupOptions {
  readonly signal?: AbortSignal;
}

/** What the lookup needs from the paired source it belongs to. */
export interface LookupContext<T> {
  readonly publication: Publication;
  readonly sourceId: string;
  readonly runtime: GeoparquetRuntime;
  readonly guard: PublicFieldGuard;
  readonly budget: PublicationQueryBudget;
  readonly serverSource: Source | undefined;
  verify(signal?: AbortSignal): Promise<void>;
  queryBrowser(query: Query<T>): Promise<Result<T>>;
}

type MeasuredLimit = Omit<PublicationQueryLimit, "message">;

interface RowGroupCost {
  readonly row_group: unknown;
  readonly bytes: unknown;
  readonly chunk_end: unknown;
  readonly identity_min: unknown;
  readonly identity_max: unknown;
}

const EMPTY_PLAN: PublicationLookupPlan = Object.freeze({
  rowGroups: Object.freeze([]),
  footerBytes: 0,
  plannedBytes: 0,
});
const utf8 = new TextEncoder();

function count(value: unknown): number {
  return Number(value);
}

/** Parquet orders string statistics by UTF-8 bytes, not by JavaScript's UTF-16 units. */
function compareUtf8(left: string, right: string): number {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return (a[index] as number) - (b[index] as number);
  }
  return a.length - b.length;
}

function describeLimit(value: string, limit: MeasuredLimit): string {
  return limit.kind === "bytes"
    ? `Looking up ${value} in the browser would download about ${(limit.observed / 2 ** 20).toFixed(1)} MB, more than the ${(limit.budget / 2 ** 20).toFixed(1)} MB limit`
    : `Looking up ${value} in the browser took longer than ${(limit.budget / 1000).toFixed(1)} s`;
}

function answeredByServerMessage(value: string, limit: MeasuredLimit): string {
  return `${describeLimit(value, limit)}, so the live service answered instead.`;
}

function noServerMessage(value: string, limit: MeasuredLimit): string {
  return `${describeLimit(value, limit)}. Connect a live service to answer lookups like this one.`;
}

export async function planLookup<T>(
  context: LookupContext<T>,
  value: string,
  signal?: AbortSignal,
): Promise<PublicationLookupPlan> {
  const { publication } = context;
  const column = stringLiteral(publication.identity.geoparquetColumn);
  const url = stringLiteral(publication.geoparquetUrl);
  const rows = (await context.runtime.query(
    `SELECT row_group_id AS row_group, CAST(sum(total_compressed_size) AS BIGINT) AS bytes,
            CAST(max(chunk_start + total_compressed_size) AS BIGINT) AS chunk_end,
            min(stats_min_value) FILTER (WHERE path_in_schema = ${column}) AS identity_min,
            max(stats_max_value) FILTER (WHERE path_in_schema = ${column}) AS identity_max
       FROM (SELECT *, CASE WHEN dictionary_page_offset > 0 AND dictionary_page_offset < data_page_offset
                            THEN dictionary_page_offset ELSE data_page_offset END AS chunk_start
               FROM parquet_metadata(${url}))
      GROUP BY row_group_id ORDER BY row_group_id`,
    signal ? { signal } : undefined,
  )) as unknown as RowGroupCost[];
  const lastChunkEnd = Math.max(0, ...rows.map((row) => count(row.chunk_end)));
  const footerBytes = publication.descriptor.artifacts.geoparquet.bytes - lastChunkEnd;
  const matching = rows.filter((row) => {
    const low = typeof row.identity_min === "string" ? row.identity_min : undefined;
    const high = typeof row.identity_max === "string" ? row.identity_max : undefined;
    return (low === undefined || compareUtf8(low, value) <= 0) && (high === undefined || compareUtf8(value, high) <= 0);
  });
  return Object.freeze({
    rowGroups: Object.freeze(matching.map((row) => count(row.row_group))),
    footerBytes,
    plannedBytes: footerBytes + matching.reduce((total, row) => total + count(row.bytes), 0),
  });
}

/** Aborts its signal when the caller cancels or, when a live service can answer, when the time budget runs out. */
function budgetClock(budget: PublicationQueryBudget, callerSignal: AbortSignal | undefined, canFallBack: boolean) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal?.reason ?? new HonuaAbortError());
  callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    if (canFallBack) controller.abort(new HonuaAbortError());
  }, budget.maxTimeToFirstResultMs);
  return {
    signal: controller.signal,
    expired: () => expired,
    stop() {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    },
  };
}

type BrowserOutcome<T> =
  | { readonly answer: PublicationLookup<T> }
  | { readonly fallback: MeasuredLimit; readonly plan: PublicationLookupPlan };

async function answerInBrowser<T>(
  context: LookupContext<T>,
  value: string,
  clock: ReturnType<typeof budgetClock>,
): Promise<BrowserOutcome<T>> {
  const started = performance.now();
  await context.verify(clock.signal);
  const plan = await settleOrAbort(planLookup(context, value, clock.signal), clock.signal);
  if (plan.plannedBytes > context.budget.maxBytes) {
    const limit: MeasuredLimit = { kind: "bytes", budget: context.budget.maxBytes, observed: plan.plannedBytes };
    if (context.serverSource) return { fallback: limit, plan };
    throw new HonuaPublicationError("query-budget-exceeded", noServerMessage(value, limit), { detail: { limit } });
  }
  const result = await settleOrAbort(
    context.queryBrowser({
      filter: queryFilter.eq(context.publication.identity.geoparquetColumn, value),
      signal: clock.signal,
    } as Query<T>),
    clock.signal,
  );
  const elapsedMs = performance.now() - started;
  const late: MeasuredLimit | undefined = clock.expired()
    ? { kind: "time", budget: context.budget.maxTimeToFirstResultMs, observed: elapsedMs }
    : undefined;
  return {
    answer: Object.freeze({
      result,
      answeredBy: "geoparquet",
      plan,
      elapsedMs,
      ...(late ? { limit: { ...late, message: noServerMessage(value, late) } } : {}),
    }),
  };
}

interface ServerRequest {
  readonly value: string;
  readonly fallback: MeasuredLimit;
  readonly plan: PublicationLookupPlan;
  readonly started: number;
  readonly signal: AbortSignal | undefined;
}

async function answerFromServer<T>(context: LookupContext<T>, request: ServerRequest): Promise<PublicationLookup<T>> {
  const { value, signal } = request;
  const limit: PublicationQueryLimit = {
    ...request.fallback,
    message: answeredByServerMessage(value, request.fallback),
  };
  const server = context.serverSource as Source<T>;
  const result = await server.query({
    filter: queryFilter.eq(context.publication.identity.field, value),
    outFields: context.guard.names,
    returnGeometry: true,
    ...(signal ? { signal } : {}),
  });
  const reason: DegradedReason = {
    capability: "query",
    reason: limit.message,
    protocol: "geoparquet",
    sourceId: context.sourceId,
  };
  return Object.freeze({
    result: context.guard.result(result, reason),
    answeredBy: "server",
    plan: request.plan,
    elapsedMs: performance.now() - request.started,
    limit,
  });
}

/** Answer an identity lookup from GeoParquet within the budget, or from the live service when over it. */
export async function lookupIdentity<T>(
  context: LookupContext<T>,
  value: string,
  options: PublicationLookupOptions = {},
): Promise<PublicationLookup<T>> {
  const { field } = context.publication.identity;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${field} lookups take the identity as non-empty text`);
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw new HonuaAbortError();
  const started = performance.now();
  const clock = budgetClock(context.budget, callerSignal, context.serverSource !== undefined);
  let outcome: BrowserOutcome<T>;
  try {
    outcome = await answerInBrowser(context, value, clock);
  } catch (error) {
    if (callerSignal?.aborted) throw new HonuaAbortError();
    if (!(clock.expired() && context.serverSource)) throw error;
    const observed = performance.now() - started;
    outcome = { fallback: { kind: "time", budget: context.budget.maxTimeToFirstResultMs, observed }, plan: EMPTY_PLAN };
  } finally {
    clock.stop();
  }
  if ("answer" in outcome) return outcome.answer;
  return answerFromServer(context, { value, ...outcome, started, signal: callerSignal });
}
