import {
  type ConnectDiscoveryCache,
  type ConnectDiscoveryCacheContext,
  type ConnectDiscoverySnapshot,
  type ConnectOptions,
  type ConnectProtocolHint,
  type HonuaConnection,
  connect as discoverConnection,
  validateConnectEndpoint,
} from "../connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityPolicy } from "../contract/discovery.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../core/errors.js";
import { snapshotOwnDataArray, snapshotOwnDataObject } from "./stable-data.js";

const DEFAULT_DISCOVERY_CACHE_MAX_ENTRIES = 256;

/**
 * @internal Cleanup callback owned by one kernel lifecycle.
 *
 * A callback that needs to acknowledge owner disposal must call `dispose()`
 * synchronously before its first async boundary; that reentrant call receives
 * a settled acknowledgement. Returning or awaiting a previously captured
 * owner completion is invalid because it makes the owner await itself.
 */
export type KernelOwnedCleanup = () => void | PromiseLike<void>;

/** @internal Resource shapes the kernel can dispose without guessing at host-specific lifecycle methods. */
export type KernelOwnedResource =
  | KernelOwnedCleanup
  | { readonly [Symbol.asyncDispose]: () => PromiseLike<void> }
  | { readonly dispose: () => void | PromiseLike<void> }
  | { readonly [Symbol.dispose]: () => void };

/** @internal Immutable policy state owned by one kernel instance. */
export interface KernelPolicySnapshot {
  readonly capabilities: Readonly<DiscoveryCapabilityPolicy>;
}

/** @internal Kernel-owned projection over the standalone discovery options. */
export type KernelConnectOptions = Omit<
  ConnectOptions,
  "endpoint" | "protocol" | "authorizationScopeFingerprint" | "capabilityPolicy" | "cache" | "signal"
> & {
  /** Forwarded unchanged; omission delegates structural recognition as `auto`. */
  readonly protocol?: ConnectProtocolHint;
  /** Stable ACL/audience partition. Omit only for structurally anonymous discovery. */
  readonly authorizationScopeFingerprint?: string;
  readonly signal?: AbortSignal;
};

/** @internal Existing discovery seam used by the kernel without reimplementing protocol recognition. */
export type KernelConnectDelegate = (options: ConnectOptions) => Promise<HonuaConnection>;

/** @internal Construction options for the lifecycle substrate used by `createHonua()`. */
export interface KernelLifecycleOptions {
  readonly capabilityPolicy?: DiscoveryCapabilityPolicy;
  readonly discoveryCacheMaxEntries?: number;
  /** Test/adapter seam; the production default is the standalone `connect()` path. */
  readonly connectDelegate?: KernelConnectDelegate;
}

/**
 * Instance-local lifecycle substrate for the application kernel.
 *
 * This stays internal until the complete `createHonua().connect()` facade is
 * available. It centralizes ownership so later facade slices cannot
 * accidentally share caches, policy arrays, cancellation, or leaf resources
 * between kernels.
 *
 * @internal
 */
export class KernelLifecycle implements AsyncDisposable {
  readonly #abortController = new AbortController();
  readonly #resources = new KernelResourceRegistry();
  readonly #connectDelegate: KernelConnectDelegate;
  readonly policy: KernelPolicySnapshot;
  readonly discoveryCache: ConnectDiscoveryCache;
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;

  public constructor(options: KernelLifecycleOptions = {}) {
    const snapshot = snapshotOwnDataObject(options, "Kernel lifecycle options");
    const connectDelegate = snapshot.connectDelegate;
    if (connectDelegate !== undefined && typeof connectDelegate !== "function") {
      throw new TypeError("connectDelegate must be a function.");
    }
    this.#connectDelegate = (connectDelegate as KernelConnectDelegate | undefined) ?? discoverConnection;
    this.policy = Object.freeze({
      capabilities: normalizeCapabilityPolicy(snapshot.capabilityPolicy),
    });
    const cache = new KernelDiscoveryCache(
      normalizeCacheBound(snapshot.discoveryCacheMaxEntries as number | undefined),
      this.#abortController.signal,
    );
    this.discoveryCache = cache;
    this.#resources.own(cache);
  }

  /** Cancellation root inherited by work started by this kernel. */
  public get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  public get state(): "active" | "disposing" | "disposed" {
    return this.#state;
  }

  /**
   * Delegate discovery through the standalone connect path while binding the
   * kernel's cache, policy, and cancellation root. Protocol classification is
   * deliberately left to that path so new reviewed adapters flow through
   * without a second detector or lifecycle change.
   */
  public async connect(locator: string | URL, options: KernelConnectOptions = {}): Promise<HonuaConnection> {
    this.#assertActive("connect");
    const snapshot = snapshotKernelConnectOptions(options);
    const endpoint = normalizeKernelEndpoint(locator, snapshot.protocol);
    // Reflection on caller-controlled objects can reenter disposal through a
    // Proxy trap. Never delegate work after that transition.
    this.#assertActive("connect");
    const authorizationScopeFingerprint = resolveKernelAuthorizationScope(snapshot);
    const signal = combineAbortSignals(this.signal, snapshot.signal);
    let connection: HonuaConnection;
    try {
      connection = await this.#connectDelegate({
        ...snapshot,
        endpoint,
        protocol: snapshot.protocol ?? "auto",
        authorizationScopeFingerprint,
        capabilityPolicy: this.policy.capabilities,
        cache: this.discoveryCache,
        signal,
      });
    } catch (error) {
      if (signal.aborted || this.#state !== "active") throw new HonuaAbortError();
      throw error;
    }
    if (signal.aborted || this.#state !== "active") {
      try {
        await disposeKernelConnectionResult(connection);
      } catch {
        throw new HonuaAbortError("Honua connection was cancelled and its delegated resource cleanup failed");
      }
      throw new HonuaAbortError();
    }
    return connection;
  }

  /** @internal Guard facade work before it reflects over caller-controlled input. */
  public assertActive(operation: string): void {
    this.#assertActive(operation);
  }

  /** Register a resource as owned by this kernel and return it unchanged. */
  public own<T extends KernelOwnedResource>(resource: T): T {
    this.#assertActive("own resources");
    return this.#resources.own(resource);
  }

  /**
   * Transfer or independently dispose a resource so kernel disposal no longer
   * invokes it. Returns whether this kernel previously owned the resource.
   */
  public release(resource: KernelOwnedResource): boolean {
    return this.#resources.release(resource);
  }

  /**
   * Abort owned work once, then dispose leaf resources in reverse ownership
   * order. Concurrent and repeated calls outside an owned cleanup share the
   * exact same completion. A cleanup that synchronously reenters disposal gets
   * a settled acknowledgement so it cannot await the owner that is awaiting it.
   */
  public dispose(): Promise<void> {
    if (this.#disposePromise) {
      return this.#resources.cleanupReentryCompletion() ?? this.#disposePromise;
    }
    this.#state = "disposing";

    let beginResourceDisposal: () => void = () => undefined;
    const resourceDisposalGate = new Promise<void>((resolve) => {
      beginResourceDisposal = resolve;
    });
    const completion = resourceDisposalGate
      .then(() => {
        const ownerCompletion = this.#disposePromise;
        if (!ownerCompletion) throw new Error("Honua kernel disposal completion was not published.");
        return this.#resources.dispose(ownerCompletion);
      })
      .then(
        () => {
          this.#state = "disposed";
        },
        (error: unknown) => {
          this.#state = "disposed";
          throw error;
        },
      );
    this.#disposePromise = completion;

    try {
      this.#abortController.abort(new HonuaAbortError("Honua kernel was disposed"));
    } finally {
      beginResourceDisposal();
    }
    return completion;
  }

  public [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertActive(operation: string): void {
    if (this.#state !== "active") {
      throw new Error(`Honua kernel cannot ${operation} after disposal has started.`);
    }
  }
}

/** @internal Create the lifecycle state that the public kernel facade will own. */
export function createKernelLifecycle(options: KernelLifecycleOptions = {}): KernelLifecycle {
  return new KernelLifecycle(options);
}

class KernelResourceRegistry {
  readonly #owned = new Map<KernelOwnedResource, KernelOwnedCleanup>();
  readonly #reentryCompletion = Promise.resolve();
  #invokingCleanup = false;
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;

  public own<T extends KernelOwnedResource>(resource: T): T {
    if (this.#state !== "active") {
      throw new Error("Honua kernel cannot own resources after disposal has started.");
    }
    if (!this.#owned.has(resource)) this.#owned.set(resource, cleanupFor(resource));
    return resource;
  }

  public release(resource: KernelOwnedResource): boolean {
    if (this.#state !== "active") return false;
    return this.#owned.delete(resource);
  }

  /** Settled view returned only to disposal reentry on the cleanup's synchronous stack. */
  public cleanupReentryCompletion(): Promise<void> | undefined {
    return this.#invokingCleanup ? this.#reentryCompletion : undefined;
  }

  public dispose(ownerCompletion: Promise<void>): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#state = "disposing";
    const cleanups = [...this.#owned.values()].reverse();
    this.#owned.clear();
    const completion = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const cleanup of cleanups) {
        try {
          this.#invokingCleanup = true;
          let result: void | PromiseLike<void>;
          try {
            result = cleanup();
          } finally {
            this.#invokingCleanup = false;
          }
          // A callback that directly returns a previously captured owner
          // completion would still create a self-cycle. Synchronous calls to
          // owner.dispose() made during invocation receive #reentryCompletion
          // instead, including promises that an async callback adopts.
          if (result !== ownerCompletion) await result;
        } catch (error) {
          failures.push(error);
        }
      }
      this.#state = "disposed";
      if (failures.length > 0) {
        throw new AggregateError(failures, "Honua kernel resource disposal failed");
      }
    });
    this.#disposePromise = completion;
    return completion;
  }
}

class KernelDiscoveryCache implements ConnectDiscoveryCache, Disposable {
  readonly #entries = new Map<string, ConnectDiscoverySnapshot>();
  #disposed = false;

  public constructor(
    private readonly maxEntries: number,
    private readonly ownerSignal: AbortSignal,
  ) {}

  public get(
    identity: DiscoveryCacheIdentity,
    context: ConnectDiscoveryCacheContext,
  ): ConnectDiscoverySnapshot | undefined {
    this.#assertUsable(context, "read");
    const value = this.#entries.get(identity.key);
    if (value) {
      // Reinsert on access so bounded eviction is least-recently-used.
      this.#entries.delete(identity.key);
      this.#entries.set(identity.key, value);
    }
    return value;
  }

  public set(
    identity: DiscoveryCacheIdentity,
    snapshot: ConnectDiscoverySnapshot,
    context: ConnectDiscoveryCacheContext,
  ): void {
    this.#assertUsable(context, "write");
    this.#entries.delete(identity.key);
    this.#entries.set(identity.key, snapshot);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  public [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#entries.clear();
  }

  #assertUsable(context: ConnectDiscoveryCacheContext, operation: "read" | "write"): void {
    if (this.#disposed) {
      throw new Error(`Honua kernel discovery cache cannot ${operation} after disposal.`);
    }
    if (this.ownerSignal.aborted || context.signal?.aborted) throw new HonuaAbortError();
  }
}

function cleanupFor(resource: KernelOwnedResource): KernelOwnedCleanup {
  if (typeof resource === "function") return resource;
  const cleanup = optionalCleanupFor(resource);
  if (cleanup) return cleanup;
  throw new TypeError("Kernel-owned resources must expose dispose, Symbol.dispose, or Symbol.asyncDispose.");
}

async function cleanupOptionalResource(resource: unknown): Promise<void> {
  if ((typeof resource !== "object" || resource === null) && typeof resource !== "function") return;
  const cleanup = optionalCleanupFor(resource as object);
  if (cleanup) await cleanup();
}

function optionalCleanupFor(resource: object): KernelOwnedCleanup | undefined {
  const asyncDispose = stableResourceMethod(resource, Symbol.asyncDispose);
  if (asyncDispose) return () => Reflect.apply(asyncDispose, resource, []) as PromiseLike<void>;
  const dispose = stableResourceMethod(resource, "dispose");
  if (dispose) return () => Reflect.apply(dispose, resource, []) as void | PromiseLike<void>;
  const symbolDispose = stableResourceMethod(resource, Symbol.dispose);
  if (symbolDispose) return () => Reflect.apply(symbolDispose, resource, []) as void;
  return undefined;
}

function stableResourceMethod(resource: object, key: PropertyKey): ((...args: never[]) => unknown) | undefined {
  try {
    let cursor: object | null = resource;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) {
        return "value" in descriptor && typeof descriptor.value === "function" ? descriptor.value : undefined;
      }
      cursor = Object.getPrototypeOf(cursor) as object | null;
    }
    return undefined;
  } catch {
    throw new TypeError("Kernel resource disposal methods must be stable data properties.");
  }
}

function normalizeCapabilityPolicy(policy: unknown): Readonly<DiscoveryCapabilityPolicy> {
  if (policy === undefined) return Object.freeze({});
  const snapshot = snapshotOwnDataObject(policy, "capabilityPolicy");
  const allow = snapshotCapabilityList(snapshot.allow, "capabilityPolicy.allow");
  const deny = snapshotCapabilityList(snapshot.deny, "capabilityPolicy.deny");
  const acceptInferred = snapshot.acceptInferred;
  if (acceptInferred !== undefined && typeof acceptInferred !== "boolean") {
    throw new TypeError("capabilityPolicy.acceptInferred must be a boolean.");
  }
  return Object.freeze({
    ...(allow ? { allow } : {}),
    ...(deny ? { deny } : {}),
    ...(acceptInferred !== undefined ? { acceptInferred } : {}),
  });
}

function snapshotCapabilityList(value: unknown, label: string): DiscoveryCapabilityPolicy["allow"] {
  if (value === undefined) return undefined;
  const input = snapshotOwnDataArray(value, label);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const capability = input[index];
    if (typeof capability !== "string") throw new TypeError(`${label} must contain capability names.`);
    if (!seen.has(capability)) {
      seen.add(capability);
      unique.push(capability);
    }
  }
  return Object.freeze(unique) as DiscoveryCapabilityPolicy["allow"];
}

function normalizeCacheBound(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DISCOVERY_CACHE_MAX_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("discoveryCacheMaxEntries must be a positive safe integer.");
  }
  return value;
}

function resolveKernelAuthorizationScope(options: KernelConnectOptions): string {
  const explicit = options.authorizationScopeFingerprint;
  let scope: string | undefined;
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || explicit.trim().length === 0) {
      throw new HonuaDiscoveryError(
        "invalid-cache-identity",
        "authorizationScopeFingerprint must be a non-empty opaque fingerprint.",
        { name: "authorizationScopeFingerprint" },
      );
    }
    scope = explicit.trim();
  }
  if (hasScopeSensitiveDiscoveryConfiguration(options)) {
    if (scope === undefined || scope === "anonymous") {
      throw new HonuaDiscoveryError(
        "invalid-cache-identity",
        "kernel.connect() requires a non-anonymous authorizationScopeFingerprint when credentials or caller-controlled discovery transport hooks are configured.",
        { name: "authorizationScopeFingerprint", required: true },
      );
    }
    return scope;
  }
  return scope ?? "anonymous";
}

function hasScopeSensitiveDiscoveryConfiguration(options: KernelConnectOptions): boolean {
  const clientOptions = options.clientOptions;
  return (
    options.client !== undefined ||
    clientOptions?.apiKey !== undefined ||
    clientOptions?.bearerToken !== undefined ||
    clientOptions?.auth !== undefined ||
    clientOptions?.fetchFn !== undefined ||
    (clientOptions?.interceptors !== undefined && clientOptions.interceptors.length > 0) ||
    options.geoparquet?.profiler !== undefined
  );
}

function combineAbortSignals(owner: AbortSignal, caller: AbortSignal | undefined): AbortSignal {
  return caller && caller !== owner ? AbortSignal.any([owner, caller]) : owner;
}

function normalizeKernelEndpoint(locator: string | URL, protocol: ConnectProtocolHint | undefined): string {
  if (typeof locator === "string") return validateConnectEndpoint(locator, protocol ?? "auto");
  try {
    return validateConnectEndpoint(URL.prototype.toString.call(locator), protocol ?? "auto");
  } catch (error) {
    if (error instanceof HonuaDiscoveryError) throw error;
    throw new HonuaDiscoveryError("invalid-endpoint", "kernel.connect() requires an absolute HTTP(S) URL locator.");
  }
}

/** @internal Stable, detached projection used by both the lifecycle and public facade. */
export function snapshotKernelConnectOptions(options: KernelConnectOptions = {}): KernelConnectOptions {
  const snapshot = snapshotOwnDataObject(options, "kernel.connect() options");
  const clientOptions = snapshotClientOptions(snapshot.clientOptions);
  const metadata = snapshot.metadata === undefined ? undefined : snapshotOwnDataObject(snapshot.metadata, "metadata");
  const capabilitiesLimits = snapshotCapabilitiesLimits(snapshot.capabilitiesLimits);
  const geoparquet = snapshotGeoParquetOptions(snapshot.geoparquet);
  return Object.freeze({
    ...(snapshot.protocol !== undefined ? { protocol: snapshot.protocol as ConnectProtocolHint } : {}),
    ...(snapshot.collectionId !== undefined ? { collectionId: snapshot.collectionId as string } : {}),
    ...(snapshot.typeName !== undefined ? { typeName: snapshot.typeName as string } : {}),
    ...(snapshot.styleId !== undefined ? { styleId: snapshot.styleId as string } : {}),
    ...(snapshot.tileMatrixSetId !== undefined ? { tileMatrixSetId: snapshot.tileMatrixSetId as string } : {}),
    ...(capabilitiesLimits ? { capabilitiesLimits } : {}),
    ...(snapshot.id !== undefined ? { id: snapshot.id as string } : {}),
    ...(snapshot.authorizationScopeFingerprint !== undefined
      ? { authorizationScopeFingerprint: snapshot.authorizationScopeFingerprint as string }
      : {}),
    ...(snapshot.client !== undefined ? { client: snapshot.client as ConnectOptions["client"] } : {}),
    ...(clientOptions ? { clientOptions } : {}),
    ...(snapshot.refresh !== undefined ? { refresh: snapshot.refresh as boolean } : {}),
    ...(snapshot.signal !== undefined ? { signal: snapshot.signal as AbortSignal } : {}),
    ...(metadata ? { metadata: metadata as ConnectOptions["metadata"] } : {}),
    ...(snapshot.resolveSource !== undefined
      ? { resolveSource: snapshot.resolveSource as ConnectOptions["resolveSource"] }
      : {}),
    ...(geoparquet ? { geoparquet } : {}),
  });
}

function snapshotCapabilitiesLimits(value: unknown): ConnectOptions["capabilitiesLimits"] {
  if (value === undefined) return undefined;
  const snapshot = snapshotOwnDataObject(value, "capabilitiesLimits");
  return Object.freeze({
    ...(snapshot.maxBytes !== undefined ? { maxBytes: snapshot.maxBytes as number } : {}),
    ...(snapshot.timeoutMs !== undefined ? { timeoutMs: snapshot.timeoutMs as number } : {}),
  });
}

/** @internal Dispose optional adapter resources without widening the standalone connection contract. */
export async function disposeKernelConnectionResult(connection: HonuaConnection): Promise<void> {
  await cleanupOptionalResource(connection);
}

function snapshotClientOptions(value: unknown): ConnectOptions["clientOptions"] {
  if (value === undefined) return undefined;
  const snapshot = snapshotOwnDataObject(value, "clientOptions");
  const interceptors = snapshot.interceptors === undefined ? undefined : snapshotInterceptors(snapshot.interceptors);
  const retry = snapshot.retry === undefined ? undefined : snapshotRetryOptions(snapshot.retry);
  return Object.freeze({
    ...snapshot,
    ...(interceptors ? { interceptors } : {}),
    ...(retry ? { retry } : {}),
  }) as ConnectOptions["clientOptions"];
}

function snapshotInterceptors(value: unknown): NonNullable<ConnectOptions["clientOptions"]>["interceptors"] {
  const input = snapshotOwnDataArray(value, "clientOptions.interceptors");
  const interceptors: Record<string, unknown>[] = [];
  for (let index = 0; index < input.length; index += 1) {
    interceptors.push(
      snapshotOwnDataObject(input[index], `clientOptions.interceptors[${index}]`) as Record<string, unknown>,
    );
  }
  return Object.freeze(interceptors) as NonNullable<ConnectOptions["clientOptions"]>["interceptors"];
}

function snapshotRetryOptions(value: unknown): NonNullable<ConnectOptions["clientOptions"]>["retry"] {
  const snapshot = snapshotOwnDataObject(value, "clientOptions.retry");
  const retryStatuses =
    snapshot.retryStatuses === undefined
      ? undefined
      : snapshotOwnDataArray(snapshot.retryStatuses, "clientOptions.retry.retryStatuses");
  return Object.freeze({
    ...snapshot,
    ...(retryStatuses ? { retryStatuses } : {}),
  }) as NonNullable<ConnectOptions["clientOptions"]>["retry"];
}

function snapshotGeoParquetOptions(value: unknown): ConnectOptions["geoparquet"] {
  if (value === undefined) return undefined;
  const snapshot = snapshotOwnDataObject(value, "geoparquet");
  const urls = snapshot.urls === undefined ? undefined : snapshotOwnDataArray(snapshot.urls, "geoparquet.urls");
  return Object.freeze({
    ...snapshot,
    ...(urls ? { urls } : {}),
  }) as ConnectOptions["geoparquet"];
}
