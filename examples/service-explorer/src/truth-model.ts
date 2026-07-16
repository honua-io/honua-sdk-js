import {
  type ConnectLocator,
  type ConnectProtocolHint,
  type ConnectionInspection,
  HonuaAbortError,
  HonuaAuthError,
  HonuaDiscoveryError,
  HonuaHttpError,
  type HonuaKernel,
  type HonuaKernelConnectOptions,
  type HonuaKernelConnection,
  type HonuaKernelOptions,
  createHonua,
  isHonuaError,
} from "@honua/sdk-js";
import type {
  DiscoveryCapabilityDecision,
  DiscoveryCapabilityEvidenceSummary,
  DiscoveryDiagnostic,
  DiscoveryProvenance,
  DiscoveryState,
  SourceDiscoveryInspection,
} from "@honua/sdk-js/contract";
import { PROTOCOLS } from "@honua/sdk-js/contract";

const MAX_ENDPOINT_INPUT_LENGTH = 4_096;
const MAX_SELECTOR_LENGTH = 512;
const MAX_TEXT_LENGTH = 512;
const MAX_SOURCES = 256;
const MAX_FIELDS_PER_SOURCE = 256;
const MAX_CRS_PER_SOURCE = 32;
const MAX_CAPABILITIES_PER_SOURCE = 64;
const MAX_CAPABILITY_DECISIONS_PER_SOURCE = 128;
const MAX_DIAGNOSTICS = 512;
const MAX_PROVENANCE_PER_SOURCE = 32;
const MAX_EXTENTS_PER_SOURCE = 16;
const MAX_PROFILE_ENTRIES = 128;
const MAX_PROFILE_EVIDENCE_PER_ENTRY = 16;
const MAX_PAGINATION_MODES = 16;
const MAX_AUTHORIZATION_SCOPES_PER_CAPABILITY = 32;
const MAX_EVIDENCE_PER_CAPABILITY = 16;
const MAX_REASONS_PER_CAPABILITY = 16;
const MAX_DIAGNOSTIC_CAPABILITIES = 32;
const ENDPOINT_INPUT_KEYS = new Set(["url", "protocol", "sourceId", "collectionId", "typeName"]);
const CONNECT_PROTOCOL_HINTS = new Set<string>(["auto", ...PROTOCOLS]);

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
  /** Transport/cache partition only. Never rendered unless it is an exact SHA-256 identity. */
  readonly authorizationScopeFingerprint?: string;
  /** Optional credential-free structural label rendered instead of the opaque fingerprint. */
  readonly authorizationScopeLabel?: string;
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
  readonly evidenceTruncated: boolean;
}

export interface ServiceExplorerCapabilityProfileEntryView {
  readonly id: string;
  readonly claimed: string;
  readonly observed: string;
  readonly effective: string;
  readonly evidence: readonly ServiceExplorerCapabilityProfileEvidenceView[];
  readonly evidenceTruncated: boolean;
  readonly reasons: readonly string[];
  readonly reasonsTruncated: boolean;
  readonly authorizationScopes: readonly string[];
  readonly authorizationScopesTruncated: boolean;
  readonly pagination?: {
    readonly modes: readonly string[];
    readonly maxPageSize?: number;
    readonly modesTruncated: boolean;
  };
}

export interface ServiceExplorerCapabilityProfileEvidenceView {
  readonly kind: string;
  readonly truth: string;
  readonly reference: string;
  readonly sourceFingerprint?: string;
  readonly observedAt?: string;
  readonly expiresAt?: string;
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
  readonly truncated: boolean;
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
  readonly crsCount: number;
  readonly crs: readonly string[];
  readonly extent?: ServiceExplorerExtentView;
  readonly attribution?: string;
  readonly schema: ServiceExplorerSchemaView;
  readonly effectiveCapabilityCount: number;
  readonly effectiveCapabilities: readonly string[];
  readonly capabilityDecisionCount: number;
  readonly capabilityDecisions: readonly ServiceExplorerCapabilityDecisionView[];
  readonly capabilityProfile?: ServiceExplorerCapabilityProfileView;
  readonly provenanceCount: number;
  readonly provenance: readonly ServiceExplorerProvenanceView[];
  readonly truncated: boolean;
}

export interface ServiceExplorerDiagnosticView {
  readonly scope: "service" | "source" | "projection";
  readonly sourceId?: string;
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly capabilities: readonly string[];
  readonly capabilitiesTruncated: boolean;
}

export interface ServiceExplorerInspectionView {
  readonly service: {
    readonly id: string;
    readonly endpoint: string;
    readonly protocol: string;
    readonly protocolHint: string;
    readonly detection: {
      readonly requestedProtocolHint: string;
      readonly resolvedProtocol: string;
      /** The public kernel currently exposes evidence, but no numeric or categorical detector confidence. */
      readonly confidence: "not-reported";
    };
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
    readonly selectedSourceVisible: boolean;
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
    try {
      listener(this.#state);
    } catch {
      // Listener failures belong to the presentation host, not discovery.
    }
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
    const inputSnapshot = snapshotEndpointInput(input);
    const request = createRequestView(
      generation,
      inputSnapshot.input,
      options.authorizationScopeFingerprint,
      options.authorizationScopeLabel,
    );
    const previous = this.#activeConnection;
    this.#activeConnection = undefined;
    this.#publish(freezeView({ kind: "loading", request }));

    if (previous) await disposeQuietly(previous);
    if (signal.aborted) {
      const state = cancelledState(request);
      if (generation === this.#generation) {
        if (isPublishedCancellation(this.#state, request.id)) return this.#state;
        this.#publish(state);
      }
      return state;
    }
    if (inputSnapshot.failure) {
      const state = freezeView({
        kind: "error",
        request,
        failure: inputSnapshot.failure,
      } satisfies ServiceExplorerFailureState);
      if (generation === this.#generation) this.#publish(state);
      return state;
    }

    let connection: HonuaKernelConnection | undefined;
    try {
      signal.throwIfAborted();
      connection = await this.#honua.connect(createLocator(inputSnapshot.input), createConnectOptions(options, signal));
      const inspection = await connection.inspect({ signal });
      signal.throwIfAborted();
      const view = projectInspection(connection, inspection, request);
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
      if (generation === this.#generation) {
        if (terminal.kind === "cancelled" && isPublishedCancellation(this.#state, request.id)) return this.#state;
        this.#publish(terminal);
      }
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
    // Publish the idempotent completion before invoking foreign cleanup. A
    // managed connection may synchronously call application hooks while its
    // disposal starts; those hooks must observe an already-disposing model.
    this.#disposePromise = Promise.resolve().then(() =>
      disposeOwnedResources(connection, this.#ownsHonua ? this.#honua : undefined),
    );
    return this.#disposePromise;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #publish(state: ServiceExplorerTruthState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // Presentation failures must not change discovery truth or leak into
        // the kernel lifecycle. Hosts own their listener diagnostics.
      }
    }
  }

  #assertActive(): void {
    if (this.#disposePromise) throw new Error("Service Explorer truth model is disposed.");
  }
}

interface EndpointInputSnapshot {
  readonly input: ServiceExplorerEndpointInput;
  readonly failure?: ServiceExplorerFailureView;
}

function snapshotEndpointInput(foreign: ServiceExplorerEndpointInput): EndpointInputSnapshot {
  if (foreign === null || typeof foreign !== "object" || Array.isArray(foreign)) {
    return invalidInputSnapshot("input.invalid-endpoint", "Invalid endpoint", "Enter a bounded HTTP(S) service URL.");
  }
  const values: Record<string, unknown> = Object.create(null);
  try {
    const prototype = Object.getPrototypeOf(foreign);
    const keys = Reflect.ownKeys(foreign);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length > ENDPOINT_INPUT_KEYS.size ||
      keys.some((key) => typeof key !== "string" || !ENDPOINT_INPUT_KEYS.has(key))
    ) {
      return invalidInputSnapshot(
        "input.invalid-shape",
        "Invalid endpoint input",
        "Endpoint input must contain only URL and source-selection fields.",
      );
    }
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(foreign, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        return invalidInputSnapshot(
          "input.invalid-shape",
          "Invalid endpoint input",
          "Endpoint input accessors are not accepted.",
        );
      }
      values[key] = descriptor.value;
    }
  } catch {
    return invalidInputSnapshot(
      "input.invalid-shape",
      "Invalid endpoint input",
      "Endpoint input could not be inspected safely.",
    );
  }

  const url = values.url;
  if (typeof url !== "string" || !validEndpointInput(url)) {
    return invalidInputSnapshot("input.invalid-endpoint", "Invalid endpoint", "Enter a bounded HTTP(S) service URL.");
  }
  const canonical = canonicalEndpointForKernel(url);
  if ("failure" in canonical)
    return invalidInputSnapshot(canonical.failure.code, "Invalid endpoint", canonical.failure.detail);
  const input: {
    url: string;
    protocol?: ConnectProtocolHint;
    sourceId?: string;
    collectionId?: string;
    typeName?: string;
  } = { url: canonical.url };
  const protocol = values.protocol;
  if (protocol !== undefined) {
    if (typeof protocol !== "string" || !CONNECT_PROTOCOL_HINTS.has(protocol)) {
      return invalidInputSnapshot(
        "input.invalid-protocol",
        "Invalid protocol hint",
        "Choose auto or a public SDK protocol identifier.",
        { url: canonical.url },
      );
    }
    input.protocol = protocol as ConnectProtocolHint;
  }
  for (const key of ["sourceId", "collectionId", "typeName"] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_SELECTOR_LENGTH ||
      value.trim() !== value ||
      hasUnsafeControl(value)
    ) {
      return invalidInputSnapshot(
        `input.invalid-${key.toLowerCase()}`,
        "Invalid source selector",
        `${key} must be a bounded, non-empty, trimmed string.`,
        input,
      );
    }
    input[key] = value;
  }
  return freezeView({ input: freezeView(input) });
}

function invalidInputSnapshot(
  code: string,
  title: string,
  detail: string,
  input: ServiceExplorerEndpointInput = { url: "" },
): EndpointInputSnapshot {
  return freezeView({ input: freezeView({ ...input }), failure: failure(code, title, detail, false) });
}

function validEndpointInput(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > MAX_ENDPOINT_INPUT_LENGTH ||
    value.trim() !== value ||
    hasUnsafeControl(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function hasUnsafeControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function canonicalEndpointForKernel(
  value: string,
): { readonly url: string } | { readonly failure: { readonly code: string; readonly detail: string } } {
  const endpoint = new URL(value);
  const removableFormatQuery =
    endpoint.searchParams.size > 0 &&
    [...endpoint.searchParams].every(
      ([name, queryValue]) =>
        (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
        (queryValue.toLowerCase() === "json" || queryValue.toLowerCase() === "pjson"),
    );
  if (endpoint.hash || (endpoint.search && !removableFormatQuery)) {
    return {
      failure: {
        code: "input.identity-bearing-endpoint",
        detail:
          "Remove fragments and identity-bearing query parameters. Configure authentication separately; only f/format=json/pjson discovery controls are removable.",
      },
    };
  }
  if (removableFormatQuery) endpoint.search = "";
  while (endpoint.pathname.length > 1 && endpoint.pathname.endsWith("/")) {
    endpoint.pathname = endpoint.pathname.slice(0, -1);
  }
  const normalized = endpoint.toString();
  return { url: normalized.endsWith("/") ? normalized.slice(0, -1) : normalized };
}

function createRequestView(
  id: number,
  input: ServiceExplorerEndpointInput,
  authorizationScopeFingerprint: string | undefined,
  authorizationScopeLabel: string | undefined,
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
    authorization: authorizationView(authorizationScopeFingerprint, authorizationScopeLabel),
  });
}

function authorizationView(fingerprint: unknown, displayLabel: unknown): ServiceExplorerAuthorizationView {
  const anonymous =
    fingerprint === undefined || fingerprint === "" || fingerprint === "public" || fingerprint === "anonymous";
  const label = anonymous ? "public" : safeAuthorizationIdentity(fingerprint, displayLabel);
  return freezeView({
    mode: anonymous ? "anonymous" : "scoped",
    scopeIdentity: label,
    credentialsRetained: false,
  });
}

function safeAuthorizationIdentity(fingerprint: unknown, displayLabel: unknown): string {
  const structuralLabel = safeScopeIdentity(displayLabel);
  if (structuralLabel !== "[configured]") return structuralLabel;
  if (typeof fingerprint === "string" && /^sha256:[0-9a-f]{64}$/i.test(fingerprint)) return fingerprint.toLowerCase();
  return "[configured]";
}

function safeScopeIdentity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ||
    /(?:bearer|password|secret|token|api[_-]?key|session|signature|jwt)/i.test(value)
  ) {
    return "[configured]";
  }
  return value;
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

function createConnectOptions(options: ServiceExplorerInspectOptions, signal: AbortSignal): HonuaKernelConnectOptions {
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
): ServiceExplorerInspectionView {
  const inspectedDefaultSourceId = inspection.defaultSourceId;
  const visibleInspections = inspection.sources.slice(0, MAX_SOURCES);
  const selectedSourceVisible =
    inspectedDefaultSourceId !== undefined &&
    visibleInspections.some((source) => source.descriptor.id === inspectedDefaultSourceId);
  const invalidDefaultSource =
    inspectedDefaultSourceId !== undefined && !selectedSourceVisible && inspection.sources.length <= MAX_SOURCES;
  const selectedSourceId = invalidDefaultSource ? undefined : inspectedDefaultSourceId;
  const sources = visibleInspections.map(projectSource);
  const diagnostics = projectDiagnostics(
    inspection,
    visibleInspections,
    sources,
    inspection.sources.length > MAX_SOURCES,
    invalidDefaultSource,
  );
  const evidenceStates = [...new Set(visibleInspections.map((source) => source.discovery))].sort();
  return freezeView({
    service: {
      id: safeText(inspection.id),
      endpoint: safeEndpoint(inspection.endpoint),
      protocol: safeText(inspection.protocol, 64),
      protocolHint: request.protocolHint,
      detection: {
        requestedProtocolHint: request.protocolHint,
        resolvedProtocol: safeText(inspection.protocol, 64),
        confidence: "not-reported",
      },
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
      selectedSourceVisible,
      selectionRequired: inspection.sources.length > 1 && selectedSourceId === undefined,
    },
    sources,
    diagnostics,
    truncated:
      inspection.sources.length > MAX_SOURCES ||
      diagnostics.some((entry) => entry.code.startsWith("explorer.") || entry.capabilitiesTruncated),
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
  const allCrs = inspection.metadata?.crs ?? [];
  const crs = allCrs.slice(0, MAX_CRS_PER_SOURCE).map((entry) => safeText(entry, 256));
  const extent = inspection.metadata?.extent ? projectExtent(inspection.metadata.extent) : undefined;
  const effectiveCapabilityCount = descriptor.capabilities.size;
  const effectiveCapabilities: string[] = [];
  for (const capability of descriptor.capabilities) {
    if (effectiveCapabilities.length >= MAX_CAPABILITIES_PER_SOURCE) break;
    effectiveCapabilities.push(safeText(capability, 128));
  }
  const capabilityDecisions = inspection.capabilityDecisions
    .slice(0, MAX_CAPABILITY_DECISIONS_PER_SOURCE)
    .map(projectCapabilityDecision);
  const capabilityProfile = descriptor.capabilityProfile
    ? projectCapabilityProfile(descriptor.capabilityProfile)
    : undefined;
  const provenance = inspection.provenance.slice(0, MAX_PROVENANCE_PER_SOURCE).map(projectProvenance);
  const truncated =
    schemaView.truncated ||
    allCrs.length > MAX_CRS_PER_SOURCE ||
    effectiveCapabilityCount > MAX_CAPABILITIES_PER_SOURCE ||
    inspection.capabilityDecisions.length > MAX_CAPABILITY_DECISIONS_PER_SOURCE ||
    capabilityDecisions.some((decision) => decision.evidenceTruncated) ||
    capabilityProfile?.truncated === true ||
    inspection.provenance.length > MAX_PROVENANCE_PER_SOURCE ||
    extent?.truncated === true;
  return freezeView({
    id: safeText(descriptor.id),
    protocol: safeText(descriptor.protocol, 64),
    locator: projectLocator(descriptor.locator),
    discovery: inspection.discovery,
    crsCount: allCrs.length,
    crs,
    ...(extent ? { extent } : {}),
    ...(descriptor.attribution ? { attribution: safeText(descriptor.attribution) } : {}),
    schema: schemaView,
    effectiveCapabilityCount,
    effectiveCapabilities: effectiveCapabilities.sort(),
    capabilityDecisionCount: inspection.capabilityDecisions.length,
    capabilityDecisions,
    ...(capabilityProfile ? { capabilityProfile } : {}),
    provenanceCount: inspection.provenance.length,
    provenance,
    truncated,
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

function projectExtent(
  extent: NonNullable<SourceDiscoveryInspection["metadata"]>["extent"],
): ServiceExplorerExtentView {
  const bboxes = extent?.spatial?.bbox ?? [];
  const intervals = extent?.temporal?.interval ?? [];
  const visibleBboxes = bboxes.slice(0, MAX_EXTENTS_PER_SOURCE);
  const visibleIntervals = intervals.slice(0, MAX_EXTENTS_PER_SOURCE);
  return freezeView({
    ...(extent?.spatial
      ? {
          spatial: {
            bbox: visibleBboxes.map((bbox) => bbox.slice(0, 6)),
            ...(extent.spatial.crs ? { crs: safeText(extent.spatial.crs, 256) } : {}),
          },
        }
      : {}),
    ...(extent?.temporal
      ? {
          temporal: {
            interval: visibleIntervals.map((interval) =>
              interval.slice(0, 2).map((value) => (value === null ? null : safeText(value, 128))),
            ),
            ...(extent.temporal.trs ? { trs: safeText(extent.temporal.trs, 256) } : {}),
          },
        }
      : {}),
    truncated:
      bboxes.length > MAX_EXTENTS_PER_SOURCE ||
      intervals.length > MAX_EXTENTS_PER_SOURCE ||
      visibleBboxes.some((bbox) => bbox.length > 6) ||
      visibleIntervals.some((interval) => interval.length > 2),
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
    evidenceTruncated: decision.evidence.length > MAX_EVIDENCE_PER_CAPABILITY,
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
  let paginationTruncated = false;
  let reasonsTruncated = false;
  let evidenceTruncated = false;
  let authorizationScopesTruncated = false;
  const entries = profile.entries.slice(0, MAX_PROFILE_ENTRIES).map((entry) => {
    const pagination = entry.constraints?.pagination;
    const authorizationScopes = entry.authorizationScopes ?? [];
    if ((pagination?.modes.length ?? 0) > MAX_PAGINATION_MODES) paginationTruncated = true;
    if (entry.reasons.length > MAX_REASONS_PER_CAPABILITY) reasonsTruncated = true;
    if (entry.evidence.length > MAX_PROFILE_EVIDENCE_PER_ENTRY) evidenceTruncated = true;
    if (authorizationScopes.length > MAX_AUTHORIZATION_SCOPES_PER_CAPABILITY) {
      authorizationScopesTruncated = true;
    }
    return {
      id: safeText(entry.id, 128),
      claimed: entry.claimed,
      observed: entry.observed,
      effective: entry.effective,
      evidence: entry.evidence.slice(0, MAX_PROFILE_EVIDENCE_PER_ENTRY).map(projectProfileEvidence),
      evidenceTruncated: entry.evidence.length > MAX_PROFILE_EVIDENCE_PER_ENTRY,
      reasons: entry.reasons.slice(0, MAX_REASONS_PER_CAPABILITY).map((reason) => safeText(reason, 256)),
      reasonsTruncated: entry.reasons.length > MAX_REASONS_PER_CAPABILITY,
      authorizationScopes: authorizationScopes
        .slice(0, MAX_AUTHORIZATION_SCOPES_PER_CAPABILITY)
        .map((scope) => safeScopeIdentity(scope)),
      authorizationScopesTruncated: authorizationScopes.length > MAX_AUTHORIZATION_SCOPES_PER_CAPABILITY,
      ...(pagination
        ? {
            pagination: {
              modes: pagination.modes.slice(0, MAX_PAGINATION_MODES).map((mode) => safeText(mode, 64)),
              ...(pagination.maxPageSize !== undefined ? { maxPageSize: pagination.maxPageSize } : {}),
              modesTruncated: pagination.modes.length > MAX_PAGINATION_MODES,
            },
          }
        : {}),
    };
  });
  return freezeView({
    fingerprint: safeText(profile.fingerprint, 128),
    evidenceFingerprint: safeText(profile.evidenceFingerprint, 128),
    evaluatedAt: profile.evaluatedAt === null ? null : safeText(profile.evaluatedAt, 128),
    validUntil: profile.validUntil === null ? null : safeText(profile.validUntil, 128),
    entries,
    truncated:
      profile.entries.length > MAX_PROFILE_ENTRIES ||
      paginationTruncated ||
      reasonsTruncated ||
      evidenceTruncated ||
      authorizationScopesTruncated,
  });
}

function projectProfileEvidence(
  evidence: NonNullable<
    SourceDiscoveryInspection["descriptor"]["capabilityProfile"]
  >["entries"][number]["evidence"][number],
): ServiceExplorerCapabilityProfileEvidenceView {
  return freezeView({
    kind: safeText(evidence.kind, 64),
    truth: safeText(evidence.truth, 64),
    reference: safeEvidenceReference(evidence.reference),
    ...(evidence.sourceFingerprint ? { sourceFingerprint: safeText(evidence.sourceFingerprint, 128) } : {}),
    ...(evidence.kind === "metadata" || evidence.kind === "conformance" || evidence.kind === "probe"
      ? {
          observedAt: safeText(evidence.observedAt, 128),
          expiresAt: safeText(evidence.expiresAt, 128),
        }
      : {}),
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
  projectedSources: readonly ServiceExplorerSourceView[],
  sourceLimitExceeded: boolean,
  invalidDefaultSource: boolean,
): readonly ServiceExplorerDiagnosticView[] {
  const diagnostics: ServiceExplorerDiagnosticView[] = [];
  let diagnosticsTruncated = false;
  const append = (entry: ServiceExplorerDiagnosticView): boolean => {
    if (diagnostics.length >= MAX_DIAGNOSTICS - 1) {
      diagnosticsTruncated = true;
      return false;
    }
    diagnostics.push(entry);
    return true;
  };
  for (const entry of inspection.diagnostics) {
    if (!append(projectDiagnostic("service", entry))) break;
  }
  for (const [index, source] of sources.entries()) {
    if (diagnosticsTruncated) break;
    for (const diagnostic of source.diagnostics) {
      if (!append(projectDiagnostic("source", diagnostic, source.descriptor.id))) break;
    }
    if ((source.descriptor.schema?.fields?.length ?? 0) > MAX_FIELDS_PER_SOURCE) {
      append(
        freezeView({
          scope: "projection",
          sourceId: safeText(source.descriptor.id),
          code: "explorer.field-limit",
          severity: "warning",
          message: `Only the first ${MAX_FIELDS_PER_SOURCE} inspected fields are visible.`,
          capabilities: [],
          capabilitiesTruncated: false,
        }),
      );
    }
    if (projectedSources[index]?.truncated) {
      append(
        freezeView({
          scope: "projection",
          sourceId: safeText(source.descriptor.id),
          code: "explorer.source-projection-limit",
          severity: "warning",
          message: "One or more inspected source collections were bounded for renderer projection.",
          capabilities: [],
          capabilitiesTruncated: false,
        }),
      );
    }
  }
  if (sourceLimitExceeded) {
    append(
      freezeView({
        scope: "projection",
        code: "explorer.source-limit",
        severity: "warning",
        message: `Only the first ${MAX_SOURCES} inspected sources are visible.`,
        capabilities: [],
        capabilitiesTruncated: false,
      }),
    );
  }
  if (invalidDefaultSource) {
    append(
      freezeView({
        scope: "projection",
        code: "explorer.invalid-default-source",
        severity: "warning",
        message: "The inspected default source was not present in the inspected source collection.",
        capabilities: [],
        capabilitiesTruncated: false,
      }),
    );
  }
  if (diagnosticsTruncated) {
    diagnostics.push(
      freezeView({
        scope: "projection",
        code: "explorer.diagnostic-limit",
        severity: "warning",
        message: `Only the first ${MAX_DIAGNOSTICS - 1} diagnostics are visible.`,
        capabilities: [],
        capabilitiesTruncated: false,
      }),
    );
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
    capabilities: (diagnostic.capabilities ?? [])
      .slice(0, MAX_DIAGNOSTIC_CAPABILITIES)
      .map((capability) => safeText(capability, 128)),
    capabilitiesTruncated: (diagnostic.capabilities?.length ?? 0) > MAX_DIAGNOSTIC_CAPABILITIES,
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
  if (inspection.truncated || inspection.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
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

function isPublishedCancellation(
  state: ServiceExplorerTruthState,
  requestId: number,
): state is ServiceExplorerFailureState & { readonly kind: "cancelled" } {
  return state.kind === "cancelled" && state.request.id === requestId;
}

function failure(code: string, title: string, detail: string, retryable: boolean): ServiceExplorerFailureView {
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

function safeEvidenceReference(value: unknown): string {
  if (typeof value !== "string") return "[invalid text]";
  if (/^https?:\/\//i.test(value)) return safeText(safeEndpoint(value), 256);
  return safeText(value, 256);
}

function safeSelector(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return safeText(value, MAX_SELECTOR_LENGTH);
}

function safeText(value: unknown, limit = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") return "[invalid text]";
  let withoutControls = "";
  for (const character of value.slice(0, limit * 4)) {
    const code = character.charCodeAt(0);
    withoutControls +=
      code <= 8 || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127 ? "�" : character;
  }
  return withoutControls
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted-auth]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\b(?:gh[pousr]_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, "[redacted-provider-token]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-jwt]")
    .replace(
      /\b(access[-_]?key|access[-_]?token|api[-_]?key|authorization|aws[-_]?secret[-_]?access[-_]?key|bearer|client[-_]?secret|cookie|credential|pass(?:word)?|proxy[-_]?authorization|pwd|secret|session|set[-_]?cookie|signature|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s&,;}]+)/gi,
      "$1=[redacted]",
    )
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

async function disposeOwnedResources(
  connection: HonuaKernelConnection | undefined,
  honua: HonuaKernel | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  if (connection) {
    try {
      await connection.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (honua) {
    try {
      await honua.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Service Explorer truth-model disposal failed.");
}

function freezeView<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) freezeView(nested);
  return Object.freeze(value);
}
