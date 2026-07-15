import type { ConnectDiscoveryCache, ConnectDiscoveryCacheContext, ConnectDiscoverySnapshot } from "../connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityPolicy } from "../contract/discovery.js";
import { HonuaAbortError } from "../core/errors.js";

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

/** @internal Construction options for the lifecycle substrate used by `createHonua()`. */
export interface KernelLifecycleOptions {
  readonly capabilityPolicy?: DiscoveryCapabilityPolicy;
  readonly discoveryCacheMaxEntries?: number;
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
  readonly policy: KernelPolicySnapshot;
  readonly discoveryCache: ConnectDiscoveryCache;
  #state: "active" | "disposing" | "disposed" = "active";
  #disposePromise: Promise<void> | undefined;

  public constructor(options: KernelLifecycleOptions = {}) {
    this.policy = Object.freeze({
      capabilities: normalizeCapabilityPolicy(options.capabilityPolicy),
    });
    const cache = new KernelDiscoveryCache(
      normalizeCacheBound(options.discoveryCacheMaxEntries),
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
  if (Symbol.asyncDispose in resource && typeof resource[Symbol.asyncDispose] === "function") {
    return () => resource[Symbol.asyncDispose]();
  }
  if ("dispose" in resource && typeof resource.dispose === "function") {
    return () => resource.dispose();
  }
  if (Symbol.dispose in resource && typeof resource[Symbol.dispose] === "function") {
    return () => resource[Symbol.dispose]();
  }
  throw new TypeError("Kernel-owned resources must expose dispose, Symbol.dispose, or Symbol.asyncDispose.");
}

function normalizeCapabilityPolicy(policy: DiscoveryCapabilityPolicy | undefined): Readonly<DiscoveryCapabilityPolicy> {
  return Object.freeze({
    ...(policy?.allow ? { allow: Object.freeze([...new Set(policy.allow)]) } : {}),
    ...(policy?.deny ? { deny: Object.freeze([...new Set(policy.deny)]) } : {}),
    ...(policy?.acceptInferred !== undefined ? { acceptInferred: policy.acceptInferred } : {}),
  });
}

function normalizeCacheBound(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DISCOVERY_CACHE_MAX_ENTRIES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("discoveryCacheMaxEntries must be a positive safe integer.");
  }
  return value;
}
