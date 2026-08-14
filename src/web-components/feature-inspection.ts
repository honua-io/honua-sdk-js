/**
 * Capability-aware feature inspection workflow.
 *
 * The controller in this module is the supported join between map hits,
 * server search, table rows, source-qualified selection, popup/details
 * presentation, attachments, relationships, and realtime freshness. It never
 * evaluates Arcade or inserts source HTML into the document.
 *
 * @module
 */

import { queryFilter } from "../contract/query-filter.js";
import type { AttachmentInfo, FeatureId, Source, SourceId } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaFieldInfo, HonuaTypedFeature } from "../core/types.js";
import { featureSelectionKey, sourceFeatureSelectionTarget } from "../exploration/selection.js";
import type { SourceQualifiedFeatureSelectionTarget } from "../exploration/types.js";
import type { HonuaApplicationContext, HonuaApplicationContextChangeEvent } from "./application-context.js";
import { renderCspSafeShadowHtml } from "./csp-styles.js";

const DEFAULT_PAGE_SIZE = 10;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_OVERLAPPING = 25;
const DEFAULT_MAX_FIELDS = 24;
const DEFAULT_MAX_RELATIONSHIPS = 8;
const DEFAULT_DETAILS_TTL_MS = 30_000;
const DEFAULT_SEARCH_TTL_MS = 5_000;
const DEFAULT_CACHE_ENTRIES = 100;

export type HonuaFeatureInspectionOrigin = "map" | "search" | "table" | "programmatic" | "refresh";
export type HonuaFeatureInspectionStatus = "idle" | "loading" | "ready" | "stale" | "deleted" | "unsupported" | "error";

export type HonuaFeatureInspectionDiagnosticCode =
  | "query-unsupported"
  | "search-unsupported"
  | "attachments-unsupported"
  | "attachments-unbounded"
  | "relationships-unsupported"
  | "relationships-unbounded"
  | "popup-arcade-unsupported"
  | "feature-not-found"
  | "query-failed"
  | "search-failed"
  | "attachments-failed"
  | "relationships-failed"
  | "unsafe-link"
  | "result-limit";

export interface HonuaFeatureInspectionDiagnostic {
  readonly code: HonuaFeatureInspectionDiagnosticCode;
  readonly message: string;
  readonly capability?: "query" | "attachments" | "queryRelated";
  readonly sourceId?: SourceId;
  readonly relationshipId?: number;
}

export interface HonuaFeatureInspectionLink {
  readonly label: string;
  readonly href: string;
  readonly external: boolean;
}

export interface HonuaFeatureInspectionField {
  readonly name: string;
  readonly label: string;
  readonly value: unknown;
  readonly text: string;
}

export interface HonuaFeatureInspectionFeature<T = Record<string, unknown>> {
  readonly target: SourceQualifiedFeatureSelectionTarget;
  readonly title: string;
  readonly description?: string;
  readonly fields: readonly HonuaFeatureInspectionField[];
  readonly links: readonly HonuaFeatureInspectionLink[];
  readonly attributes: T;
  readonly geometry?: Record<string, unknown> | null;
}

export interface HonuaFeatureInspectionPage<T> {
  readonly items: readonly T[];
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  /** True when the server returned more values than the configured memory budget retained. */
  readonly truncated: boolean;
}

export interface HonuaFeatureInspectionAttachment extends AttachmentInfo {
  readonly href?: string;
}

export interface HonuaFeatureInspectionRelationship<T = Record<string, unknown>> {
  readonly id: number;
  readonly label: string;
  readonly fields: readonly HonuaFieldInfo[];
  readonly page: HonuaFeatureInspectionPage<HonuaTypedFeature<T>>;
}

export interface HonuaFeatureInspectionSearchResult<T = Record<string, unknown>> {
  readonly id: string;
  readonly target: SourceQualifiedFeatureSelectionTarget;
  readonly title: string;
  readonly subtitle?: string;
  readonly feature: HonuaTypedFeature<T>;
}

export interface HonuaFeatureInspectionSearchState<T = Record<string, unknown>> {
  readonly status: "idle" | "loading" | "ready" | "unsupported" | "error";
  readonly query: string;
  readonly results: readonly HonuaFeatureInspectionSearchResult<T>[];
  readonly diagnostics: readonly HonuaFeatureInspectionDiagnostic[];
}

export interface HonuaFeatureInspectionSnapshot<T = Record<string, unknown>> {
  readonly status: HonuaFeatureInspectionStatus;
  readonly origin?: HonuaFeatureInspectionOrigin;
  readonly candidates: readonly HonuaFeatureInspectionCandidate<T>[];
  readonly activeIndex: number;
  readonly feature?: HonuaFeatureInspectionFeature<T>;
  readonly attachments?: HonuaFeatureInspectionPage<HonuaFeatureInspectionAttachment>;
  readonly relationships: readonly HonuaFeatureInspectionRelationship<T>[];
  readonly diagnostics: readonly HonuaFeatureInspectionDiagnostic[];
  readonly search: HonuaFeatureInspectionSearchState<T>;
  readonly staleReason?: string;
}

export interface HonuaFeatureInspectionCandidate<T = Record<string, unknown>> {
  readonly target: SourceQualifiedFeatureSelectionTarget;
  /** A complete, authoritative feature may avoid a second lookup. Map hits should normally omit it. */
  readonly feature?: HonuaTypedFeature<T>;
  readonly authoritative?: boolean;
}

export interface HonuaFeatureInspectionRelationshipDefinition {
  readonly id: number;
  readonly label?: string;
  readonly outFields?: readonly string[];
}

export interface HonuaFeatureInspectionExternalLinkDefinition {
  readonly label: string;
  readonly hrefField: string;
}

export interface HonuaFeatureInspectionPresentation {
  readonly titleField?: string;
  readonly description?: string;
  readonly fields?: readonly string[];
  readonly links?: readonly HonuaFeatureInspectionExternalLinkDefinition[];
  /** Declared only so the workflow can diagnose and refuse Arcade explicitly. */
  readonly arcadeExpressions?: readonly string[];
}

/** Every user-visible string owned by `<honua-feature-inspection>`. */
export interface HonuaFeatureInspectionMessages {
  readonly panelLabel?: string;
  readonly searchLabel?: string;
  readonly searchButtonLabel?: string;
  readonly searchResultsLabel?: string;
  readonly closeDetailsLabel?: string;
  readonly overlappingResultsLabel?: string;
  readonly previousResultLabel?: string;
  readonly nextResultLabel?: string;
  readonly resultPosition?: (index: number, total: number) => string;
  readonly refreshLabel?: string;
  readonly featureLinksLabel?: string;
  readonly attachmentsLabel?: string;
  readonly attachmentLabel?: (id: FeatureId) => string;
  readonly attachmentSize?: (bytes: number) => string;
  readonly attachmentPagesLabel?: string;
  readonly previousAttachmentsLabel?: string;
  readonly nextAttachmentsLabel?: string;
  readonly relationshipPagesLabel?: (relationship: string) => string;
  readonly previousRelatedLabel?: string;
  readonly nextRelatedLabel?: string;
  readonly diagnosticsLabel?: string;
  readonly diagnostic?: (diagnostic: HonuaFeatureInspectionDiagnostic) => string;
  readonly range?: (offset: number, count: number, total: number) => string;
  readonly disconnectedStatus?: string;
  readonly searchingStatus?: string;
  readonly loadingStatus?: string;
  readonly deletedStatus?: string;
  readonly staleStatus?: string;
  readonly showingStatus?: (title: string) => string;
  readonly searchResultsStatus?: (count: number) => string;
  readonly emptyStatus?: string;
}

export interface HonuaFeatureInspectionBudgets {
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxOverlappingResults?: number;
  readonly maxFields?: number;
  readonly maxRelationships?: number;
  readonly maxSearchSources?: number;
  readonly cacheEntries?: number;
}

export interface HonuaFeatureInspectionSelectionAdapter {
  setSelection(
    targets: readonly SourceQualifiedFeatureSelectionTarget[],
    options: { readonly origin: HonuaFeatureInspectionOrigin },
  ): void;
}

/** A caller-owned collection window whose upstream request honored `offset` and `limit`. */
export interface HonuaFeatureInspectionBoundedPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly truncated?: boolean;
}

export interface HonuaFeatureInspectionAttachmentPageRequest<T = Record<string, unknown>> {
  readonly source: Source<T>;
  readonly target: SourceQualifiedFeatureSelectionTarget;
  readonly offset: number;
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface HonuaFeatureInspectionRelationshipPageRequest<T = Record<string, unknown>>
  extends HonuaFeatureInspectionAttachmentPageRequest<T> {
  readonly relationship: HonuaFeatureInspectionRelationshipDefinition;
}

export interface HonuaFeatureInspectionRelationshipPageResult<T = Record<string, unknown>>
  extends HonuaFeatureInspectionBoundedPage<HonuaTypedFeature<T>> {
  readonly fields?: readonly HonuaFieldInfo[];
}

export interface CreateHonuaFeatureInspectionOptions<T = Record<string, unknown>> {
  readonly resolveSource: (sourceId: SourceId) => Source<T> | undefined;
  readonly sourceIds?: readonly SourceId[];
  readonly presentation?:
    | HonuaFeatureInspectionPresentation
    | ((source: Source<T>) => HonuaFeatureInspectionPresentation | undefined);
  readonly relationships?:
    | readonly HonuaFeatureInspectionRelationshipDefinition[]
    | ((source: Source<T>) => readonly HonuaFeatureInspectionRelationshipDefinition[]);
  readonly searchFields?: readonly string[] | ((source: Source<T>) => readonly string[]);
  readonly selection?: HonuaFeatureInspectionSelectionAdapter;
  /**
   * Executes a provably bounded attachment request. The canonical AttachmentApi
   * has no pagination parameters, so inspection fails this subfeature closed
   * unless the host supplies a protocol-aware bounded loader.
   */
  readonly loadAttachmentPage?: (
    request: HonuaFeatureInspectionAttachmentPageRequest<T>,
  ) => Promise<HonuaFeatureInspectionBoundedPage<AttachmentInfo>>;
  /**
   * Executes a provably bounded related-record request. RelatedQuery currently
   * has no pagination parameters, so the host must supply this adapter.
   */
  readonly loadRelationshipPage?: (
    request: HonuaFeatureInspectionRelationshipPageRequest<T>,
  ) => Promise<HonuaFeatureInspectionRelationshipPageResult<T>>;
  readonly attachmentHref?: (
    attachment: AttachmentInfo,
    target: SourceQualifiedFeatureSelectionTarget,
  ) => string | undefined;
  readonly baseHref?: string;
  readonly allowedLinkOrigins?: readonly string[];
  readonly authScope?: () => string;
  readonly version?: (source: Source<T>) => string | undefined;
  readonly budgets?: HonuaFeatureInspectionBudgets;
  readonly detailsTtlMs?: number;
  readonly searchTtlMs?: number;
  readonly now?: () => number;
}

export interface CreateHonuaFeatureInspectionFromApplicationContextOptions<T = Record<string, unknown>>
  extends Omit<
    CreateHonuaFeatureInspectionOptions<T>,
    "resolveSource" | "sourceIds" | "selection" | "authScope" | "version"
  > {
  /** Resolve additional sources when the context's primary binding is not enough. */
  readonly resolveSource?: (sourceId: SourceId) => Source<T> | undefined;
  readonly sourceIds?: readonly SourceId[];
}

export interface HonuaFeatureInspectionRealtimeUpdate<T = Record<string, unknown>> {
  readonly kind: "upsert" | "delete";
  readonly target: SourceQualifiedFeatureSelectionTarget;
  readonly attributes?: Partial<T>;
  readonly geometry?: Record<string, unknown> | null;
  /** A full record may replace the open feature; a patch must name every changed field. */
  readonly completeness?: "full" | "patch";
  readonly changedFields?: readonly string[];
}

export interface HonuaFeatureInspectionController<T = Record<string, unknown>> {
  snapshot(): HonuaFeatureInspectionSnapshot<T>;
  subscribe(listener: (snapshot: HonuaFeatureInspectionSnapshot<T>) => void): { remove(): void };
  open(
    candidates: HonuaFeatureInspectionCandidate<T> | readonly HonuaFeatureInspectionCandidate<T>[],
    options?: {
      readonly origin?: HonuaFeatureInspectionOrigin;
      readonly activeIndex?: number;
      readonly force?: boolean;
    },
  ): Promise<HonuaFeatureInspectionSnapshot<T>>;
  openFromMapClick(
    candidates: readonly HonuaFeatureInspectionCandidate<T>[],
  ): Promise<HonuaFeatureInspectionSnapshot<T>>;
  openFromTableRow(candidate: HonuaFeatureInspectionCandidate<T>): Promise<HonuaFeatureInspectionSnapshot<T>>;
  openSearchResult(index: number): Promise<HonuaFeatureInspectionSnapshot<T>>;
  search(
    query: string,
    options?: { readonly sourceIds?: readonly SourceId[] },
  ): Promise<HonuaFeatureInspectionSearchState<T>>;
  navigate(index: number): Promise<HonuaFeatureInspectionSnapshot<T>>;
  next(): Promise<HonuaFeatureInspectionSnapshot<T>>;
  previous(): Promise<HonuaFeatureInspectionSnapshot<T>>;
  setAttachmentPage(page: number): HonuaFeatureInspectionSnapshot<T>;
  setRelationshipPage(relationshipId: number, page: number): HonuaFeatureInspectionSnapshot<T>;
  refresh(): Promise<HonuaFeatureInspectionSnapshot<T>>;
  applyRealtime(update: HonuaFeatureInspectionRealtimeUpdate<T>): HonuaFeatureInspectionSnapshot<T>;
  close(): void;
  dispose(): void;
}

interface CachedDetails<T> {
  readonly feature: HonuaFeatureInspectionFeature<T>;
  readonly attachments: readonly HonuaFeatureInspectionAttachment[];
  readonly attachmentTotal: number;
  readonly attachmentTruncated: boolean;
  readonly relationships: readonly CachedRelationship<T>[];
  readonly diagnostics: readonly HonuaFeatureInspectionDiagnostic[];
}

interface CachedRelationship<T = Record<string, unknown>> {
  readonly id: number;
  readonly label: string;
  readonly fields: readonly HonuaFieldInfo[];
  readonly features: readonly HonuaTypedFeature<T>[];
  readonly total: number;
  readonly truncated: boolean;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

class BoundedTtlCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();

  public constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  public get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: T, ttlMs: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.now() + Math.max(0, ttlMs) });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  public clear(): void {
    this.#entries.clear();
  }
}

/** Create a bounded, cancellable inspection workflow. */
export function createHonuaFeatureInspection<T = Record<string, unknown>>(
  options: CreateHonuaFeatureInspectionOptions<T>,
): HonuaFeatureInspectionController<T> {
  return new FeatureInspectionController(options);
}

/**
 * Bind inspection to the supported application shell without introducing a
 * second selection identity or authorization cache scope.
 */
export function createHonuaFeatureInspectionFromApplicationContext<T = Record<string, unknown>>(
  context: HonuaApplicationContext<T>,
  options: CreateHonuaFeatureInspectionFromApplicationContextOptions<T> = {},
): HonuaFeatureInspectionController<T> {
  const boundSource = (): Source<T> | undefined => context.snapshot.binding.source;
  const sourceIdentity = (): SourceId | undefined =>
    context.snapshot.binding.sourceIdentity ?? context.snapshot.binding.source?.descriptor.id;
  return createHonuaFeatureInspection({
    ...options,
    resolveSource: (sourceId) => {
      const source = boundSource();
      if (source && (sourceIdentity() === sourceId || source.descriptor.id === sourceId)) return source;
      return options.resolveSource?.(sourceId);
    },
    sourceIds: options.sourceIds ?? (sourceIdentity() ? [sourceIdentity() as SourceId] : []),
    selection: {
      setSelection(targets) {
        context.update({ selection: targets });
      },
    },
    authScope: () => {
      const authorization = context.snapshot.authorization;
      return [authorization.status, authorization.principalId ?? "", ...authorization.scopes].join(":");
    },
    version: () =>
      [
        context.snapshot.binding.sourceIdentity ?? "",
        context.snapshot.binding.planIdentity ?? "",
        context.snapshot.invalidationGeneration,
        context.snapshot.freshness.generation,
      ].join(":"),
  });
}

class FeatureInspectionController<T> implements HonuaFeatureInspectionController<T> {
  readonly #listeners = new Set<(snapshot: HonuaFeatureInspectionSnapshot<T>) => void>();
  readonly #now: () => number;
  readonly #detailsCache: BoundedTtlCache<CachedDetails<T>>;
  readonly #searchCache: BoundedTtlCache<readonly HonuaFeatureInspectionSearchResult<T>[]>;
  readonly #pageSize: number;
  readonly #maxStoredItems: number;
  readonly #maxOverlapping: number;
  readonly #maxFields: number;
  readonly #maxRelationships: number;
  readonly #maxSearchSources: number;
  readonly #detailsTtlMs: number;
  readonly #searchTtlMs: number;
  #detailsAbort: AbortController | undefined;
  #searchAbort: AbortController | undefined;
  #generation = 0;
  #disposed = false;
  #cachedDetails: CachedDetails<T> | undefined;
  #attachmentPage = 0;
  readonly #relationshipPages = new Map<number, number>();
  #state: HonuaFeatureInspectionSnapshot<T> = {
    status: "idle",
    candidates: [],
    activeIndex: 0,
    relationships: [],
    diagnostics: [],
    search: { status: "idle", query: "", results: [], diagnostics: [] },
  };

  public constructor(private readonly options: CreateHonuaFeatureInspectionOptions<T>) {
    this.#now = options.now ?? Date.now;
    const budgets = options.budgets ?? {};
    this.#pageSize = positiveInteger(budgets.pageSize, DEFAULT_PAGE_SIZE);
    const maxPages = positiveInteger(budgets.maxPages, DEFAULT_MAX_PAGES);
    this.#maxStoredItems = this.#pageSize * maxPages;
    this.#maxOverlapping = positiveInteger(budgets.maxOverlappingResults, DEFAULT_MAX_OVERLAPPING);
    this.#maxFields = positiveInteger(budgets.maxFields, DEFAULT_MAX_FIELDS);
    this.#maxRelationships = positiveInteger(budgets.maxRelationships, DEFAULT_MAX_RELATIONSHIPS);
    this.#maxSearchSources = positiveInteger(budgets.maxSearchSources, 10);
    const cacheEntries = positiveInteger(budgets.cacheEntries, DEFAULT_CACHE_ENTRIES);
    this.#detailsCache = new BoundedTtlCache(cacheEntries, this.#now);
    this.#searchCache = new BoundedTtlCache(cacheEntries, this.#now);
    this.#detailsTtlMs = nonNegativeNumber(options.detailsTtlMs, DEFAULT_DETAILS_TTL_MS);
    this.#searchTtlMs = nonNegativeNumber(options.searchTtlMs, DEFAULT_SEARCH_TTL_MS);
  }

  public snapshot(): HonuaFeatureInspectionSnapshot<T> {
    return this.#state;
  }

  public subscribe(listener: (snapshot: HonuaFeatureInspectionSnapshot<T>) => void): { remove(): void } {
    this.#assertLive();
    this.#listeners.add(listener);
    listener(this.#state);
    return { remove: () => this.#listeners.delete(listener) };
  }

  public openFromMapClick(
    candidates: readonly HonuaFeatureInspectionCandidate<T>[],
  ): Promise<HonuaFeatureInspectionSnapshot<T>> {
    return this.open(candidates, { origin: "map" });
  }

  public openFromTableRow(candidate: HonuaFeatureInspectionCandidate<T>): Promise<HonuaFeatureInspectionSnapshot<T>> {
    return this.open(candidate, { origin: "table" });
  }

  public openSearchResult(index: number): Promise<HonuaFeatureInspectionSnapshot<T>> {
    const result = this.#state.search.results[index];
    if (!result) return Promise.resolve(this.#state);
    return this.open({ target: result.target, feature: result.feature, authoritative: true }, { origin: "search" });
  }

  public async open(
    input: HonuaFeatureInspectionCandidate<T> | readonly HonuaFeatureInspectionCandidate<T>[],
    options: {
      readonly origin?: HonuaFeatureInspectionOrigin;
      readonly activeIndex?: number;
      readonly force?: boolean;
    } = {},
  ): Promise<HonuaFeatureInspectionSnapshot<T>> {
    this.#assertLive();
    const supplied = (Array.isArray(input) ? input : [input]) as readonly HonuaFeatureInspectionCandidate<T>[];
    const deduped = dedupeCandidates<T>(supplied).slice(0, this.#maxOverlapping);
    if (deduped.length === 0) {
      this.close();
      return this.#state;
    }
    const diagnostics: HonuaFeatureInspectionDiagnostic[] = [];
    if (supplied.length > deduped.length) {
      diagnostics.push({
        code: "result-limit",
        message: `Inspection is limited to ${this.#maxOverlapping} overlapping results. Refine the map hit or search to inspect more.`,
      });
    }
    const activeIndex = clamp(options.activeIndex ?? 0, 0, deduped.length - 1);
    const candidate = deduped[activeIndex];
    if (!candidate) return this.#state;
    const origin = options.origin ?? "programmatic";

    this.#detailsAbort?.abort();
    this.#detailsAbort = new AbortController();
    this.#generation += 1;
    const generation = this.#generation;
    this.#cachedDetails = undefined;
    this.#attachmentPage = 0;
    this.#relationshipPages.clear();
    this.#state = {
      ...this.#state,
      status: "loading",
      origin,
      candidates: deduped,
      activeIndex,
      feature: undefined,
      attachments: undefined,
      relationships: [],
      diagnostics,
      staleReason: undefined,
    };
    this.options.selection?.setSelection([candidate.target], { origin });
    this.#notify();

    const source = this.options.resolveSource(candidate.target.sourceId);
    if (!source || !source.capabilities.has("query")) {
      if (generation !== this.#generation) return this.#state;
      const diagnostic = capabilityDiagnostic("query", candidate.target.sourceId, source?.descriptor.protocol);
      this.#state = { ...this.#state, status: "unsupported", diagnostics: [...diagnostics, diagnostic] };
      this.#notify();
      return this.#state;
    }

    const presentation = this.#presentation(source);
    const fields = requiredFields(source, presentation, this.#maxFields);
    const key = this.#detailsKey(source, candidate.target, fields);
    const cached = options.force ? undefined : this.#detailsCache.get(key);
    try {
      const details =
        cached ??
        (await this.#loadDetails(source, candidate, presentation, fields, this.#detailsAbort.signal, diagnostics));
      if (generation !== this.#generation || this.#detailsAbort.signal.aborted) return this.#state;
      if (!cached) this.#detailsCache.set(key, details, this.#detailsTtlMs);
      this.#cachedDetails = details;
      this.#state = this.#projectDetails("ready", details);
      this.#notify();
      return this.#state;
    } catch (error) {
      if (generation !== this.#generation || isAbortError(error)) return this.#state;
      const diagnostic = diagnosticForError(error, "query-failed", candidate.target.sourceId);
      this.#state = {
        ...this.#state,
        status: error instanceof HonuaCapabilityNotSupportedError ? "unsupported" : "error",
        diagnostics: [...diagnostics, diagnostic],
      };
      this.#notify();
      return this.#state;
    }
  }

  public async search(
    query: string,
    options: { readonly sourceIds?: readonly SourceId[] } = {},
  ): Promise<HonuaFeatureInspectionSearchState<T>> {
    this.#assertLive();
    const normalized = query.trim();
    this.#searchAbort?.abort();
    if (!normalized) {
      this.#setSearch({ status: "idle", query: "", results: [], diagnostics: [] });
      return this.#state.search;
    }
    const controller = new AbortController();
    this.#searchAbort = controller;
    const sourceIds = [...new Set(options.sourceIds ?? this.options.sourceIds ?? [])].slice(0, this.#maxSearchSources);
    this.#setSearch({ status: "loading", query: normalized, results: [], diagnostics: [] });
    const diagnostics: HonuaFeatureInspectionDiagnostic[] = [];
    const results: HonuaFeatureInspectionSearchResult<T>[] = [];

    await Promise.all(
      sourceIds.map(async (sourceId) => {
        const source = this.options.resolveSource(sourceId);
        if (!source || !source.capabilities.has("query")) {
          diagnostics.push({
            code: "search-unsupported",
            capability: "query",
            sourceId,
            message: `Server search is unavailable for source "${sourceId}" because it does not advertise query.`,
          });
          return;
        }
        const fields = this.#searchFields(source);
        if (fields.length === 0) {
          diagnostics.push({
            code: "search-unsupported",
            capability: "query",
            sourceId,
            message: `Server search is unavailable for source "${sourceId}" because it has no searchable fields.`,
          });
          return;
        }
        const cacheKey = this.#searchKey(source, normalized, fields);
        const cached = this.#searchCache.get(cacheKey);
        if (cached) {
          results.push(...cached);
          return;
        }
        try {
          const pk = primaryKey(source);
          const outFields = uniqueStrings([pk, ...fields]).slice(0, this.#maxFields);
          const result = await source.query({
            filter: queryFilter.or(...fields.map((field) => queryFilter.like(field, `%${normalized}%`))),
            outFields,
            returnGeometry: false,
            pagination: { limit: this.#maxStoredItems },
            signal: controller.signal,
          });
          const sourceResults = result.features.slice(0, this.#maxStoredItems).map((feature, index) => {
            const id = featureId(feature.attributes, pk, index);
            const target = sourceFeatureSelectionTarget(sourceId, id);
            const presentation = this.#presentation(source);
            return {
              id: featureSelectionKey(target),
              target,
              title: featureTitle(feature.attributes, presentation.titleField, id),
              subtitle: source.descriptor.id,
              feature,
            } satisfies HonuaFeatureInspectionSearchResult<T>;
          });
          this.#searchCache.set(cacheKey, sourceResults, this.#searchTtlMs);
          results.push(...sourceResults);
          if (result.exceededTransferLimit || result.features.length > this.#maxStoredItems) {
            diagnostics.push({
              code: "result-limit",
              sourceId,
              message: `Search results for source "${sourceId}" were limited to ${this.#maxStoredItems}. Refine the search text for more specific results.`,
            });
          }
        } catch (error) {
          if (isAbortError(error)) return;
          diagnostics.push(diagnosticForError(error, "search-failed", sourceId));
        }
      }),
    );
    if (controller.signal.aborted || this.#searchAbort !== controller) return this.#state.search;
    const bounded = dedupeSearchResults(results).slice(0, this.#maxStoredItems);
    const status =
      bounded.length > 0 || diagnostics.length === 0
        ? "ready"
        : diagnostics.every(isUnsupportedDiagnostic)
          ? "unsupported"
          : "error";
    this.#setSearch({ status, query: normalized, results: bounded, diagnostics });
    return this.#state.search;
  }

  public navigate(index: number): Promise<HonuaFeatureInspectionSnapshot<T>> {
    if (this.#state.candidates.length === 0) return Promise.resolve(this.#state);
    return this.open(this.#state.candidates, {
      origin: this.#state.origin ?? "programmatic",
      activeIndex: clamp(index, 0, this.#state.candidates.length - 1),
    });
  }

  public next(): Promise<HonuaFeatureInspectionSnapshot<T>> {
    return this.navigate(this.#state.activeIndex + 1);
  }

  public previous(): Promise<HonuaFeatureInspectionSnapshot<T>> {
    return this.navigate(this.#state.activeIndex - 1);
  }

  public setAttachmentPage(page: number): HonuaFeatureInspectionSnapshot<T> {
    if (!this.#cachedDetails) return this.#state;
    this.#attachmentPage = boundedPage(page, this.#cachedDetails.attachmentTotal, this.#pageSize);
    this.#state = this.#projectDetails(this.#state.status, this.#cachedDetails);
    this.#notify();
    return this.#state;
  }

  public setRelationshipPage(relationshipId: number, page: number): HonuaFeatureInspectionSnapshot<T> {
    if (!this.#cachedDetails) return this.#state;
    const relationship = this.#cachedDetails.relationships.find((candidate) => candidate.id === relationshipId);
    if (!relationship) return this.#state;
    this.#relationshipPages.set(relationshipId, boundedPage(page, relationship.total, this.#pageSize));
    this.#state = this.#projectDetails(this.#state.status, this.#cachedDetails);
    this.#notify();
    return this.#state;
  }

  public refresh(): Promise<HonuaFeatureInspectionSnapshot<T>> {
    if (this.#state.candidates.length === 0) return Promise.resolve(this.#state);
    return this.open(this.#state.candidates, {
      activeIndex: this.#state.activeIndex,
      origin: "refresh",
      force: true,
    });
  }

  public applyRealtime(update: HonuaFeatureInspectionRealtimeUpdate<T>): HonuaFeatureInspectionSnapshot<T> {
    const current = this.#state.feature;
    if (!current || featureSelectionKey(current.target) !== featureSelectionKey(update.target)) return this.#state;
    if (update.kind === "delete") {
      this.#detailsAbort?.abort();
      this.#cachedDetails = undefined;
      this.#state = {
        ...this.#state,
        status: "deleted",
        feature: undefined,
        attachments: undefined,
        relationships: [],
        staleReason: "The selected feature was deleted by a realtime update.",
      };
      this.#notify();
      return this.#state;
    }
    const changedFields = update.changedFields ?? [];
    const loadedFields = new Set(current.fields.map((field) => field.name));
    const safePatch =
      update.completeness === "full" ||
      (update.completeness === "patch" &&
        changedFields.length > 0 &&
        changedFields.every((field) => loadedFields.has(field)));
    if (!safePatch || !update.attributes) {
      this.#state = {
        ...this.#state,
        status: "stale",
        staleReason:
          "A realtime update changed fields that were not safely patchable. Refresh to load the authoritative feature.",
      };
      this.#notify();
      return this.#state;
    }
    const attributes =
      update.completeness === "full"
        ? (update.attributes as T)
        : ({ ...(current.attributes as Record<string, unknown>), ...update.attributes } as T);
    const source = this.options.resolveSource(current.target.sourceId);
    if (!source) return this.#state;
    const feature = projectFeature(
      current.target,
      { attributes, ...(update.geometry !== undefined ? { geometry: update.geometry } : {}) },
      source,
      this.#presentation(source),
      this.options,
      [],
      current.fields.map((field) => field.name),
    );
    this.#state = { ...this.#state, status: "ready", feature, staleReason: undefined };
    this.#notify();
    return this.#state;
  }

  public close(): void {
    if (this.#disposed) return;
    this.#detailsAbort?.abort();
    this.#detailsAbort = undefined;
    this.#generation += 1;
    this.#cachedDetails = undefined;
    this.#state = {
      ...this.#state,
      status: "idle",
      origin: undefined,
      candidates: [],
      activeIndex: 0,
      feature: undefined,
      attachments: undefined,
      relationships: [],
      diagnostics: [],
      staleReason: undefined,
    };
    this.options.selection?.setSelection([], { origin: "programmatic" });
    this.#notify();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detailsAbort?.abort();
    this.#searchAbort?.abort();
    this.#detailsCache.clear();
    this.#searchCache.clear();
    this.#listeners.clear();
  }

  async #loadDetails(
    source: Source<T>,
    candidate: HonuaFeatureInspectionCandidate<T>,
    presentation: HonuaFeatureInspectionPresentation,
    fields: readonly string[],
    signal: AbortSignal,
    initialDiagnostics: readonly HonuaFeatureInspectionDiagnostic[],
  ): Promise<CachedDetails<T>> {
    const pk = primaryKey(source);
    const feature =
      candidate.authoritative && candidate.feature
        ? candidate.feature
        : (
            await source.query({
              filter: queryFilter.eq(pk, scalarFeatureId(candidate.target.id)),
              outFields: fields,
              returnGeometry: false,
              pagination: { limit: 1 },
              signal,
            })
          ).features[0];
    if (!feature) {
      throw new FeatureNotFoundError(candidate.target.sourceId, candidate.target.id);
    }
    const diagnostics = [...initialDiagnostics];
    if ((presentation.arcadeExpressions?.length ?? 0) > 0) {
      diagnostics.push({
        code: "popup-arcade-unsupported",
        sourceId: candidate.target.sourceId,
        message:
          "Arcade popup expressions are not executed. Replace them with server-computed fields or application-owned presentation logic.",
      });
    }
    const projected = projectFeature(
      candidate.target,
      feature,
      source,
      presentation,
      this.options,
      diagnostics,
      fields,
    );
    const [attachmentResult, relationshipResult] = await Promise.all([
      this.#loadAttachments(source, candidate.target, signal),
      this.#loadRelationships(source, candidate.target, signal),
    ]);
    diagnostics.push(...attachmentResult.diagnostics, ...relationshipResult.diagnostics);
    return {
      feature: projected,
      attachments: attachmentResult.items,
      attachmentTotal: attachmentResult.total,
      attachmentTruncated: attachmentResult.truncated,
      relationships: relationshipResult.items,
      diagnostics,
    };
  }

  async #loadAttachments(
    source: Source<T>,
    target: SourceQualifiedFeatureSelectionTarget,
    signal: AbortSignal,
  ): Promise<{
    items: readonly HonuaFeatureInspectionAttachment[];
    total: number;
    truncated: boolean;
    diagnostics: readonly HonuaFeatureInspectionDiagnostic[];
  }> {
    if (!source.capabilities.has("attachments")) {
      return {
        items: [],
        total: 0,
        truncated: false,
        diagnostics: [capabilityDiagnostic("attachments", target.sourceId, source.descriptor.protocol)],
      };
    }
    if (!this.options.loadAttachmentPage) {
      return {
        items: [],
        total: 0,
        truncated: false,
        diagnostics: [
          {
            code: "attachments-unbounded",
            capability: "attachments",
            sourceId: target.sourceId,
            message:
              "Attachments were not requested because the canonical source API cannot bound the response. Configure loadAttachmentPage with a protocol-aware offset/limit implementation.",
          },
        ],
      };
    }
    try {
      const result = await this.options.loadAttachmentPage({
        source,
        target,
        offset: 0,
        limit: this.#maxStoredItems,
        signal,
      });
      signal.throwIfAborted();
      const bounded = result.items.slice(0, this.#maxStoredItems);
      const items = bounded.map((attachment) => {
        const rawHref = this.options.attachmentHref?.(attachment, target);
        const href = rawHref
          ? sanitizeHonuaInspectionHref(rawHref, {
              baseHref: this.options.baseHref,
              allowedOrigins: this.options.allowedLinkOrigins,
            })
          : undefined;
        return { ...attachment, ...(href ? { href } : {}) };
      });
      return {
        items,
        total: Math.max(items.length, result.total),
        truncated: result.truncated === true || result.total > items.length || result.items.length > items.length,
        diagnostics:
          result.items.length > this.#maxStoredItems
            ? [
                {
                  code: "result-limit",
                  sourceId: target.sourceId,
                  message: `The attachment loader returned more than its ${this.#maxStoredItems}-item limit. Extra entries were discarded.`,
                },
              ]
            : [],
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        items: [],
        total: 0,
        truncated: false,
        diagnostics: [diagnosticForError(error, "attachments-failed", target.sourceId)],
      };
    }
  }

  async #loadRelationships(
    source: Source<T>,
    target: SourceQualifiedFeatureSelectionTarget,
    signal: AbortSignal,
  ): Promise<{
    items: readonly CachedRelationship<T>[];
    diagnostics: readonly HonuaFeatureInspectionDiagnostic[];
  }> {
    const definitions = this.#relationships(source).slice(0, this.#maxRelationships);
    if (definitions.length === 0) return { items: [], diagnostics: [] };
    if (!source.capabilities.has("queryRelated")) {
      return {
        items: [],
        diagnostics: [capabilityDiagnostic("queryRelated", target.sourceId, source.descriptor.protocol)],
      };
    }
    if (!this.options.loadRelationshipPage) {
      return {
        items: [],
        diagnostics: [
          {
            code: "relationships-unbounded",
            capability: "queryRelated",
            sourceId: target.sourceId,
            message:
              "Related records were not requested because the canonical source API cannot bound the response. Configure loadRelationshipPage with a protocol-aware offset/limit implementation.",
          },
        ],
      };
    }
    const loadRelationshipPage = this.options.loadRelationshipPage;
    const diagnostics: HonuaFeatureInspectionDiagnostic[] = [];
    const items = await Promise.all(
      definitions.map(async (definition): Promise<CachedRelationship<T> | undefined> => {
        try {
          const result = await loadRelationshipPage({
            source,
            target,
            relationship: {
              ...definition,
              ...(definition.outFields ? { outFields: definition.outFields.slice(0, this.#maxFields) } : {}),
            },
            offset: 0,
            limit: this.#maxStoredItems,
            signal,
          });
          signal.throwIfAborted();
          const features = result.items.slice(0, this.#maxStoredItems);
          const total = Math.max(features.length, result.total);
          if (result.items.length > this.#maxStoredItems) {
            diagnostics.push({
              code: "result-limit",
              sourceId: target.sourceId,
              relationshipId: definition.id,
              message: `The related-record loader returned more than its ${this.#maxStoredItems}-item limit. Extra entries were discarded.`,
            });
          }
          return {
            id: definition.id,
            label: definition.label ?? `Related records ${definition.id}`,
            fields: result.fields ?? [],
            features,
            total,
            truncated: result.truncated === true || total > features.length || result.items.length > features.length,
          };
        } catch (error) {
          if (isAbortError(error)) throw error;
          diagnostics.push({
            ...diagnosticForError(error, "relationships-failed", target.sourceId),
            relationshipId: definition.id,
          });
          return undefined;
        }
      }),
    );
    return { items: items.filter((item): item is CachedRelationship<T> => item !== undefined), diagnostics };
  }

  #projectDetails(status: HonuaFeatureInspectionStatus, details: CachedDetails<T>): HonuaFeatureInspectionSnapshot<T> {
    return {
      ...this.#state,
      status,
      feature: details.feature,
      attachments: pageOf(
        details.attachments,
        details.attachmentTotal,
        this.#attachmentPage,
        this.#pageSize,
        details.attachmentTruncated,
      ),
      relationships: details.relationships.map((relationship) => ({
        id: relationship.id,
        label: relationship.label,
        fields: relationship.fields,
        page: pageOf(
          relationship.features,
          relationship.total,
          this.#relationshipPages.get(relationship.id) ?? 0,
          this.#pageSize,
          relationship.truncated,
        ),
      })),
      diagnostics: details.diagnostics,
    };
  }

  #presentation(source: Source<T>): HonuaFeatureInspectionPresentation {
    const configured = this.options.presentation;
    return (typeof configured === "function" ? configured(source) : configured) ?? {};
  }

  #relationships(source: Source<T>): readonly HonuaFeatureInspectionRelationshipDefinition[] {
    const configured = this.options.relationships;
    return (typeof configured === "function" ? configured(source) : configured) ?? [];
  }

  #searchFields(source: Source<T>): readonly string[] {
    const configured = this.options.searchFields;
    const fields = typeof configured === "function" ? configured(source) : configured;
    if (fields) return uniqueStrings(fields).slice(0, this.#maxFields);
    return searchableFields(source.descriptor.schema?.fields ?? []).slice(0, this.#maxFields);
  }

  #detailsKey(source: Source<T>, target: SourceQualifiedFeatureSelectionTarget, fields: readonly string[]): string {
    const relationships = this.#relationships(source)
      .slice(0, this.#maxRelationships)
      .map((relationship) => `${relationship.id}:${relationship.outFields?.join(",") ?? "*"}`)
      .join("|");
    return [
      featureSelectionKey(target),
      fields.join(","),
      relationships,
      this.options.authScope?.() ?? "",
      this.options.version?.(source) ?? "",
    ].join("\u0001");
  }

  #searchKey(source: Source<T>, query: string, fields: readonly string[]): string {
    return [
      source.descriptor.id,
      query.toLocaleLowerCase(),
      fields.join(","),
      this.options.authScope?.() ?? "",
      this.options.version?.(source) ?? "",
    ].join("\u0001");
  }

  #setSearch(search: HonuaFeatureInspectionSearchState<T>): void {
    this.#state = { ...this.#state, search };
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("HonuaFeatureInspectionController has been disposed");
  }
}

class FeatureNotFoundError extends Error {
  public constructor(
    public readonly sourceId: SourceId,
    public readonly featureId: FeatureId,
  ) {
    super(`Feature ${String(featureId)} was not found in source ${sourceId}`);
    this.name = "FeatureNotFoundError";
  }
}

function projectFeature<T>(
  target: SourceQualifiedFeatureSelectionTarget,
  feature: HonuaTypedFeature<T>,
  source: Source<T>,
  presentation: HonuaFeatureInspectionPresentation,
  options: CreateHonuaFeatureInspectionOptions<T>,
  diagnostics: HonuaFeatureInspectionDiagnostic[],
  requestedFields = requiredFields(source, presentation, DEFAULT_MAX_FIELDS),
): HonuaFeatureInspectionFeature<T> {
  const attributes = feature.attributes as Record<string, unknown>;
  const schemaFields = new Map((source.descriptor.schema?.fields ?? []).map((field) => [field.name, field]));
  const names = requestedFields.filter((name) => name in attributes);
  const fields = names.map((name) => ({
    name,
    label: schemaFields.get(name)?.alias ?? name,
    value: attributes[name],
    text: formatHonuaInspectionValue(attributes[name]),
  }));
  const links: HonuaFeatureInspectionLink[] = [];
  for (const link of presentation.links ?? []) {
    const raw = attributes[link.hrefField];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const href = sanitizeHonuaInspectionHref(raw, {
      baseHref: options.baseHref,
      allowedOrigins: options.allowedLinkOrigins,
    });
    if (!href) {
      diagnostics.push({
        code: "unsafe-link",
        sourceId: target.sourceId,
        message: `The external link in field "${link.hrefField}" was withheld because its URL is unsafe or outside the configured origins.`,
      });
      continue;
    }
    const baseOrigin = safeOrigin(options.baseHref);
    links.push({ label: link.label, href, external: safeOrigin(href) !== baseOrigin });
  }
  const description = presentation.description
    ? sanitizeHonuaInspectionRichText(interpolateInspectionTemplate(presentation.description, attributes))
    : undefined;
  return {
    target,
    title: featureTitle(feature.attributes, presentation.titleField, target.id),
    ...(description ? { description } : {}),
    fields,
    links,
    attributes: feature.attributes,
    ...(feature.geometry !== undefined ? { geometry: feature.geometry as Record<string, unknown> | null } : {}),
  };
}

function requiredFields<T>(
  source: Source<T>,
  presentation: HonuaFeatureInspectionPresentation,
  maxFields: number,
): readonly string[] {
  const pk = primaryKey(source);
  const requested = presentation.fields ?? source.descriptor.schema?.fields?.map((field) => field.name) ?? [pk];
  const linkFields = presentation.links?.map((link) => link.hrefField) ?? [];
  return uniqueStrings([
    pk,
    ...(presentation.titleField ? [presentation.titleField] : []),
    ...requested,
    ...linkFields,
  ]).slice(0, maxFields);
}

function primaryKey<T>(source: Source<T>): string {
  return (
    source.descriptor.schema?.primaryKey ??
    source.descriptor.schema?.fields?.find((field) => /^(objectid|fid|id)$/i.test(field.name))?.name ??
    "OBJECTID"
  );
}

function searchableFields(fields: readonly HonuaFieldInfo[]): readonly string[] {
  const strings = fields.filter((field) => /string|guid/i.test(field.type)).map((field) => field.name);
  return strings.length > 0 ? strings : fields.map((field) => field.name);
}

function scalarFeatureId(id: FeatureId): string | number {
  return id;
}

function featureId(attributes: unknown, pk: string, fallbackIndex: number): FeatureId {
  const record = asRecord(attributes);
  const value = record[pk];
  if (typeof value === "string" || typeof value === "number") return value;
  for (const name of ["OBJECTID", "objectid", "id", "ID", "fid", "FID"]) {
    const candidate = record[name];
    if (typeof candidate === "string" || typeof candidate === "number") return candidate;
  }
  return `result:${fallbackIndex}`;
}

function featureTitle(attributes: unknown, titleField: string | undefined, id: FeatureId): string {
  const record = asRecord(attributes);
  const named = titleField ? record[titleField] : undefined;
  if (typeof named === "string" && named.trim()) return named;
  for (const key of ["name", "Name", "NAME", "title", "Title", "TITLE", "label", "Label", "LABEL"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return String(id);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" ? (value as Readonly<Record<string, unknown>>) : {};
}

function dedupeCandidates<T>(
  candidates: readonly HonuaFeatureInspectionCandidate<T>[],
): HonuaFeatureInspectionCandidate<T>[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = featureSelectionKey(candidate.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeSearchResults<T>(
  results: readonly HonuaFeatureInspectionSearchResult<T>[],
): HonuaFeatureInspectionSearchResult<T>[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.id)) return false;
    seen.add(result.id);
    return true;
  });
}

function pageOf<T>(
  values: readonly T[],
  total: number,
  page: number,
  limit: number,
  truncated: boolean,
): HonuaFeatureInspectionPage<T> {
  const resolvedPage = boundedPage(page, total, limit);
  const offset = resolvedPage * limit;
  return {
    items: values.slice(offset, offset + limit),
    offset,
    limit,
    total,
    hasPrevious: resolvedPage > 0,
    hasNext: offset + limit < total && offset + limit < values.length,
    truncated,
  };
}

function boundedPage(page: number, total: number, limit: number): number {
  return clamp(Math.trunc(page), 0, Math.max(0, Math.ceil(total / limit) - 1));
}

function capabilityDiagnostic(
  capability: "query" | "attachments" | "queryRelated",
  sourceId: SourceId,
  protocol = "unknown",
): HonuaFeatureInspectionDiagnostic {
  const error = new HonuaCapabilityNotSupportedError(capability, protocol, sourceId);
  const labels = { query: "Feature details", attachments: "Attachments", queryRelated: "Related records" } as const;
  const codes = {
    query: "query-unsupported",
    attachments: "attachments-unsupported",
    queryRelated: "relationships-unsupported",
  } as const;
  return {
    code: codes[capability],
    capability,
    sourceId,
    message: `${labels[capability]} are unavailable: ${error.message}. Choose a source that advertises "${capability}" or hide this presentation.`,
  };
}

function diagnosticForError(
  error: unknown,
  fallback: "query-failed" | "search-failed" | "attachments-failed" | "relationships-failed",
  sourceId: SourceId,
): HonuaFeatureInspectionDiagnostic {
  if (error instanceof FeatureNotFoundError) {
    return {
      code: "feature-not-found",
      sourceId,
      message: `Feature "${String(error.featureId)}" is no longer available in source "${sourceId}". Clear the selection or refresh its origin.`,
    };
  }
  if (error instanceof HonuaCapabilityNotSupportedError) {
    const capability =
      error.capability === "attachments" || error.capability === "queryRelated" ? error.capability : "query";
    return capabilityDiagnostic(capability, sourceId, error.protocol);
  }
  const labels = {
    "query-failed": "Feature details could not be loaded. Retry or verify access to the source.",
    "search-failed": "Server search failed. Refine the query, retry, or verify access to the source.",
    "attachments-failed": "Attachments could not be loaded. Retry or verify attachment access.",
    "relationships-failed": "Related records could not be loaded. Retry or verify relationship access.",
  } as const;
  return { code: fallback, sourceId, message: labels[fallback] };
}

function isUnsupportedDiagnostic(diagnostic: HonuaFeatureInspectionDiagnostic): boolean {
  return diagnostic.code.endsWith("-unsupported");
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException === "function" && error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function safeOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Convert source-owned popup text to plain text. Tags, script/style blocks,
 * event handlers, and control characters never reach a DOM interpretation.
 */
export function sanitizeHonuaInspectionRichText(value: string): string {
  const plainText = value
    .replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'");
  return [...plainText]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Resolve a display link without carrying credentials or unsafe schemes. */
export function sanitizeHonuaInspectionHref(
  value: string,
  options: { readonly baseHref?: string; readonly allowedOrigins?: readonly string[] } = {},
): string | undefined {
  try {
    const url = options.baseHref ? new URL(value, options.baseHref) : new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    const allowed = options.allowedOrigins;
    if (allowed && allowed.length > 0 && !allowed.includes(url.origin)) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Format a scalar popup/detail value without interpreting it as markup. */
export function formatHonuaInspectionValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unavailable]";
    }
  }
  return String(value);
}

function interpolateInspectionTemplate(template: string, attributes: Readonly<Record<string, unknown>>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_.:]*)\}/g, (_match, field: string) =>
    formatHonuaInspectionValue(attributes[field]),
  );
}

const globalDom = globalThis as typeof globalThis & {
  HTMLElement?: typeof HTMLElement;
  customElements?: CustomElementRegistry;
};
const HTMLElementBase: typeof HTMLElement = globalDom.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

/** Accessible search + popup/details presentation for a feature inspection controller. */
export class HonuaFeatureInspectionElement<T = Record<string, unknown>> extends HTMLElementBase {
  #controller: HonuaFeatureInspectionController<T> | undefined;
  #subscription: { remove(): void } | undefined;
  #applicationContext: HonuaApplicationContext<T> | undefined;
  #ownsController = false;
  #state: HonuaFeatureInspectionSnapshot<T> | undefined;
  #restoreFocus: HTMLElement | undefined;
  #messages: HonuaFeatureInspectionMessages = {};

  /** Caller-injected labels, status text, range formatters, and diagnostics. */
  public get messages(): HonuaFeatureInspectionMessages {
    return this.#messages;
  }

  public set messages(messages: HonuaFeatureInspectionMessages | undefined) {
    this.#messages = messages ?? {};
    this.#render();
  }

  public get inspection(): HonuaFeatureInspectionController<T> | undefined {
    return this.#controller;
  }

  public set inspection(controller: HonuaFeatureInspectionController<T> | undefined) {
    this.#bindInspection(controller, false);
  }

  /** Application shell context assigned by `mountHonuaApplication()`. */
  public get applicationContext(): HonuaApplicationContext<T> | undefined {
    return this.#applicationContext;
  }

  public set applicationContext(context: HonuaApplicationContext<T> | undefined) {
    if (context === this.#applicationContext) return;
    this.#applicationContext = context;
    if (!context) {
      if (this.#ownsController) this.#bindInspection(undefined, false);
      return;
    }
    this.#bindApplicationContext(context);
  }

  public honuaApplicationContextConnected(context: HonuaApplicationContext<T>): void {
    this.applicationContext = context;
  }

  public honuaApplicationContextChanged(event: HonuaApplicationContextChangeEvent<T>): void {
    if (event.current !== this.#applicationContext?.snapshot) return;
    if (event.changed.includes("binding") || event.changed.includes("authorization")) {
      this.#bindApplicationContext(this.#applicationContext);
      return;
    }
    if (event.changed.includes("selection")) this.#applyContextSelection(event.current.selection);
    this.#applyContextPresentation();
  }

  public honuaApplicationContextDisconnected(context: HonuaApplicationContext<T>): void {
    if (this.#applicationContext === context) this.applicationContext = undefined;
  }

  #bindInspection(controller: HonuaFeatureInspectionController<T> | undefined, owned: boolean): void {
    if (controller === this.#controller) return;
    this.#subscription?.remove();
    if (this.#ownsController) this.#controller?.dispose();
    this.#controller = controller;
    this.#ownsController = owned;
    this.#state = controller?.snapshot();
    if (controller) this.#subscribeInspection(controller);
    this.#render();
  }

  #subscribeInspection(controller: HonuaFeatureInspectionController<T>): void {
    this.#subscription = controller.subscribe((state) => {
      const wasOpen = this.#state?.status !== "idle" && this.#state !== undefined;
      const isOpen = state.status !== "idle";
      if (!wasOpen && isOpen) this.#captureFocus();
      this.#state = state;
      this.#render();
      if (wasOpen && !isOpen) this.#restoreFocus?.focus();
    });
  }

  #bindApplicationContext(context: HonuaApplicationContext<T>): void {
    if (!context.snapshot.binding.source) {
      if (this.#ownsController) this.#bindInspection(undefined, false);
      this.#applyContextPresentation();
      return;
    }
    this.#bindInspection(createHonuaFeatureInspectionFromApplicationContext(context), true);
    this.#applyContextSelection(context.snapshot.selection);
    this.#applyContextPresentation();
  }

  #applyContextSelection(selection: readonly unknown[]): void {
    if (!this.#controller) return;
    const target = selection.find(isSourceQualifiedTarget);
    const current = this.#controller.snapshot().candidates[this.#controller.snapshot().activeIndex]?.target;
    if (!target) {
      if (current) this.#controller.close();
      return;
    }
    if (!current || featureSelectionKey(current) !== featureSelectionKey(target)) {
      void this.#controller.open({ target }, { origin: "programmatic" });
    }
  }

  #applyContextPresentation(): void {
    const snapshot = this.#applicationContext?.snapshot;
    if (!snapshot) return;
    this.setAttribute("lang", snapshot.locale.locale);
    this.setAttribute("dir", snapshot.locale.direction ?? "auto");
    this.style.colorScheme = snapshot.theme.colorScheme ?? "";
  }

  public connectedCallback(): void {
    if (!this.shadowRoot && typeof this.attachShadow === "function") this.attachShadow({ mode: "open" });
    this.shadowRoot?.addEventListener("click", this.#onClick);
    this.shadowRoot?.addEventListener("keydown", this.#onKeyDown);
    this.shadowRoot?.addEventListener("submit", this.#onSubmit);
    if (this.#controller && !this.#subscription) this.#subscribeInspection(this.#controller);
    if (this.#applicationContext && !this.#controller) this.#bindApplicationContext(this.#applicationContext);
    this.#render();
  }

  public disconnectedCallback(): void {
    this.shadowRoot?.removeEventListener("click", this.#onClick);
    this.shadowRoot?.removeEventListener("keydown", this.#onKeyDown);
    this.shadowRoot?.removeEventListener("submit", this.#onSubmit);
    this.#subscription?.remove();
    this.#subscription = undefined;
    if (this.#ownsController) this.#bindInspection(undefined, false);
  }

  #captureFocus(): void {
    const active = this.ownerDocument?.activeElement;
    this.#restoreFocus = active instanceof HTMLElement ? active : undefined;
  }

  #render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const focus = captureInspectionFocus(root);
    const state = this.#state;
    const messages = resolveInspectionMessages(this.#messages, this.#applicationContext);
    const label = this.getAttribute("label") ?? messages.panelLabel;
    const search = state?.search ?? { status: "idle", query: "", results: [], diagnostics: [] };
    const feature = state?.feature;
    const role = this.getAttribute("presentation") === "popup" ? "dialog" : "region";
    const details = feature
      ? `<article class="details" part="details" role="${role}"${role === "dialog" ? ' aria-modal="false"' : ""} aria-labelledby="honua-inspection-title">
          <header><h2 id="honua-inspection-title" tabindex="-1">${escapeHtml(feature.title)}</h2>
            <button type="button" data-focus-id="close" data-action="close" aria-label="${escapeAttribute(messages.closeDetailsLabel)}">&times;</button></header>
          ${feature.description ? `<p>${escapeHtml(feature.description)}</p>` : ""}
          ${renderNavigation(state, messages)}
          <dl>${feature.fields
            .map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.text)}</dd></div>`)
            .join("")}</dl>
          ${renderLinks(feature.links, messages)}
          ${renderAttachments(state?.attachments, messages)}
          ${renderRelationships<T>(state?.relationships ?? [], messages)}
        </article>`
      : "";
    renderCspSafeShadowHtml(
      root,
      `<style>${inspectionStyles()}</style>
       <section class="inspection" part="panel" aria-label="${escapeAttribute(label)}" aria-busy="${String(
         state?.status === "loading" || search.status === "loading",
       )}">
        <form role="search"><label for="honua-inspection-search">${escapeHtml(messages.searchLabel)}</label>
          <div class="search-row"><input id="honua-inspection-search" name="q" type="search" value="${escapeAttribute(
            search.query,
          )}" data-focus-id="search" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="${String(
            search.results.length > 0,
          )}" aria-controls="honua-inspection-results" />
          <button type="submit" data-focus-id="search-submit">${escapeHtml(messages.searchButtonLabel)}</button></div></form>
        <ol id="honua-inspection-results" class="results" role="listbox" aria-label="${escapeAttribute(
          messages.searchResultsLabel,
        )}">${search.results
          .map(
            (result, index) =>
              `<li role="option" aria-selected="${String(
                featureSelectionKey(result.target) ===
                  (state?.feature ? featureSelectionKey(state.feature.target) : undefined),
              )}"><button type="button" data-focus-id="search-${index}" data-search-index="${index}">${escapeHtml(result.title)}<small>${escapeHtml(
                result.subtitle ?? result.target.sourceId,
              )}</small></button></li>`,
          )
          .join("")}</ol>
        <p class="status" role="status" aria-live="polite">${escapeHtml(statusText(state, messages))}</p>
        ${renderDiagnostics(state?.diagnostics ?? [], search.diagnostics, messages)}
        ${details}
       </section>`,
    );
    restoreInspectionFocus(root, focus);
  }

  readonly #onClick = (event: Event): void => {
    const button = event.composedPath().find((entry): entry is HTMLButtonElement => entry instanceof HTMLButtonElement);
    if (button) this.#activate(button);
  };

  readonly #onSubmit = (event: Event): void => {
    event.preventDefault();
    this.#search();
  };

  readonly #onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    const target = keyboardEvent.composedPath()[0];
    if (target instanceof HTMLButtonElement && (keyboardEvent.key === "Enter" || keyboardEvent.key === " ")) {
      keyboardEvent.preventDefault();
      this.#activate(target);
      return;
    }
    if (target instanceof HTMLInputElement && keyboardEvent.key === "Enter") {
      keyboardEvent.preventDefault();
      this.#search();
      return;
    }
    if (keyboardEvent.key === "/" && !(target instanceof HTMLInputElement)) {
      keyboardEvent.preventDefault();
      this.shadowRoot?.querySelector<HTMLInputElement>("input[name='q']")?.focus();
      return;
    }
    if (keyboardEvent.key === "Escape" && this.#state?.status !== "idle") {
      event.preventDefault();
      this.#controller?.close();
      return;
    }
    if (target instanceof HTMLInputElement) return;
    if (keyboardEvent.key === "ArrowLeft") {
      keyboardEvent.preventDefault();
      void this.#controller?.previous();
    } else if (keyboardEvent.key === "ArrowRight") {
      keyboardEvent.preventDefault();
      void this.#controller?.next();
    } else if (keyboardEvent.key === "Home") {
      keyboardEvent.preventDefault();
      void this.#controller?.navigate(0);
    } else if (keyboardEvent.key === "End") {
      keyboardEvent.preventDefault();
      void this.#controller?.navigate(Number.MAX_SAFE_INTEGER);
    }
  };

  #search(): void {
    const value = this.shadowRoot?.querySelector<HTMLInputElement>("input[name='q']")?.value ?? "";
    void this.#controller?.search(value);
  }

  #activate(button: HTMLButtonElement): void {
    if (button.disabled) return;
    if (button.dataset.searchIndex !== undefined) {
      void this.#controller?.openSearchResult(Number(button.dataset.searchIndex));
      return;
    }
    switch (button.dataset.action) {
      case "close":
        this.#controller?.close();
        return;
      case "previous":
        void this.#controller?.previous();
        return;
      case "next":
        void this.#controller?.next();
        return;
      case "refresh":
        void this.#controller?.refresh();
        return;
      case "attachments-previous":
        this.#moveAttachmentPage(-1);
        return;
      case "attachments-next":
        this.#moveAttachmentPage(1);
        return;
    }
    if (button.dataset.relationshipId === undefined) return;
    const relationshipId = Number(button.dataset.relationshipId);
    const relationship = this.#state?.relationships.find((candidate) => candidate.id === relationshipId);
    if (!relationship) return;
    const direction = button.dataset.relationshipPage === "previous" ? -1 : 1;
    this.#controller?.setRelationshipPage(
      relationshipId,
      relationship.page.offset / relationship.page.limit + direction,
    );
  }

  #moveAttachmentPage(direction: -1 | 1): void {
    const page = this.#state?.attachments;
    if (page) this.#controller?.setAttachmentPage(page.offset / page.limit + direction);
  }
}

/** Define `<honua-feature-inspection>` in a registry, if it is not already defined. */
export function defineHonuaFeatureInspection(
  registry: CustomElementRegistry | undefined = globalDom.customElements,
): void {
  if (!registry?.get("honua-feature-inspection"))
    registry?.define("honua-feature-inspection", HonuaFeatureInspectionElement);
}

type RequiredInspectionMessages = Required<HonuaFeatureInspectionMessages>;

const DEFAULT_INSPECTION_MESSAGES: RequiredInspectionMessages = Object.freeze({
  panelLabel: "Feature inspection",
  searchLabel: "Search features",
  searchButtonLabel: "Search",
  searchResultsLabel: "Feature search results",
  closeDetailsLabel: "Close feature details",
  overlappingResultsLabel: "Overlapping feature results",
  previousResultLabel: "Previous",
  nextResultLabel: "Next",
  resultPosition: (index, total) => `${index} of ${total}`,
  refreshLabel: "Refresh",
  featureLinksLabel: "Feature links",
  attachmentsLabel: "Attachments",
  attachmentLabel: (id) => `Attachment ${String(id)}`,
  attachmentSize: (bytes) => `${bytes} bytes`,
  attachmentPagesLabel: "Attachment pages",
  previousAttachmentsLabel: "Previous attachments",
  nextAttachmentsLabel: "Next attachments",
  relationshipPagesLabel: (relationship) => `${relationship} pages`,
  previousRelatedLabel: "Previous related records",
  nextRelatedLabel: "Next related records",
  diagnosticsLabel: "Inspection diagnostics",
  diagnostic: (diagnostic) => diagnostic.message,
  range: (offset, count, total) => `${offset + Math.min(1, count)}-${offset + count} of ${total}`,
  disconnectedStatus: "Connect an inspection controller to search and inspect features.",
  searchingStatus: "Searching features.",
  loadingStatus: "Loading feature details.",
  deletedStatus: "The selected feature was deleted.",
  staleStatus: "Feature details are stale. Refresh to continue.",
  showingStatus: (title) => `Showing ${title}.`,
  searchResultsStatus: (count) => `${count} feature search result(s).`,
  emptyStatus: "No feature selected.",
});

function resolveInspectionMessages<T>(
  messages: HonuaFeatureInspectionMessages,
  context?: HonuaApplicationContext<T>,
): RequiredInspectionMessages {
  const statuses = context?.snapshot.locale.status;
  return {
    ...DEFAULT_INSPECTION_MESSAGES,
    ...(statuses?.loading ? { loadingStatus: statuses.loading, searchingStatus: statuses.loading } : {}),
    ...(statuses?.stale ? { staleStatus: statuses.stale } : {}),
    ...(statuses?.empty ? { emptyStatus: statuses.empty } : {}),
    ...(statuses?.unsupported ? { disconnectedStatus: statuses.unsupported } : {}),
    ...messages,
  };
}

function renderNavigation<T>(state: HonuaFeatureInspectionSnapshot<T>, messages: RequiredInspectionMessages): string {
  if (state.candidates.length <= 1) return state.status === "stale" ? refreshButton(messages) : "";
  return `<nav aria-label="${escapeAttribute(messages.overlappingResultsLabel)}">
    <button type="button" data-focus-id="result-previous" data-action="previous"${
      state.activeIndex === 0 ? " disabled" : ""
    }>${escapeHtml(messages.previousResultLabel)}</button>
    <span>${escapeHtml(messages.resultPosition(state.activeIndex + 1, state.candidates.length))}</span>
    <button type="button" data-focus-id="result-next" data-action="next"${
      state.activeIndex + 1 >= state.candidates.length ? " disabled" : ""
    }>${escapeHtml(messages.nextResultLabel)}</button>
    ${state.status === "stale" ? refreshButton(messages) : ""}
  </nav>`;
}

function refreshButton(messages: RequiredInspectionMessages): string {
  return `<button type="button" data-focus-id="refresh" data-action="refresh">${escapeHtml(messages.refreshLabel)}</button>`;
}

function renderLinks(links: readonly HonuaFeatureInspectionLink[], messages: RequiredInspectionMessages): string {
  if (links.length === 0) return "";
  return `<ul class="links" aria-label="${escapeAttribute(messages.featureLinksLabel)}">${links
    .map(
      (link) =>
        `<li><a href="${escapeAttribute(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a></li>`,
    )
    .join("")}</ul>`;
}

function renderAttachments(
  page: HonuaFeatureInspectionPage<HonuaFeatureInspectionAttachment> | undefined,
  messages: RequiredInspectionMessages,
): string {
  if (!page || page.total === 0) return "";
  return `<section aria-labelledby="honua-inspection-attachments"><h3 id="honua-inspection-attachments">${escapeHtml(
    messages.attachmentsLabel,
  )}</h3>
    <ul>${page.items
      .map((attachment) => {
        const label = attachment.name ?? messages.attachmentLabel(attachment.id);
        return `<li>${
          attachment.href
            ? `<a href="${escapeAttribute(attachment.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
            : escapeHtml(label)
        }${attachment.size === undefined ? "" : ` (${escapeHtml(messages.attachmentSize(attachment.size))})`}</li>`;
      })
      .join("")}</ul><p>${escapeHtml(messages.range(page.offset, page.items.length, page.total))}</p>
      <nav aria-label="${escapeAttribute(messages.attachmentPagesLabel)}"><button type="button" data-focus-id="attachments-previous" data-action="attachments-previous"${
        page.hasPrevious ? "" : " disabled"
      }>${escapeHtml(messages.previousAttachmentsLabel)}</button><button type="button" data-focus-id="attachments-next" data-action="attachments-next"${
        page.hasNext ? "" : " disabled"
      }>${escapeHtml(messages.nextAttachmentsLabel)}</button></nav></section>`;
}

function renderRelationships<T>(
  relationships: readonly HonuaFeatureInspectionRelationship<T>[],
  messages: RequiredInspectionMessages,
): string {
  return relationships
    .map(
      (relationship) => `<section aria-labelledby="honua-relationship-${relationship.id}">
        <h3 id="honua-relationship-${relationship.id}">${escapeHtml(relationship.label)}</h3>
        <ol>${relationship.page.items
          .map((feature) => `<li>${escapeHtml(featureTitle(feature.attributes, undefined, "related"))}</li>`)
          .join("")}</ol>
        <p>${escapeHtml(
          messages.range(relationship.page.offset, relationship.page.items.length, relationship.page.total),
        )}</p>
        <nav aria-label="${escapeAttribute(messages.relationshipPagesLabel(relationship.label))}">
          <button type="button" data-focus-id="relationship-${relationship.id}-previous" data-relationship-id="${relationship.id}" data-relationship-page="previous"${
            relationship.page.hasPrevious ? "" : " disabled"
          }>${escapeHtml(messages.previousRelatedLabel)}</button>
          <button type="button" data-focus-id="relationship-${relationship.id}-next" data-relationship-id="${relationship.id}" data-relationship-page="next"${
            relationship.page.hasNext ? "" : " disabled"
          }>${escapeHtml(messages.nextRelatedLabel)}</button>
        </nav>
      </section>`,
    )
    .join("");
}

function renderDiagnostics(
  details: readonly HonuaFeatureInspectionDiagnostic[],
  search: readonly HonuaFeatureInspectionDiagnostic[],
  messages: RequiredInspectionMessages,
): string {
  const diagnostics = [...details, ...search];
  if (diagnostics.length === 0) return "";
  return `<ul class="diagnostics" role="alert" aria-label="${escapeAttribute(messages.diagnosticsLabel)}">${diagnostics
    .map((diagnostic) => `<li>${escapeHtml(messages.diagnostic(diagnostic))}</li>`)
    .join("")}</ul>`;
}

function statusText<T>(
  state: HonuaFeatureInspectionSnapshot<T> | undefined,
  messages: RequiredInspectionMessages,
): string {
  if (!state) return messages.disconnectedStatus;
  if (state.search.status === "loading") return messages.searchingStatus;
  if (state.status === "loading") return messages.loadingStatus;
  if (state.status === "deleted") return state.staleReason ?? messages.deletedStatus;
  if (state.status === "stale") return state.staleReason ?? messages.staleStatus;
  if (state.feature) return messages.showingStatus(state.feature.title);
  if (state.search.status === "ready") return messages.searchResultsStatus(state.search.results.length);
  return messages.emptyStatus;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isSourceQualifiedTarget(value: unknown): value is SourceQualifiedFeatureSelectionTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<SourceQualifiedFeatureSelectionTarget>;
  return (
    typeof target.sourceId === "string" &&
    (typeof target.id === "string" || (typeof target.id === "number" && Number.isFinite(target.id)))
  );
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

interface InspectionFocusSnapshot {
  readonly id: string;
  readonly value?: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly selectionDirection?: "forward" | "backward" | "none";
}

function captureInspectionFocus(root: ShadowRoot): InspectionFocusSnapshot | undefined {
  const active = root.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  const id = active.dataset.focusId;
  if (!id) return undefined;
  if (!(active instanceof HTMLInputElement)) return { id };
  return {
    id,
    value: active.value,
    ...(active.selectionStart !== null ? { selectionStart: active.selectionStart } : {}),
    ...(active.selectionEnd !== null ? { selectionEnd: active.selectionEnd } : {}),
    ...(active.selectionDirection ? { selectionDirection: active.selectionDirection } : {}),
  };
}

function restoreInspectionFocus(root: ShadowRoot, snapshot: InspectionFocusSnapshot | undefined): void {
  if (!snapshot) return;
  const target = [...root.querySelectorAll<HTMLElement>("[data-focus-id]")].find(
    (candidate) => candidate.dataset.focusId === snapshot.id,
  );
  if (!target) return;
  if (target instanceof HTMLInputElement && snapshot.value !== undefined) {
    target.value = snapshot.value;
  }
  target.focus();
  if (
    target instanceof HTMLInputElement &&
    snapshot.selectionStart !== undefined &&
    snapshot.selectionEnd !== undefined
  ) {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection);
  }
}

function inspectionStyles(): string {
  return `:host{display:block;min-inline-size:0;max-inline-size:100%;container-type:inline-size;color:var(--honua-color-text,#17202a);font:var(--honua-font,normal 400 1rem/1.5 system-ui,sans-serif)}
  *{box-sizing:border-box}.inspection{display:grid;min-inline-size:0;gap:.75rem}.search-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.5rem}
  label,h2,h3{font-weight:600}input,button,a{font:inherit}input{min-inline-size:0;max-inline-size:100%;padding:.5rem;border:1px solid var(--honua-color-border,#777);border-radius:.25rem}
  button{max-inline-size:100%;padding:.45rem .7rem;overflow-wrap:anywhere}.results,.links,.diagnostics{margin:0;padding-inline-start:1.25rem}.results:empty{display:none}.results button{inline-size:100%;text-align:start}.results small{display:block}
  .details{min-inline-size:0;border:1px solid var(--honua-color-border,#aaa);border-radius:.375rem;padding:1rem;overflow-wrap:anywhere}.details header{display:flex;justify-content:space-between;gap:1rem}.details h2{margin:0}
  dl{display:grid;gap:.25rem}dl div{display:grid;grid-template-columns:minmax(8rem,1fr) 2fr;gap:.5rem}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}
  nav{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}.status{min-height:1.5em}.diagnostics{color:var(--honua-color-danger,#8b1a1a)}
  :focus-visible{outline:3px solid var(--honua-color-focus,#1565c0);outline-offset:2px}
  @container(max-width:320px){.search-row,dl div{grid-template-columns:minmax(0,1fr)}.search-row button,nav button{inline-size:100%}.details header{align-items:stretch;flex-direction:column}}
  @media(max-width:320px){.search-row,dl div{grid-template-columns:minmax(0,1fr)}.search-row button,nav button{inline-size:100%}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
  @media(forced-colors:active),(prefers-contrast:more){:host{color:CanvasText;background:Canvas}.inspection,.details,input{color:CanvasText;background:Canvas;border-color:CanvasText}button{color:ButtonText;background:ButtonFace;border:1px solid ButtonText}a{color:LinkText}.diagnostics{color:CanvasText;border-inline-start:3px solid MarkText}:focus-visible{outline-color:Highlight}}`;
}
