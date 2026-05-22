/**
 * `@honua/sdk-js/filter-registry` — shared filter / crossfilter registry.
 *
 * Protocol-neutral state container for map, chart, table, search, and control
 * filters. Projection helpers translate active clauses into existing SDK
 * query, linked-view, widget, runtime-style, and URL state.
 *
 * @example
 * ```ts
 * import { createFilterRegistry, projectFilterRegistryToQuery } from "@honua/sdk-js/filter-registry";
 *
 * const registry = createFilterRegistry();
 * registry.set("status", { field: "STATUS", op: "=", value: "ACTIVE" });
 * registry.set("severity", { field: "SEVERITY", op: ">=", value: 3 });
 *
 * const query = projectFilterRegistryToQuery(registry, { sourceId: "incidents" });
 * const { features } = await dataset.source("incidents")!.queryAll(query);
 * ```
 *
 * @packageDocumentation
 */

import type {
  Capability,
  DegradedReason,
  PaginationSpec,
  Protocol,
  Query,
  SortSpec,
  SourceDescriptor,
  SourceId,
} from "../contract/types.js";
import type { WidgetSourceProjection } from "../contract/widget-source.js";
import type { SpatialFilter } from "../core/spatial-filter.js";
import type { HonuaExtent } from "../core/types.js";
import type { LinkedViewQueryProjection } from "../exploration/selectors.js";
import type {
  FilterClause as ExplorationFilterClause,
  FeatureSelectionTarget,
  FilterOperator,
} from "../exploration/types.js";

export type FilterRegistryOwner =
  | { readonly kind: "map"; readonly id: string }
  | { readonly kind: "chart"; readonly id: string }
  | { readonly kind: "table"; readonly id: string }
  | { readonly kind: "search"; readonly id: string }
  | { readonly kind: "control"; readonly id: string }
  | { readonly kind: "component"; readonly id: string };

export type FilterLifecycle = "persistent" | "session" | "transient";
export type FilterEffect = "filter" | "crossfilter" | "selection" | "search" | "spatial-mask";
export type FilterSourceScope = "all" | readonly SourceId[];
export type FilterRuntimeApplyMode = "server" | "runtime" | "client";
export type RuntimeStyleFilterExpression = readonly unknown[];

export interface FilterValuePolicy {
  /** Omit this value from URL/share serialization. */
  readonly secret?: boolean;
  /** Omit values whose stable JSON representation exceeds this size. @default 2048 */
  readonly maxSerializedBytes?: number;
}

export interface RegistrySpatialScope {
  readonly filter?: SpatialFilter;
  readonly extent?: HonuaExtent;
}

export interface FilterClause {
  readonly id: string;
  readonly owner: FilterRegistryOwner;
  readonly sourceScope?: FilterSourceScope;
  readonly field?: string;
  readonly operator?: FilterOperator;
  readonly value?: unknown;
  readonly spatialScope?: RegistrySpatialScope;
  readonly lifecycle?: FilterLifecycle;
  readonly effect?: FilterEffect;
  readonly enabled?: boolean;
  readonly cacheable?: boolean;
  readonly valuePolicy?: FilterValuePolicy;
}

export interface FilterRegistrySnapshot {
  readonly version: 1;
  readonly clauses: readonly FilterClause[];
}

export interface ShareableFilterRegistryState {
  readonly version: 1;
  readonly clauses: readonly FilterClause[];
}

export interface FilterRegistryChangeEvent {
  readonly snapshot: FilterRegistrySnapshot;
  readonly previous: FilterRegistrySnapshot;
  readonly changedIds: ReadonlySet<string>;
}

export type FilterRegistryListener = (event: FilterRegistryChangeEvent) => void;
export type FilterRegistrySelector<T> = (snapshot: FilterRegistrySnapshot) => T;
export type FilterRegistrySelectorListener<T> = (value: T, event: FilterRegistryChangeEvent | undefined) => void;
export type FilterRegistryUnsubscribe = () => void;

export interface FilterRegistrySelectorOptions<T> {
  readonly fireImmediately?: boolean;
  readonly equals?: (left: T, right: T) => boolean;
}

export interface FilterRegistry {
  readonly snapshot: FilterRegistrySnapshot;
  upsert(clause: FilterClause): void;
  remove(id: string): void;
  clearOwner(owner: FilterRegistryOwner): void;
  clearSource(sourceId: SourceId): void;
  setEnabled(id: string, enabled: boolean): void;
  replace(snapshot: FilterRegistrySnapshot): void;
  subscribe(listener: FilterRegistryListener): FilterRegistryUnsubscribe;
  select<T>(
    selector: FilterRegistrySelector<T>,
    listener: FilterRegistrySelectorListener<T>,
    options?: FilterRegistrySelectorOptions<T>,
  ): FilterRegistryUnsubscribe;
}

export interface CreateFilterRegistryOptions {
  readonly initialClauses?: readonly FilterClause[];
}

export interface FilterRegistryProjectionOptions {
  readonly sourceId?: SourceId;
  readonly includeDisabled?: boolean;
}

export interface FilterRegistryQueryProjectionOptions extends FilterRegistryProjectionOptions {
  readonly baseQuery?: Query;
  readonly source?: Pick<SourceDescriptor, "id" | "protocol" | "capabilities">;
}

export interface FilterRegistryQueryProjection {
  readonly query: Query;
  readonly where?: string;
  readonly projection: WidgetSourceProjection;
  readonly linkedView: LinkedViewQueryProjection;
  readonly runtimeFilter?: RuntimeStyleFilterExpression;
  readonly degraded?: readonly DegradedReason[];
  readonly cacheKey: string;
  readonly cacheable: boolean;
}

const SERVER_FILTER_PROTOCOLS = new Set<Protocol>([
  "grpc",
  "geoservices-feature-service",
  "geoservices-map-service",
  "ogc-features",
  "wfs",
  "odata",
]);
const FILTER_OWNER_KINDS = new Set<FilterRegistryOwner["kind"]>([
  "map",
  "chart",
  "table",
  "search",
  "control",
  "component",
]);
const FILTER_LIFECYCLES = new Set<FilterLifecycle>(["persistent", "session", "transient"]);
const FILTER_EFFECTS = new Set<FilterEffect>(["filter", "crossfilter", "selection", "search", "spatial-mask"]);
const FILTER_OPERATORS = new Set<FilterOperator>([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "between",
  "like",
  "is-null",
  "is-not-null",
]);
const FILTER_FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Create an in-memory filter registry with owner-scoped mutation helpers. */
export function createFilterRegistry(options: CreateFilterRegistryOptions = {}): FilterRegistry {
  let clauses = normalizeClauses(options.initialClauses ?? []);
  let snapshot = freezeSnapshot({ version: 1, clauses });
  const listeners = new Set<FilterRegistryListener>();

  function publish(previous: FilterRegistrySnapshot, changedIds: ReadonlySet<string>): void {
    if (changedIds.size === 0) return;
    const event: FilterRegistryChangeEvent = { snapshot, previous, changedIds };
    for (const listener of [...listeners]) listener(event);
  }

  function commit(nextClauses: readonly FilterClause[], changedIds: ReadonlySet<string>): void {
    const previous = snapshot;
    clauses = normalizeClauses(nextClauses);
    snapshot = freezeSnapshot({ version: 1, clauses });
    publish(previous, changedIds);
  }

  return {
    get snapshot() {
      return snapshot;
    },
    upsert(clause) {
      const byId = new Map(clauses.map((entry) => [entry.id, entry] as const));
      const existing = byId.get(clause.id);
      if (existing && valuesEqual(existing, clause)) return;
      byId.set(clause.id, normalizeClause(clause));
      commit([...byId.values()], new Set([clause.id]));
    },
    remove(id) {
      if (!clauses.some((clause) => clause.id === id)) return;
      commit(
        clauses.filter((clause) => clause.id !== id),
        new Set([id]),
      );
    },
    clearOwner(owner) {
      const changed = clauses.filter((clause) => ownerKey(clause.owner) === ownerKey(owner)).map((clause) => clause.id);
      if (changed.length === 0) return;
      commit(
        clauses.filter((clause) => ownerKey(clause.owner) !== ownerKey(owner)),
        new Set(changed),
      );
    },
    clearSource(sourceId) {
      const changed = clauses
        .filter((clause) => appliesExplicitlyToSource(clause, sourceId))
        .map((clause) => clause.id);
      if (changed.length === 0) return;
      commit(
        clauses.filter((clause) => !appliesExplicitlyToSource(clause, sourceId)),
        new Set(changed),
      );
    },
    setEnabled(id, enabled) {
      let changed = false;
      const next = clauses.map((clause) => {
        if (clause.id !== id || (clause.enabled ?? true) === enabled) return clause;
        changed = true;
        return { ...clause, enabled };
      });
      if (changed) commit(next, new Set([id]));
    },
    replace(nextSnapshot) {
      if (nextSnapshot.version !== 1)
        throw new Error(`Unsupported filter registry snapshot version ${nextSnapshot.version}`);
      const next = normalizeClauses(nextSnapshot.clauses);
      if (valuesEqual(clauses, next)) return;
      const ids = new Set([...clauses.map((clause) => clause.id), ...next.map((clause) => clause.id)]);
      commit(next, ids);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(selector, listener, options = {}) {
      const equals = options.equals ?? valuesEqual;
      let current = selector(snapshot);
      if (options.fireImmediately) listener(current, undefined);
      return this.subscribe((event) => {
        const next = selector(event.snapshot);
        if (equals(current, next)) return;
        current = next;
        listener(next, event);
      });
    },
  };
}

/** Return active clauses in deterministic id order, optionally source-scoped. */
export function selectActiveFilterClauses(
  snapshot: FilterRegistrySnapshot,
  options: FilterRegistryProjectionOptions = {},
): readonly FilterClause[] {
  return snapshot.clauses
    .filter(isFilterClause)
    .filter(
      (clause) => (options.includeDisabled || (clause.enabled ?? true)) && appliesToSource(clause, options.sourceId),
    )
    .sort(compareClause);
}

/** Project active registry clauses into query/widget/linked-view/runtime state. */
export function projectFilterRegistryToQuery(
  snapshot: FilterRegistrySnapshot,
  options: FilterRegistryQueryProjectionOptions = {},
): FilterRegistryQueryProjection {
  const active = selectActiveFilterClauses(snapshot, options);
  const filters = toProjectionFilters(active);
  const linkedViewFilters = toLinkedViewFilters(active);
  const where = compileWhere(active);
  const spatialFilter = firstSpatialFilter(active);
  const query: Query = {
    ...(options.baseQuery ?? {}),
    ...(combineWhere(options.baseQuery?.where, where) ? { where: combineWhere(options.baseQuery?.where, where) } : {}),
    ...((options.baseQuery?.spatialFilter ?? spatialFilter)
      ? { spatialFilter: options.baseQuery?.spatialFilter ?? spatialFilter }
      : {}),
  };
  const projection: WidgetSourceProjection = {
    filters,
    ...(spatialFilter ? { spatialFilter } : {}),
  };
  const linkedView: LinkedViewQueryProjection = {
    filters: linkedViewFilters,
    ...(spatialFilter ? { spatialFilter } : {}),
    orderBy: (query.orderBy ?? []) as readonly SortSpec[],
    pagination: (query.pagination ?? {}) as PaginationSpec,
    ...(query.outFields ? { outFields: query.outFields } : {}),
    grouping: [],
    ...(query.aggregation ? { aggregation: query.aggregation } : {}),
    selection: [] as readonly FeatureSelectionTarget[],
  };
  const degraded = degradationFor(options.source, active);
  return {
    query,
    ...(where ? { where } : {}),
    projection,
    linkedView,
    runtimeFilter: compileRuntimeStyleFilter(active),
    ...(degraded.length > 0 ? { degraded } : {}),
    cacheKey: serializeFilterRegistry(snapshot, { sourceId: options.sourceId }),
    cacheable: active.every((clause) => clause.cacheable !== false && clause.lifecycle !== "transient"),
  };
}

/** Project active clauses directly into a `WidgetSourceProjection`. */
export function projectFilterRegistryToWidgetProjection(
  snapshot: FilterRegistrySnapshot,
  options: FilterRegistryProjectionOptions = {},
): WidgetSourceProjection {
  const projection = projectFilterRegistryToQuery(snapshot, options).projection;
  return projection;
}

/** Project active clauses into the linked-view projection consumed by existing helpers. */
export function projectFilterRegistryToLinkedView(
  snapshot: FilterRegistrySnapshot,
  options: FilterRegistryQueryProjectionOptions = {},
): LinkedViewQueryProjection {
  return projectFilterRegistryToQuery(snapshot, options).linkedView;
}

/** Compile active field clauses into a MapLibre-compatible expression tree. */
export function compileRuntimeStyleFilter(clauses: readonly FilterClause[]): RuntimeStyleFilterExpression | undefined {
  const parts = clauses
    .filter((clause) => (clause.enabled ?? true) && clause.field && clause.operator)
    .map(compileRuntimeClause)
    .filter((entry): entry is RuntimeStyleFilterExpression => entry !== undefined);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : (["all", ...parts] as const);
}

/** Deterministic URL/cache serialization. Secret or large values are omitted. */
export function serializeFilterRegistry(
  snapshot: FilterRegistrySnapshot,
  options: FilterRegistryProjectionOptions = {},
): string {
  const shareable: ShareableFilterRegistryState = {
    version: 1,
    clauses: selectActiveFilterClauses(snapshot, options)
      .filter((clause) => clause.lifecycle !== "transient")
      .map(shareableClause),
  };
  return stableShareStringify(shareable);
}

/** Parse a registry serialization produced by `serializeFilterRegistry`. */
export function parseFilterRegistry(value: string | null | undefined): FilterRegistrySnapshot {
  if (!value) return freezeSnapshot({ version: 1, clauses: [] });
  try {
    const parsed = JSON.parse(value) as Partial<ShareableFilterRegistryState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.clauses)) return freezeSnapshot({ version: 1, clauses: [] });
    return freezeSnapshot({ version: 1, clauses: normalizeClauses(parsed.clauses.filter(isFilterClause)) });
  } catch {
    return freezeSnapshot({ version: 1, clauses: [] });
  }
}

function toProjectionFilters(clauses: readonly FilterClause[]): NonNullable<WidgetSourceProjection["filters"]> {
  const out: Record<string, NonNullable<WidgetSourceProjection["filters"]>[string]> = {};
  for (const clause of clauses) {
    if (!clause.field || !clause.operator) continue;
    out[clause.id] = {
      field: clause.field,
      operator: clause.operator,
      ...(clause.value !== undefined ? { value: clause.value } : {}),
      ...(Array.isArray(clause.sourceScope) ? { appliesTo: clause.sourceScope } : {}),
    };
  }
  return out;
}

function toLinkedViewFilters(clauses: readonly FilterClause[]): Readonly<Record<string, ExplorationFilterClause>> {
  const out: Record<string, ExplorationFilterClause> = {};
  for (const clause of clauses) {
    if (!clause.field || !clause.operator) continue;
    out[clause.id] = {
      field: clause.field,
      operator: clause.operator,
      ...(clause.value !== undefined ? { value: clause.value } : {}),
      ...(Array.isArray(clause.sourceScope) ? { appliesTo: clause.sourceScope } : {}),
    };
  }
  return out;
}

function compileWhere(clauses: readonly FilterClause[]): string | undefined {
  const parts = clauses
    .map(compileClauseWhere)
    .filter((entry): entry is string => entry !== undefined)
    .map((entry) => `(${entry})`);
  return parts.length > 0 ? parts.join(" AND ") : undefined;
}

function compileClauseWhere(clause: FilterClause): string | undefined {
  if (!clause.field || !clause.operator) return undefined;
  const field = sqlIdentifier(clause.field);
  if (!field) return undefined;
  switch (clause.operator) {
    case "=":
      return `${field} = ${literal(clause.value)}`;
    case "!=":
      return `${field} <> ${literal(clause.value)}`;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return `${field} ${clause.operator} ${literal(clause.value)}`;
    case "in":
    case "not-in":
      if (!Array.isArray(clause.value) || clause.value.length === 0) return undefined;
      return `${field} ${clause.operator === "not-in" ? "NOT " : ""}IN (${clause.value.map(literal).join(", ")})`;
    case "between":
      if (!Array.isArray(clause.value) || clause.value.length < 2) return undefined;
      return `${field} BETWEEN ${literal(clause.value[0])} AND ${literal(clause.value[1])}`;
    case "like":
      return `${field} LIKE ${literal(clause.value)}`;
    case "is-null":
      return `${field} IS NULL`;
    case "is-not-null":
      return `${field} IS NOT NULL`;
  }
}

function compileRuntimeClause(clause: FilterClause): RuntimeStyleFilterExpression | undefined {
  if (!clause.field || !clause.operator) return undefined;
  const get = ["get", clause.field] as const;
  switch (clause.operator) {
    case "=":
      return ["==", get, clause.value] as const;
    case "!=":
      return ["!=", get, clause.value] as const;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return [clause.operator, get, clause.value] as const;
    case "in":
      return Array.isArray(clause.value) ? (["in", get, ["literal", clause.value]] as const) : undefined;
    case "not-in":
      return Array.isArray(clause.value) ? (["!", ["in", get, ["literal", clause.value]]] as const) : undefined;
    case "is-null":
      return ["==", get, null] as const;
    case "is-not-null":
      return ["!=", get, null] as const;
    case "between":
      if (!Array.isArray(clause.value) || clause.value.length < 2) return undefined;
      return ["all", [">=", get, clause.value[0]], ["<=", get, clause.value[1]]] as const;
    case "like":
      return undefined;
  }
}

function degradationFor(
  source: Pick<SourceDescriptor, "id" | "protocol" | "capabilities"> | undefined,
  clauses: readonly FilterClause[],
): readonly DegradedReason[] {
  if (!source || clauses.length === 0) return [];
  const fieldClauses = clauses.filter((clause) => clause.field && clause.operator);
  if (fieldClauses.length === 0) return [];
  const canQuery = source.capabilities.has("query");
  const canServerFilter = canQuery && (source.capabilities.has("sql") || SERVER_FILTER_PROTOCOLS.has(source.protocol));
  if (canServerFilter) return [];
  return [
    degradedReason(
      "query",
      source,
      `Filter registry kept ${fieldClauses.length} field filter(s) for runtime/client evaluation because ${source.protocol} cannot apply them server-side.`,
    ),
  ];
}

function degradedReason(
  capability: Capability,
  source: Pick<SourceDescriptor, "id" | "protocol">,
  reason: string,
): DegradedReason {
  return { capability, protocol: source.protocol, sourceId: source.id, reason };
}

function firstSpatialFilter(clauses: readonly FilterClause[]): SpatialFilter | undefined {
  for (const clause of clauses) {
    if (clause.spatialScope?.filter) return clause.spatialScope.filter;
    if (clause.spatialScope?.extent) {
      const extent = clause.spatialScope.extent;
      return {
        geometryType: "esriGeometryEnvelope",
        geometry: { ...extent },
        spatialRel: "esriSpatialRelIntersects",
      };
    }
  }
  return undefined;
}

function appliesToSource(clause: FilterClause, sourceId: SourceId | undefined): boolean {
  if (!sourceId) return true;
  if (!clause.sourceScope || clause.sourceScope === "all") return true;
  return clause.sourceScope.includes(sourceId);
}

function appliesExplicitlyToSource(clause: FilterClause, sourceId: SourceId): boolean {
  return Array.isArray(clause.sourceScope) && clause.sourceScope.includes(sourceId);
}

function shareableClause(clause: FilterClause): FilterClause {
  const normalized = normalizeClause(clause);
  if (normalized.value === undefined) return normalized;
  const maxBytes = normalized.valuePolicy?.maxSerializedBytes ?? 2048;
  const encoded = stableStringify(normalized.value);
  if (normalized.valuePolicy?.secret || encoded.length > maxBytes) {
    const { value: _value, ...withoutValue } = normalized;
    return withoutValue;
  }
  return normalized;
}

function normalizeClauses(input: readonly FilterClause[]): readonly FilterClause[] {
  const byId = new Map<string, FilterClause>();
  for (const clause of input) byId.set(clause.id, normalizeClause(clause));
  return deepFreeze([...byId.values()].sort(compareClause));
}

function normalizeClause(clause: FilterClause): FilterClause {
  if (!isFilterClause(clause)) throw new Error("Invalid filter registry clause");
  return deepFreeze({
    id: clause.id,
    owner: { kind: clause.owner.kind, id: clause.owner.id },
    ...(clause.field !== undefined ? { field: clause.field } : {}),
    ...(clause.operator !== undefined ? { operator: clause.operator } : {}),
    ...(clause.value !== undefined ? { value: cloneJsonLike(clause.value) } : {}),
    ...(clause.spatialScope !== undefined ? { spatialScope: cloneJsonLike(clause.spatialScope) } : {}),
    enabled: clause.enabled ?? true,
    lifecycle: clause.lifecycle ?? "session",
    effect: clause.effect ?? (clause.spatialScope ? "spatial-mask" : "filter"),
    sourceScope: cloneSourceScope(clause.sourceScope ?? "all"),
    ...(clause.cacheable !== undefined ? { cacheable: clause.cacheable } : {}),
    ...(clause.valuePolicy !== undefined ? { valuePolicy: cloneJsonLike(clause.valuePolicy) } : {}),
  });
}

function compareClause(left: FilterClause, right: FilterClause): number {
  return left.id.localeCompare(right.id);
}

function ownerKey(owner: FilterRegistryOwner): string {
  return `${owner.kind}:${owner.id}`;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlIdentifier(field: string): string | undefined {
  return FILTER_FIELD_IDENTIFIER.test(field) ? field : undefined;
}

function combineWhere(left: string | undefined, right: string | undefined): string | undefined {
  if (left && right) return `(${left}) AND (${right})`;
  return left || right || undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value, false));
}

function stableShareStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value, true));
}

function sortJsonValue(value: unknown, stripValuePolicy: boolean): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJsonValue(entry, stripValuePolicy));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (stripValuePolicy && key === "valuePolicy") continue;
    out[key] = sortJsonValue((value as Record<string, unknown>)[key], stripValuePolicy);
  }
  return out;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function isFilterClause(value: unknown): value is FilterClause {
  if (!isRecord(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    isFilterRegistryOwner(record.owner) &&
    validOptional(record.field, (field) => typeof field === "string" && FILTER_FIELD_IDENTIFIER.test(field)) &&
    validOptional(
      record.operator,
      (operator) => typeof operator === "string" && FILTER_OPERATORS.has(operator as FilterOperator),
    ) &&
    validOptional(record.sourceScope, isFilterSourceScope) &&
    validOptional(
      record.lifecycle,
      (lifecycle) => typeof lifecycle === "string" && FILTER_LIFECYCLES.has(lifecycle as FilterLifecycle),
    ) &&
    validOptional(
      record.effect,
      (effect) => typeof effect === "string" && FILTER_EFFECTS.has(effect as FilterEffect),
    ) &&
    validOptional(record.enabled, (enabled) => typeof enabled === "boolean") &&
    validOptional(record.cacheable, (cacheable) => typeof cacheable === "boolean") &&
    validOptional(record.spatialScope, isRecord) &&
    validOptional(record.valuePolicy, isFilterValuePolicy)
  );
}

function isFilterRegistryOwner(value: unknown): value is FilterRegistryOwner {
  if (!isRecord(value)) return false;
  return (
    typeof value.kind === "string" &&
    FILTER_OWNER_KINDS.has(value.kind as FilterRegistryOwner["kind"]) &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}

function isFilterSourceScope(value: unknown): value is FilterSourceScope {
  return (
    value === "all" || (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0))
  );
}

function isFilterValuePolicy(value: unknown): value is FilterValuePolicy {
  if (!isRecord(value)) return false;
  return (
    validOptional(value.secret, (secret) => typeof secret === "boolean") &&
    validOptional(
      value.maxSerializedBytes,
      (maxSerializedBytes) => typeof maxSerializedBytes === "number" && Number.isFinite(maxSerializedBytes),
    )
  );
}

function validOptional(value: unknown, validate: (value: unknown) => boolean): boolean {
  return value === undefined || validate(value);
}

function cloneSourceScope(sourceScope: FilterSourceScope): FilterSourceScope {
  return Array.isArray(sourceScope) ? deepFreeze([...sourceScope]) : sourceScope;
}

function freezeSnapshot(snapshot: FilterRegistrySnapshot): FilterRegistrySnapshot {
  return deepFreeze(snapshot);
}

function cloneJsonLike<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJsonLike) as T;
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = cloneJsonLike((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
