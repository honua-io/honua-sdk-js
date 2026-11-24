/**
 * Framework-neutral app workspace state orchestration for sample apps.
 *
 * The workspace composes existing Honua surfaces into typed state slices.
 * Components dispatch reducer-style commands and subscribe to narrow slices or
 * selectors; no component needs an imperative reference to another component.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import { isJobTerminal } from "../contract/index.js";
import type { IJobRun, JobSnapshot, SourceId } from "../contract/index.js";
import {
  EMPTY_STATE,
  featureSelectionKey,
  isSourceQualifiedSelectionTarget,
  selectLinkedViewQueryProjection,
  sourceFeatureSelectionTarget,
} from "../exploration/index.js";
import type {
  ExplorationContext,
  ExplorationState,
  ExplorationStateSnapshot,
  FeatureSelectionTarget,
  FilterClause,
  LinkedViewQueryProjection,
  LinkedViewQueryProjectionOptions,
  Unsubscribe,
} from "../exploration/index.js";
import {
  type RealtimeFeatureEvent,
  type RealtimeFeatureRecord,
  type RealtimeFeatureState,
  type RealtimeFeatureTombstone,
  emptyRealtimeFeatureState,
  realtimeFeatureKey,
  reduceRealtimeFeatureState,
} from "../realtime/index.js";

export type HonuaAppStoreSlice = "all" | "exploration" | "sources" | "realtime" | "jobs" | "layout" | "drafts";

export interface HonuaAppStoreExplorationState {
  readonly reference?: HonuaAppStoreExplorationReference;
  readonly snapshot?: ExplorationStateSnapshot;
}

export interface HonuaAppStoreExplorationReference {
  readonly datasetId: string;
  readonly sourceIds: ReadonlyArray<string>;
}

export type HonuaSourceCacheStatus = "idle" | "loading" | "ready" | "stale" | "error";

export interface HonuaSourceMetadataEntry<TMetadata = unknown> {
  readonly sourceId: string;
  readonly status: HonuaSourceCacheStatus;
  readonly metadata?: TMetadata;
  readonly updatedAt?: number;
  readonly error?: unknown;
}

export interface HonuaAppStoreSourceState<TMetadata = unknown> {
  readonly entries: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
}

export interface HonuaAppStoreRealtimeState<TFeature = unknown> {
  readonly features: RealtimeFeatureState<TFeature>;
}

export interface HonuaAppStoreJobEntry<TResult = unknown> {
  readonly id: string;
  readonly type: string;
  readonly snapshot: JobSnapshot<TResult>;
}

export interface HonuaAppStoreJobState<TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppStoreJobEntry<TResult>>>;
}

export interface HonuaAppStoreLayoutState {
  readonly activeViewId?: string;
  readonly panels: Readonly<Record<string, HonuaAppStorePanelState>>;
  readonly savedState?: HonuaAppStoreSavedStateMetadata;
}

export interface HonuaAppStorePanelState {
  readonly visible?: boolean;
  readonly order?: number;
  readonly size?: number;
  readonly collapsed?: boolean;
}

export interface HonuaAppStoreSavedStateMetadata {
  readonly id: string;
  readonly label?: string;
  readonly savedAt: number;
  readonly version?: string;
}

export interface HonuaAppStoreDraftEntry<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly id: string;
  readonly source: "mcp" | "ai" | "import" | "user" | (string & {});
  readonly proposedIntent: HonuaAppStoreReviewableIntent<TFeature, TMetadata, TResult>;
  readonly createdAt?: number;
  readonly label?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAppStoreDraftState<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppStoreDraftEntry<TFeature, TMetadata, TResult>>>;
  readonly activeDraftId?: string;
}

export interface HonuaAppStoreState<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly exploration: HonuaAppStoreExplorationState;
  readonly sources: HonuaAppStoreSourceState<TMetadata>;
  readonly realtime: HonuaAppStoreRealtimeState<TFeature>;
  readonly jobs: HonuaAppStoreJobState<TResult>;
  readonly layout: HonuaAppStoreLayoutState;
  readonly drafts: HonuaAppStoreDraftState<TFeature, TMetadata, TResult>;
}

export interface HonuaAppStoreSnapshot<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly version: 1;
  readonly state: HonuaAppStoreState<TFeature, TMetadata, TResult>;
}

export const HONUA_SAVED_APP_STATE_DOCUMENT_KIND = "honua.saved-workspace" as const;
export const HONUA_SAVED_APP_STATE_DOCUMENT_VERSION = 1 as const;

export type HonuaSavedAppStateDocumentKind = typeof HONUA_SAVED_APP_STATE_DOCUMENT_KIND;
export type HonuaSavedAppStateDocumentVersion = typeof HONUA_SAVED_APP_STATE_DOCUMENT_VERSION;

export interface HonuaSavedAppStateMigrationMetadata {
  readonly schemaVersion: HonuaSavedAppStateDocumentVersion;
  readonly savedAt: string;
  readonly createdBy?: string;
  readonly createdWith?: string;
  readonly migratedFrom?: ReadonlyArray<string>;
  readonly migrations?: ReadonlyArray<HonuaSavedAppStateMigrationStep>;
}

export interface HonuaSavedAppStateMigrationStep {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly note?: string;
}

export interface HonuaAppProjectState {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAppSessionState {
  readonly id?: string;
  readonly userId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly activeViewId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateSource {
  readonly id: string;
  readonly protocol?: string;
  readonly title?: string;
  readonly locator?: Readonly<Record<string, unknown>>;
  readonly capabilities?: ReadonlyArray<string>;
  readonly status?: HonuaSourceCacheStatus;
  readonly metadata?: unknown;
}

export interface HonuaSavedAppStateLayer {
  readonly id: string;
  readonly sourceId?: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly styleId?: string;
  readonly filterIds?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateStyle {
  readonly id: string;
  readonly layerId?: string;
  readonly name?: string;
  readonly spec?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateQuery {
  readonly id: string;
  readonly label?: string;
  readonly sourceIds?: ReadonlyArray<string>;
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly spatialFilter?: ExplorationState["spatialFilter"];
  readonly sort?: ExplorationState["sort"];
  readonly page?: ExplorationState["page"];
  readonly visibleFields?: ExplorationState["visibleFields"];
  readonly grouping?: ExplorationState["grouping"];
  readonly aggregation?: ExplorationState["aggregation"];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateSelectedFeature<TFeature = unknown> {
  readonly sourceId?: string;
  readonly id: string | number;
  readonly feature?: TFeature;
  readonly selectedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateJob<TResult = unknown> {
  readonly id: string;
  readonly type: string;
  readonly status: JobSnapshot<TResult>["status"];
  readonly progress?: JobSnapshot<TResult>["progress"];
  readonly result?: JobSnapshot<TResult>["result"];
  readonly error?: JobSnapshot<TResult>["error"];
  readonly outputIds?: ReadonlyArray<string>;
  readonly updatedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateAnalysisOutput {
  readonly id: string;
  readonly jobId?: string;
  readonly type: string;
  readonly label?: string;
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly href?: string;
  readonly mediaType?: string;
  readonly data?: unknown;
  readonly createdAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly kind: HonuaSavedAppStateDocumentKind;
  readonly version: HonuaSavedAppStateDocumentVersion;
  readonly migration: HonuaSavedAppStateMigrationMetadata;
  readonly project: HonuaAppProjectState;
  readonly session?: HonuaAppSessionState;
  readonly sources: ReadonlyArray<HonuaSavedAppStateSource>;
  readonly layers: ReadonlyArray<HonuaSavedAppStateLayer>;
  readonly styles: ReadonlyArray<HonuaSavedAppStateStyle>;
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly savedQueries: ReadonlyArray<HonuaSavedAppStateQuery>;
  readonly selectedFeatures: ReadonlyArray<HonuaSavedAppStateSelectedFeature<TFeature>>;
  readonly jobs: ReadonlyArray<HonuaSavedAppStateJob<TResult>>;
  readonly analysisOutputs: ReadonlyArray<HonuaSavedAppStateAnalysisOutput>;
  readonly appSnapshot?: HonuaAppStoreSnapshot<TFeature, TMetadata, TResult>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateCreateOptions<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly project: HonuaAppProjectState;
  readonly session?: HonuaAppSessionState;
  readonly snapshot?: HonuaAppStoreSnapshot<TFeature, TMetadata, TResult>;
  readonly state?: HonuaAppStoreState<TFeature, TMetadata, TResult>;
  readonly sources?: ReadonlyArray<HonuaSavedAppStateSource>;
  readonly layers?: ReadonlyArray<HonuaSavedAppStateLayer>;
  readonly styles?: ReadonlyArray<HonuaSavedAppStateStyle>;
  readonly savedQueries?: ReadonlyArray<HonuaSavedAppStateQuery>;
  readonly jobs?: ReadonlyArray<HonuaSavedAppStateJob<TResult>>;
  readonly analysisOutputs?: ReadonlyArray<HonuaSavedAppStateAnalysisOutput>;
  readonly migration?: Partial<HonuaSavedAppStateMigrationMetadata>;
  readonly savedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedAppStateValidationError {
  readonly path: string;
  readonly message: string;
}

export type HonuaSavedAppStateValidationResult<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | {
      readonly ok: true;
      readonly document: HonuaSavedAppStateDocument<TFeature, TMetadata, TResult>;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<HonuaSavedAppStateValidationError>;
    };

export interface HonuaSavedAppStateHydrateOptions<TResult = unknown> {
  readonly jobsById?: Readonly<Record<string, Partial<HonuaSavedAppStateJob<TResult>>>>;
  readonly analysisOutputsById?: Readonly<Record<string, HonuaSavedAppStateAnalysisOutput>>;
}

export interface HonuaSavedAppStateMcpSummary {
  readonly kind: "honua.workspace.summary";
  readonly workspaceId: string;
  readonly title?: string;
  readonly savedAt: string;
  readonly schemaVersion: HonuaSavedAppStateDocumentVersion;
  readonly sourceCount: number;
  readonly layerCount: number;
  readonly savedQueryCount: number;
  readonly selectedFeatureCount: number;
  readonly jobCount: number;
  readonly analysisOutputCount: number;
  readonly sources: ReadonlyArray<Pick<HonuaSavedAppStateSource, "id" | "protocol" | "title" | "status">>;
  readonly layers: ReadonlyArray<Pick<HonuaSavedAppStateLayer, "id" | "sourceId" | "title" | "visible">>;
  readonly savedQueries: ReadonlyArray<Pick<HonuaSavedAppStateQuery, "id" | "label" | "sourceIds">>;
  readonly jobs: ReadonlyArray<Pick<HonuaSavedAppStateJob, "id" | "type" | "status" | "outputIds">>;
  readonly analysisOutputs: ReadonlyArray<
    Pick<HonuaSavedAppStateAnalysisOutput, "id" | "jobId" | "type" | "label" | "sourceId" | "layerId">
  >;
}

export interface HonuaAppStoreOptions<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly initialState?: Partial<HonuaAppStoreState<TFeature, TMetadata, TResult>>;
}

export type HonuaAppStoreReviewableIntent<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | {
      readonly kind: "set-exploration";
      readonly reference?: HonuaAppStoreExplorationReference;
      readonly snapshot?: ExplorationStateSnapshot;
    }
  | {
      readonly kind: "restore-exploration-snapshot";
      readonly snapshot: ExplorationStateSnapshot;
    }
  | {
      readonly kind: "set-source-metadata";
      readonly sourceId: string;
      readonly status: HonuaSourceCacheStatus;
      readonly metadata?: TMetadata;
      readonly updatedAt?: number;
      readonly error?: unknown;
    }
  | {
      readonly kind: "clear-source-metadata";
      readonly sourceId?: string;
    }
  | {
      readonly kind: "apply-realtime-event";
      readonly event: RealtimeFeatureEvent<TFeature>;
    }
  | {
      readonly kind: "set-realtime-state";
      readonly state: RealtimeFeatureState<TFeature>;
    }
  | {
      readonly kind: "set-job-snapshot";
      readonly jobId: string;
      readonly type: string;
      readonly snapshot: JobSnapshot<TResult>;
    }
  | {
      readonly kind: "remove-job";
      readonly jobId: string;
    }
  | {
      readonly kind: "set-layout";
      readonly layout: HonuaAppStoreLayoutState;
    }
  | {
      readonly kind: "update-panel";
      readonly panelId: string;
      readonly panel: HonuaAppStorePanelState;
    }
  | {
      readonly kind: "set-active-view";
      readonly viewId: string | undefined;
    }
  | {
      readonly kind: "set-saved-state-metadata";
      readonly metadata: HonuaAppStoreSavedStateMetadata | undefined;
    };

export type HonuaAppStoreIntent<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | HonuaAppStoreReviewableIntent<TFeature, TMetadata, TResult>
  | {
      readonly kind: "attach-exploration-context";
      readonly context: ExplorationContext;
    }
  | {
      readonly kind: "attach-job";
      readonly job: IJobRun<TResult>;
    }
  | {
      readonly kind: "stage-draft";
      readonly draft: HonuaAppStoreDraftEntry<TFeature, TMetadata, TResult>;
      readonly activate?: boolean;
    }
  | {
      readonly kind: "remove-draft";
      readonly draftId: string;
    }
  | {
      readonly kind: "clear-drafts";
    }
  | {
      readonly kind: "set-active-draft";
      readonly draftId: string | undefined;
    }
  | {
      readonly kind: "restore-workspace-snapshot";
      readonly snapshot: HonuaAppStoreSnapshot<TFeature, TMetadata, TResult>;
    };

export interface HonuaAppStoreMapModel<TMetadata = unknown> {
  readonly extent: ExplorationState["extent"];
  readonly spatialFilter: ExplorationState["spatialFilter"];
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly sourceStatuses: Readonly<Record<SourceId, HonuaSourceCacheStatus>>;
  readonly sources: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
  readonly query: LinkedViewQueryProjection;
}

export interface HonuaAppStoreTableModel<TFeature = unknown, TMetadata = unknown> {
  readonly query: LinkedViewQueryProjection;
  readonly records: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly source?: HonuaSourceMetadataEntry<TMetadata>;
}

export interface HonuaAppStoreDetailModel<TFeature = unknown> {
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly selectedRecords: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly tombstones: ReadonlyArray<RealtimeFeatureTombstone>;
  readonly missingSelection: ReadonlyArray<FeatureSelectionTarget>;
}

export interface HonuaAppStoreFilterModel {
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly spatialFilter: ExplorationState["spatialFilter"];
  readonly extent: ExplorationState["extent"];
}

export interface HonuaAppStoreChartModel {
  readonly query: LinkedViewQueryProjection;
  readonly grouping: ExplorationState["grouping"];
  readonly aggregation: ExplorationState["aggregation"];
}

export interface HonuaAppStoreJobModel<TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppStoreJobEntry<TResult>>>;
  readonly running: ReadonlyArray<HonuaAppStoreJobEntry<TResult>>;
  readonly terminal: ReadonlyArray<HonuaAppStoreJobEntry<TResult>>;
}

export interface HonuaAppStoreRealtimeModel<TFeature = unknown> {
  readonly status: RealtimeFeatureState<TFeature>["status"];
  readonly cursor: RealtimeFeatureState<TFeature>["cursor"];
  readonly watermark: RealtimeFeatureState<TFeature>["watermark"];
  readonly records: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly tombstones: ReadonlyArray<RealtimeFeatureTombstone>;
  readonly ignoredEventCount: number;
}

export interface HonuaAppStoreMetadataCacheModel<TMetadata = unknown> {
  readonly entries: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
  readonly loading: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly ready: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly stale: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly errors: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
}

export interface HonuaAppStoreChangeEvent<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly state: HonuaAppStoreState<TFeature, TMetadata, TResult>;
  readonly previous: HonuaAppStoreState<TFeature, TMetadata, TResult>;
  readonly changedSlices: ReadonlySet<HonuaAppStoreSlice>;
  readonly intent: HonuaAppStoreIntent<TFeature, TMetadata, TResult>;
}

export type HonuaAppStoreListener<TFeature = unknown, TMetadata = unknown, TResult = unknown> = (
  event: HonuaAppStoreChangeEvent<TFeature, TMetadata, TResult>,
) => void;

export type HonuaAppStoreSelector<TSelected, TFeature = unknown, TMetadata = unknown, TResult = unknown> = (
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
) => TSelected;

export type HonuaAppStoreSelectorListener<TSelected> = (value: TSelected, previous: TSelected) => void;

export type HonuaAppStoreEquality<TSelected> = (a: TSelected, b: TSelected) => boolean;

export class HonuaAppStore<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  #state: HonuaAppStoreState<TFeature, TMetadata, TResult>;
  readonly #listeners = new Map<HonuaAppStoreSlice, Set<HonuaAppStoreListener<TFeature, TMetadata, TResult>>>();
  readonly #externalUnsubscribers = new Set<Unsubscribe>();
  #disposed = false;

  public constructor(options: HonuaAppStoreOptions<TFeature, TMetadata, TResult> = {}) {
    this.#state = mergeInitialState(options.initialState);
  }

  public get state(): HonuaAppStoreState<TFeature, TMetadata, TResult> {
    return this.#state;
  }

  public dispatch(intent: HonuaAppStoreIntent<TFeature, TMetadata, TResult>): void {
    this.#ensureLive("dispatch");
    if (intent.kind === "attach-exploration-context") {
      this.#attachExplorationContext(intent.context);
    } else if (intent.kind === "attach-job") {
      this.#attachJob(intent.job);
    }

    const previous = this.#state;
    const next = reduceAppWorkspaceState(previous, intent);
    if (next === previous) return;
    this.#state = next;
    const changedSlices = changedWorkspaceSlices(previous, next);
    this.#emit({ state: next, previous, changedSlices, intent });
  }

  public subscribe(
    slice: HonuaAppStoreSlice,
    listener: HonuaAppStoreListener<TFeature, TMetadata, TResult>,
  ): Unsubscribe {
    this.#ensureLive("subscribe");
    let listeners = this.#listeners.get(slice);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(slice, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.#listeners.get(slice);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(slice);
    };
  }

  public subscribeSelector<TSelected>(
    selector: HonuaAppStoreSelector<TSelected, TFeature, TMetadata, TResult>,
    listener: HonuaAppStoreSelectorListener<TSelected>,
    equality: HonuaAppStoreEquality<TSelected> = Object.is,
  ): Unsubscribe {
    this.#ensureLive("subscribeSelector");
    let selected = selector(this.#state);
    return this.subscribe("all", (event) => {
      const next = selector(event.state);
      if (equality(selected, next)) return;
      const previous = selected;
      selected = next;
      listener(next, previous);
    });
  }

  public snapshot(): HonuaAppStoreSnapshot<TFeature, TMetadata, TResult> {
    this.#ensureLive("snapshot");
    return { version: 1, state: cloneValue(this.#state) };
  }

  public restore(snapshot: HonuaAppStoreSnapshot<TFeature, TMetadata, TResult>): void {
    this.dispatch({ kind: "restore-workspace-snapshot", snapshot });
  }

  public applyDraft(draftId: string): void {
    this.#ensureLive("applyDraft");
    const draft = this.#state.drafts.entries[draftId];
    if (!draft) throw new Error(`HonuaAppStore draft ${draftId} was not found`);
    this.dispatch(draft.proposedIntent);
    this.dispatch({ kind: "remove-draft", draftId });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsubscribe of this.#externalUnsubscribers) unsubscribe();
    this.#externalUnsubscribers.clear();
    this.#listeners.clear();
  }

  #attachExplorationContext(context: ExplorationContext): void {
    const unsubscribe = context.subscribe("all", () => {
      if (this.#disposed) return;
      this.dispatch({
        kind: "set-exploration",
        reference: { datasetId: context.datasetId, sourceIds: context.sourceIds },
        snapshot: context.snapshot(),
      });
    });
    this.#externalUnsubscribers.add(unsubscribe);
  }

  #attachJob(job: IJobRun<TResult>): void {
    const unsubscribe = job.watch((snapshot) => {
      if (this.#disposed) return;
      this.dispatch({ kind: "set-job-snapshot", jobId: job.id, type: job.type, snapshot });
    });
    this.#externalUnsubscribers.add(unsubscribe);
  }

  #emit(event: HonuaAppStoreChangeEvent<TFeature, TMetadata, TResult>): void {
    const allListeners = this.#listeners.get("all");
    if (allListeners) {
      for (const listener of [...allListeners]) listener(event);
    }
    for (const slice of event.changedSlices) {
      const listeners = this.#listeners.get(slice);
      if (!listeners) continue;
      for (const listener of [...listeners]) listener(event);
    }
  }

  #ensureLive(operation: string): void {
    if (this.#disposed) {
      throw new Error(`HonuaAppStore cannot ${operation} after dispose()`);
    }
  }
}

export function createHonuaAppStore<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  options?: HonuaAppStoreOptions<TFeature, TMetadata, TResult>,
): HonuaAppStore<TFeature, TMetadata, TResult> {
  return new HonuaAppStore(options);
}

export function createHonuaSavedAppStateDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  options: HonuaSavedAppStateCreateOptions<TFeature, TMetadata, TResult>,
): HonuaSavedAppStateDocument<TFeature, TMetadata, TResult> {
  const snapshot = options.snapshot ?? (options.state ? { version: 1, state: cloneValue(options.state) } : undefined);
  const state = snapshot?.state;
  const savedAt = options.savedAt ?? new Date().toISOString();
  const exploration = state ? selectWorkspaceExplorationState(state) : EMPTY_STATE;

  return {
    kind: HONUA_SAVED_APP_STATE_DOCUMENT_KIND,
    version: HONUA_SAVED_APP_STATE_DOCUMENT_VERSION,
    migration: {
      schemaVersion: HONUA_SAVED_APP_STATE_DOCUMENT_VERSION,
      savedAt,
      ...cloneValue(options.migration ?? {}),
    },
    project: cloneValue(options.project),
    session: options.session
      ? cloneValue({
          ...options.session,
          activeViewId: options.session.activeViewId ?? state?.layout.activeViewId,
        })
      : state?.layout.activeViewId
        ? { activeViewId: state.layout.activeViewId }
        : undefined,
    sources: cloneValue(options.sources ?? sourcesFromWorkspaceState(state)),
    layers: cloneValue(options.layers ?? []),
    styles: cloneValue(options.styles ?? []),
    filters: cloneValue(exploration.filters),
    savedQueries: cloneValue(options.savedQueries ?? []),
    selectedFeatures: cloneValue(selectedFeaturesFromWorkspaceState(state)),
    jobs: cloneValue(options.jobs ?? jobsFromWorkspaceState(state)),
    analysisOutputs: cloneValue(options.analysisOutputs ?? []),
    appSnapshot: snapshot ? cloneValue(snapshot) : undefined,
    metadata: options.metadata ? cloneValue(options.metadata) : undefined,
  };
}

export function validateHonuaSavedAppStateDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
): HonuaSavedAppStateValidationResult<TFeature, TMetadata, TResult> {
  const errors: HonuaSavedAppStateValidationError[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: "$", message: "document must be an object" }] };
  }

  if (value.kind !== HONUA_SAVED_APP_STATE_DOCUMENT_KIND) {
    errors.push({ path: "$.kind", message: `must be ${HONUA_SAVED_APP_STATE_DOCUMENT_KIND}` });
  }
  if (value.version !== HONUA_SAVED_APP_STATE_DOCUMENT_VERSION) {
    errors.push({ path: "$.version", message: "unsupported saved workspace document version" });
  }
  if (!isRecord(value.migration)) {
    errors.push({ path: "$.migration", message: "migration metadata is required" });
  } else {
    if (value.migration.schemaVersion !== HONUA_SAVED_APP_STATE_DOCUMENT_VERSION) {
      errors.push({ path: "$.migration.schemaVersion", message: "unsupported migration schema version" });
    }
    if (typeof value.migration.savedAt !== "string") {
      errors.push({ path: "$.migration.savedAt", message: "savedAt must be a string" });
    }
  }
  if (!isRecord(value.project)) {
    errors.push({ path: "$.project", message: "project is required" });
  } else if (typeof value.project.id !== "string" || value.project.id.length === 0) {
    errors.push({ path: "$.project.id", message: "project id must be a non-empty string" });
  }

  validateArrayWithIds(value.sources, "$.sources", errors);
  validateArrayWithIds(value.layers, "$.layers", errors);
  validateArrayWithIds(value.styles, "$.styles", errors);
  validateArrayWithIds(value.savedQueries, "$.savedQueries", errors);
  validateArrayWithIds(value.analysisOutputs, "$.analysisOutputs", errors);

  if (!isRecord(value.filters)) {
    errors.push({ path: "$.filters", message: "filters must be an object" });
  }
  if (!Array.isArray(value.selectedFeatures)) {
    errors.push({ path: "$.selectedFeatures", message: "selectedFeatures must be an array" });
  } else {
    value.selectedFeatures.forEach((entry, index) => {
      if (!isRecord(entry)) {
        errors.push({ path: `$.selectedFeatures[${index}]`, message: "selected feature must be an object" });
      } else if (typeof entry.id !== "string" && typeof entry.id !== "number") {
        errors.push({
          path: `$.selectedFeatures[${index}].id`,
          message: "selected feature id must be string or number",
        });
      }
    });
  }
  if (!Array.isArray(value.jobs)) {
    errors.push({ path: "$.jobs", message: "jobs must be an array" });
  } else {
    value.jobs.forEach((entry, index) => {
      if (!isRecord(entry)) {
        errors.push({ path: `$.jobs[${index}]`, message: "job must be an object" });
        return;
      }
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        errors.push({ path: `$.jobs[${index}].id`, message: "job id must be a non-empty string" });
      }
      if (typeof entry.type !== "string" || entry.type.length === 0) {
        errors.push({ path: `$.jobs[${index}].type`, message: "job type must be a non-empty string" });
      }
      if (!isSupportedJobStatus(entry.status)) {
        errors.push({ path: `$.jobs[${index}].status`, message: "job status is not supported" });
      }
    });
  }
  if (value.appSnapshot !== undefined) {
    if (!isRecord(value.appSnapshot)) {
      errors.push({ path: "$.appSnapshot", message: "appSnapshot must be an object" });
    } else {
      if (value.appSnapshot.version !== 1) {
        errors.push({ path: "$.appSnapshot.version", message: "unsupported app workspace snapshot version" });
      }
      if (!isRecord(value.appSnapshot.state)) {
        errors.push({ path: "$.appSnapshot.state", message: "appSnapshot state is required" });
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    document: cloneValue(value) as unknown as HonuaSavedAppStateDocument<TFeature, TMetadata, TResult>,
  };
}

export function assertHonuaSavedAppStateDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
): HonuaSavedAppStateDocument<TFeature, TMetadata, TResult> {
  const validation = validateHonuaSavedAppStateDocument<TFeature, TMetadata, TResult>(value);
  if (validation.ok) return validation.document;
  const message = validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
  throw new Error(`Invalid Honua saved workspace document: ${message}`);
}

export function hydrateHonuaSavedAppState<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
  options: HonuaSavedAppStateHydrateOptions<TResult> = {},
): HonuaAppStoreState<TFeature, TMetadata, TResult> {
  const document = reattachHonuaSavedAppStateArtifacts(
    assertHonuaSavedAppStateDocument<TFeature, TMetadata, TResult>(value),
    options,
  );
  if (document.appSnapshot) {
    return applySavedWorkspaceJobsToState(cloneValue(document.appSnapshot.state), document.jobs);
  }
  return stateFromSavedWorkspaceDocument(document);
}

export function createHonuaAppStoreFromSavedDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
  options: HonuaSavedAppStateHydrateOptions<TResult> = {},
): HonuaAppStore<TFeature, TMetadata, TResult> {
  return createHonuaAppStore({
    initialState: hydrateHonuaSavedAppState<TFeature, TMetadata, TResult>(value, options),
  });
}

export function reattachHonuaSavedAppStateArtifacts<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: HonuaSavedAppStateDocument<TFeature, TMetadata, TResult>,
  options: HonuaSavedAppStateHydrateOptions<TResult> = {},
): HonuaSavedAppStateDocument<TFeature, TMetadata, TResult> {
  const jobsById = options.jobsById ?? {};
  const analysisOutputsById = options.analysisOutputsById ?? {};
  const analysisOutputIds = new Set(value.analysisOutputs.map((output) => output.id));
  const extraOutputs = Object.values(analysisOutputsById).filter((output) => !analysisOutputIds.has(output.id));

  return {
    ...cloneValue(value),
    jobs: value.jobs.map((job) => ({ ...job, ...cloneValue(jobsById[job.id] ?? {}) })),
    analysisOutputs: [
      ...value.analysisOutputs.map((output) => cloneValue(analysisOutputsById[output.id] ?? output)),
      ...cloneValue(extraOutputs),
    ],
  };
}

export function summarizeHonuaSavedAppStateForMcp(value: unknown): HonuaSavedAppStateMcpSummary {
  const document = assertHonuaSavedAppStateDocument(value);
  return {
    kind: "honua.workspace.summary",
    workspaceId: document.project.id,
    title: document.project.title,
    savedAt: document.migration.savedAt,
    schemaVersion: document.version,
    sourceCount: document.sources.length,
    layerCount: document.layers.length,
    savedQueryCount: document.savedQueries.length,
    selectedFeatureCount: document.selectedFeatures.length,
    jobCount: document.jobs.length,
    analysisOutputCount: document.analysisOutputs.length,
    sources: document.sources.map(({ id, protocol, title, status }) => ({ id, protocol, title, status })),
    layers: document.layers.map(({ id, sourceId, title, visible }) => ({ id, sourceId, title, visible })),
    savedQueries: document.savedQueries.map(({ id, label, sourceIds }) => ({ id, label, sourceIds })),
    jobs: document.jobs.map(({ id, type, status, outputIds }) => ({ id, type, status, outputIds })),
    analysisOutputs: document.analysisOutputs.map(({ id, jobId, type, label, sourceId, layerId }) => ({
      id,
      jobId,
      type,
      label,
      sourceId,
      layerId,
    })),
  };
}

export function bindHonuaAppStoreSelector<TSelected, TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  workspace: HonuaAppStore<TFeature, TMetadata, TResult>,
  selector: HonuaAppStoreSelector<TSelected, TFeature, TMetadata, TResult>,
  listener: HonuaAppStoreSelectorListener<TSelected>,
  options: { readonly equality?: HonuaAppStoreEquality<TSelected>; readonly fireImmediately?: boolean } = {},
): Unsubscribe {
  if (options.fireImmediately) {
    const selected = selector(workspace.state);
    listener(selected, selected);
  }
  return workspace.subscribeSelector(selector, listener, options.equality);
}

export function selectHonuaAppStoreMapModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppStoreMapModel<TMetadata> {
  const exploration = selectWorkspaceExplorationState(state);
  const sourceStatuses: Record<SourceId, HonuaSourceCacheStatus> = {};
  for (const [sourceId, entry] of Object.entries(state.sources.entries)) {
    sourceStatuses[sourceId] = entry.status;
  }
  return {
    extent: exploration.extent,
    spatialFilter: exploration.spatialFilter,
    selection: exploration.selection,
    sourceStatuses,
    sources: state.sources.entries,
    query: selectLinkedViewQueryProjection(exploration, options),
  };
}

export function selectHonuaAppStoreTableModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppStoreTableModel<TFeature, TMetadata> {
  return {
    query: selectLinkedViewQueryProjection(selectWorkspaceExplorationState(state), options),
    records: selectRealtimeRecords(state.realtime.features, options.sourceId),
    source: options.sourceId ? state.sources.entries[options.sourceId] : undefined,
  };
}

export function selectHonuaAppStoreDetailModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): HonuaAppStoreDetailModel<TFeature> {
  const exploration = selectWorkspaceExplorationState(state);
  const selectedRecords: RealtimeFeatureRecord<TFeature>[] = [];
  const tombstones: RealtimeFeatureTombstone[] = [];
  const missingSelection: FeatureSelectionTarget[] = [];
  const seen = new Set<string>();

  for (const target of exploration.selection) {
    const selectionKey = featureSelectionKey(target);
    if (seen.has(selectionKey)) continue;
    seen.add(selectionKey);

    const key = realtimeKeyForSelection(target);
    const record = state.realtime.features.records[key];
    if (record) {
      selectedRecords.push(record);
      continue;
    }

    const tombstone = state.realtime.features.tombstones[key];
    if (tombstone) {
      tombstones.push(tombstone);
      continue;
    }

    missingSelection.push(target);
  }

  return {
    selection: exploration.selection,
    selectedRecords,
    tombstones,
    missingSelection,
  };
}

export function selectHonuaAppStoreFilterModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): HonuaAppStoreFilterModel {
  const exploration = selectWorkspaceExplorationState(state);
  return {
    filters: exploration.filters,
    spatialFilter: exploration.spatialFilter,
    extent: exploration.extent,
  };
}

export function selectHonuaAppStoreChartModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppStoreChartModel {
  const exploration = selectWorkspaceExplorationState(state);
  return {
    query: selectLinkedViewQueryProjection(exploration, options),
    grouping: exploration.grouping,
    aggregation: exploration.aggregation,
  };
}

export function selectHonuaAppStoreJobModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): HonuaAppStoreJobModel<TResult> {
  const entries = Object.values(state.jobs.entries);
  return {
    entries: state.jobs.entries,
    running: entries.filter((entry) => !isJobTerminal(entry.snapshot.status)),
    terminal: entries.filter((entry) => isJobTerminal(entry.snapshot.status)),
  };
}

export function selectHonuaAppStoreRealtimeModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  options: { readonly sourceId?: SourceId } = {},
): HonuaAppStoreRealtimeModel<TFeature> {
  const realtime = state.realtime.features;
  return {
    status: realtime.status,
    cursor: realtime.cursor,
    watermark: realtime.watermark,
    records: selectRealtimeRecords(realtime, options.sourceId),
    tombstones: selectRealtimeTombstones(realtime, options.sourceId),
    ignoredEventCount: realtime.ignoredEventCount,
  };
}

export function selectHonuaAppStoreMetadataCacheModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): HonuaAppStoreMetadataCacheModel<TMetadata> {
  const entries = Object.values(state.sources.entries);
  return {
    entries: state.sources.entries,
    loading: entries.filter((entry) => entry.status === "loading"),
    ready: entries.filter((entry) => entry.status === "ready"),
    stale: entries.filter((entry) => entry.status === "stale"),
    errors: entries.filter((entry) => entry.status === "error"),
  };
}

export function selectHonuaAppStoreDrafts<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): HonuaAppStoreDraftState<TFeature, TMetadata, TResult> {
  return state.drafts;
}

function reduceAppWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  intent: HonuaAppStoreIntent<TFeature, TMetadata, TResult>,
): HonuaAppStoreState<TFeature, TMetadata, TResult> {
  switch (intent.kind) {
    case "set-exploration":
      return withSlice(state, "exploration", {
        reference: intent.reference ? cloneValue(intent.reference) : undefined,
        snapshot: intent.snapshot ? cloneValue(intent.snapshot) : undefined,
      });
    case "attach-exploration-context":
      return withSlice(state, "exploration", {
        reference: { datasetId: intent.context.datasetId, sourceIds: [...intent.context.sourceIds] },
        snapshot: intent.context.snapshot(),
      });
    case "restore-exploration-snapshot":
      return withSlice(state, "exploration", {
        reference: state.exploration.reference,
        snapshot: cloneValue(intent.snapshot),
      });
    case "set-source-metadata":
      return withSlice(state, "sources", {
        entries: {
          ...state.sources.entries,
          [intent.sourceId]: {
            sourceId: intent.sourceId,
            status: intent.status,
            metadata: intent.metadata !== undefined ? cloneValue(intent.metadata) : undefined,
            updatedAt: intent.updatedAt,
            error: intent.error,
          },
        },
      });
    case "clear-source-metadata": {
      if (!intent.sourceId) return withSlice(state, "sources", { entries: {} });
      if (!state.sources.entries[intent.sourceId]) return state;
      const entries = { ...state.sources.entries };
      delete entries[intent.sourceId];
      return withSlice(state, "sources", { entries });
    }
    case "apply-realtime-event":
      return withSlice(state, "realtime", {
        features: reduceRealtimeFeatureState(state.realtime.features, intent.event),
      });
    case "set-realtime-state":
      return withSlice(state, "realtime", { features: cloneValue(intent.state) });
    case "set-job-snapshot":
      return withSlice(state, "jobs", {
        entries: {
          ...state.jobs.entries,
          [intent.jobId]: { id: intent.jobId, type: intent.type, snapshot: cloneValue(intent.snapshot) },
        },
      });
    case "attach-job":
      return withSlice(state, "jobs", {
        entries: {
          ...state.jobs.entries,
          [intent.job.id]: {
            id: intent.job.id,
            type: intent.job.type,
            snapshot: { status: intent.job.status, progress: intent.job.progress },
          },
        },
      });
    case "remove-job": {
      if (!state.jobs.entries[intent.jobId]) return state;
      const entries = { ...state.jobs.entries };
      delete entries[intent.jobId];
      return withSlice(state, "jobs", { entries });
    }
    case "set-layout":
      return withSlice(state, "layout", cloneValue(intent.layout));
    case "update-panel":
      return withSlice(state, "layout", {
        ...state.layout,
        panels: {
          ...state.layout.panels,
          [intent.panelId]: {
            ...state.layout.panels[intent.panelId],
            ...intent.panel,
          },
        },
      });
    case "set-active-view":
      return withSlice(state, "layout", { ...state.layout, activeViewId: intent.viewId });
    case "set-saved-state-metadata":
      return withSlice(state, "layout", { ...state.layout, savedState: intent.metadata });
    case "stage-draft":
      return withSlice(state, "drafts", {
        entries: {
          ...state.drafts.entries,
          [intent.draft.id]: cloneValue(intent.draft),
        },
        activeDraftId: intent.activate ? intent.draft.id : state.drafts.activeDraftId,
      });
    case "remove-draft": {
      if (!state.drafts.entries[intent.draftId]) return state;
      const entries = { ...state.drafts.entries };
      delete entries[intent.draftId];
      return withSlice(state, "drafts", {
        entries,
        activeDraftId: state.drafts.activeDraftId === intent.draftId ? undefined : state.drafts.activeDraftId,
      });
    }
    case "clear-drafts":
      return withSlice(state, "drafts", { entries: {} });
    case "set-active-draft":
      return withSlice(state, "drafts", { ...state.drafts, activeDraftId: intent.draftId });
    case "restore-workspace-snapshot":
      if (intent.snapshot.version !== 1) {
        throw new Error(`HonuaAppStore snapshot version ${String(intent.snapshot.version)} is not supported`);
      }
      return cloneValue(intent.snapshot.state);
  }
}

function withSlice<TFeature, TMetadata, TResult, K extends Exclude<HonuaAppStoreSlice, "all">>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  slice: K,
  value: HonuaAppStoreState<TFeature, TMetadata, TResult>[K],
): HonuaAppStoreState<TFeature, TMetadata, TResult> {
  if (Object.is(state[slice], value)) return state;
  return { ...state, [slice]: value };
}

function changedWorkspaceSlices<TFeature, TMetadata, TResult>(
  previous: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  next: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): ReadonlySet<HonuaAppStoreSlice> {
  const changed = new Set<HonuaAppStoreSlice>();
  if (previous.exploration !== next.exploration) changed.add("exploration");
  if (previous.sources !== next.sources) changed.add("sources");
  if (previous.realtime !== next.realtime) changed.add("realtime");
  if (previous.jobs !== next.jobs) changed.add("jobs");
  if (previous.layout !== next.layout) changed.add("layout");
  if (previous.drafts !== next.drafts) changed.add("drafts");
  return changed;
}

function mergeInitialState<TFeature, TMetadata, TResult>(
  initial: Partial<HonuaAppStoreState<TFeature, TMetadata, TResult>> | undefined,
): HonuaAppStoreState<TFeature, TMetadata, TResult> {
  return {
    exploration: initial?.exploration ? cloneValue(initial.exploration) : {},
    sources: initial?.sources ? cloneValue(initial.sources) : { entries: {} },
    realtime: initial?.realtime ? cloneValue(initial.realtime) : { features: emptyRealtimeFeatureState<TFeature>() },
    jobs: initial?.jobs ? cloneValue(initial.jobs) : { entries: {} },
    layout: initial?.layout ? cloneValue(initial.layout) : { panels: {} },
    drafts: initial?.drafts ? cloneValue(initial.drafts) : { entries: {} },
  };
}

function selectWorkspaceExplorationState<TFeature, TMetadata, TResult>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
): ExplorationState {
  return state.exploration.snapshot?.state ?? EMPTY_STATE;
}

function selectRealtimeRecords<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  sourceId: SourceId | undefined,
): RealtimeFeatureRecord<TFeature>[] {
  return Object.values(state.records).filter((record) => sourceId === undefined || record.sourceId === sourceId);
}

function selectRealtimeTombstones<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  sourceId: SourceId | undefined,
): RealtimeFeatureTombstone[] {
  return Object.values(state.tombstones).filter(
    (tombstone) => sourceId === undefined || tombstone.sourceId === sourceId,
  );
}

function realtimeKeyForSelection(target: FeatureSelectionTarget): string {
  if (isSourceQualifiedSelectionTarget(target)) return realtimeFeatureKey(target.sourceId, target.id);
  return realtimeFeatureKey(undefined, target);
}

function sourcesFromWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult> | undefined,
): HonuaSavedAppStateSource[] {
  if (!state) return [];
  return Object.values(state.sources.entries).map((entry) => ({
    id: entry.sourceId,
    status: entry.status,
    metadata: entry.metadata,
  }));
}

function selectedFeaturesFromWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult> | undefined,
): HonuaSavedAppStateSelectedFeature<TFeature>[] {
  if (!state) return [];
  return selectWorkspaceExplorationState(state).selection.map((target) => {
    if (isSourceQualifiedSelectionTarget(target)) {
      return { sourceId: target.sourceId, id: target.id };
    }
    return { id: target };
  });
}

function jobsFromWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult> | undefined,
): HonuaSavedAppStateJob<TResult>[] {
  if (!state) return [];
  return Object.values(state.jobs.entries).map((entry) => ({
    id: entry.id,
    type: entry.type,
    status: entry.snapshot.status,
    progress: entry.snapshot.progress,
    result: entry.snapshot.result,
    error: entry.snapshot.error,
    outputIds: entry.snapshot.result ? Object.keys(entry.snapshot.result.outputs) : undefined,
  }));
}

function stateFromSavedWorkspaceDocument<TFeature, TMetadata, TResult>(
  document: HonuaSavedAppStateDocument<TFeature, TMetadata, TResult>,
): HonuaAppStoreState<TFeature, TMetadata, TResult> {
  const sources: Record<string, HonuaSourceMetadataEntry<TMetadata>> = {};
  for (const source of document.sources) {
    sources[source.id] = {
      sourceId: source.id,
      status: source.status ?? "idle",
      metadata: source.metadata as TMetadata,
    };
  }

  const jobs: Record<string, HonuaAppStoreJobEntry<TResult>> = {};
  for (const job of document.jobs) {
    jobs[job.id] = {
      id: job.id,
      type: job.type,
      snapshot: {
        status: job.status,
        progress: job.progress,
        result: job.result,
        error: job.error,
      },
    };
  }

  return {
    exploration: {
      reference:
        document.project.id || document.sources.length > 0
          ? { datasetId: document.project.id, sourceIds: document.sources.map((source) => source.id) }
          : undefined,
      snapshot: {
        version: 1,
        state: {
          ...EMPTY_STATE,
          filters: cloneValue(document.filters),
          selection: document.selectedFeatures.map((feature) =>
            feature.sourceId ? sourceFeatureSelectionTarget(feature.sourceId, feature.id) : feature.id,
          ),
        },
      },
    },
    sources: { entries: sources },
    realtime: { features: emptyRealtimeFeatureState<TFeature>() },
    jobs: { entries: jobs },
    layout: {
      activeViewId: document.session?.activeViewId,
      panels: {},
      savedState: {
        id: document.project.id,
        label: document.project.title,
        savedAt: Date.parse(document.migration.savedAt),
        version: String(document.version),
      },
    },
    drafts: { entries: {} },
  };
}

function applySavedWorkspaceJobsToState<TFeature, TMetadata, TResult>(
  state: HonuaAppStoreState<TFeature, TMetadata, TResult>,
  jobs: ReadonlyArray<HonuaSavedAppStateJob<TResult>>,
): HonuaAppStoreState<TFeature, TMetadata, TResult> {
  if (jobs.length === 0) return state;
  const entries: Record<string, HonuaAppStoreJobEntry<TResult>> = { ...state.jobs.entries };
  for (const job of jobs) {
    entries[job.id] = {
      id: job.id,
      type: job.type,
      snapshot: {
        status: job.status,
        progress: job.progress,
        result: job.result,
        error: job.error,
      },
    };
  }
  return { ...state, jobs: { entries } };
}

function validateArrayWithIds(value: unknown, path: string, errors: HonuaSavedAppStateValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: "must be an array" });
    return;
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push({ path: `${path}[${index}]`, message: "entry must be an object" });
    } else if (typeof entry.id !== "string" || entry.id.length === 0) {
      errors.push({ path: `${path}[${index}].id`, message: "id must be a non-empty string" });
    }
  });
}

function isSupportedJobStatus(value: unknown): value is JobSnapshot["status"] {
  return (
    value === "accepted" || value === "running" || value === "successful" || value === "failed" || value === "dismissed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
