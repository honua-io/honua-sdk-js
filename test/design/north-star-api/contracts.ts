/**
 * Compile-only contract for the north-star application-kernel API.
 *
 * This file is deliberately outside `src/`: it fixes the intended TypeScript
 * shape without publishing an implementation before discovery and planning
 * semantics exist. See `docs/decisions/north-star-sdk-application-kernel.md`.
 */

import type {
  Dataset,
  Protocol,
  Query,
  Result,
  Source,
  SourceDescriptor,
  SourceId,
} from "../../../src/contract/index.js";
import type { HonuaExtent } from "../../../src/core/types.js";
import type { ExplorationContext, ExplorationStateSnapshot } from "../../../src/exploration/index.js";

export type EnvironmentKind = "browser" | "node" | "worker";
export type QueryFormat = "features" | "columnar";
export type RendererKind = "maplibre" | "deckgl" | "cesium";

export interface ProvenanceRecord {
  readonly sourceUrl: string;
  readonly protocol: Protocol;
  readonly sourceVersion?: string;
  readonly retrievedAt: string;
  readonly license?: string;
  readonly attribution?: string;
}

export interface Observation {
  readonly state: "live" | "cached" | "replayed" | "pending-local";
  readonly observedAt: string;
  readonly validAt?: string;
  readonly expiresAt?: string;
  readonly cursor?: string;
  readonly provenance: readonly ProvenanceRecord[];
}

export interface KernelDiagnostic {
  readonly id: string;
  readonly timestamp: string;
  readonly severity: "info" | "warning" | "error";
  readonly stage: "connect" | "inspect" | "plan" | "query" | "render" | "agent" | "dispose";
  readonly code: string;
  readonly message: string;
  readonly operationId?: string;
  readonly sourceId?: SourceId;
  readonly remediation?: string;
  readonly cause?: unknown;
}

export interface DiagnosticChannel {
  snapshot(options?: { readonly operationId?: string; readonly since?: string }): readonly KernelDiagnostic[];
  subscribe(listener: (diagnostic: KernelDiagnostic) => void): () => void;
}

export interface SourceInspection extends SourceDescriptor {
  readonly title?: string;
  readonly geometryType?: string;
  readonly crs?: string;
  readonly discovery: "metadata" | "declared" | "inferred" | "unavailable";
  readonly observation: Observation;
}

export interface ConnectionInspection {
  readonly id: string;
  readonly endpoint: string;
  readonly defaultSourceId?: SourceId;
  readonly sources: readonly SourceInspection[];
  readonly observation: Observation;
  readonly diagnostics: readonly KernelDiagnostic[];
}

export interface ConnectLocator {
  readonly url: string | URL;
  readonly protocol?: Protocol | "auto";
  readonly sourceId?: SourceId;
  readonly collectionId?: string | number;
}

export interface ConnectOptions {
  readonly signal?: AbortSignal;
  readonly capabilityPolicy?: "strict" | "degraded";
  readonly metadata?: {
    readonly cache?: "prefer" | "bypass" | "only";
    readonly maxAgeMs?: number;
  };
}

export interface PlanStep {
  readonly id: string;
  readonly engine: "remote" | "worker" | "renderer" | "client";
  readonly operation: string;
  readonly pushdown: "full" | "partial" | "none";
  readonly reason: string;
  readonly estimatedRows?: number;
  readonly estimatedBytes?: number;
  readonly requests?: number;
  readonly cache: "hit" | "miss" | "bypass" | "unknown";
  readonly fidelity: "exact" | "equivalent" | "approximate" | "unsupported";
  readonly requiredAuthorization?: readonly string[];
}

export interface ExecutionPlan<T, TFormat extends QueryFormat = "features"> {
  readonly id: string;
  readonly fingerprint: string;
  readonly connectionId: string;
  readonly sourceId: SourceId;
  readonly query: Readonly<Query<T>>;
  readonly format: TFormat;
  readonly createdAt: string;
  readonly validUntil?: string;
  readonly steps: readonly PlanStep[];
  readonly observation: Observation;
  readonly diagnostics: readonly KernelDiagnostic[];
}

export interface ExecutionReceipt {
  readonly operationId: string;
  readonly planId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly observation: Observation;
  readonly diagnostics: readonly KernelDiagnostic[];
}

export type FeatureQueryResult<T> = Result<T> & {
  readonly format: "features";
  readonly execution: ExecutionReceipt;
};

export interface ColumnarBatch<T> {
  readonly length: number;
  readonly columns: Readonly<Partial<{ [K in keyof T]: ArrayLike<T[K]> }>>;
  readonly geometry?: ArrayLike<unknown>;
}

export interface ColumnarQueryResult<T> {
  readonly format: "columnar";
  readonly schema: readonly { readonly name: string; readonly type: string }[];
  readonly batches: AsyncIterable<ColumnarBatch<T>>;
  readonly execution: ExecutionReceipt;
}

export type PlannedQueryResult<T, TFormat extends QueryFormat> = TFormat extends "columnar"
  ? ColumnarQueryResult<T>
  : FeatureQueryResult<T>;

export interface ExplainOptions<TFormat extends QueryFormat = "features"> {
  readonly sourceId?: SourceId;
  readonly format?: TFormat;
  readonly context?: ExplorationStateSnapshot;
  readonly freshness?: {
    readonly maxAgeMs?: number;
    readonly requireLive?: boolean;
  };
  readonly signal?: AbortSignal;
}

export interface QueryOptions<TFormat extends QueryFormat = "features"> extends ExplainOptions<TFormat> {}

export interface RendererAdapter<TRaw = unknown> {
  readonly kind: RendererKind;
  readonly environments: readonly EnvironmentKind[];
  /** The renderer module is injected here; core never imports the heavy peer. */
  readonly peer: unknown;
  readonly rawType?: TRaw;
}

export interface MountLayer<T = Record<string, unknown>, TFormat extends QueryFormat = "features"> {
  readonly id?: string;
  readonly sourceId?: SourceId;
  readonly query?: Readonly<Query<T>> | ExecutionPlan<T, TFormat>;
  readonly style?: "auto" | Readonly<Record<string, unknown>>;
}

export interface MountOptions<T = Record<string, unknown>> {
  readonly renderer: RendererAdapter;
  readonly layers?: readonly MountLayer<T, QueryFormat>[];
  readonly style?: "auto" | Readonly<Record<string, unknown>>;
  readonly context?: ExplorationContext;
  readonly initialView?: { readonly extent?: HonuaExtent; readonly padding?: number };
  readonly signal?: AbortSignal;
  /** Defaults to `owned` for a selector/element and `borrowed` for a host object. */
  readonly ownership?: "owned" | "borrowed";
}

export interface MountedMap extends AsyncDisposable {
  readonly id: string;
  readonly renderer: RendererKind;
  readonly ready: Promise<void>;
  readonly diagnostics: DiagnosticChannel;
  raw<TRaw = unknown>(kind: RendererKind): TRaw | undefined;
  dispose(): Promise<void>;
}

export interface HonuaConnection<T = Record<string, unknown>> extends AsyncDisposable {
  readonly id: string;
  readonly dataset: Dataset;
  readonly diagnostics: DiagnosticChannel;
  readonly sourceDescriptors: readonly SourceDescriptor[];

  inspect(options?: { readonly refresh?: boolean; readonly signal?: AbortSignal }): Promise<ConnectionInspection>;
  source<TSource = T>(id?: SourceId): Source<TSource>;
  explain<TFormat extends QueryFormat = "features">(
    query: Readonly<Query<T>>,
    options?: ExplainOptions<TFormat>,
  ): Promise<ExecutionPlan<T, TFormat>>;
  query<TFormat extends QueryFormat = "features">(
    queryOrPlan: Readonly<Query<T>> | ExecutionPlan<T, TFormat>,
    options?: QueryOptions<TFormat>,
  ): Promise<PlannedQueryResult<T, TFormat>>;
  mount(target: string | Element | object, options: MountOptions<T>): Promise<MountedMap>;
  dispose(): Promise<void>;
}

export interface HonuaKernelOptions {
  readonly environment?: EnvironmentKind | "auto";
  readonly fetch?: typeof fetch;
  readonly auth?: unknown;
  readonly plugins?: readonly HonuaPlugin[];
  readonly onDiagnostic?: (diagnostic: KernelDiagnostic) => void;
}

export interface HonuaPlugin {
  readonly apiVersion: 1;
  readonly id: string;
  readonly kind: "protocol" | "loader" | "auth" | "cache" | "realtime" | "analysis";
  readonly environments: readonly EnvironmentKind[];
}

export interface HonuaKernel extends AsyncDisposable {
  readonly diagnostics: DiagnosticChannel;
  connect<T = Record<string, unknown>>(
    locator: string | URL | ConnectLocator,
    options?: ConnectOptions,
  ): Promise<HonuaConnection<T>>;
  dispose(): Promise<void>;
}

/** Proposed root factory; declaration only, not a production implementation. */
export declare function createHonua(options?: HonuaKernelOptions): HonuaKernel;

/** Proposed optional renderer factories; their peer modules stay caller-supplied. */
export declare function maplibreRenderer(peer: unknown): RendererAdapter;
export declare function deckGlRenderer(peer: unknown): RendererAdapter;
export declare function geoparquetPlugin(peer: unknown): HonuaPlugin;

export type AgentPermission = "data:read" | "map:write" | "data:write" | "publish";

export interface AgentPolicy {
  readonly allow: readonly AgentPermission[];
  readonly deny?: readonly AgentPermission[];
  readonly maxEstimatedBytes?: number;
}

export interface ApprovalRequest {
  readonly proposalId: string;
  readonly summary: string;
  readonly permissions: readonly AgentPermission[];
  readonly planFingerprint: string;
}

declare const APPROVAL_GRANT: unique symbol;

export interface ApprovalGrant {
  readonly [APPROVAL_GRANT]: true;
  readonly proposalId: string;
  readonly planFingerprint: string;
  readonly approvedAt: string;
}

export interface AgentDryRun {
  readonly allowed: boolean;
  readonly plan: ExecutionPlan<unknown, QueryFormat>;
  readonly diagnostics: readonly KernelDiagnostic[];
}

export interface AgentProposal {
  readonly id: string;
  readonly summary: string;
  readonly plan: ExecutionPlan<unknown, QueryFormat>;
  readonly approval: ApprovalRequest;
  dryRun(): Promise<AgentDryRun>;
  execute(options: { readonly approval: ApprovalGrant; readonly signal?: AbortSignal }): Promise<ExecutionReceipt>;
}

export interface AgentPlanner {
  propose(
    instruction: string,
    options: { readonly connections: readonly HonuaConnection[]; readonly policy?: AgentPolicy },
  ): Promise<AgentProposal>;
}

export interface AgentHost {
  readonly planner: AgentPlanner;
  requestApproval(request: ApprovalRequest): Promise<ApprovalGrant | undefined>;
}
