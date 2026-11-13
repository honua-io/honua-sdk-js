import { queryFilter } from "../contract/query-filter.js";
import type { DegradedReason, Result, Source } from "../contract/types.js";
import { HonuaAbortError } from "../core/errors.js";
import { settleOrAbort } from "./abort.js";
import { HonuaPublicationError } from "./errors.js";
import type { PublicFieldGuard } from "./guard.js";
import type { Publication } from "./open.js";
import type { PublicationParquet } from "./parquet.js";
import { isRangeNotServed, megabytes } from "./range-reader.js";

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
  /** `ranges`: the host answered a range request with the whole file, so `observed` is the file size. */
  readonly kind: "bytes" | "time" | "ranges";
  readonly budget: number;
  readonly observed: number;
  readonly message: string;
}

/** GeoParquet row groups an identity lookup must read, and what reading them costs on a cold source. */
export interface PublicationLookupPlan {
  readonly rowGroups: readonly number[];
  /** The first read of the file's tail, which holds the footer. */
  readonly footerBytes: number;
  /** Footer read, bloom-filter reads and row-group reads together. */
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
export interface LookupContext {
  readonly publication: Publication;
  readonly sourceId: string;
  readonly parquet: PublicationParquet;
  readonly guard: PublicFieldGuard;
  readonly budget: PublicationQueryBudget;
  readonly serverSource: Source | undefined;
}

type MeasuredLimit = Omit<PublicationQueryLimit, "message">;

const EMPTY_PLAN: PublicationLookupPlan = Object.freeze({
  rowGroups: Object.freeze([]),
  footerBytes: 0,
  plannedBytes: 0,
});

function describeLimit(value: string, limit: MeasuredLimit): string {
  switch (limit.kind) {
    case "bytes":
      return `Looking up ${value} in the browser would download about ${megabytes(limit.observed)} MB, more than the ${megabytes(limit.budget)} MB limit`;
    case "ranges":
      return `Looking up ${value} in the browser would download the whole ${megabytes(limit.observed)} MB file, because its host does not serve byte ranges`;
    case "time":
      return `Looking up ${value} in the browser took longer than ${(limit.budget / 1000).toFixed(1)} s`;
  }
}

function answeredByServerMessage(value: string, limit: MeasuredLimit): string {
  return `${describeLimit(value, limit)}, so the live service answered instead.`;
}

function noServerMessage(value: string, limit: MeasuredLimit): string {
  return `${describeLimit(value, limit)}. Connect a live service to answer lookups like this one.`;
}

export async function planLookup(
  context: LookupContext,
  value: string,
  signal?: AbortSignal,
): Promise<PublicationLookupPlan> {
  return (await context.parquet.prepareLookup(value, signal)).plan;
}

/** Aborts its signal when the caller cancels or, when a live service can answer, when the time budget runs out. */
function budgetClock(context: LookupContext, callerSignal: AbortSignal | undefined) {
  const { budget, serverSource } = context;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(callerSignal?.reason ?? new HonuaAbortError());
  callerSignal?.addEventListener("abort", forwardAbort, { once: true });
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    if (serverSource) controller.abort(new HonuaAbortError());
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

function overBudget<T>(
  context: LookupContext,
  value: string,
  outcome: { readonly fallback: MeasuredLimit; readonly plan: PublicationLookupPlan },
): BrowserOutcome<T> {
  if (context.serverSource) return outcome;
  throw new HonuaPublicationError("query-budget-exceeded", noServerMessage(value, outcome.fallback), {
    detail: { limit: outcome.fallback },
  });
}

async function readInBrowser<T>(
  context: LookupContext,
  value: string,
  clock: ReturnType<typeof budgetClock>,
): Promise<BrowserOutcome<T>> {
  const started = performance.now();
  const prepared = await settleOrAbort(context.parquet.prepareLookup<T>(value, clock.signal), clock.signal);
  const { plan } = prepared;
  if (plan.plannedBytes > context.budget.maxBytes) {
    return overBudget(context, value, {
      fallback: { kind: "bytes", budget: context.budget.maxBytes, observed: plan.plannedBytes },
      plan,
    });
  }
  const result = context.guard.result(await settleOrAbort(prepared.read(), clock.signal));
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

/** A host without range support would cost the whole file, so the lookup leaves the browser with limit kind `ranges`. */
async function answerInBrowser<T>(
  context: LookupContext,
  value: string,
  clock: ReturnType<typeof budgetClock>,
): Promise<BrowserOutcome<T>> {
  try {
    return await readInBrowser<T>(context, value, clock);
  } catch (error) {
    if (!isRangeNotServed(error)) throw error;
    const observed = Number(error.detail?.fileBytes);
    return overBudget(context, value, {
      fallback: { kind: "ranges", budget: context.budget.maxBytes, observed },
      plan: EMPTY_PLAN,
    });
  }
}

interface ServerRequest {
  readonly value: string;
  readonly fallback: MeasuredLimit;
  readonly plan: PublicationLookupPlan;
  readonly started: number;
  readonly signal: AbortSignal | undefined;
}

async function answerFromServer<T>(context: LookupContext, request: ServerRequest): Promise<PublicationLookup<T>> {
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
  context: LookupContext,
  value: string,
  options: PublicationLookupOptions = {},
): Promise<PublicationLookup<T>> {
  const { field } = context.publication.identity;
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${field} lookups take the identity as non-empty text`);
  const callerSignal = options.signal;
  if (callerSignal?.aborted) throw new HonuaAbortError();
  const started = performance.now();
  const clock = budgetClock(context, callerSignal);
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
