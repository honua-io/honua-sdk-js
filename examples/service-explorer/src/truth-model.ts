import {
  HonuaAbortError,
  HonuaAuthError,
  HonuaDiscoveryError,
  HonuaHttpError,
  createHonua,
  isHonuaError,
  type ConnectLocator,
  type ConnectProtocolHint,
  type ConnectionInspection,
  type HonuaKernel,
  type HonuaKernelConnection,
  type HonuaKernelConnectOptions,
  type HonuaKernelOptions,
} from "@honua/sdk-js";
import type {
  DiscoveryCapabilityDecision,
  DiscoveryCapabilityEvidenceSummary,
  DiscoveryDiagnostic,
  DiscoveryProvenance,
  DiscoveryState,
  SourceDiscoveryInspection,
} from "@honua/sdk-js/contract";

const MAX_ENDPOINT_INPUT_LENGTH = 4_096;
const MAX_SELECTOR_LENGTH = 512;
const MAX_TEXT_LENGTH = 512;
const MAX_SOURCES = 256;
const MAX_FIELDS_PER_SOURCE = 256;
const MAX_DIAGNOSTICS = 512;
const MAX_PROVENANCE_PER_SOURCE = 32;
const MAX_EXTENTS_PER_SOURCE = 16;
const MAX_PROFILE_ENTRIES = 128;
const MAX_EVIDENCE_PER_CAPABILITY = 16;
const MAX_REASONS_PER_CAPABILITY = 16;

export type ServiceExplorerTruthStateKind =
  | "idle"
  | "loading"
  | "ready"
  | "auth"
  | "unsupported"
  | "partial"
  | "ambiguous"
  | "cancelled"
  | "error";

export interface ServiceExplorerEndpointInput {
  readonly url: string;
  readonly protocol?: ConnectProtocolHint;
  readonly sourceId?: string;
  readonly collectionId?: string;
  readonly typeName?: string;
}

/**
 * Live access is injected separately from renderer-safe endpoint input. None of
 * these values are copied into the inspection model.
 */
export interface ServiceExplorerInspectOptions {
  readonly authorizationScopeFingerprint?: string;
  readonly client?: HonuaKernelConnectOptions["client"];
  readonly clientOptions?: HonuaKernelConnectOptions["clientOptions"];
  readonly metadata?: HonuaKernelConnectOptions["metadata"];
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface ServiceExplorerAuthorizationView {
  readonly mode: "anonymous" | "scoped";
  /** A structural caller label, or `[configured]` when the label resembles credential material. */
  readonly scopeIdentity: string;
  readonly credentialsRetained: false;
}

export interface ServiceExplorerRequestView {
  readonly id: number;
  /** Query, fragment, and URL user-info are never retained in renderer state. */
  readonly endpoint: string;
  readonly protocolHint: string;
  readonly sourceId?: string;
  readonly collectionId?: string;
  readonly typeName?: string;
  readonly authorization: ServiceExplorerAuthorizationView;
}

export interface ServiceExplorerFailureView {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
}

export interface ServiceExplorerCapabilityEvidenceView {
  readonly kind: DiscoveryCapabilityEvidenceSummary["kind"];
  readonly supported: boolean;
  readonly reason?: string;
  readonly provenanceCount: number;
}

export interface ServiceExplorerCapabilityDecisionView {
  readonly capability: string;
  readonly effective: boolean;
  readonly code: DiscoveryCapabilityDecision["code"];
  readonly reason: string;
  readonly adapterSupported: boolean;
  readonly positiveEvidence: boolean;
  readonly policyAllowed: boolean;
  readonly evidence: readonly ServiceExplorerCapabilityEvidenceView[];
}

export interface ServiceExplorerCapabilityProfileEntryView {
  readonly id: string;
  readonly claimed: string;
  readonly observed: string;
  readonly effective: string;
  readonly reasons: readonly string[];
  readonly pagination?: {
    readonly modes: readonly string[];
    readonly maxPageSize?: number;
  };
}

export interface ServiceExplorerCapabilityProfileView {
  readonly fingerprint: string;
  readonly evidenceFingerprint: string;
  readonly evaluatedAt: string | null;
  readonly validUntil: string | null;
  readonly entries: readonly ServiceExplorerCapabilityProfileEntryView[];
  readonly truncated: boolean;
}

export interface ServiceExplorerFieldView {
  readonly name: string;
  readonly type: string;
  readonly alias?: string;
  readonly length?: number;
  readonly nullable?: boolean;
  readonly editable?: boolean;
}

export interface ServiceExplorerSchemaView {
  readonly state: "available" | "unavailable";
  readonly primaryKey?: string;
  readonly timeField?: string;
  readonly fieldCount: number;
  readonly fields: readonly ServiceExplorerFieldView[];
  readonly truncated: boolean;
  readonly schemaV2?: {
    readonly kind: string;
    readonly version: string;
    readonly fingerprint: string;
  };
}

export interface ServiceExplorerExtentView {
  readonly spatial?: {
    readonly bbox: readonly (readonly number[])[];
    readonly crs?: string;
  };
  readonly temporal?: {
    readonly interval: readonly (readonly (string | null)[])[];
    readonly trs?: string;
  };
}

export interface ServiceExplorerSourceLocatorView {
  readonly url: string;
  readonly serviceId?: string;
  readonly layerId?: number;
  readonly collectionId?: string;
  readonly layout?: string;
  readonly basePath?: string;
  readonly tileMatrixSetId?: string;
  readonly styleId?: string;
  readonly typeName?: string;
  readonly srsName?: string;
  readonly entitySet?: string;
  readonly taskName?: string;
}

export interface ServiceExplorerProvenanceView {
  readonly source: string;
  readonly retrievedAt?: string;
  readonly validator?: string;
}

export interface ServiceExplorerSourceView {
  readonly id: string;
  readonly protocol: string;
  readonly locator: ServiceExplorerSourceLocatorView;
  readonly discovery: DiscoveryState;
  readonly crs: readonly string[];
  readonly extent?: ServiceExplorerExtentView;
  readonly attribution?: string;
  readonly schema: ServiceExplorerSchemaView;
  readonly effectiveCapabilities: readonly string[];
  readonly capabilityDecisions: readonly ServiceExplorerCapabilityDecisionView[];
  readonly capabilityProfile?: ServiceExplorerCapabilityProfileView;
  readonly provenance: readonly ServiceExplorerProvenanceView[];
}

export interface ServiceExplorerDiagnosticView {
  readonly scope: "service" | "source" | "projection";
  readonly sourceId?: string;
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly capabilities: readonly string[];
}

export interface ServiceExplorerInspectionView {
  readonly service: {
    readonly id: string;
    readonly endpoint: string;
    readonly protocol: string;
    readonly protocolHint: string;
    readonly evidenceStates: readonly DiscoveryState[];
    readonly cache: {
      readonly scope: "discovery-metadata";
      readonly status: ConnectionInspection["cacheStatus"];
      readonly featureData: "not-loaded";
    };
    readonly authorization: ServiceExplorerAuthorizationView;
  };
  readonly dataset: {
    readonly id: string;
    readonly sourceCount: number;
    readonly visibleSourceCount: number;
    readonly sourceIds: readonly string[];
    readonly selectedSourceId?: string;
    readonly selectionRequired: boolean;
  };
  readonly sources: readonly ServiceExplorerSourceView[];
  readonly diagnostics: readonly ServiceExplorerDiagnosticView[];
  readonly truncated: boolean;
}

export interface ServiceExplorerIdleState {
  readonly kind: "idle";
}

export interface ServiceExplorerLoadingState {
  readonly kind: "loading";
  readonly request: ServiceExplorerRequestView;
}

export interface ServiceExplorerReadyState {
  readonly kind: "ready" | "partial";
  readonly request: ServiceExplorerRequestView;
  readonly inspection: ServiceExplorerInspectionView;
}

export interface ServiceExplorerAmbiguousState {
  readonly kind: "ambiguous";
  readonly request: ServiceExplorerRequestView;
  readonly failure: ServiceExplorerFailureView;
  readonly inspection?: ServiceExplorerInspectionView;
}

export interface ServiceExplorerUnsupportedState {
  readonly kind: "unsupported";
  readonly request: ServiceExplorerRequestView;
  readonly failure: ServiceExplorerFailureView;
  readonly inspection?: ServiceExplorerInspectionView;
}

export interface ServiceExplorerFailureState {
  readonly kind: "auth" | "cancelled" | "error";
  readonly request: ServiceExplorerRequestView;
  readonly failure: ServiceExplorerFailureView;
}

export type ServiceExplorerTerminalState =
  | ServiceExplorerReadyState
  | ServiceExplorerAmbiguousState
  | ServiceExplorerUnsupportedState
  | ServiceExplorerFailureState;

export type ServiceExplorerTruthState =
  | ServiceExplorerIdleState
  | ServiceExplorerLoadingState
  | ServiceExplorerTerminalState;

export interface ServiceExplorerTruthModelOptions {
  /** Existing kernels are borrowed; otherwise this session owns a public `createHonua()` instance. */
  readonly honua?: HonuaKernel;
  readonly kernelOptions?: HonuaKernelOptions;
}

export interface ServiceExplorerTruthModel extends AsyncDisposable {
  readonly state: ServiceExplorerTruthState;
  inspect(
    input: ServiceExplorerEndpointInput,
    options?: ServiceExplorerInspectOptions,
  ): Promise<ServiceExplorerTerminalState>;
  subscribe(listener: (state: ServiceExplorerTruthState) => void): () => void;
  /** The non-serializable handle used by the later accepted-operation workflow. */
  connection(): HonuaKernelConnection | undefined;
  cancel(): void;
  dispose(): Promise<void>;
}

/**
 * Build the renderer-neutral URL -> connect -> inspect state machine used by
 * the Service Explorer. This projects public kernel truth; it never performs
 * protocol guessing or capability inference of its own.
 */
export function createServiceExplorerTruthModel(
  options: ServiceExplorerTruthModelOptions = {},
): ServiceExplorerTruthModel {
  return new ServiceExplorerTruthModelSession(options);
}

class ServiceExplorerTruthModelSession implements ServiceExplorerTruthModel {
  readonly #honua: HonuaKernel;
  readonly #ownsHonua: boolean;
  readonly #listeners = new Set<(state: ServiceExplorerTruthState) => void>();
  #activeAbortController: AbortController | undefined;
  #activeConnection: HonuaKernelConnection | undefined;
  #disposePromise: Promise<void> | undefined;
  #generation = 0;
  #state: ServiceExplorerTruthState = Object.freeze({ kind: "idle" });

  public constructor(options: ServiceExplorerTruthModelOptions) {
    this.#honua = options.honua ?? createHonua(options.kernelOptions);
    this.#ownsHonua = options.honua === undefined;
  }

  public get state(): ServiceExplorerTruthState {
    return this.#state;
  }

  public subscribe(listener: (state: ServiceExplorerTruthState) => void): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  public connection(): HonuaKernelConnection | undefined {
    this.#assertActive();
    return this.#activeConnection;
  }

  public async inspect(
    input: ServiceExplorerEndpointInput,
    options: ServiceExplorerInspectOptions = {},
  ): Promise<ServiceExplorerTerminalState> {
    this.#assertActive();
    const generation = ++this.#generation;
    this.#activeAbortController?.abort(new HonuaAbortError("Service Explorer request was superseded"));
    const controller = new AbortController();
    this.#activeAbortController = controller;
    const signal = combineAbortSignals(controller.signal, options.signal);
    const request = createRequestView(generation, input, options.authorizationScopeFingerprint);
    this.#publish(freezeView({ kind: "loading", request }));

    const inputFailure = validateInput(input);
    if (inputFailure) {
      const state = freezeView({ kind: "error", request, failure: inputFailure } satisfies ServiceExplorerFailureState);
      if (generation === this.#generation) this.#publish(state);
      return state;
    }

    const previous = this.#activeConnection;
    this.#activeConnection = undefined;
    if (previous) await previous.dispose();

    let connection: HonuaKernelConnection | undefined;
    try {
      signal.throwIfAborted();
      connection = await this.#honua.connect(createLocator(input), createConnectOptions(options, signal));
      const inspection = await connection.inspect({ signal });
      signal.throwIfAborted();
      const view = projectInspection(connection, inspection, request, input.sourceId);
      const terminal = classifyInspection(request, view);
      if (generation !== this.#generation) {
        await connection.dispose();
        return cancelledState(request);
      }
      this.#activeConnection = connection;
      this.#publish(terminal);
      return terminal;
    } catch (error) {
      if (connection) await disposeQuietly(connection);
      const terminal = failureState(request, error, signal);
      if (generation === this.#generation) this.#publish(terminal);
      return terminal;
    } finally {
      if (generation === this.#generation) this.#activeAbortController = undefined;
    }
  }

  public cancel(): void {
    this.#assertActive();
    const controller = this.#activeAbortController;
    if (!controller) return;
    controller.abort(new HonuaAbortError("Service Explorer request was cancelled"));
    if (this.#state.kind === "loading") this.#publish(cancelledState(this.#state.request));
  }

  public dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#generation += 1;
    this.#activeAbortController?.abort(new HonuaAbortError("Service Explorer truth model was disposed"));
    this.#activeAbortController = undefined;
    const connection = this.#activeConnection;
    this.#activeConnection = undefined;
    this.#listeners.clear();
    this.#disposePromise = (async () => {
      if (connection) await connection.dispose();
      if (this.#ownsHonua) await this.#honua.dispose();
    })();
    return this.#disposePromise;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #publish(state: ServiceExplorerTruthState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  #assertActive(): void {
    if (this.#disposePromise) throw new Error("Service Explorer truth model is disposed.");
  }
}

function createRequestView(
  id: number,
  input: ServiceExplorerEndpointInput,
  authorizationScopeFingerprint: string | undefined,
): ServiceExplorerRequestView {
  const sourceId = safeSelector(input.sourceId);
  const collectionId = safeSelector(input.collectionId);
  const typeName = safeSelector(input.typeName);
  return freezeView({
    id,
    endpoint: safeEndpoint(input.url),
    protocolHint: safeText(typeof input.protocol === "string" ? input.protocol : "auto", 64),
    ...(sourceId ? { sourceId } : {}),
    ...(collectionId ? { collectionId } : {}),
    ...(typeName ? { typeName } : {}),
    authorization: authorizationView(authorizationScopeFingerprint),
  });
}

function authorizationView(value: string | undefined): ServiceExplorerAuthorizationView {
  const candidate = value?.trim();
  const anonymous = candidate === undefined || candidate === "" || candidate === "public" || candidate === "anonymous";
  return freezeView({
    mode: anonymous ? "anonymous" : "scoped",
    scopeIdentity: anonymous ? "public" : safeScopeIdentity(candidate),
    credentialsRetained: false,
  });
}

function safeScopeIdentity(value: string): string {
  if (
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ||
    /(?:bearer|password|secret|token|api[_-]?key|session|signature|jwt)/i.test(value)
  ) {
    return "[configured]";
  }
  return value;
}

function validateInput(input: ServiceExplorerEndpointInput): ServiceExplorerFailureView | undefined {
  if (typeof input.url !== "string" || input.url.length === 0 || input.url.length > MAX_ENDPOINT_INPUT_LENGTH) {
    return failure("input.invalid-endpoint", "Invalid endpoint", "Enter a bounded HTTP(S) service URL.", false);
  }
  for (const [name, value] of [
    ["sourceId", input.sourceId],
    ["collectionId", input.collectionId],
    ["typeName", input.typeName],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_SELECTOR_LENGTH)) {
      return failure(
        `input.invalid-${name.toLowerCase()}`,
        "Invalid source selector",
        `${name} must be a bounded string.`,
        false,
      );
    }
  }
  return undefined;
}

function createLocator(input: ServiceExplorerEndpointInput): ConnectLocator {
  return {
    url: input.url,
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    ...(input.sourceId !== undefined ? { sourceId: input.sourceId } : {}),
    ...(input.collectionId !== undefined ? { collectionId: input.collectionId } : {}),
    ...(input.typeName !== undefined ? { typeName: input.typeName } : {}),
  };
}

function createConnectOptions(
  options: ServiceExplorerInspectOptions,
  signal: AbortSignal,
): HonuaKernelConnectOptions {
  return {
    ...(options.authorizationScopeFingerprint !== undefined
      ? { authorizationScopeFingerprint: options.authorizationScopeFingerprint }
      : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.clientOptions !== undefined ? { clientOptions: options.clientOptions } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
    signal,
  };
}

function projectInspection(
  connection: HonuaKernelConnection,
  inspection: ConnectionInspection,
  request: ServiceExplorerRequestView,
  explicitlySelectedSourceId: string | undefined,
): ServiceExplorerInspectionView {
  const visibleInspections = inspection.sources.slice(0, MAX_SOURCES);
  const sources = visibleInspections.map(projectSource);
  const selectedSourceId = explicitlySelectedSourceId ?? inspection.defaultSourceId;
  const diagnostics = projectDiagnostics(inspection, visibleInspections, inspection.sources.length > MAX_SOURCES);
  const evidenceStates = [...new Set(inspection.sources.map((source) => source.discovery))].sort();
  return freezeView({
    service: {
      id: safeText(inspection.id),
      endpoint: safeEndpoint(inspection.endpoint),
      protocol: safeText(inspection.protocol, 64),
      protocolHint: request.protocolHint,
      evidenceStates,
      cache: {
        scope: "discovery-metadata",
        status: inspection.cacheStatus,
        featureData: "not-loaded",
      },
      authorization: request.authorization,
    },
    dataset: {
      id: safeText(connection.dataset.id),
      sourceCount: inspection.sources.length,
      visibleSourceCount: sources.length,
      sourceIds: sources.map((source) => source.id),
      ...(selectedSourceId ? { selectedSourceId: safeText(selectedSourceId) } : {}),
      selectionRequired: inspection.sources.length > 1 && selectedSourceId === undefined,
    },
    sources,
    diagnostics,
    truncated: inspection.sources.length > MAX_SOURCES || diagnostics.some((entry) => entry.code.startsWith("explorer.")),
  });
}

function projectSource(inspection: SourceDiscoveryInspection): ServiceExplorerSourceView {
  const descriptor = inspection.descriptor;
  const schema = descriptor.schema;
  const fields = schema?.fields ?? [];
  const visibleFields = fields.slice(0, MAX_FIELDS_PER_SOURCE).map((field) => ({
    name: safeText(field.name),
    type: safeText(field.type, 128),
    ...(field.alias !== undefined ? { alias: safeText(field.alias) } : {}),
    ...(field.length !== undefined ? { length: field.length } : {}),
    ...(field.nullable !== undefined ? { nullable: field.nullable } : {}),
    ...(field.editable !== undefined ? { editable: field.editable } : {}),
  }));
  const schemaV2 = descriptor.schemaV2;
  const schemaView: ServiceExplorerSchemaView = {
    state: schema === undefined && schemaV2 === undefined ? "unavailable" : "available",
    ...(schema?.primaryKey ? { primaryKey: safeText(schema.primaryKey) } : {}),
    ...(schema?.timeField ? { timeField: safeText(schema.timeField) } : {}),
    fieldCount: fields.length,
    fields: visibleFields,
    truncated: fields.length > MAX_FIELDS_PER_SOURCE,
    ...(schemaV2
      ? {
          schemaV2: {
            kind: safeText(schemaV2.kind, 128),
            version: safeText(schemaV2.version, 64),
            fingerprint: safeText(schemaV2.fingerprint, 128),
          },
        }
      : {}),
  };
  const crs = (inspection.metadata?.crs ?? []).slice(0, MAX_EXTENTS_PER_SOURCE).map((entry) => safeText(entry, 256));
  return freezeView({
    id: safeText(descriptor.id),
    protocol: safeText(descriptor.protocol, 64),
    locator: projectLocator(descriptor.locator),
    discovery: inspection.discovery,
    crs,
    ...(inspection.metadata?.extent ? { extent: projectExtent(inspection.metadata.extent) } : {}),
    ...(descriptor.attribution ? { attribution: safeText(descriptor.attribution) } : {}),
    schema: schemaView,
    effectiveCapabilities: [...descriptor.capabilities].map((entry) => safeText(entry, 128)).sort(),
    capabilityDecisions: inspection.capabilityDecisions.map(projectCapabilityDecision),
    ...(descriptor.capabilityProfile ? { capabilityProfile: projectCapabilityProfile(descriptor.capabilityProfile) } : {}),
    provenance: inspection.provenance.slice(0, MAX_PROVENANCE_PER_SOURCE).map(projectProvenance),
  });
}

function projectLocator(locator: SourceDiscoveryInspection["descriptor"]["locator"]): ServiceExplorerSourceLocatorView {
  return freezeView({
    url: safeEndpoint(locator.url),
    ...(locator.serviceId !== undefined ? { serviceId: safeText(locator.serviceId) } : {}),
    ...(locator.layerId !== undefined ? { layerId: locator.layerId } : {}),
    ...(locator.collectionId !== undefined ? { collectionId: safeText(String(locator.collectionId)) } : {}),
    ...(locator.layout !== undefined ? { layout: safeText(locator.layout, 64) } : {}),
    ...(locator.basePath !== undefined ? { basePath: safeText(locator.basePath, 256) } : {}),
    ...(locator.tileMatrixSetId !== undefined ? { tileMatrixSetId: safeText(locator.tileMatrixSetId) } : {}),
    ...(locator.styleId !== undefined ? { styleId: safeText(locator.styleId) } : {}),
    ...(locator.typeName !== undefined ? { typeName: safeText(locator.typeName) } : {}),
    ...(locator.srsName !== undefined ? { srsName: safeText(String(locator.srsName)) } : {}),
    ...(locator.entitySet !== undefined ? { entitySet: safeText(locator.entitySet) } : {}),
    ...(locator.taskName !== undefined ? { taskName: safeText(locator.taskName) } : {}),
  });
}

function projectExtent(extent: NonNullable<SourceDiscoveryInspection["metadata"]>["extent"]): ServiceExplorerExtentView {
  return freezeView({
    ...(extent?.spatial
      ? {
          spatial: {
            bbox: extent.spatial.bbox.slice(0, MAX_EXTENTS_PER_SOURCE).map((bbox) => bbox.slice(0, 6)),
            ...(extent.spatial.crs ? { crs: safeText(extent.spatial.crs, 256) } : {}),
          },
        }
      : {}),
    ...(extent?.temporal
      ? {
          temporal: {
            interval: extent.temporal.interval
              .slice(0, MAX_EXTENTS_PER_SOURCE)
              .map((interval) => interval.slice(0, 2).map((value) => (value === null ? null : safeText(value, 128)))),
            ...(extent.temporal.trs ? { trs: safeText(extent.temporal.trs, 256) } : {}),
          },
        }
      : {}),
  });
}

function projectCapabilityDecision(decision: DiscoveryCapabilityDecision): ServiceExplorerCapabilityDecisionView {
  return freezeView({
    capability: safeText(decision.capability, 128),
    effective: decision.effective,
    code: decision.code,
    reason: safeText(decision.reason),
    adapterSupported: decision.adapterSupported,
    positiveEvidence: decision.positiveEvidence,
    policyAllowed: decision.policyAllowed,
    evidence: decision.evidence.slice(0, MAX_EVIDENCE_PER_CAPABILITY).map(projectCapabilityEvidence),
  });
}

function projectCapabilityEvidence(
  evidence: DiscoveryCapabilityEvidenceSummary,
): ServiceExplorerCapabilityEvidenceView {
  return freezeView({
    kind: evidence.kind,
    supported: evidence.supported,
    ...(evidence.reason ? { reason: safeText(evidence.reason) } : {}),
    provenanceCount: evidence.provenance.length,
  });
}

function projectCapabilityProfile(
  profile: NonNullable<SourceDiscoveryInspection["descriptor"]["capabilityProfile"]>,
): ServiceExplorerCapabilityProfileView {
  const entries = profile.entries.slice(0, MAX_PROFILE_ENTRIES).map((entry) => {
    const pagination = entry.constraints?.pagination;
    return {
      id: safeText(entry.id, 128),
      claimed: entry.claimed,
      observed: entry.observed,
      effective: entry.effective,
      reasons: entry.reasons.slice(0, MAX_REASONS_PER_CAPABILITY).map((reason) => safeText(reason, 256)),
      ...(pagination
        ? {
            pagination: {
              modes: pagination.modes.map((mode) => safeText(mode, 64)),
              ...(pagination.maxPageSize !== undefined ? { maxPageSize: pagination.maxPageSize } : {}),
            },
          }
        : {}),
    };
  });
  return freezeView({
    fingerprint: safeText(profile.fingerprint, 128),
    evidenceFingerprint: safeText(profile.evidenceFingerprint, 128),
    evaluatedAt: profile.evaluatedAt,
    validUntil: profile.validUntil,
    entries,
    truncated: profile.entries.length > MAX_PROFILE_ENTRIES,
  });
}

function projectProvenance(provenance: DiscoveryProvenance): ServiceExplorerProvenanceView {
  return freezeView({
    source: safeEndpoint(provenance.source),
    ...(provenance.retrievedAt ? { retrievedAt: safeText(provenance.retrievedAt, 128) } : {}),
    ...(provenance.validator ? { validator: safeText(provenance.validator, 256) } : {}),
  });
}

function projectDiagnostics(
  inspection: ConnectionInspection,
  sources: readonly SourceDiscoveryInspection[],
  sourceLimitExceeded: boolean,
): readonly ServiceExplorerDiagnosticView[] {
  const diagnostics: ServiceExplorerDiagnosticView[] = inspection.diagnostics.map((entry) =>
    projectDiagnostic("service", entry),
  );
  for (const source of sources) {
    for (const diagnostic of source.diagnostics) {
      diagnostics.push(projectDiagnostic("source", diagnostic, source.descriptor.id));
    }
    if ((source.descriptor.schema?.fields?.length ?? 0) > MAX_FIELDS_PER_SOURCE) {
      diagnostics.push({
        scope: "projection",
        sourceId: safeText(source.descriptor.id),
        code: "explorer.field-limit",
        severity: "warning",
        message: `Only the first ${MAX_FIELDS_PER_SOURCE} inspected fields are visible.`,
        capabilities: [],
      });
    }
  }
  if (sourceLimitExceeded) {
    diagnostics.push({
      scope: "projection",
      code: "explorer.source-limit",
      severity: "warning",
      message: `Only the first ${MAX_SOURCES} inspected sources are visible.`,
      capabilities: [],
    });
  }
  if (diagnostics.length > MAX_DIAGNOSTICS) {
    return freezeView([
      ...diagnostics.slice(0, MAX_DIAGNOSTICS - 1),
      {
        scope: "projection",
        code: "explorer.diagnostic-limit",
        severity: "warning",
        message: `Only the first ${MAX_DIAGNOSTICS - 1} diagnostics are visible.`,
        capabilities: [],
      } satisfies ServiceExplorerDiagnosticView,
    ]);
  }
  return freezeView(diagnostics);
}

function projectDiagnostic(
  scope: ServiceExplorerDiagnosticView["scope"],
  diagnostic: DiscoveryDiagnostic,
  sourceId?: string,
): ServiceExplorerDiagnosticView {
  return freezeView({
    scope,
    ...(sourceId ? { sourceId: safeText(sourceId) } : {}),
    code: safeText(diagnostic.code, 128),
    severity: diagnostic.severity,
    message: safeText(diagnostic.message),
    capabilities: (diagnostic.capabilities ?? []).map((capability) => safeText(capability, 128)),
  });
}

function classifyInspection(
  request: ServiceExplorerRequestView,
  inspection: ServiceExplorerInspectionView,
): ServiceExplorerTerminalState {
  if (inspection.dataset.sourceCount === 0) {
    return freezeView({
      kind: "unsupported",
      request,
      inspection,
      failure: failure(
        "discovery.no-sources",
        "No supported sources",
        "The endpoint was inspected but did not advertise a source usable by this public kernel.",
        false,
      ),
    });
  }
  if (inspection.dataset.selectionRequired) {
    return freezeView({
      kind: "ambiguous",
      request,
      inspection,
      failure: failure(
        "discovery.ambiguous-source",
        "Choose a source",
        "The service advertises multiple sources and no source has been selected.",
        false,
      ),
    });
  }
  if (inspection.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return freezeView({ kind: "partial", request, inspection });
  }
  return freezeView({ kind: "ready", request, inspection });
}

function failureState(
  request: ServiceExplorerRequestView,
  error: unknown,
  signal: AbortSignal,
): ServiceExplorerTerminalState {
  if (signal.aborted || error instanceof HonuaAbortError) return cancelledState(request);
  if (error instanceof HonuaAuthError || (error instanceof HonuaHttpError && [401, 403].includes(error.statusCode))) {
    return freezeView({
      kind: "auth",
      request,
      failure: failure(
        isHonuaError(error) ? error.sdkCode : "core.auth.required",
        "Authentication required",
        "Configure access for this endpoint and retry. Credential values are not retained by the explorer.",
        false,
      ),
    });
  }
  if (error instanceof HonuaDiscoveryError && error.code === "unsupported-protocol") {
    return freezeView({
      kind: "unsupported",
      request,
      failure: failure(
        error.sdkCode,
        "Protocol not available",
        "This protocol is not supported by the public connect discovery surface on this SDK build.",
        false,
      ),
    });
  }
  if (
    error instanceof HonuaDiscoveryError &&
    (error.code === "ambiguous-protocol" || error.code === "ambiguous-source")
  ) {
    return freezeView({
      kind: "ambiguous",
      request,
      failure: failure(
        error.sdkCode,
        "More information required",
        "Select an explicit protocol or advertised source and retry.",
        false,
      ),
    });
  }
  const sdkError = isHonuaError(error) ? error : undefined;
  return freezeView({
    kind: "error",
    request,
    failure: failure(
      sdkError?.sdkCode ?? "service-explorer.inspect-failed",
      "Inspection failed",
      sdkError?.retryable
        ? "The endpoint could not be inspected. The SDK marked this failure as retryable."
        : "The endpoint could not be inspected safely.",
      sdkError?.retryable ?? false,
    ),
  });
}

function cancelledState(request: ServiceExplorerRequestView): ServiceExplorerFailureState {
  return freezeView({
    kind: "cancelled",
    request,
    failure: failure("core.cancelled", "Inspection cancelled", "No inspection result was published.", true),
  });
}

function failure(
  code: string,
  title: string,
  detail: string,
  retryable: boolean,
): ServiceExplorerFailureView {
  return freezeView({
    code: safeText(code, 128),
    title: safeText(title, 128),
    detail: safeText(detail),
    retryable,
  });
}

function safeEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_INPUT_LENGTH) {
    return "[invalid endpoint]";
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[invalid endpoint]";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return safeText(parsed.toString(), MAX_ENDPOINT_INPUT_LENGTH);
  } catch {
    return "[invalid endpoint]";
  }
}

function safeSelector(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return safeText(value, MAX_SELECTOR_LENGTH);
}

function safeText(value: string, limit = MAX_TEXT_LENGTH): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
    .replace(/\b(Bearer)\s+[^\s]+/gi, "$1 [redacted]")
    .replace(/\b(access_token|api[_-]?key|password|secret|session|signature|token)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, limit);
}

function combineAbortSignals(owned: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  return caller ? AbortSignal.any([owned, caller]) : owned;
}

async function disposeQuietly(connection: HonuaKernelConnection): Promise<void> {
  try {
    await connection.dispose();
  } catch {
    // The terminal inspection state remains credential-safe and deterministic.
  }
}

function freezeView<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeView(nested);
  return Object.freeze(value);
}
