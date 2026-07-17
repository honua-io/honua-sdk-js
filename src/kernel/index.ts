import {
  type ConnectCacheStatus,
  type ConnectProtocolHint,
  type ConnectResolvedProtocol,
  type HonuaConnection as DiscoveredHonuaConnection,
  validateConnectEndpoint,
} from "../connect.js";
import {
  type DiscoveryCapabilityDecision,
  type DiscoveryCapabilityPolicy,
  type DiscoveryDiagnostic,
  type DiscoveryEvidenceKind,
  type DiscoveryProvenance,
  type SourceDiscoveryInspection,
  normalizeDiscoveryEndpoint,
} from "../contract/discovery.js";
import type {
  CapabilityPolicy,
  Dataset,
  Query,
  Result,
  Source,
  SourceDescriptor,
  SourceId,
} from "../contract/types.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../core/errors.js";
import { canonicalStringify, sha256, toJsonValue } from "../query-planner/canonical.js";
import { executeQueryPlan } from "../query-planner/executor.js";
import { explainQuery, parseQueryPlan, serializeQueryPlan } from "../query-planner/planner.js";
import {
  HonuaQueryPlanExecutionError,
  HonuaQueryPlanningError,
  type QueryExecutionPlan,
  type QueryExecutionPlanV1,
  type QueryFallbackPolicy,
  type QueryPlanCacheOptions,
  type QueryPlanDiscoveryContext,
  type QueryPlanningEstimates,
} from "../query-planner/types.js";
import {
  type KernelConnectOptions,
  type KernelLifecycle,
  type KernelLifecycleOptions,
  createKernelLifecycle,
  disposeKernelConnectionResult,
  snapshotKernelConnectOptions,
} from "./lifecycle.js";
import type {
  MountOptions,
  MountedMap,
  MountedMapRefreshOptions,
  RendererAdapter,
  RendererKind,
  RendererMountRequest,
  RendererOwnership,
  RendererSession,
  RendererTarget,
} from "./renderer.js";
import { snapshotOwnDataArray, snapshotOwnDataObject } from "./stable-data.js";

export type {
  MountOptions,
  MountedMap,
  MountedMapRefreshOptions,
  RendererAdapter,
  RendererDiagnostic,
  RendererEnvironment,
  RendererKind,
  RendererMountRequest,
  RendererOwnership,
  RendererSession,
  RendererTarget,
} from "./renderer.js";

/** A source URL plus the discovery and source-selection hints that belong to it. */
export interface ConnectLocator {
  readonly url: string | URL;
  readonly protocol?: ConnectProtocolHint;
  /** Select the connection's default source without silently choosing the first advertised source. */
  readonly sourceId?: SourceId;
  /** Restrict OGC API Features or STAC discovery to one collection. */
  readonly collectionId?: string;
  /** Restrict WFS discovery to one namespace-qualified feature type. */
  readonly typeName?: string;
}

/** Options for one kernel-owned connection. Cache and capability policy remain instance-owned. */
export type HonuaKernelConnectOptions = KernelConnectOptions & {
  /** Select the connection's default source without changing the discovered service-root identity. */
  readonly sourceId?: SourceId;
};

/** Options for reading or revalidating a connection's immutable metadata snapshot. */
export interface InspectOptions {
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

/** Planning controls for the connection-owned, feature-result query workflow. */
export interface ExplainOptions {
  /** Select a source explicitly when the connection advertises more than one. */
  readonly sourceId?: SourceId;
  /** Refresh discovery before planning. The resulting observation is bound into the plan. */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
  readonly capabilityPolicy?: CapabilityPolicy;
  readonly fallback?: QueryFallbackPolicy;
  readonly estimates?: QueryPlanningEstimates;
  /** Explicit query-result cache observation; discovery metadata cache state is never inferred here. */
  readonly cache?: QueryPlanCacheOptions;
}

/** Execution controls. Planning controls apply only when `query()` receives a query, not an accepted plan. */
export type QueryOptions = ExplainOptions;

/** Credential-free terminal evidence attached to a completed connection query. */
export interface ExecutionReceipt {
  readonly version: "1.0";
  readonly operationId: string;
  readonly plan: {
    readonly id: string;
    readonly fingerprint: `sha256:${string}`;
  };
  readonly timings: {
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly durationMs: number;
  };
  readonly provenance: {
    readonly sourceFingerprint: `sha256:${string}`;
    readonly schemaFingerprint?: `sha256:${string}`;
    readonly discoveryFingerprint: `sha256:${string}`;
    readonly authorizationScopeFingerprint: `sha256:${string}`;
  };
  readonly observation: {
    readonly connectionFingerprint: `sha256:${string}`;
    readonly protocol: SourceDescriptor["protocol"];
    readonly discovery: SourceDiscoveryInspection["discovery"];
    readonly cacheStatus: ConnectCacheStatus;
    readonly observedAt?: string;
  };
  readonly diagnostics: readonly {
    readonly source: "discovery" | "planner";
    readonly code: string;
    readonly severity: "info" | "warning";
    readonly message: string;
    readonly path?: string;
    readonly remediation?: string;
  }[];
  readonly terminal: {
    readonly state: "completed";
    readonly featureCount: number;
    readonly exceededTransferLimit: boolean;
  };
}

/** Existing feature result contract plus its accepted-plan execution evidence. */
export type FeatureQueryResult<T = Record<string, unknown>> = Result<T> & {
  readonly format: "features";
  readonly execution: ExecutionReceipt;
};

/**
 * Credential-safe connection snapshot.
 *
 * The lower-level discovery cache identity is intentionally absent: it is an
 * implementation detail that includes authorization partitioning information.
 */
export interface ConnectionInspection {
  readonly id: string;
  readonly endpoint: string;
  readonly protocol: ConnectResolvedProtocol;
  readonly defaultSourceId?: SourceId;
  readonly sources: readonly SourceDiscoveryInspection[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly cacheStatus: ConnectCacheStatus;
}

/** Instance-scoped policy and cache bounds for {@link createHonua}. */
export interface HonuaKernelOptions {
  readonly capabilityPolicy?: DiscoveryCapabilityPolicy;
  readonly discoveryCacheMaxEntries?: number;
}

/**
 * Kernel-managed connection returned by {@link HonuaKernel.connect}.
 *
 * `HonuaKernelConnection` is additive beside the existing lower-level
 * `HonuaConnection` returned by standalone `connect()`. Both expose the same
 * `Dataset -> Source` contract; this handle additionally owns refresh and
 * disposal semantics.
 */
export interface HonuaKernelConnection<T = Record<string, unknown>> extends AsyncDisposable {
  readonly id: string;
  readonly dataset: Dataset;
  readonly sourceDescriptors: readonly SourceDescriptor[];
  inspect(options?: InspectOptions): Promise<ConnectionInspection>;
  source<TSource = T>(id?: SourceId): Source<TSource>;
  explain(query: Readonly<Query<T>>, options?: ExplainOptions): Promise<QueryExecutionPlanV1>;
  query(query: Readonly<Query<T>>, options?: QueryOptions): Promise<FeatureQueryResult<T>>;
  query(plan: QueryExecutionPlanV1, options?: QueryOptions): Promise<FeatureQueryResult<T>>;
  mount<TKind extends RendererKind, TRaw, TRendererOptions = unknown>(
    target: RendererTarget,
    options: MountOptions<T, TKind, TRaw, TRendererOptions>,
  ): Promise<MountedMap<TKind, TRaw>>;
  dispose(): Promise<void>;
}

/** Instance-scoped owner for discovery cache, policy, cancellation, and connections. */
export interface HonuaKernel extends AsyncDisposable {
  connect<T = Record<string, unknown>>(
    locator: string | URL | ConnectLocator,
    options?: HonuaKernelConnectOptions,
  ): Promise<HonuaKernelConnection<T>>;
  dispose(): Promise<void>;
}

/** Create an isolated Honua application kernel. */
export function createHonua(options: HonuaKernelOptions = {}): HonuaKernel {
  const snapshot = snapshotOwnDataObject(options, "createHonua() options");
  return createHonuaKernel({
    ...(snapshot.capabilityPolicy !== undefined
      ? { capabilityPolicy: snapshot.capabilityPolicy as DiscoveryCapabilityPolicy }
      : {}),
    ...(snapshot.discoveryCacheMaxEntries !== undefined
      ? { discoveryCacheMaxEntries: snapshot.discoveryCacheMaxEntries as number }
      : {}),
  });
}

/** @internal Test/adapter seam that keeps the production options intentionally small. */
export function createHonuaKernel(options: KernelLifecycleOptions = {}): HonuaKernel {
  return new HonuaKernelFacade(createKernelLifecycle(options));
}

class HonuaKernelFacade implements HonuaKernel {
  public constructor(private readonly lifecycle: KernelLifecycle) {}

  public async connect<T = Record<string, unknown>>(
    locator: string | URL | ConnectLocator,
    options: HonuaKernelConnectOptions = {},
  ): Promise<HonuaKernelConnection<T>> {
    this.lifecycle.assertActive("connect");
    const request = normalizeConnectRequest(locator, options);
    let discovered: DiscoveredHonuaConnection | undefined;
    try {
      discovered = await this.lifecycle.connect(request.endpoint, request.initialOptions);
      throwIfAborted(this.lifecycle.signal);
      throwIfAborted(request.initialOptions.signal);
    } catch (error) {
      if (discovered) await cleanupRejectedConnection(discovered, request.secrets);
      throw credentialSafeError(error, request.secrets);
    }
    if (!discovered) throw new Error("Kernel discovery completed without a connection.");

    let managed: ManagedHonuaConnection<T>;
    try {
      managed = new ManagedHonuaConnection<T>({
        lifecycle: this.lifecycle,
        endpoint: request.endpoint,
        options: request.refreshOptions,
        selectedSourceId: request.selectedSourceId,
        discovered,
        secrets: request.secrets,
      });
    } catch (error) {
      await cleanupRejectedConnection(discovered, request.secrets);
      throw credentialSafeError(error, request.secrets);
    }
    try {
      return this.lifecycle.own(managed);
    } catch (error) {
      await managed.dispose();
      throw credentialSafeError(error, request.secrets);
    }
  }

  public dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

interface ManagedConnectionInit {
  readonly lifecycle: KernelLifecycle;
  readonly endpoint: string;
  readonly options: KernelConnectOptions;
  readonly selectedSourceId?: SourceId;
  readonly discovered: DiscoveredHonuaConnection;
  readonly secrets: readonly string[];
}

interface ManagedConnectionState {
  readonly discovered: DiscoveredHonuaConnection;
  readonly inspection: ConnectionInspection;
  readonly sourceDescriptors: readonly SourceDescriptor[];
  readonly sourceIds: readonly SourceId[];
}

interface ManagedQueryContext<T> {
  readonly state: ManagedConnectionState;
  readonly sourceInspection: SourceDiscoveryInspection;
  readonly descriptor: SourceDescriptor;
  readonly source: Source<T>;
  readonly schemaVersion?: string;
  readonly sourceVersion: string;
  readonly authorizationScope: readonly string[];
  readonly discovery: QueryPlanDiscoveryContext;
}

interface ConnectionOwnedMount {
  dispose(): Promise<void>;
}

class ManagedHonuaConnection<T> implements HonuaKernelConnection<T> {
  readonly #abortController = new AbortController();
  readonly #lifecycle: KernelLifecycle;
  readonly #endpoint: string;
  readonly #options: KernelConnectOptions;
  readonly #selectedSourceId: SourceId | undefined;
  readonly #secrets: readonly string[];
  readonly #ownedDiscoveries = new Set<DiscoveredHonuaConnection>();
  readonly #ownedMounts = new Set<ConnectionOwnedMount>();
  readonly #cleanupReentryCompletion = Promise.resolve();
  #current: ManagedConnectionState;
  #invokingAdapterCleanup = false;
  #refreshGeneration = 0;
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;
  #querySequence = 0;
  #mountSequence = 0;
  public readonly id: string;

  public constructor(init: ManagedConnectionInit) {
    this.#lifecycle = init.lifecycle;
    this.#endpoint = init.endpoint;
    this.#options = init.options;
    this.#selectedSourceId = init.selectedSourceId;
    this.#secrets = init.secrets;
    this.#current = createManagedConnectionState(init.discovered, init.endpoint, init.secrets);
    this.#ownedDiscoveries.add(init.discovered);
    this.id = this.#current.inspection.id;
    assertSelectedSource(this.#selectedSourceId, this.#current.sourceIds);
  }

  public get dataset(): Dataset {
    this.#assertActive("read the dataset");
    return this.#current.discovered.dataset;
  }

  public get sourceDescriptors(): readonly SourceDescriptor[] {
    this.#assertActive("read source descriptors");
    return this.#current.sourceDescriptors;
  }

  public async inspect(options: InspectOptions = {}): Promise<ConnectionInspection> {
    this.#assertActive("inspect metadata");
    const inspectOptions = snapshotOwnDataObject(options, "inspect() options");
    // A Proxy reflection trap can synchronously dispose the connection.
    this.#assertActive("inspect metadata");
    const signal = inspectOptions.signal as AbortSignal | undefined;
    throwIfAborted(signal);
    if (inspectOptions.refresh !== true) return this.#current.inspection;

    const generation = ++this.#refreshGeneration;
    let discovered: DiscoveredHonuaConnection | undefined;
    try {
      discovered = await this.#lifecycle.connect(this.#endpoint, {
        ...this.#options,
        refresh: true,
        signal: combineAbortSignals(this.#abortController.signal, signal),
      });
      throwIfAborted(this.#abortController.signal);
      throwIfAborted(signal);
    } catch (error) {
      if (discovered && !this.#ownedDiscoveries.has(discovered)) {
        await cleanupRejectedConnection(discovered, this.#secrets);
      }
      throw credentialSafeError(error, this.#secrets);
    }
    if (!discovered) throw new Error("Kernel refresh completed without a connection.");

    let refreshed: ManagedConnectionState;
    try {
      refreshed = createManagedConnectionState(discovered, this.#endpoint, this.#secrets);
      if (refreshed.inspection.id !== this.id) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Refreshed discovery changed the connection identity; the previous immutable snapshot remains active.",
        );
      }
      if (refreshed.inspection.protocol !== this.#current.inspection.protocol) {
        throw new HonuaDiscoveryError(
          "protocol-mismatch",
          "Refreshed discovery changed protocol; the previous immutable snapshot remains active.",
        );
      }
      assertSelectedSource(this.#selectedSourceId, refreshed.sourceIds);
      this.#assertActive("publish refreshed metadata");
      throwIfAborted(this.#abortController.signal);
    } catch (error) {
      if (!this.#ownedDiscoveries.has(discovered)) {
        await cleanupRejectedConnection(discovered, this.#secrets);
      }
      throw credentialSafeError(error, this.#secrets);
    }

    // Latest-started refresh wins. A slower earlier request can complete for
    // its caller, but it never replaces a newer snapshot or revives stale data.
    if (generation === this.#refreshGeneration) {
      this.#ownedDiscoveries.add(refreshed.discovered);
      this.#current = refreshed;
    } else if (!this.#ownedDiscoveries.has(refreshed.discovered)) {
      await cleanupRejectedConnection(refreshed.discovered, this.#secrets);
    }
    return this.#current.inspection;
  }

  public source<TSource = T>(id?: SourceId): Source<TSource> {
    this.#assertActive("resolve a source");
    const sourceId = resolveSourceId(id, this.#selectedSourceId, this.#current);
    try {
      return this.#current.discovered.source<TSource>(sourceId);
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }
  }

  public async explain(query: Readonly<Query<T>>, options: ExplainOptions = {}): Promise<QueryExecutionPlanV1> {
    this.#assertActive("explain a query");
    const querySnapshot = snapshotQuery(query);
    const optionSnapshot = snapshotExplainOptions(options);
    const signal = combineAbortSignals(this.#abortController.signal, optionSnapshot.signal, querySnapshot.signal);
    throwIfAborted(signal);
    if (optionSnapshot.refresh === true) await this.inspect({ refresh: true, signal });
    this.#assertActive("explain a query");
    throwIfAborted(signal);
    try {
      const context = this.#queryContext(optionSnapshot.sourceId, this.#current);
      return explainQuery({
        descriptor: context.descriptor,
        query: querySnapshot,
        capabilityPolicy: optionSnapshot.capabilityPolicy,
        fallback: optionSnapshot.fallback,
        estimates: optionSnapshot.estimates,
        cache: optionSnapshot.cache ?? defaultPlanCache(),
        schemaVersion: context.schemaVersion,
        sourceVersion: context.sourceVersion,
        authorizationScope: context.authorizationScope,
        discovery: context.discovery,
      });
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }
  }

  public async query(
    queryOrPlan: Readonly<Query<T>> | QueryExecutionPlanV1,
    options: QueryOptions = {},
  ): Promise<FeatureQueryResult<T>> {
    this.#assertActive("execute a query");
    const optionSnapshot = snapshotExplainOptions(options);
    const planInput = looksLikeQueryPlan(queryOrPlan);
    const querySnapshot = planInput ? undefined : snapshotQuery(queryOrPlan as Readonly<Query<T>>);
    const signal = combineAbortSignals(this.#abortController.signal, optionSnapshot.signal, querySnapshot?.signal);
    throwIfAborted(signal);
    if (optionSnapshot.refresh === true) await this.inspect({ refresh: true, signal });
    this.#assertActive("execute a query");
    throwIfAborted(signal);

    const state = this.#current;
    let plan: QueryExecutionPlanV1;
    let context: ManagedQueryContext<T>;
    try {
      if (planInput) {
        assertAcceptedPlanExecutionOptions(optionSnapshot);
        plan = acceptedFeaturePlan(queryOrPlan);
        const sourceId = optionSnapshot.sourceId ?? plan.ir.source.id;
        context = this.#queryContext(sourceId, state, true);
        assertConnectionPlanBinding(plan, context.sourceVersion);
      } else {
        context = this.#queryContext(optionSnapshot.sourceId, state);
        plan = explainQuery({
          descriptor: context.descriptor,
          query: querySnapshot,
          capabilityPolicy: optionSnapshot.capabilityPolicy,
          fallback: optionSnapshot.fallback,
          estimates: optionSnapshot.estimates,
          cache: optionSnapshot.cache ?? defaultPlanCache(),
          schemaVersion: context.schemaVersion,
          sourceVersion: context.sourceVersion,
          authorizationScope: context.authorizationScope,
          discovery: context.discovery,
        });
      }
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }

    const sequence = ++this.#querySequence;
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const monotonicStart = monotonicNow();
    try {
      const execution = await executeQueryPlan(plan, context.source, {
        signal,
        schemaVersion: context.schemaVersion,
        sourceVersion: context.sourceVersion,
        authorizationScope: context.authorizationScope,
        discovery: context.discovery,
        executionMode: "snapshot",
      });
      throwIfAborted(signal);
      this.#assertActive("complete a query");
      const finishedAtMs = Date.now();
      const receipt = createExecutionReceipt({
        sequence,
        plan,
        state,
        sourceInspection: context.sourceInspection,
        result: execution.result,
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
        durationMs: Math.max(0, monotonicNow() - monotonicStart),
      });
      return {
        ...execution.result,
        format: "features",
        execution: receipt,
      };
    } catch (error) {
      if (signal.aborted) throw new HonuaAbortError();
      throw credentialSafeError(error, this.#secrets);
    }
  }

  public async mount<TKind extends RendererKind, TRaw, TRendererOptions = unknown>(
    target: RendererTarget,
    options: MountOptions<T, TKind, TRaw, TRendererOptions>,
  ): Promise<MountedMap<TKind, TRaw>> {
    this.#assertActive("mount a renderer");
    const mountOptions = snapshotMountOptions(options);
    const adapter = validateRendererAdapter(mountOptions.renderer);
    validateRendererTarget(target);
    // Reflection on caller-owned adapter/target values may reenter disposal.
    this.#assertActive("mount a renderer");
    const mountAbortController = new AbortController();
    const signal = combineAbortSignals(this.#abortController.signal, mountOptions.signal, mountAbortController.signal);
    throwIfAborted(signal);
    const state = this.#current;
    const suppliedPlan =
      mountOptions.query !== undefined && looksLikeQueryPlan(mountOptions.query)
        ? acceptedFeaturePlan(mountOptions.query)
        : undefined;
    const query =
      suppliedPlan === undefined ? boundedMountQuery(mountOptions.query as Readonly<Query<T>> | undefined) : undefined;
    const context = this.#queryContext(
      mountOptions.sourceId ?? suppliedPlan?.ir.source.id,
      state,
      suppliedPlan !== undefined,
    );
    if (suppliedPlan !== undefined) assertConnectionPlanBinding(suppliedPlan, context.sourceVersion);
    let planned: Promise<QueryExecutionPlanV1> | undefined;
    const planQuery = (): Promise<QueryExecutionPlanV1> => {
      try {
        this.#assertActive("plan a renderer query");
        throwIfAborted(signal);
      } catch (error) {
        return Promise.reject(credentialSafeError(error, this.#secrets));
      }
      if (planned !== undefined) return planned;
      planned = Promise.resolve()
        .then(() => {
          this.#assertActive("plan a renderer query");
          throwIfAborted(signal);
          return (
            suppliedPlan ??
            explainQuery({
              descriptor: context.descriptor,
              query,
              capabilityPolicy: mountOptions.capabilityPolicy,
              fallback: mountOptions.fallback,
              estimates: mountOptions.estimates,
              cache: mountOptions.cache ?? defaultPlanCache(),
              schemaVersion: context.schemaVersion,
              sourceVersion: context.sourceVersion,
              authorizationScope: context.authorizationScope,
              discovery: context.discovery,
            })
          );
        })
        .catch((error: unknown) => {
          throw credentialSafeError(error, this.#secrets);
        });
      return planned;
    };
    let ownership: RendererOwnership;
    try {
      ownership = mountOptions.ownership ?? adapter.defaultOwnership(target);
      if (ownership !== "owned" && ownership !== "borrowed") throw new TypeError("Renderer ownership is invalid.");
      // A custom adapter may synchronously reenter connection disposal.
      this.#assertActive("mount a renderer");
      throwIfAborted(signal);
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }
    const request: RendererMountRequest<T, TRendererOptions> = Object.freeze({
      source: context.source,
      ...(mountOptions.rendererOptions === undefined ? {} : { rendererOptions: mountOptions.rendererOptions }),
      ...(mountOptions.style === undefined ? {} : { style: mountOptions.style }),
      ownership,
      signal,
      queryIntent: mountOptions.query === undefined ? "default" : "explicit",
      ...(suppliedPlan === undefined ? {} : { queryPlan: suppliedPlan }),
      execution: Object.freeze({
        signal,
        sourceVersion: context.sourceVersion,
        ...(context.schemaVersion === undefined ? {} : { schemaVersion: context.schemaVersion }),
        authorizationScope: context.authorizationScope,
        discovery: context.discovery,
      }),
      planQuery,
    });

    let candidateSession: unknown;
    let session: RendererSession<TRaw> | undefined;
    try {
      candidateSession = await adapter.mount(target, request);
      session = validateRendererSession(candidateSession as RendererSession<TRaw>);
      throwIfAborted(signal);
      this.#assertActive("publish a mounted renderer");
      const id = `mount_${sha256(`honua.kernel.mount.v1\0${this.id}\0${++this.#mountSequence}\0${adapter.kind}`).slice(7, 23)}`;
      const mounted = new ManagedMountedMap<TKind, TRaw>({
        id,
        renderer: adapter.kind,
        session,
        signal,
        abortController: mountAbortController,
        secrets: this.#secrets,
        release: (resource) => this.#ownedMounts.delete(resource),
        invokeCleanup: (cleanup) => this.#invokeAdapterCleanup(cleanup),
      });
      this.#ownedMounts.add(mounted);
      return mounted;
    } catch (error) {
      mountAbortController.abort(new HonuaAbortError("Renderer mount was not adopted"));
      const cleanupError = await cleanupRejectedRendererSession(session ?? candidateSession);
      if (cleanupError !== undefined) {
        throw credentialSafeError(
          new AggregateError([error, cleanupError], "Renderer mount failed and rollback did not complete"),
          this.#secrets,
        );
      }
      throw credentialSafeError(error, this.#secrets);
    }
  }

  #queryContext(
    requested: SourceId | undefined,
    state: ManagedConnectionState,
    acceptedPlan = false,
  ): ManagedQueryContext<T> {
    let sourceId: SourceId;
    try {
      sourceId = resolveSourceId(requested, this.#selectedSourceId, state);
    } catch (error) {
      if (acceptedPlan && requested !== undefined) {
        throw new HonuaQueryPlanExecutionError(
          "foreign-plan",
          "Query plan belongs to a foreign connection or source; explain a replacement plan",
          { context: { reason: "source-identity-changed" } },
          "source-identity-changed",
        );
      }
      throw error;
    }
    const sourceInspection = state.inspection.sources.find((entry) => entry.descriptor.id === sourceId);
    if (!sourceInspection) throw sourceSelectionError(state.sourceIds);
    const descriptor = sourceInspection.descriptor;
    const authorizationScope = connectionAuthorizationScope(this.#options.authorizationScopeFingerprint);
    const discovery = connectionDiscoveryContext(sourceInspection, this.#lifecycle.policy.capabilities);
    const schemaVersion = legacySchemaVersion(descriptor);
    const sourceVersion = connectionSourceVersion(state.inspection, descriptor);
    let delegate: Source<T>;
    try {
      delegate = state.discovered.source<T>(sourceId);
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }
    return {
      state,
      sourceInspection,
      descriptor,
      source: plannerSource(delegate, descriptor),
      authorizationScope,
      discovery,
      ...(schemaVersion ? { schemaVersion } : {}),
      sourceVersion,
    };
  }

  public dispose(): Promise<void> {
    if (this.#invokingAdapterCleanup) return this.#cleanupReentryCompletion;
    if (this.#disposePromise) return this.#disposePromise;
    this.#state = "disposing";

    let beginCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      beginCleanup = resolve;
    });
    let synchronousFailure: unknown;
    let hasSynchronousFailure = false;
    const completion = cleanupGate
      .then(async () => {
        const failures: unknown[] = [];
        const mounts = [...this.#ownedMounts].reverse();
        for (const mount of mounts) {
          try {
            await mount.dispose();
          } catch (error) {
            failures.push(error);
          }
        }
        const discoveries = [...this.#ownedDiscoveries];
        this.#ownedDiscoveries.clear();
        for (const discovery of discoveries) {
          try {
            const result = this.#invokeAdapterCleanup(() => disposeKernelConnectionResult(discovery));
            await result;
          } catch (error) {
            failures.push(error);
          }
        }
        if (hasSynchronousFailure) failures.push(synchronousFailure);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Honua connection adapter resource disposal failed");
        }
      })
      .then(
        () => {
          this.#state = "disposed";
        },
        (error: unknown) => {
          this.#state = "disposed";
          throw credentialSafeError(error, this.#secrets);
        },
      );
    this.#disposePromise = completion;

    try {
      this.#refreshGeneration += 1;
      this.#abortController.abort(new HonuaAbortError("Honua connection was disposed"));
      this.#lifecycle.release(this);
    } catch (error) {
      synchronousFailure = error;
      hasSynchronousFailure = true;
    } finally {
      beginCleanup();
    }
    return completion;
  }

  #invokeAdapterCleanup<TResult>(cleanup: () => TResult): TResult {
    this.#invokingAdapterCleanup = true;
    try {
      return cleanup();
    } finally {
      this.#invokingAdapterCleanup = false;
    }
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertActive(operation: string): void {
    if (this.#state !== "active") {
      throw new Error(`Honua connection cannot ${operation} after disposal has started.`);
    }
  }
}

interface ManagedMountedMapInit<TKind extends RendererKind, TRaw> {
  readonly id: string;
  readonly renderer: TKind;
  readonly session: RendererSession<TRaw>;
  readonly signal: AbortSignal;
  readonly abortController: AbortController;
  readonly secrets: readonly string[];
  readonly release: (resource: ConnectionOwnedMount) => void;
  readonly invokeCleanup: <TResult>(cleanup: () => TResult) => TResult;
}

class ManagedMountedMap<TKind extends RendererKind, TRaw> implements MountedMap<TKind, TRaw>, ConnectionOwnedMount {
  readonly #session: RendererSession<TRaw>;
  readonly #signal: AbortSignal;
  readonly #abortController: AbortController;
  readonly #secrets: readonly string[];
  readonly #release: (resource: ConnectionOwnedMount) => void;
  readonly #invokeCleanup: ManagedMountedMapInit<TKind, TRaw>["invokeCleanup"];
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;
  public readonly id: string;
  public readonly renderer: TKind;
  public readonly ready: Promise<void>;

  public constructor(init: ManagedMountedMapInit<TKind, TRaw>) {
    this.id = init.id;
    this.renderer = init.renderer;
    this.#session = init.session;
    this.#signal = init.signal;
    this.#abortController = init.abortController;
    this.#secrets = init.secrets;
    this.#release = init.release;
    this.#invokeCleanup = init.invokeCleanup;
    const ready = init.session.ready.catch(async (error: unknown) => {
      const failure = credentialSafeError(error, this.#secrets);
      try {
        await this.dispose();
      } catch (cleanupError) {
        throw credentialSafeError(
          new AggregateError([failure, cleanupError], "Renderer readiness failed and rollback did not complete"),
          this.#secrets,
        );
      }
      throw failure;
    });
    // The caller still observes the original rejection. This internal branch
    // prevents disposal-before-first-frame from becoming an unhandled rejection
    // when an application intentionally never awaits the readiness handle.
    void ready.catch(() => undefined);
    this.ready = ready;
  }

  public get diagnostics(): RendererSession<TRaw>["diagnostics"] {
    return this.#session.diagnostics;
  }

  public raw(kind: TKind): TRaw | undefined {
    return this.#state === "active" && kind === this.renderer ? this.#session.raw : undefined;
  }

  public async refresh(options: MountedMapRefreshOptions = {}): Promise<void> {
    this.#assertActive("refresh");
    const snapshot = snapshotOwnDataObject(options, "mounted-map refresh options");
    this.#assertActive("refresh");
    const signal = combineAbortSignals(this.#signal, snapshot.signal as AbortSignal | undefined);
    throwIfAborted(signal);
    try {
      await this.#session.refresh({ signal });
      throwIfAborted(signal);
      this.#assertActive("complete refresh");
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#state = "disposing";
    let beginCleanup: () => void = () => undefined;
    const cleanupGate = new Promise<void>((resolve) => {
      beginCleanup = resolve;
    });
    let cleanupResult: void | Promise<void> = undefined;
    let synchronousFailure: unknown;
    let hasSynchronousFailure = false;
    const completion = cleanupGate
      .then(async () => {
        if (hasSynchronousFailure) throw synchronousFailure;
        await cleanupResult;
      })
      .then(
        () => {
          this.#state = "disposed";
          this.#release(this);
        },
        (error: unknown) => {
          this.#state = "disposed";
          throw credentialSafeError(error, this.#secrets);
        },
      );
    this.#disposePromise = completion;
    this.#abortController.abort(new HonuaAbortError("Mounted renderer was disposed"));
    try {
      cleanupResult = this.#invokeCleanup(() => this.#session.dispose());
    } catch (error) {
      synchronousFailure = error;
      hasSynchronousFailure = true;
    } finally {
      beginCleanup();
    }
    return completion;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertActive(operation: string): void {
    if (this.#state !== "active") throw new Error(`Mounted renderer cannot ${operation} after disposal has started.`);
  }
}

interface NormalizedConnectRequest {
  readonly endpoint: string;
  readonly selectedSourceId?: SourceId;
  readonly initialOptions: KernelConnectOptions;
  readonly refreshOptions: KernelConnectOptions;
  readonly secrets: readonly string[];
}

function normalizeConnectRequest(
  locator: string | URL | ConnectLocator,
  options: HonuaKernelConnectOptions,
): NormalizedConnectRequest {
  const optionSnapshot = snapshotOwnDataObject(options, "kernel.connect() options");
  const locatorSnapshot = snapshotConnectLocator(locator);
  const endpoint = validateConnectEndpoint(locatorSnapshot.endpoint);
  const selectedSourceId = mergeSourceSelection(
    locatorSnapshot.fields?.sourceId as SourceId | undefined,
    optionSnapshot.sourceId as SourceId | undefined,
  );
  const protocol = mergeLocatorOption(
    "protocol",
    locatorSnapshot.fields?.protocol as ConnectProtocolHint | undefined,
    optionSnapshot.protocol as ConnectProtocolHint | undefined,
  );
  const collectionId = mergeLocatorOption(
    "collectionId",
    locatorSnapshot.fields?.collectionId as string | undefined,
    optionSnapshot.collectionId as string | undefined,
  );
  const typeName = mergeLocatorOption(
    "typeName",
    locatorSnapshot.fields?.typeName as string | undefined,
    optionSnapshot.typeName as string | undefined,
  );
  const initialOptions = snapshotKernelConnectOptions(
    Object.freeze({
      ...optionSnapshot,
      ...(protocol !== undefined ? { protocol } : {}),
      ...(collectionId !== undefined ? { collectionId } : {}),
      ...(typeName !== undefined ? { typeName } : {}),
    }) as KernelConnectOptions,
  );
  const { refresh: _refresh, signal: _signal, ...persistentOptions } = initialOptions;
  void _refresh;
  void _signal;
  const refreshOptions = Object.freeze(persistentOptions);
  return Object.freeze({
    endpoint,
    ...(selectedSourceId ? { selectedSourceId } : {}),
    initialOptions,
    refreshOptions,
    secrets: credentialValues(initialOptions),
  });
}

function snapshotConnectLocator(value: string | URL | ConnectLocator): {
  readonly endpoint: string;
  readonly fields?: Readonly<Record<string, unknown>>;
} {
  if (typeof value === "string") return Object.freeze({ endpoint: value });
  const url = serializeIntrinsicUrl(value);
  if (url !== undefined) return Object.freeze({ endpoint: url });
  try {
    const fields = snapshotOwnDataObject(value, "Structured connect locator");
    const endpoint = fields.url;
    if (typeof endpoint === "string") return Object.freeze({ endpoint, fields });
    const serialized = serializeIntrinsicUrl(endpoint);
    if (serialized !== undefined) return Object.freeze({ endpoint: serialized, fields });
  } catch {
    // Public locator failures are deliberately stable and never forward Proxy
    // trap messages that could include credentials.
  }
  throw new HonuaDiscoveryError("invalid-endpoint", "Structured connect locators must contain a stable URL field.");
}

function serializeIntrinsicUrl(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return URL.prototype.toString.call(value);
  } catch {
    return undefined;
  }
}

function mergeLocatorOption<T>(name: string, locatorValue: T | undefined, optionValue: T | undefined): T | undefined {
  if (locatorValue !== undefined && optionValue !== undefined && locatorValue !== optionValue) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `Conflicting ${name} values were supplied in the locator and connect options.`,
      { name },
    );
  }
  return locatorValue ?? optionValue;
}

function mergeSourceSelection(
  locatorValue: SourceId | undefined,
  optionValue: SourceId | undefined,
): SourceId | undefined {
  const selected = mergeLocatorOption("sourceId", locatorValue, optionValue);
  if (selected === undefined) return undefined;
  if (typeof selected !== "string" || selected.length === 0 || selected.trim() !== selected) {
    throw new HonuaDiscoveryError("ambiguous-source", "sourceId must be a non-empty, trimmed advertised identifier.");
  }
  return selected;
}

function credentialValues(options: KernelConnectOptions): readonly string[] {
  const values = [options.clientOptions?.apiKey, options.clientOptions?.bearerToken].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return Object.freeze([...new Set(values)]);
}

async function cleanupRejectedConnection(
  connection: DiscoveredHonuaConnection,
  secrets: readonly string[],
): Promise<void> {
  try {
    await disposeKernelConnectionResult(connection);
  } catch (error) {
    throw credentialSafeError(error, secrets);
  }
}

function createManagedConnectionState(
  discovered: DiscoveredHonuaConnection,
  endpoint: string,
  secrets: readonly string[],
): ManagedConnectionState {
  const raw = discovered.inspection;
  if (!raw || typeof raw !== "object") {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery returned no connection inspection.");
  }
  const projected = {
    id: raw.id,
    endpoint,
    protocol: raw.protocol,
    ...(raw.defaultSourceId ? { defaultSourceId: raw.defaultSourceId } : {}),
    sources: raw.sources,
    diagnostics: raw.diagnostics,
    cacheStatus: raw.cacheStatus,
  } satisfies ConnectionInspection;
  const inspection = cloneInspection(projected, secrets);
  const sourceIds = Object.freeze(
    inspection.sources.map((entry) => {
      const id = entry.descriptor.id;
      if (typeof id !== "string" || id.length === 0 || id.trim() !== id) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Discovery returned a source without a stable non-empty identifier.",
        );
      }
      return id;
    }),
  );
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery returned duplicate source identifiers.");
  }
  if (inspection.defaultSourceId !== undefined && !sourceIds.includes(inspection.defaultSourceId)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery returned a default source that was not present in the immutable inspection.",
    );
  }
  return Object.freeze({
    discovered,
    inspection,
    sourceIds,
    sourceDescriptors: Object.freeze(inspection.sources.map((entry) => entry.descriptor)),
  });
}

function assertSelectedSource(selected: SourceId | undefined, sourceIds: readonly SourceId[]): void {
  if (selected === undefined || sourceIds.includes(selected)) return;
  throw sourceSelectionError(sourceIds);
}

function resolveSourceId(
  requested: SourceId | undefined,
  selected: SourceId | undefined,
  state: ManagedConnectionState,
): SourceId {
  if (requested !== undefined && (typeof requested !== "string" || !requested || requested.trim() !== requested)) {
    throw sourceSelectionError(state.sourceIds);
  }
  const resolved = requested ?? selected ?? state.inspection.defaultSourceId;
  if (resolved === undefined || !state.sourceIds.includes(resolved)) throw sourceSelectionError(state.sourceIds);
  return resolved;
}

function sourceSelectionError(sourceIds: readonly SourceId[]): HonuaDiscoveryError {
  const available = Object.freeze([...sourceIds]);
  const guidance = available.length > 0 ? ` Pass one of: ${available.join(", ")}.` : " No sources were advertised.";
  return new HonuaDiscoveryError(
    "ambiguous-source",
    `The connection does not have an unambiguous selected source.${guidance}`,
    { sourceIds: available },
  );
}

function snapshotExplainOptions(value: ExplainOptions): ExplainOptions {
  const snapshot = snapshotOwnDataObject(value, "connection query options");
  return Object.freeze({
    ...(snapshot.sourceId !== undefined ? { sourceId: snapshot.sourceId as SourceId } : {}),
    ...(snapshot.refresh !== undefined ? { refresh: snapshot.refresh as boolean } : {}),
    ...(snapshot.signal !== undefined ? { signal: snapshot.signal as AbortSignal } : {}),
    ...(snapshot.capabilityPolicy !== undefined
      ? { capabilityPolicy: snapshot.capabilityPolicy as CapabilityPolicy }
      : {}),
    ...(snapshot.fallback !== undefined ? { fallback: snapshot.fallback as QueryFallbackPolicy } : {}),
    ...(snapshot.estimates !== undefined ? { estimates: snapshot.estimates as QueryPlanningEstimates } : {}),
    ...(snapshot.cache !== undefined ? { cache: snapshot.cache as QueryPlanCacheOptions } : {}),
  });
}

function snapshotMountOptions<T, TKind extends RendererKind, TRaw, TRendererOptions>(
  value: MountOptions<T, TKind, TRaw, TRendererOptions>,
): MountOptions<T, TKind, TRaw, TRendererOptions> {
  const snapshot = snapshotOwnDataObject(value, "connection mount options");
  const query =
    snapshot.query === undefined || looksLikeQueryPlan(snapshot.query)
      ? snapshot.query
      : snapshotQuery(snapshot.query as Readonly<Query<T>>);
  const rendererOptions =
    snapshot.rendererOptions === undefined
      ? undefined
      : (snapshotOwnDataObject(snapshot.rendererOptions, "renderer options") as TRendererOptions);
  const style =
    snapshot.style === undefined || snapshot.style === "auto"
      ? snapshot.style
      : snapshotOwnDataObject(snapshot.style, "renderer style");
  return Object.freeze({
    renderer: snapshot.renderer as RendererAdapter<TKind, TRaw, TRendererOptions>,
    ...(snapshot.sourceId === undefined ? {} : { sourceId: snapshot.sourceId as SourceId }),
    ...(query === undefined ? {} : { query: query as Readonly<Query<T>> | QueryExecutionPlanV1 }),
    ...(snapshot.capabilityPolicy === undefined
      ? {}
      : { capabilityPolicy: snapshot.capabilityPolicy as CapabilityPolicy }),
    ...(snapshot.fallback === undefined ? {} : { fallback: snapshot.fallback as QueryFallbackPolicy }),
    ...(snapshot.estimates === undefined ? {} : { estimates: snapshot.estimates as QueryPlanningEstimates }),
    ...(snapshot.cache === undefined ? {} : { cache: snapshot.cache as QueryPlanCacheOptions }),
    ...(rendererOptions === undefined ? {} : { rendererOptions }),
    ...(style === undefined ? {} : { style: style as "auto" | Readonly<Record<string, unknown>> }),
    ...(snapshot.ownership === undefined ? {} : { ownership: snapshot.ownership as RendererOwnership }),
    ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal as AbortSignal }),
  });
}

function validateRendererAdapter<TKind extends RendererKind, TRaw, TRendererOptions>(
  value: RendererAdapter<TKind, TRaw, TRendererOptions>,
): RendererAdapter<TKind, TRaw, TRendererOptions> {
  const snapshot = snapshotOwnDataObject(value, "renderer adapter");
  const kind = snapshot.kind;
  if (
    typeof kind !== "string" ||
    kind.length === 0 ||
    kind.length > 128 ||
    (kind !== "maplibre" && !/^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/.test(kind))
  ) {
    throw new TypeError("Renderer adapter kind must be maplibre or a stable namespaced identifier.");
  }
  const environments = snapshotOwnDataArray(snapshot.environments, "renderer adapter environments");
  if (
    environments.length === 0 ||
    environments.some((environment) => environment !== "browser" && environment !== "node" && environment !== "worker")
  ) {
    throw new TypeError("Renderer adapter environments are invalid.");
  }
  if (typeof snapshot.defaultOwnership !== "function" || typeof snapshot.mount !== "function") {
    throw new TypeError("Renderer adapter must expose defaultOwnership() and mount().");
  }
  if (!Object.hasOwn(snapshot, "peer")) throw new TypeError("Renderer adapter must retain its injected peer.");
  const defaultOwnership = snapshot.defaultOwnership as RendererAdapter<
    TKind,
    TRaw,
    TRendererOptions
  >["defaultOwnership"];
  const mount = snapshot.mount as RendererAdapter<TKind, TRaw, TRendererOptions>["mount"];
  const stable: RendererAdapter<TKind, TRaw, TRendererOptions> = {
    kind: kind as TKind,
    environments: Object.freeze([...environments]) as RendererAdapter<TKind, TRaw, TRendererOptions>["environments"],
    peer: snapshot.peer,
    defaultOwnership: (target) => Reflect.apply(defaultOwnership, stable, [target]) as RendererOwnership,
    mount: (target, request) => Reflect.apply(mount, stable, [target, request]) as Promise<RendererSession<TRaw>>,
  };
  return Object.freeze(stable);
}

function validateRendererSession<TRaw>(value: RendererSession<TRaw>): RendererSession<TRaw> {
  const snapshot = snapshotOwnDataObject(value, "renderer session");
  if (!Object.hasOwn(snapshot, "raw")) throw new TypeError("Renderer session must expose raw.");
  const ready = snapshot.ready;
  if (
    (typeof ready !== "object" && typeof ready !== "function") ||
    ready === null ||
    typeof (ready as PromiseLike<void>).then !== "function"
  ) {
    throw new TypeError("Renderer session ready must be a promise.");
  }
  const diagnostics = snapshotOwnDataArray(snapshot.diagnostics, "renderer session diagnostics").map((entry) =>
    Object.freeze(snapshotOwnDataObject(entry, "renderer diagnostic")),
  ) as unknown as readonly RendererSession<TRaw>["diagnostics"][number][];
  if (typeof snapshot.refresh !== "function" || typeof snapshot.dispose !== "function") {
    throw new TypeError("Renderer session must expose refresh() and dispose().");
  }
  const refresh = snapshot.refresh as RendererSession<TRaw>["refresh"];
  const dispose = snapshot.dispose as RendererSession<TRaw>["dispose"];
  const stable: RendererSession<TRaw> = {
    raw: snapshot.raw as TRaw,
    ready: Promise.resolve(ready as PromiseLike<void>),
    diagnostics: Object.freeze([...diagnostics]),
    refresh: (options) => Reflect.apply(refresh, stable, [options]) as Promise<void>,
    dispose: () => Reflect.apply(dispose, stable, []) as void | Promise<void>,
  };
  return Object.freeze(stable);
}

async function cleanupRejectedRendererSession(value: unknown): Promise<unknown | undefined> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Reflect.getOwnPropertyDescriptor(value, "dispose");
  } catch (error) {
    return error;
  }
  if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
    return undefined;
  }
  try {
    await Reflect.apply(descriptor.value, value, []);
    return undefined;
  } catch (error) {
    return error;
  }
}

function validateRendererTarget(target: RendererTarget): void {
  if (typeof target === "string") {
    if (target.length === 0 || target.trim() !== target) throw new TypeError("Renderer target selector is invalid.");
    return;
  }
  if (typeof target !== "object" || target === null) throw new TypeError("Renderer target is invalid.");
}

const DEFAULT_MOUNT_QUERY_LIMIT = 10_000;

function boundedMountQuery<T>(input: Readonly<Query<T>> | undefined): Readonly<Query<T>> {
  const query: Readonly<Query<T>> = input ?? Object.freeze({});
  const paginationSnapshot =
    query.pagination === undefined ? undefined : snapshotOwnDataObject(query.pagination, "mount query pagination");
  const pagination =
    paginationSnapshot === undefined
      ? Object.freeze({ limit: DEFAULT_MOUNT_QUERY_LIMIT })
      : Object.freeze({
          ...paginationSnapshot,
          ...(paginationSnapshot.limit === undefined ? { limit: DEFAULT_MOUNT_QUERY_LIMIT } : {}),
        });
  return Object.freeze({
    ...query,
    pagination,
    ...(query.returnGeometry === undefined ? { returnGeometry: true } : {}),
  });
}

function snapshotQuery<T>(value: Readonly<Query<T>>): Readonly<Query<T>> {
  return snapshotOwnDataObject(value, "connection query") as Readonly<Query<T>>;
}

function looksLikeQueryPlan(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return ["kind", "version", "fingerprint", "ir", "steps", "validity"].some(
      (key) => Reflect.getOwnPropertyDescriptor(value, key) !== undefined,
    );
  } catch {
    // Unstable reflection is never allowed to fall through to silent replanning.
    return true;
  }
}

function acceptedFeaturePlan(value: unknown): QueryExecutionPlanV1 {
  const accepted = parseQueryPlan(serializeQueryPlan(value as QueryExecutionPlan));
  if (accepted.version !== "1.0" || accepted.ir.version !== "1.0") {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "Connection query accepts version 1 feature plans; columnar and realtime execution require an explicit engine",
    );
  }
  return accepted;
}

function assertAcceptedPlanExecutionOptions(options: QueryOptions): void {
  if (
    options.capabilityPolicy !== undefined ||
    options.fallback !== undefined ||
    options.estimates !== undefined ||
    options.cache !== undefined
  ) {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "Planning options cannot be applied while executing an accepted plan; explain a replacement plan instead",
    );
  }
}

function assertConnectionPlanBinding(plan: QueryExecutionPlanV1, sourceVersion: string): void {
  if (plan.validity.executionMode !== "snapshot") {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "Connection query accepts snapshot feature plans; realtime execution requires an explicit engine",
    );
  }
  if (plan.ir.source.sourceVersion !== sourceVersion) {
    throw new HonuaQueryPlanExecutionError(
      "foreign-plan",
      "Query plan belongs to a foreign connection or source; explain a replacement plan",
      { context: { reason: "source-identity-changed" } },
      "source-identity-changed",
    );
  }
}

function connectionAuthorizationScope(value: string | undefined): readonly string[] {
  const fingerprint = value?.trim() || "anonymous";
  return Object.freeze([`scope:${sha256(`honua.kernel.authorization-scope.v1\0${fingerprint}`)}`]);
}

function connectionSourceVersion(inspection: ConnectionInspection, descriptor: SourceDescriptor): string {
  const identity = canonicalStringify(
    toJsonValue({
      version: 3,
      connectionId: inspection.id,
      endpoint: inspection.endpoint,
      protocol: inspection.protocol,
      source: semanticSourceAddress(descriptor),
    }),
  );
  return `connection-source:${sha256(identity)}`;
}

/** Project stable source addressing without retaining URL credentials or mutable discovery truth. */
function semanticSourceAddress(descriptor: SourceDescriptor): Readonly<Record<string, unknown>> {
  const { url, geoparquet, ...locatorCoordinates } = descriptor.locator;
  const locator = {
    ...locatorCoordinates,
    url: normalizeDiscoveryEndpoint(url),
    ...(geoparquet === undefined
      ? {}
      : {
          geoparquet: {
            ...geoparquet,
            ...(geoparquet.urls === undefined
              ? {}
              : { urls: sortedUniqueStrings(geoparquet.urls.map((entry) => normalizeDiscoveryEndpoint(entry))) }),
          },
        }),
  };
  return {
    id: descriptor.id,
    protocol: descriptor.protocol,
    locator,
  };
}

function legacySchemaVersion(descriptor: SourceDescriptor): string | undefined {
  if (descriptor.schemaV2 !== undefined || descriptor.schema === undefined) return undefined;
  return `legacy-schema:${sha256(canonicalStringify(toJsonValue(descriptor.schema)))}`;
}

function connectionDiscoveryContext(
  inspection: SourceDiscoveryInspection,
  policy: DiscoveryCapabilityPolicy,
): QueryPlanDiscoveryContext {
  const provenance = normalizeDiscoveryProvenance(inspection.provenance);
  const capabilityDecisions = canonicalUnique(
    inspection.capabilityDecisions.map((decision) => normalizeDiscoveryCapabilityDecision(decision)),
  );
  const evidence = canonicalStringify(
    toJsonValue({
      version: 3,
      discovery: inspection.discovery,
      provenance,
      capabilityDecisions,
      capabilityProfileFingerprint: inspection.descriptor.capabilityProfile?.fingerprint ?? null,
      policy: normalizeDiscoveryCapabilityPolicy(policy),
    }),
  );
  const validators = sortedUniqueStrings([
    ...provenance.flatMap((entry) => (entry.validator === undefined ? [] : [entry.validator])),
    ...capabilityDecisions.flatMap((decision) =>
      decision.evidence.flatMap((entry) =>
        entry.provenance.flatMap((provenanceEntry) =>
          provenanceEntry.validator === undefined ? [] : [provenanceEntry.validator],
        ),
      ),
    ),
  ]);
  return Object.freeze({
    state: plannerDiscoveryState(inspection),
    sourceFingerprint: sha256(`honua.kernel.discovery-evidence.v3\0${evidence}`),
    ...(validators.length > 0
      ? {
          validator: {
            kind: "fingerprint" as const,
            fingerprint: sha256(`honua.kernel.discovery-validator.v2\0${canonicalStringify(toJsonValue(validators))}`),
          },
        }
      : {}),
  });
}

interface SemanticDiscoveryProvenance {
  readonly source: string;
  readonly validator?: string;
}

interface SemanticDiscoveryEvidence {
  readonly kind: DiscoveryEvidenceKind;
  readonly supported: boolean;
  readonly reason?: string;
  readonly provenance: readonly SemanticDiscoveryProvenance[];
}

interface SemanticDiscoveryCapabilityDecision {
  readonly capability: DiscoveryCapabilityDecision["capability"];
  readonly effective: boolean;
  readonly code: DiscoveryCapabilityDecision["code"];
  readonly evidence: readonly SemanticDiscoveryEvidence[];
  readonly adapterSupported: boolean;
  readonly positiveEvidence: boolean;
  readonly policyAllowed: boolean;
}

/** Strip receipt-only clocks and canonicalize set-like discovery evidence before hashing plan identity. */
function normalizeDiscoveryProvenance(
  provenance: readonly DiscoveryProvenance[],
): readonly SemanticDiscoveryProvenance[] {
  return canonicalUnique(
    provenance.map((entry) => ({
      source: entry.source,
      ...(typeof entry.validator === "string" && entry.validator.length > 0 ? { validator: entry.validator } : {}),
    })),
  );
}

function normalizeDiscoveryCapabilityDecision(
  decision: DiscoveryCapabilityDecision,
): SemanticDiscoveryCapabilityDecision {
  return {
    capability: decision.capability,
    effective: decision.effective,
    code: decision.code,
    evidence: canonicalUnique(
      decision.evidence.map((entry) => ({
        kind: entry.kind,
        supported: entry.supported,
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        provenance: normalizeDiscoveryProvenance(entry.provenance),
      })),
    ),
    adapterSupported: decision.adapterSupported,
    positiveEvidence: decision.positiveEvidence,
    policyAllowed: decision.policyAllowed,
  };
}

function normalizeDiscoveryCapabilityPolicy(policy: DiscoveryCapabilityPolicy): Readonly<{
  allow?: readonly DiscoveryCapabilityDecision["capability"][];
  deny: readonly DiscoveryCapabilityDecision["capability"][];
  acceptInferred: boolean;
}> {
  return {
    ...(policy.allow === undefined ? {} : { allow: sortedUniqueStrings(policy.allow) }),
    deny: sortedUniqueStrings(policy.deny ?? []),
    acceptInferred: policy.acceptInferred === true,
  };
}

function canonicalUnique<T>(values: readonly T[]): readonly T[] {
  const keyed = new Map<string, T>();
  for (const value of values) {
    const key = canonicalStringify(toJsonValue(value));
    if (!keyed.has(key)) keyed.set(key, value);
  }
  return [...keyed.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

function sortedUniqueStrings<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort();
}

function plannerDiscoveryState(inspection: SourceDiscoveryInspection): DiscoveryEvidenceKind {
  if (inspection.discovery !== "mixed") return inspection.discovery;
  const kinds = new Set(
    inspection.capabilityDecisions.flatMap((decision) => decision.evidence.map((entry) => entry.kind)),
  );
  if (kinds.has("metadata")) return "metadata";
  if (kinds.has("declared")) return "declared";
  if (kinds.has("inferred")) return "inferred";
  return "unavailable";
}

function defaultPlanCache(): QueryPlanCacheOptions {
  // A discovery-metadata cache observation says nothing about query-result
  // reuse. Managed queries execute the adapter unless the caller supplies an
  // explicit query-cache observation to the planner.
  return Object.freeze({ policy: "bypass" });
}

/** Bind execution to the immutable inspection descriptor while preserving the adapter implementation. */
function plannerSource<T>(delegate: Source<T>, descriptor: SourceDescriptor): Source<T> {
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    query: (request) => delegate.query(request),
    queryAll: (request) => delegate.queryAll(request),
    queryAggregate: (request) => delegate.queryAggregate(request),
    protocol: (kind) => delegate.protocol(kind),
  } as Source<T>;
}

interface CreateExecutionReceiptOptions<T> {
  readonly sequence: number;
  readonly plan: QueryExecutionPlanV1;
  readonly state: ManagedConnectionState;
  readonly sourceInspection: SourceDiscoveryInspection;
  readonly result: Result<T>;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

function createExecutionReceipt<T>(options: CreateExecutionReceiptOptions<T>): ExecutionReceipt {
  const observedAt = options.sourceInspection.provenance
    .map((entry) => entry.retrievedAt)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1);
  const diagnostics = Object.freeze([
    ...options.sourceInspection.diagnostics.map((diagnostic) =>
      Object.freeze({
        source: "discovery" as const,
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: diagnostic.message,
      }),
    ),
    ...options.plan.warnings.map((warning) =>
      Object.freeze({
        source: "planner" as const,
        code: warning.code,
        severity: warning.severity,
        message: warning.message,
        path: warning.path,
        remediation: warning.remediation,
      }),
    ),
  ]);
  const schemaFingerprint =
    options.plan.provenance.schema.state === "known" ? options.plan.provenance.schema.fingerprint : undefined;
  const operationFingerprint = sha256(
    `honua.kernel.query-operation.v1\0${options.plan.fingerprint}\0${options.sequence}\0${options.startedAt}`,
  );
  return Object.freeze({
    version: "1.0",
    operationId: `query_${operationFingerprint.slice("sha256:".length, "sha256:".length + 20)}`,
    plan: Object.freeze({ id: options.plan.id, fingerprint: options.plan.fingerprint }),
    timings: Object.freeze({
      startedAt: options.startedAt,
      finishedAt: options.finishedAt,
      durationMs: Number(options.durationMs.toFixed(3)),
    }),
    provenance: Object.freeze({
      sourceFingerprint: options.plan.provenance.source.descriptorFingerprint,
      ...(schemaFingerprint ? { schemaFingerprint } : {}),
      discoveryFingerprint: options.plan.provenance.discovery.fingerprint,
      authorizationScopeFingerprint: options.plan.provenance.authorizationScope.fingerprint,
    }),
    observation: Object.freeze({
      connectionFingerprint: sha256(
        `honua.kernel.connection-receipt.v1\0${options.state.inspection.id}\0${options.state.inspection.endpoint}`,
      ),
      protocol: options.sourceInspection.descriptor.protocol,
      discovery: options.sourceInspection.discovery,
      cacheStatus: options.state.inspection.cacheStatus,
      ...(observedAt ? { observedAt } : {}),
    }),
    diagnostics,
    terminal: Object.freeze({
      state: "completed",
      featureCount: options.result.features.length,
      exceededTransferLimit: options.result.exceededTransferLimit,
    }),
  });
}

function monotonicNow(): number {
  return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function cloneInspection(value: ConnectionInspection, secrets: readonly string[]): ConnectionInspection {
  const seen = new Set<object>();
  return cloneInspectionValue(value, secrets, seen, 0) as ConnectionInspection;
}

function cloneInspectionValue(
  value: unknown,
  secrets: readonly string[],
  seen: Set<object>,
  depth: number,
  propertyName?: string,
): unknown {
  if (depth > 64) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Connection inspection exceeded the nesting limit.");
  }
  if (typeof value === "string") {
    return identifierProperty(propertyName)
      ? redactKnownSecrets(value, secrets)
      : sanitizeInspectionString(value, secrets);
  }
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Connection inspection contained non-data values.");
  }
  if (seen.has(value)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Connection inspection contained a cycle.");
  }
  seen.add(value);
  try {
    const setValues = readonlySetValues(value);
    if (setValues) {
      const cloned: string[] = [];
      for (let index = 0; index < setValues.length; index += 1) {
        cloned.push(cloneInspectionValue(setValues[index], secrets, seen, depth + 1) as string);
      }
      return Object.freeze(new ImmutableReadonlySet(cloned));
    }
    if (Array.isArray(value)) {
      const entries = snapshotOwnDataArray(value, "Connection inspection array");
      const cloned: unknown[] = [];
      for (let index = 0; index < entries.length; index += 1) {
        cloned.push(cloneInspectionValue(entries[index], secrets, seen, depth + 1, propertyName));
      }
      return Object.freeze(cloned);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Connection inspection must contain plain data.");
    }
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new HonuaDiscoveryError("invalid-discovery-cache", "Connection inspection cannot contain symbol keys.");
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || "get" in descriptor || !descriptor.enumerable) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Connection inspection must contain stable data fields.",
        );
      }
      Object.defineProperty(out, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: cloneInspectionValue(descriptor.value, secrets, seen, depth + 1, key),
      });
    }
    return Object.freeze(out);
  } finally {
    seen.delete(value);
  }
}

class ImmutableReadonlySet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  public constructor(values: readonly T[]) {
    this.#values = new Set(values);
  }

  public get size(): number {
    return this.#values.size;
  }

  public has(value: T): boolean {
    return this.#values.has(value);
  }

  public entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  public keys(): SetIterator<T> {
    return this.#values.keys();
  }

  public values(): SetIterator<T> {
    return this.#values.values();
  }

  public forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  public [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  public readonly [Symbol.toStringTag] = "Set";
}

Object.freeze(ImmutableReadonlySet.prototype);

function readonlySetValues(value: object): readonly unknown[] | undefined {
  try {
    const iterator = Set.prototype.values.call(value) as SetIterator<unknown>;
    return Object.freeze(Array.from(iterator));
  } catch {
    // SDK capability sets use an immutable ReadonlySet implementation. Locate
    // its declared methods through descriptors so accessors and Proxy get
    // traps are never invoked merely to classify the value.
  }
  try {
    const values = stableDataMethod(value, "values");
    const has = stableDataMethod(value, "has");
    const iterator = stableDataMethod(value, Symbol.iterator);
    if (!values || !has || !iterator || !stablePropertyExists(value, "size")) return undefined;
    const result = Reflect.apply(values, value, []);
    if (typeof result !== "object" || result === null) return undefined;
    return Object.freeze(Array.from(result as Iterable<unknown>));
  } catch {
    return undefined;
  }
}

function stableDataMethod(value: object, key: PropertyKey): ((...args: never[]) => unknown) | undefined {
  const descriptor = stablePropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value : undefined;
}

function stablePropertyExists(value: object, key: PropertyKey): boolean {
  return stablePropertyDescriptor(value, key) !== undefined;
}

function stablePropertyDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  let cursor: object | null = value;
  for (let depth = 0; cursor && depth < 32; depth += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) return descriptor;
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return undefined;
}

function identifierProperty(name: string | undefined): boolean {
  return name === "id" || name === "sourceId" || name === "defaultSourceId";
}

function sanitizeInspectionString(value: string, secrets: readonly string[]): string {
  let sanitized = redactKnownSecrets(value, secrets);
  sanitized = sanitized.replace(
    /\b(access[_-]?token|api[_-]?key|authorization|bearer|password|secret|signature|token)\b\s*[:=]\s*[^\s,;&]+/giu,
    "$1=[redacted]",
  );
  return sanitized.replace(/https?:\/\/[^\s"'<>]+/giu, (match) => sanitizeEmbeddedUrl(match));
}

function sanitizeEmbeddedUrl(match: string): string {
  let candidate = match;
  let suffix = "";
  const mapTileTemplate = /\{(?:z|x|y)\}/i.test(candidate);
  while (!mapTileTemplate && /[.),\]}]$/.test(candidate)) {
    suffix = `${candidate.at(-1)}${suffix}`;
    candidate = candidate.slice(0, -1);
  }
  try {
    const normalized = normalizeDiscoveryEndpoint(candidate)
      .replace(/%7Bz%7D/giu, "{z}")
      .replace(/%7Bx%7D/giu, "{x}")
      .replace(/%7By%7D/giu, "{y}");
    return `${normalized}${suffix}`;
  } catch {
    return `[redacted-url]${suffix}`;
  }
}

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let sanitized = value;
  for (const secret of secrets) sanitized = sanitized.split(secret).join("[redacted]");
  return sanitized;
}

function credentialSafeError(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) {
    return containsCredentialMaterial(error, secrets, new Set(), 0) ? new Error("Honua operation failed.") : error;
  }
  const message = stableStringProperty(error, "message");
  const originalMessage = message.safe && message.value !== undefined ? message.value : "Honua operation failed.";
  const sanitizedMessage = sanitizeInspectionString(originalMessage, secrets);
  const unsafePayload = !message.safe || containsCredentialMaterial(error, secrets, new Set(), 0);
  if (sanitizedMessage === originalMessage && !unsafePayload) return error;
  if (error instanceof HonuaDiscoveryError) {
    const code = stableStringProperty(error, "code");
    if (code.safe && isDiscoveryErrorCode(code.value)) {
      return new HonuaDiscoveryError(
        code.value,
        sanitizedMessage,
        sanitizedDiscoveryErrorDetail(error, secrets) ?? { redacted: true },
      );
    }
  }
  if (error instanceof HonuaAbortError) return new HonuaAbortError(sanitizedMessage);
  if (error instanceof HonuaQueryPlanExecutionError) {
    return new HonuaQueryPlanExecutionError(
      error.code,
      sanitizedMessage,
      error.reason ? { context: { reason: error.reason } } : {},
      error.reason,
    );
  }
  if (error instanceof HonuaQueryPlanningError) {
    return new HonuaQueryPlanningError(error.code, sanitizedMessage);
  }
  const sanitized = new Error(sanitizedMessage);
  const name = stableStringProperty(error, "name");
  if (name.safe && name.value !== undefined) sanitized.name = name.value;
  return sanitized;
}

function sanitizedDiscoveryErrorDetail(
  error: HonuaDiscoveryError,
  secrets: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  try {
    const descriptor = stablePropertyDescriptor(error, "context");
    if (!descriptor || !("value" in descriptor)) return undefined;
    const context = descriptor.value;
    if (typeof context !== "object" || context === null || Array.isArray(context)) return undefined;
    const cloned = cloneInspectionValue(context, secrets, new Set(), 0);
    return typeof cloned === "object" && cloned !== null && !Array.isArray(cloned)
      ? (cloned as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stableStringProperty(value: object, key: PropertyKey): { readonly safe: boolean; readonly value?: string } {
  try {
    const descriptor = stablePropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return { safe: false };
    return typeof descriptor.value === "string" ? { safe: true, value: descriptor.value } : { safe: false };
  } catch {
    return { safe: false };
  }
}

function isDiscoveryErrorCode(value: string | undefined): value is HonuaDiscoveryError["code"] {
  return (
    value === "ambiguous-protocol" ||
    value === "ambiguous-source" ||
    value === "invalid-endpoint" ||
    value === "invalid-cache-identity" ||
    value === "invalid-discovery-cache" ||
    value === "invalid-capability" ||
    value === "unsupported-protocol" ||
    value === "protocol-mismatch"
  );
}

function containsCredentialMaterial(
  value: unknown,
  secrets: readonly string[],
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > 8) return true;
  if (typeof value === "string") {
    if (secrets.some((secret) => value.includes(secret))) return true;
    if (
      /\b(access[_-]?token|api[_-]?key|authorization|bearer|password|secret|signature|token)\b\s*[:=]/iu.test(value)
    ) {
      return true;
    }
    return /https?:\/\/[^\s"'<>]*(?:@|\?|#)[^\s"'<>]*/iu.test(value);
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return true;
      if (containsCredentialMaterial(descriptor.value, secrets, seen, depth + 1)) {
        return true;
      }
    }
    return false;
  } catch {
    // An unstable error payload is not safe to forward from the public facade.
    return true;
  } finally {
    seen.delete(value);
  }
}

function combineAbortSignals(owner: AbortSignal, ...callers: readonly (AbortSignal | undefined)[]): AbortSignal {
  const signals = [owner, ...callers.filter((signal): signal is AbortSignal => signal !== undefined)].filter(
    (signal, index, values) => values.indexOf(signal) === index,
  );
  return signals.length === 1 ? owner : AbortSignal.any(signals);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
