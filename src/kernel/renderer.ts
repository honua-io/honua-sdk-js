import type { CapabilityPolicy, Query, Source, SourceId } from "../contract/types.js";
import type {
  ExecuteQueryPlanOptions,
  QueryExecutionPlanV1,
  QueryFallbackPolicy,
  QueryPlanCacheOptions,
  QueryPlanningEstimates,
} from "../query-planner/types.js";

/** Built-in renderers are conveniences; namespaced adapters may extend this vocabulary. */
export type RendererKind = "maplibre" | (string & {});

export type RendererEnvironment = "browser" | "node" | "worker";
export type RendererOwnership = "owned" | "borrowed";
export type RendererTarget = string | object;

/** Stable, renderer-neutral diagnostic exposed by one mounted handle. */
export interface RendererDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly strategy?: string;
}

/** Refresh controls shared by every renderer session. */
export interface MountedMapRefreshOptions {
  readonly signal?: AbortSignal;
}

/**
 * Request passed to an injected renderer adapter.
 *
 * The adapter may ask for a query plan only when its existing strategy needs
 * materialized features. Planning is memoized and performs no result I/O.
 */
export interface RendererMountRequest<T = Record<string, unknown>, TOptions = unknown> {
  readonly source: Source<T>;
  readonly rendererOptions?: TOptions;
  readonly style?: "auto" | Readonly<Record<string, unknown>>;
  readonly ownership: RendererOwnership;
  readonly signal: AbortSignal;
  readonly queryPlan?: QueryExecutionPlanV1;
  readonly execution: ExecuteQueryPlanOptions;
  planQuery(): Promise<QueryExecutionPlanV1>;
}

/** Renderer-owned leaf session adopted by the connection lifecycle. */
export interface RendererSession<TRaw = unknown> {
  readonly raw: TRaw;
  readonly ready: Promise<void>;
  readonly diagnostics: readonly RendererDiagnostic[];
  refresh(options?: MountedMapRefreshOptions): Promise<void>;
  dispose(): void | Promise<void>;
}

/**
 * Minimal executable renderer seam. Heavy peers are injected as values and
 * are never imported by the kernel.
 */
export interface RendererAdapter<TKind extends RendererKind = RendererKind, TRaw = unknown, TOptions = unknown> {
  readonly kind: TKind;
  readonly environments: readonly RendererEnvironment[];
  readonly peer: unknown;
  defaultOwnership(target: RendererTarget): RendererOwnership;
  mount<T = Record<string, unknown>>(
    target: RendererTarget,
    request: RendererMountRequest<T, TOptions>,
  ): Promise<RendererSession<TRaw>>;
}

/** Connection-level planning and renderer controls for one mount. */
export interface MountOptions<
  T = Record<string, unknown>,
  TKind extends RendererKind = RendererKind,
  TRaw = unknown,
  TRendererOptions = unknown,
> {
  readonly renderer: RendererAdapter<TKind, TRaw, TRendererOptions>;
  readonly sourceId?: SourceId;
  /** A raw query is bounded before planning; an accepted plan is executed without replanning. */
  readonly query?: Readonly<Query<T>> | QueryExecutionPlanV1;
  readonly capabilityPolicy?: CapabilityPolicy;
  readonly fallback?: QueryFallbackPolicy;
  readonly estimates?: QueryPlanningEstimates;
  readonly cache?: QueryPlanCacheOptions;
  readonly rendererOptions?: TRendererOptions;
  readonly style?: "auto" | Readonly<Record<string, unknown>>;
  /** Defaults to owned for a selector/element target and borrowed for an existing host object. */
  readonly ownership?: RendererOwnership;
  readonly signal?: AbortSignal;
}

/** Connection-owned map lifecycle with a typed raw escape hatch. */
export interface MountedMap<TKind extends RendererKind = RendererKind, TRaw = unknown> extends AsyncDisposable {
  readonly id: string;
  readonly renderer: TKind;
  readonly ready: Promise<void>;
  readonly diagnostics: readonly RendererDiagnostic[];
  raw(kind: TKind): TRaw | undefined;
  refresh(options?: MountedMapRefreshOptions): Promise<void>;
  dispose(): Promise<void>;
}
