/**
 * Framework-neutral app workspace state orchestration for sample apps.
 *
 * The workspace composes existing Honua surfaces into typed state slices.
 * Components dispatch reducer-style commands and subscribe to narrow slices or
 * selectors; no component needs an imperative reference to another component.
 *
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

export type HonuaAppWorkspaceSlice = "all" | "exploration" | "sources" | "realtime" | "jobs" | "layout" | "drafts";

export interface HonuaAppWorkspaceExplorationState {
  readonly reference?: HonuaAppWorkspaceExplorationReference;
  readonly snapshot?: ExplorationStateSnapshot;
}

export interface HonuaAppWorkspaceExplorationReference {
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

export interface HonuaAppWorkspaceSourceState<TMetadata = unknown> {
  readonly entries: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
}

export interface HonuaAppWorkspaceRealtimeState<TFeature = unknown> {
  readonly features: RealtimeFeatureState<TFeature>;
}

export interface HonuaAppWorkspaceJobEntry<TResult = unknown> {
  readonly id: string;
  readonly type: string;
  readonly snapshot: JobSnapshot<TResult>;
}

export interface HonuaAppWorkspaceJobState<TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppWorkspaceJobEntry<TResult>>>;
}

export interface HonuaAppWorkspaceLayoutState {
  readonly activeViewId?: string;
  readonly panels: Readonly<Record<string, HonuaAppWorkspacePanelState>>;
  readonly savedState?: HonuaAppWorkspaceSavedStateMetadata;
}

export interface HonuaAppWorkspacePanelState {
  readonly visible?: boolean;
  readonly order?: number;
  readonly size?: number;
  readonly collapsed?: boolean;
}

export interface HonuaAppWorkspaceSavedStateMetadata {
  readonly id: string;
  readonly label?: string;
  readonly savedAt: number;
  readonly version?: string;
}

export interface HonuaAppWorkspaceDraftEntry<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly id: string;
  readonly source: "mcp" | "ai" | "import" | "user" | (string & {});
  readonly proposedIntent: HonuaAppWorkspaceReviewableIntent<TFeature, TMetadata, TResult>;
  readonly createdAt?: number;
  readonly label?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaAppWorkspaceDraftState<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppWorkspaceDraftEntry<TFeature, TMetadata, TResult>>>;
  readonly activeDraftId?: string;
}

export interface HonuaAppWorkspaceState<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly exploration: HonuaAppWorkspaceExplorationState;
  readonly sources: HonuaAppWorkspaceSourceState<TMetadata>;
  readonly realtime: HonuaAppWorkspaceRealtimeState<TFeature>;
  readonly jobs: HonuaAppWorkspaceJobState<TResult>;
  readonly layout: HonuaAppWorkspaceLayoutState;
  readonly drafts: HonuaAppWorkspaceDraftState<TFeature, TMetadata, TResult>;
}

export interface HonuaAppWorkspaceSnapshot<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly version: 1;
  readonly state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
}

export const HONUA_SAVED_WORKSPACE_DOCUMENT_KIND = "honua.saved-workspace" as const;
export const HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION = 1 as const;

export type HonuaSavedWorkspaceDocumentKind = typeof HONUA_SAVED_WORKSPACE_DOCUMENT_KIND;
export type HonuaSavedWorkspaceDocumentVersion = typeof HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION;

export interface HonuaSavedWorkspaceMigrationMetadata {
  readonly schemaVersion: HonuaSavedWorkspaceDocumentVersion;
  readonly savedAt: string;
  readonly createdBy?: string;
  readonly createdWith?: string;
  readonly migratedFrom?: ReadonlyArray<string>;
  readonly migrations?: ReadonlyArray<HonuaSavedWorkspaceMigrationStep>;
}

export interface HonuaSavedWorkspaceMigrationStep {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly note?: string;
}

export interface HonuaWorkspaceProjectState {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaWorkspaceSessionState {
  readonly id?: string;
  readonly userId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly activeViewId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedWorkspaceSource {
  readonly id: string;
  readonly protocol?: string;
  readonly title?: string;
  readonly locator?: Readonly<Record<string, unknown>>;
  readonly capabilities?: ReadonlyArray<string>;
  readonly status?: HonuaSourceCacheStatus;
  readonly metadata?: unknown;
}

export interface HonuaSavedWorkspaceLayer {
  readonly id: string;
  readonly sourceId?: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly opacity?: number;
  readonly styleId?: string;
  readonly filterIds?: ReadonlyArray<string>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedWorkspaceStyle {
  readonly id: string;
  readonly layerId?: string;
  readonly name?: string;
  readonly spec?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedWorkspaceQuery {
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

export interface HonuaSavedWorkspaceSelectedFeature<TFeature = unknown> {
  readonly sourceId?: string;
  readonly id: string | number;
  readonly feature?: TFeature;
  readonly selectedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedWorkspaceJob<TResult = unknown> {
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

export interface HonuaSavedWorkspaceAnalysisOutput {
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

export interface HonuaSavedWorkspaceDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly kind: HonuaSavedWorkspaceDocumentKind;
  readonly version: HonuaSavedWorkspaceDocumentVersion;
  readonly migration: HonuaSavedWorkspaceMigrationMetadata;
  readonly project: HonuaWorkspaceProjectState;
  readonly session?: HonuaWorkspaceSessionState;
  readonly sources: ReadonlyArray<HonuaSavedWorkspaceSource>;
  readonly layers: ReadonlyArray<HonuaSavedWorkspaceLayer>;
  readonly styles: ReadonlyArray<HonuaSavedWorkspaceStyle>;
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly savedQueries: ReadonlyArray<HonuaSavedWorkspaceQuery>;
  readonly selectedFeatures: ReadonlyArray<HonuaSavedWorkspaceSelectedFeature<TFeature>>;
  readonly jobs: ReadonlyArray<HonuaSavedWorkspaceJob<TResult>>;
  readonly analysisOutputs: ReadonlyArray<HonuaSavedWorkspaceAnalysisOutput>;
  readonly appSnapshot?: HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedWorkspaceCreateOptions<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly project: HonuaWorkspaceProjectState;
  readonly session?: HonuaWorkspaceSessionState;
  readonly snapshot?: HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult>;
  readonly state?: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly sources?: ReadonlyArray<HonuaSavedWorkspaceSource>;
  readonly layers?: ReadonlyArray<HonuaSavedWorkspaceLayer>;
  readonly styles?: ReadonlyArray<HonuaSavedWorkspaceStyle>;
  readonly savedQueries?: ReadonlyArray<HonuaSavedWorkspaceQuery>;
  readonly jobs?: ReadonlyArray<HonuaSavedWorkspaceJob<TResult>>;
  readonly analysisOutputs?: ReadonlyArray<HonuaSavedWorkspaceAnalysisOutput>;
  readonly migration?: Partial<HonuaSavedWorkspaceMigrationMetadata>;
  readonly savedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HonuaSavedWorkspaceValidationError {
  readonly path: string;
  readonly message: string;
}

export type HonuaSavedWorkspaceValidationResult<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | {
      readonly ok: true;
      readonly document: HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult>;
    }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<HonuaSavedWorkspaceValidationError>;
    };

export interface HonuaSavedWorkspaceHydrateOptions<TResult = unknown> {
  readonly jobsById?: Readonly<Record<string, Partial<HonuaSavedWorkspaceJob<TResult>>>>;
  readonly analysisOutputsById?: Readonly<Record<string, HonuaSavedWorkspaceAnalysisOutput>>;
}

export interface HonuaSavedWorkspaceMcpSummary {
  readonly kind: "honua.workspace.summary";
  readonly workspaceId: string;
  readonly title?: string;
  readonly savedAt: string;
  readonly schemaVersion: HonuaSavedWorkspaceDocumentVersion;
  readonly sourceCount: number;
  readonly layerCount: number;
  readonly savedQueryCount: number;
  readonly selectedFeatureCount: number;
  readonly jobCount: number;
  readonly analysisOutputCount: number;
  readonly sources: ReadonlyArray<Pick<HonuaSavedWorkspaceSource, "id" | "protocol" | "title" | "status">>;
  readonly layers: ReadonlyArray<Pick<HonuaSavedWorkspaceLayer, "id" | "sourceId" | "title" | "visible">>;
  readonly savedQueries: ReadonlyArray<Pick<HonuaSavedWorkspaceQuery, "id" | "label" | "sourceIds">>;
  readonly jobs: ReadonlyArray<Pick<HonuaSavedWorkspaceJob, "id" | "type" | "status" | "outputIds">>;
  readonly analysisOutputs: ReadonlyArray<
    Pick<HonuaSavedWorkspaceAnalysisOutput, "id" | "jobId" | "type" | "label" | "sourceId" | "layerId">
  >;
}

export interface HonuaAppWorkspaceOptions<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly initialState?: Partial<HonuaAppWorkspaceState<TFeature, TMetadata, TResult>>;
}

export type HonuaAppWorkspaceReviewableIntent<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | {
      readonly kind: "set-exploration";
      readonly reference?: HonuaAppWorkspaceExplorationReference;
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
      readonly layout: HonuaAppWorkspaceLayoutState;
    }
  | {
      readonly kind: "update-panel";
      readonly panelId: string;
      readonly panel: HonuaAppWorkspacePanelState;
    }
  | {
      readonly kind: "set-active-view";
      readonly viewId: string | undefined;
    }
  | {
      readonly kind: "set-saved-state-metadata";
      readonly metadata: HonuaAppWorkspaceSavedStateMetadata | undefined;
    };

export type HonuaAppWorkspaceIntent<TFeature = unknown, TMetadata = unknown, TResult = unknown> =
  | HonuaAppWorkspaceReviewableIntent<TFeature, TMetadata, TResult>
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
      readonly draft: HonuaAppWorkspaceDraftEntry<TFeature, TMetadata, TResult>;
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
      readonly snapshot: HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult>;
    };

export interface HonuaAppWorkspaceMapModel<TMetadata = unknown> {
  readonly extent: ExplorationState["extent"];
  readonly spatialFilter: ExplorationState["spatialFilter"];
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly sourceStatuses: Readonly<Record<SourceId, HonuaSourceCacheStatus>>;
  readonly sources: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
  readonly query: LinkedViewQueryProjection;
}

export interface HonuaAppWorkspaceTableModel<TFeature = unknown, TMetadata = unknown> {
  readonly query: LinkedViewQueryProjection;
  readonly records: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly source?: HonuaSourceMetadataEntry<TMetadata>;
}

export interface HonuaAppWorkspaceDetailModel<TFeature = unknown> {
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly selectedRecords: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly tombstones: ReadonlyArray<RealtimeFeatureTombstone>;
  readonly missingSelection: ReadonlyArray<FeatureSelectionTarget>;
}

export interface HonuaAppWorkspaceFilterModel {
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly spatialFilter: ExplorationState["spatialFilter"];
  readonly extent: ExplorationState["extent"];
}

export interface HonuaAppWorkspaceChartModel {
  readonly query: LinkedViewQueryProjection;
  readonly grouping: ExplorationState["grouping"];
  readonly aggregation: ExplorationState["aggregation"];
}

export interface HonuaAppWorkspaceJobModel<TResult = unknown> {
  readonly entries: Readonly<Record<string, HonuaAppWorkspaceJobEntry<TResult>>>;
  readonly running: ReadonlyArray<HonuaAppWorkspaceJobEntry<TResult>>;
  readonly terminal: ReadonlyArray<HonuaAppWorkspaceJobEntry<TResult>>;
}

export interface HonuaAppWorkspaceRealtimeModel<TFeature = unknown> {
  readonly status: RealtimeFeatureState<TFeature>["status"];
  readonly cursor: RealtimeFeatureState<TFeature>["cursor"];
  readonly watermark: RealtimeFeatureState<TFeature>["watermark"];
  readonly records: ReadonlyArray<RealtimeFeatureRecord<TFeature>>;
  readonly tombstones: ReadonlyArray<RealtimeFeatureTombstone>;
  readonly ignoredEventCount: number;
}

export interface HonuaAppWorkspaceMetadataCacheModel<TMetadata = unknown> {
  readonly entries: Readonly<Record<string, HonuaSourceMetadataEntry<TMetadata>>>;
  readonly loading: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly ready: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly stale: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
  readonly errors: ReadonlyArray<HonuaSourceMetadataEntry<TMetadata>>;
}

export interface HonuaAppWorkspaceChangeEvent<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  readonly state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly previous: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly changedSlices: ReadonlySet<HonuaAppWorkspaceSlice>;
  readonly intent: HonuaAppWorkspaceIntent<TFeature, TMetadata, TResult>;
}

export type HonuaAppWorkspaceListener<TFeature = unknown, TMetadata = unknown, TResult = unknown> = (
  event: HonuaAppWorkspaceChangeEvent<TFeature, TMetadata, TResult>,
) => void;

export type HonuaAppWorkspaceSelector<TSelected, TFeature = unknown, TMetadata = unknown, TResult = unknown> = (
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
) => TSelected;

export type HonuaAppWorkspaceSelectorListener<TSelected> = (value: TSelected, previous: TSelected) => void;

export type HonuaAppWorkspaceEquality<TSelected> = (a: TSelected, b: TSelected) => boolean;

export class HonuaAppWorkspace<TFeature = unknown, TMetadata = unknown, TResult = unknown> {
  #state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>;
  readonly #listeners = new Map<HonuaAppWorkspaceSlice, Set<HonuaAppWorkspaceListener<TFeature, TMetadata, TResult>>>();
  readonly #externalUnsubscribers = new Set<Unsubscribe>();
  #disposed = false;

  public constructor(options: HonuaAppWorkspaceOptions<TFeature, TMetadata, TResult> = {}) {
    this.#state = mergeInitialState(options.initialState);
  }

  public get state(): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
    return this.#state;
  }

  public dispatch(intent: HonuaAppWorkspaceIntent<TFeature, TMetadata, TResult>): void {
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
    slice: HonuaAppWorkspaceSlice,
    listener: HonuaAppWorkspaceListener<TFeature, TMetadata, TResult>,
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
    selector: HonuaAppWorkspaceSelector<TSelected, TFeature, TMetadata, TResult>,
    listener: HonuaAppWorkspaceSelectorListener<TSelected>,
    equality: HonuaAppWorkspaceEquality<TSelected> = Object.is,
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

  public snapshot(): HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult> {
    this.#ensureLive("snapshot");
    return { version: 1, state: cloneValue(this.#state) };
  }

  public restore(snapshot: HonuaAppWorkspaceSnapshot<TFeature, TMetadata, TResult>): void {
    this.dispatch({ kind: "restore-workspace-snapshot", snapshot });
  }

  public applyDraft(draftId: string): void {
    this.#ensureLive("applyDraft");
    const draft = this.#state.drafts.entries[draftId];
    if (!draft) throw new Error(`HonuaAppWorkspace draft ${draftId} was not found`);
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

  #emit(event: HonuaAppWorkspaceChangeEvent<TFeature, TMetadata, TResult>): void {
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
      throw new Error(`HonuaAppWorkspace cannot ${operation} after dispose()`);
    }
  }
}

export function createHonuaAppWorkspace<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  options?: HonuaAppWorkspaceOptions<TFeature, TMetadata, TResult>,
): HonuaAppWorkspace<TFeature, TMetadata, TResult> {
  return new HonuaAppWorkspace(options);
}

export function createHonuaSavedWorkspaceDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  options: HonuaSavedWorkspaceCreateOptions<TFeature, TMetadata, TResult>,
): HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult> {
  const snapshot = options.snapshot ?? (options.state ? { version: 1, state: cloneValue(options.state) } : undefined);
  const state = snapshot?.state;
  const savedAt = options.savedAt ?? new Date().toISOString();
  const exploration = state ? selectWorkspaceExplorationState(state) : EMPTY_STATE;

  return {
    kind: HONUA_SAVED_WORKSPACE_DOCUMENT_KIND,
    version: HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION,
    migration: {
      schemaVersion: HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION,
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

export function validateHonuaSavedWorkspaceDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
): HonuaSavedWorkspaceValidationResult<TFeature, TMetadata, TResult> {
  const errors: HonuaSavedWorkspaceValidationError[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [{ path: "$", message: "document must be an object" }] };
  }

  if (value.kind !== HONUA_SAVED_WORKSPACE_DOCUMENT_KIND) {
    errors.push({ path: "$.kind", message: `must be ${HONUA_SAVED_WORKSPACE_DOCUMENT_KIND}` });
  }
  if (value.version !== HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION) {
    errors.push({ path: "$.version", message: "unsupported saved workspace document version" });
  }
  if (!isRecord(value.migration)) {
    errors.push({ path: "$.migration", message: "migration metadata is required" });
  } else {
    if (value.migration.schemaVersion !== HONUA_SAVED_WORKSPACE_DOCUMENT_VERSION) {
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
    document: cloneValue(value) as unknown as HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult>,
  };
}

export function assertHonuaSavedWorkspaceDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
): HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult> {
  const validation = validateHonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult>(value);
  if (validation.ok) return validation.document;
  const message = validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
  throw new Error(`Invalid Honua saved workspace document: ${message}`);
}

export function hydrateHonuaSavedWorkspaceState<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
  options: HonuaSavedWorkspaceHydrateOptions<TResult> = {},
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  const document = reattachHonuaSavedWorkspaceArtifacts(
    assertHonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult>(value),
    options,
  );
  if (document.appSnapshot) {
    return applySavedWorkspaceJobsToState(cloneValue(document.appSnapshot.state), document.jobs);
  }
  return stateFromSavedWorkspaceDocument(document);
}

export function createHonuaAppWorkspaceFromSavedDocument<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: unknown,
  options: HonuaSavedWorkspaceHydrateOptions<TResult> = {},
): HonuaAppWorkspace<TFeature, TMetadata, TResult> {
  return createHonuaAppWorkspace({
    initialState: hydrateHonuaSavedWorkspaceState<TFeature, TMetadata, TResult>(value, options),
  });
}

export function reattachHonuaSavedWorkspaceArtifacts<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  value: HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult>,
  options: HonuaSavedWorkspaceHydrateOptions<TResult> = {},
): HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult> {
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

export function summarizeHonuaSavedWorkspaceForMcp(value: unknown): HonuaSavedWorkspaceMcpSummary {
  const document = assertHonuaSavedWorkspaceDocument(value);
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

export function bindHonuaAppWorkspaceSelector<TSelected, TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  workspace: HonuaAppWorkspace<TFeature, TMetadata, TResult>,
  selector: HonuaAppWorkspaceSelector<TSelected, TFeature, TMetadata, TResult>,
  listener: HonuaAppWorkspaceSelectorListener<TSelected>,
  options: { readonly equality?: HonuaAppWorkspaceEquality<TSelected>; readonly fireImmediately?: boolean } = {},
): Unsubscribe {
  if (options.fireImmediately) {
    const selected = selector(workspace.state);
    listener(selected, selected);
  }
  return workspace.subscribeSelector(selector, listener, options.equality);
}

export function selectHonuaAppWorkspaceMapModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppWorkspaceMapModel<TMetadata> {
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

export function selectHonuaAppWorkspaceTableModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppWorkspaceTableModel<TFeature, TMetadata> {
  return {
    query: selectLinkedViewQueryProjection(selectWorkspaceExplorationState(state), options),
    records: selectRealtimeRecords(state.realtime.features, options.sourceId),
    source: options.sourceId ? state.sources.entries[options.sourceId] : undefined,
  };
}

export function selectHonuaAppWorkspaceDetailModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceDetailModel<TFeature> {
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

export function selectHonuaAppWorkspaceFilterModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceFilterModel {
  const exploration = selectWorkspaceExplorationState(state);
  return {
    filters: exploration.filters,
    spatialFilter: exploration.spatialFilter,
    extent: exploration.extent,
  };
}

export function selectHonuaAppWorkspaceChartModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: LinkedViewQueryProjectionOptions = {},
): HonuaAppWorkspaceChartModel {
  const exploration = selectWorkspaceExplorationState(state);
  return {
    query: selectLinkedViewQueryProjection(exploration, options),
    grouping: exploration.grouping,
    aggregation: exploration.aggregation,
  };
}

export function selectHonuaAppWorkspaceJobModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceJobModel<TResult> {
  const entries = Object.values(state.jobs.entries);
  return {
    entries: state.jobs.entries,
    running: entries.filter((entry) => !isJobTerminal(entry.snapshot.status)),
    terminal: entries.filter((entry) => isJobTerminal(entry.snapshot.status)),
  };
}

export function selectHonuaAppWorkspaceRealtimeModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  options: { readonly sourceId?: SourceId } = {},
): HonuaAppWorkspaceRealtimeModel<TFeature> {
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

export function selectHonuaAppWorkspaceMetadataCacheModel<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceMetadataCacheModel<TMetadata> {
  const entries = Object.values(state.sources.entries);
  return {
    entries: state.sources.entries,
    loading: entries.filter((entry) => entry.status === "loading"),
    ready: entries.filter((entry) => entry.status === "ready"),
    stale: entries.filter((entry) => entry.status === "stale"),
    errors: entries.filter((entry) => entry.status === "error"),
  };
}

export function selectHonuaAppWorkspaceDrafts<TFeature = unknown, TMetadata = unknown, TResult = unknown>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceDraftState<TFeature, TMetadata, TResult> {
  return state.drafts;
}

function reduceAppWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  intent: HonuaAppWorkspaceIntent<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
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
        throw new Error(`HonuaAppWorkspace snapshot version ${String(intent.snapshot.version)} is not supported`);
      }
      return cloneValue(intent.snapshot.state);
  }
}

function withSlice<TFeature, TMetadata, TResult, K extends Exclude<HonuaAppWorkspaceSlice, "all">>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  slice: K,
  value: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>[K],
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  if (Object.is(state[slice], value)) return state;
  return { ...state, [slice]: value };
}

function changedWorkspaceSlices<TFeature, TMetadata, TResult>(
  previous: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  next: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
): ReadonlySet<HonuaAppWorkspaceSlice> {
  const changed = new Set<HonuaAppWorkspaceSlice>();
  if (previous.exploration !== next.exploration) changed.add("exploration");
  if (previous.sources !== next.sources) changed.add("sources");
  if (previous.realtime !== next.realtime) changed.add("realtime");
  if (previous.jobs !== next.jobs) changed.add("jobs");
  if (previous.layout !== next.layout) changed.add("layout");
  if (previous.drafts !== next.drafts) changed.add("drafts");
  return changed;
}

function mergeInitialState<TFeature, TMetadata, TResult>(
  initial: Partial<HonuaAppWorkspaceState<TFeature, TMetadata, TResult>> | undefined,
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
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
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
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
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult> | undefined,
): HonuaSavedWorkspaceSource[] {
  if (!state) return [];
  return Object.values(state.sources.entries).map((entry) => ({
    id: entry.sourceId,
    status: entry.status,
    metadata: entry.metadata,
  }));
}

function selectedFeaturesFromWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult> | undefined,
): HonuaSavedWorkspaceSelectedFeature<TFeature>[] {
  if (!state) return [];
  return selectWorkspaceExplorationState(state).selection.map((target) => {
    if (isSourceQualifiedSelectionTarget(target)) {
      return { sourceId: target.sourceId, id: target.id };
    }
    return { id: target };
  });
}

function jobsFromWorkspaceState<TFeature, TMetadata, TResult>(
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult> | undefined,
): HonuaSavedWorkspaceJob<TResult>[] {
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
  document: HonuaSavedWorkspaceDocument<TFeature, TMetadata, TResult>,
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  const sources: Record<string, HonuaSourceMetadataEntry<TMetadata>> = {};
  for (const source of document.sources) {
    sources[source.id] = {
      sourceId: source.id,
      status: source.status ?? "idle",
      metadata: source.metadata as TMetadata,
    };
  }

  const jobs: Record<string, HonuaAppWorkspaceJobEntry<TResult>> = {};
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
  state: HonuaAppWorkspaceState<TFeature, TMetadata, TResult>,
  jobs: ReadonlyArray<HonuaSavedWorkspaceJob<TResult>>,
): HonuaAppWorkspaceState<TFeature, TMetadata, TResult> {
  if (jobs.length === 0) return state;
  const entries: Record<string, HonuaAppWorkspaceJobEntry<TResult>> = { ...state.jobs.entries };
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

function validateArrayWithIds(value: unknown, path: string, errors: HonuaSavedWorkspaceValidationError[]): void {
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
