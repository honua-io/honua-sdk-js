import type { FeatureId, Query, Result, SortSpec } from "../contract/types.js";
import { isSourceQualifiedSelectionTarget } from "../exploration/selection.js";
import type { FeatureSelectionTarget } from "../exploration/types.js";
import { sqlIdentifier, sqlLiteral } from "../filter-registry/sql-text.js";
import type {
  HonuaFeatureTableBudgetLedger,
  HonuaFeatureTableBudgets,
  HonuaFeatureTableCountEvidence,
  HonuaFeatureTableFocus,
  HonuaFeatureTablePagingMode,
  HonuaFeatureTableReveal,
  HonuaFeatureTableRow,
  HonuaFeatureTableRowKey,
  HonuaFeatureTableState,
  HonuaFeatureTableWindow,
} from "./feature-table-engine.js";

export interface FeatureTableCachedPage<T> {
  readonly offset: number;
  readonly rows: readonly HonuaFeatureTableRow<T>[];
  readonly bytes: number;
  readonly cacheKey: string;
  sequence: number;
}

interface LocateView<T> {
  readonly disposed: boolean;
  readonly revealSerial: number;
  readonly identityField: string | undefined;
  readonly state: HonuaFeatureTableState;
  readonly message: string | undefined;
  readonly pagingMode: HonuaFeatureTablePagingMode;
  readonly sourceId: string;
  readonly window: HonuaFeatureTableWindow;
  readonly budgets: HonuaFeatureTableBudgets;
  readonly sort: readonly SortSpec[];
  readonly pages: ReadonlyMap<number, FeatureTableCachedPage<T>>;
  readonly totalKnown: number | undefined;
  readonly totalEvidence: Extract<HonuaFeatureTableCountEvidence, "result-total-count" | "exhausted-pages">;
  readonly exhausted: boolean;
  readonly focus: HonuaFeatureTableFocus | undefined;
  readonly ledger: HonuaFeatureTableBudgetLedger;
}

interface LocateWrite<T> {
  readonly revealSerial?: number;
  readonly window?: HonuaFeatureTableWindow;
  readonly focus?: HonuaFeatureTableFocus;
  readonly totals?: {
    readonly totalKnown: number | undefined;
    readonly totalEvidence: LocateView<T>["totalEvidence"];
    readonly exhausted: boolean;
  };
  readonly pages?: ReadonlyMap<number, FeatureTableCachedPage<T>>;
}

export interface FeatureTableLocateHost<T> {
  read(): LocateView<T>;
  write(patch: LocateWrite<T>): void;
  query(query: Query<T>): Promise<Result<T>>;
  composeQuery(page: { readonly offset?: number; readonly limit: number }): {
    readonly query: Query<T>;
    readonly empty: boolean;
  };
  noteBudget(patch: { requests?: number; rows?: number; bytes?: number; evictedRows?: number }): void;
  fetchPage(offset: number, signal: AbortSignal | undefined): Promise<FeatureTableCachedPage<T> | undefined>;
  findRow(key: HonuaFeatureTableRowKey): HonuaFeatureTableRow<T> | undefined;
  setSelection(next: readonly HonuaFeatureTableRowKey[]): void;
  settle(): void;
  publish(): void;
  keyForTarget(target: FeatureSelectionTarget): HonuaFeatureTableRowKey | undefined;
  pageOffsetFor(index: number): number;
  projection(): readonly string[] | undefined;
  orderedFields(): readonly string[];
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

interface LocateRequest {
  readonly id: string | number;
  readonly idField: string;
  readonly signal: AbortSignal | undefined;
  readonly token: number;
}

type SortKey = { readonly field: string; readonly direction: "asc" | "desc" };
type ComparableKey = SortKey & { readonly value: string | number | boolean };

const LOCATE_CEILING = {
  status: "unsupported" as const,
  reason: "The request ceiling was reached before the target could be located.",
};

function targetIdentity(sourceId: string, target: FeatureSelectionTarget): FeatureId | undefined {
  if (!isSourceQualifiedSelectionTarget(target)) return target;
  return target.sourceId === sourceId ? target.id : undefined;
}

function sameIdentity(left: unknown, right: FeatureId): boolean {
  if (left === right) return true;
  return (typeof left === "string" || typeof left === "number") && String(left) === String(right);
}

function rowsBeforePredicate(keys: readonly ComparableKey[], idField: string, idValue: string | number): string {
  const terms: string[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!key) continue;
    const earlier = keys.slice(0, index).map((entry) => `${entry.field} = ${sqlLiteral(entry.value)}`);
    const comparison = `${key.field} ${key.direction === "desc" ? ">" : "<"} ${sqlLiteral(key.value)}`;
    terms.push(`(${[...earlier, comparison].join(" AND ")})`);
  }
  const tied = keys.map((entry) => `${entry.field} = ${sqlLiteral(entry.value)}`);
  terms.push(`(${[...tied, `${idField} < ${sqlLiteral(idValue)}`].join(" AND ")})`);
  return terms.join(" OR ");
}

function probeQuery<T>(request: {
  readonly base: Query<T> | undefined;
  readonly predicate: string;
  readonly signal: AbortSignal | undefined;
  readonly fields: readonly string[];
}): Query<T> {
  return {
    ...(request.base ?? {}),
    where: request.base?.where ? `(${request.base.where}) AND (${request.predicate})` : request.predicate,
    outFields: request.fields,
    pagination: { limit: 1 },
    returnGeometry: false,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

async function ask<T>(
  host: FeatureTableLocateHost<T>,
  query: Query<T>,
  signal: AbortSignal | undefined,
): Promise<Result<T> | "cancelled" | "ceiling"> {
  const view = host.read();
  if (view.disposed || signal?.aborted) return "cancelled";
  if (view.ledger.requests >= view.budgets.maxRequests) return "ceiling";
  host.noteBudget({ requests: 1 });
  try {
    return await host.query(query);
  } catch (error) {
    if (isAbort(error) || signal?.aborted) return "cancelled";
    throw error;
  }
}

function revealStillCurrent<T>(
  host: FeatureTableLocateHost<T>,
  token: number,
  signal: AbortSignal | undefined,
): boolean {
  const view = host.read();
  return token === view.revealSerial && !view.disposed && !signal?.aborted;
}

function restorePages<T>(
  host: FeatureTableLocateHost<T>,
  saved: ReadonlyMap<number, FeatureTableCachedPage<T>>,
  totals: NonNullable<LocateWrite<T>["totals"]>,
): void {
  host.write({ pages: saved, totals });
  host.publish();
}

function windowOffsets<T>(host: FeatureTableLocateHost<T>, nextWindow: HonuaFeatureTableWindow): number[] {
  const wanted = new Set<number>();
  const end = Math.max(nextWindow.endIndex, nextWindow.startIndex + 1);
  for (let index = nextWindow.startIndex; index < end; index += 1) wanted.add(host.pageOffsetFor(index));
  return [...wanted].sort((left, right) => left - right);
}

async function showLocated<T>(
  host: FeatureTableLocateHost<T>,
  request: {
    readonly index: number;
    readonly key: HonuaFeatureTableRowKey;
    readonly signal: AbortSignal | undefined;
    readonly token: number;
    readonly selection: "replace" | "keep";
  },
): Promise<"shown" | "cancelled" | "unsupported"> {
  if (!revealStillCurrent(host, request.token, request.signal)) return "cancelled";
  const view = host.read();
  const span = Math.max(
    1,
    view.window.endIndex > view.window.startIndex
      ? view.window.endIndex - view.window.startIndex
      : view.budgets.pageSize,
  );
  const start =
    request.index < view.window.startIndex || request.index >= view.window.endIndex
      ? Math.max(0, request.index - Math.floor((span - 1) / 2))
      : view.window.startIndex;
  const nextWindow = Object.freeze({ startIndex: start, endIndex: start + span });
  const savedPages = new Map(view.pages);
  const savedTotals = { totalKnown: view.totalKnown, totalEvidence: view.totalEvidence, exhausted: view.exhausted };
  try {
    for (const offset of windowOffsets(host, nextWindow)) {
      if (!revealStillCurrent(host, request.token, request.signal)) return "cancelled";
      await host.fetchPage(offset, request.signal);
    }
  } catch (error) {
    const current = host.read();
    if (request.token === current.revealSerial && !current.disposed) restorePages(host, savedPages, savedTotals);
    if (isAbort(error) || request.signal?.aborted) return "cancelled";
    throw error;
  }
  if (!revealStillCurrent(host, request.token, request.signal)) {
    if (request.signal?.aborted && request.token === host.read().revealSerial && !host.read().disposed) {
      restorePages(host, savedPages, savedTotals);
    }
    return "cancelled";
  }
  const shown = host.findRow(request.key);
  if (!shown || shown.index !== request.index) {
    restorePages(host, savedPages, savedTotals);
    return "unsupported";
  }
  host.write({ window: nextWindow });
  const field = host.orderedFields()[0];
  if (field) host.write({ focus: Object.freeze({ rowKey: request.key, field }) });
  if (request.selection === "replace") host.setSelection([request.key]);
  host.settle();
  host.publish();
  return "shown";
}

function collectSortKeys(sort: readonly SortSpec[]): { ok: true; keys: SortKey[] } | { ok: false; reason: string } {
  const keys: SortKey[] = [];
  for (const entry of sort) {
    const field = sqlIdentifier(entry.field);
    if (!field) return { ok: false, reason: `Sort field ${entry.field} cannot be used in a bounded locate query.` };
    keys.push({ field, direction: entry.direction === "desc" ? "desc" : "asc" });
  }
  return { ok: true, keys };
}

function comparableSortValues(
  keys: readonly SortKey[],
  attributes: Record<string, unknown>,
): { ok: true; keys: ComparableKey[] } | { ok: false; reason: string } {
  const comparable: ComparableKey[] = [];
  for (const key of keys) {
    const value = attributes[key.field];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, reason: `Sort field ${key.field} has no comparable value on the target.` };
    }
    comparable.push({ field: key.field, direction: key.direction, value });
  }
  return { ok: true, keys: comparable };
}

async function rankTarget<T>(
  host: FeatureTableLocateHost<T>,
  request: LocateRequest,
  probe: { readonly query: Query<T>; readonly fields: readonly string[]; readonly keys: readonly SortKey[] },
): Promise<HonuaFeatureTableReveal | { readonly status: "found"; readonly index: number } | undefined> {
  const asked = await ask(
    host,
    probeQuery({
      base: probe.query,
      predicate: `${request.idField} = ${sqlLiteral(request.id)}`,
      signal: request.signal,
      fields: probe.fields,
    }),
    request.signal,
  );
  if (asked === "cancelled" || !revealStillCurrent(host, request.token, request.signal)) return { status: "cancelled" };
  if (asked === "ceiling") return LOCATE_CEILING;
  const feature = asked.features[0];
  const attributes = feature?.attributes as Record<string, unknown> | undefined;
  if (!feature || !attributes) return undefined;
  if (!sameIdentity(attributes[host.read().identityField ?? ""], request.id)) {
    return { status: "unsupported", reason: "The source did not apply the identity predicate." };
  }
  const comparable = comparableSortValues(probe.keys, attributes);
  if (!comparable.ok) return { status: "unsupported", reason: comparable.reason };
  const ranked = await ask(
    host,
    probeQuery({
      base: probe.query,
      predicate: rowsBeforePredicate(comparable.keys, request.idField, request.id),
      signal: request.signal,
      fields: [request.idField],
    }),
    request.signal,
  );
  if (ranked === "cancelled" || !revealStillCurrent(host, request.token, request.signal))
    return { status: "cancelled" };
  if (ranked === "ceiling") return LOCATE_CEILING;
  if (typeof ranked.totalCount !== "number" || !Number.isInteger(ranked.totalCount) || ranked.totalCount < 0) {
    return { status: "unsupported", reason: "The source did not report how many rows sort before the target." };
  }
  return { status: "found", index: ranked.totalCount };
}

async function probeBareIdentity<T>(
  host: FeatureTableLocateHost<T>,
  request: LocateRequest,
): Promise<HonuaFeatureTableReveal> {
  const bare = await ask(
    host,
    probeQuery({
      base: undefined,
      predicate: `${request.idField} = ${sqlLiteral(request.id)}`,
      signal: request.signal,
      fields: [request.idField],
    }),
    request.signal,
  );
  if (bare === "cancelled" || !revealStillCurrent(host, request.token, request.signal)) return { status: "cancelled" };
  if (bare === "ceiling") return LOCATE_CEILING;
  const identityField = host.read().identityField ?? "";
  const present = bare.features.some((feature) =>
    sameIdentity((feature.attributes as Record<string, unknown> | undefined)?.[identityField], request.id),
  );
  return present ? { status: "filtered-out" } : { status: "missing" };
}

async function locate<T>(
  host: FeatureTableLocateHost<T>,
  request: LocateRequest,
): Promise<HonuaFeatureTableReveal | { readonly status: "found"; readonly index: number }> {
  const view = host.read();
  const composed = host.composeQuery({ offset: 0, limit: 1 });
  const collected = collectSortKeys(view.sort);
  if (!collected.ok) return { status: "unsupported", reason: collected.reason };
  const fields = [
    ...new Set([...(host.projection() ?? []), request.idField, ...collected.keys.map((key) => key.field)]),
  ];
  if (!composed.empty) {
    const ranked = await rankTarget(host, request, { query: composed.query, fields, keys: collected.keys });
    if (ranked) return ranked;
  }
  return probeBareIdentity(host, request);
}

export async function revealOffWindow<T>(
  host: FeatureTableLocateHost<T>,
  target: FeatureSelectionTarget,
  revealOptions: { readonly signal?: AbortSignal; readonly select?: boolean } = {},
): Promise<HonuaFeatureTableReveal> {
  const signal = revealOptions.signal;
  const view = host.read();
  if (view.disposed || signal?.aborted) return { status: "cancelled" };
  if (!view.identityField || view.state === "unsupported") {
    return { status: "unsupported", reason: view.message ?? "This table cannot reveal a row." };
  }
  if (view.pagingMode === "cursor")
    return { status: "unsupported", reason: "Cursor paging cannot reveal an arbitrary row." };
  const id = targetIdentity(view.sourceId, target);
  const key = host.keyForTarget(target);
  const idField = sqlIdentifier(view.identityField);
  if (id === undefined || key === undefined) return { status: "missing" };
  if (!idField)
    return { status: "unsupported", reason: "The identity field cannot be used in a bounded locate query." };
  if (typeof id !== "string" && typeof id !== "number") {
    return { status: "unsupported", reason: "The target identity cannot be used in a bounded locate query." };
  }
  const token = view.revealSerial + 1;
  host.write({ revealSerial: token });
  try {
    const resident = host.findRow(key);
    const located = resident
      ? { status: "found" as const, index: resident.index }
      : await locate(host, { id, idField, signal, token });
    if (located.status !== "found") return located;
    if (!revealStillCurrent(host, token, signal)) return { status: "cancelled" };
    const shown = await showLocated(host, {
      index: located.index,
      key,
      signal,
      token,
      selection: revealOptions.select === false ? "keep" : "replace",
    });
    if (shown === "cancelled") return { status: "cancelled" };
    if (shown === "unsupported") {
      return { status: "unsupported", reason: "The source count did not place the target in the loaded window." };
    }
    return { status: "visible", key, index: located.index };
  } catch (error) {
    if (isAbort(error) || signal?.aborted) return { status: "cancelled" };
    throw error;
  }
}
