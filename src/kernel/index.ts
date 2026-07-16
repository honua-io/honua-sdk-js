import {
  type ConnectCacheStatus,
  type ConnectProtocolHint,
  type ConnectResolvedProtocol,
  type HonuaConnection as DiscoveredHonuaConnection,
  validateConnectEndpoint,
} from "../connect.js";
import {
  type DiscoveryCapabilityPolicy,
  type DiscoveryDiagnostic,
  type SourceDiscoveryInspection,
  normalizeDiscoveryEndpoint,
} from "../contract/discovery.js";
import type { Dataset, Source, SourceDescriptor, SourceId } from "../contract/types.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../core/errors.js";
import {
  type KernelConnectOptions,
  type KernelLifecycle,
  type KernelLifecycleOptions,
  createKernelLifecycle,
  disposeKernelConnectionResult,
  snapshotKernelConnectOptions,
} from "./lifecycle.js";
import { snapshotOwnDataArray, snapshotOwnDataObject } from "./stable-data.js";

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

class ManagedHonuaConnection<T> implements HonuaKernelConnection<T> {
  readonly #abortController = new AbortController();
  readonly #lifecycle: KernelLifecycle;
  readonly #endpoint: string;
  readonly #options: KernelConnectOptions;
  readonly #selectedSourceId: SourceId | undefined;
  readonly #secrets: readonly string[];
  readonly #ownedDiscoveries = new Set<DiscoveredHonuaConnection>();
  readonly #cleanupReentryCompletion = Promise.resolve();
  #current: ManagedConnectionState;
  #invokingAdapterCleanup = false;
  #refreshGeneration = 0;
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;
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
    let discovered: DiscoveredHonuaConnection;
    try {
      discovered = await this.#lifecycle.connect(this.#endpoint, {
        ...this.#options,
        refresh: true,
        signal: combineAbortSignals(this.#abortController.signal, signal),
      });
      throwIfAborted(this.#abortController.signal);
      throwIfAborted(signal);
    } catch (error) {
      throw credentialSafeError(error, this.#secrets);
    }

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

  public dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#invokingAdapterCleanup ? this.#cleanupReentryCompletion : this.#disposePromise;
    }
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
        const discoveries = [...this.#ownedDiscoveries];
        this.#ownedDiscoveries.clear();
        for (const discovery of discoveries) {
          try {
            this.#invokingAdapterCleanup = true;
            let result: Promise<void>;
            try {
              result = disposeKernelConnectionResult(discovery);
            } finally {
              this.#invokingAdapterCleanup = false;
            }
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

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertActive(operation: string): void {
    if (this.#state !== "active") {
      throw new Error(`Honua connection cannot ${operation} after disposal has started.`);
    }
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
  while (/[.),\]}]$/.test(candidate)) {
    suffix = `${candidate.at(-1)}${suffix}`;
    candidate = candidate.slice(0, -1);
  }
  try {
    return `${normalizeDiscoveryEndpoint(candidate)}${suffix}`;
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

function combineAbortSignals(owner: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  return caller && caller !== owner ? AbortSignal.any([owner, caller]) : owner;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
