import {
  type HonuaErrorCode,
  HonuaSdkError,
  ownDataProperty,
  withHonuaErrorReasonClassification,
} from "../core/error-base.js";
import { certifyHonuaPluginManifest, validateHonuaPluginCertificationHost } from "./certification.js";
import type {
  HonuaPluginDependency,
  HonuaPluginExtensionKindMap,
  HonuaPluginFactory,
  HonuaPluginHostServices,
  HonuaPluginInstance,
  HonuaPluginKind,
  HonuaPluginLifecycleContext,
  HonuaPluginLifecycleDiagnostic,
  HonuaPluginLifecyclePhase,
  HonuaPluginLifecycleStatus,
  HonuaPluginManifest,
  HonuaPluginRegistryOptions,
  HonuaPluginScopedServices,
} from "./types.js";

const MAX_BATCH = 128;
const MAX_DEPENDENCIES = 64;
const ABORTED_GETTER = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

type AnyFactory = { readonly [K in HonuaPluginKind]: HonuaPluginFactory<K> }[HonuaPluginKind];
type AnyInstance = { readonly [K in HonuaPluginKind]: HonuaPluginInstance<K> }[HonuaPluginKind];
type ErasedInitialize = (context: HonuaPluginLifecycleContext) => AnyInstance | Promise<AnyInstance>;
type ErasedHook = (context: HonuaPluginLifecycleContext) => void | Promise<void>;
interface ErasedInstance {
  readonly extension: HonuaPluginExtensionKindMap[HonuaPluginKind];
  readonly start?: ErasedHook;
  readonly stop?: ErasedHook;
  readonly dispose?: ErasedHook;
}

interface FactorySnapshot {
  readonly manifestText: string;
  readonly dependencies: readonly HonuaPluginDependency[];
  readonly initialize: ErasedInitialize;
}

interface RegisteredPlugin {
  readonly manifest: HonuaPluginManifest;
  readonly instance: ErasedInstance;
  readonly context: HonuaPluginLifecycleContext;
  started: boolean;
}

function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function data(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !("value" in descriptor))
    throw new TypeError(`Plugin input ${String(key)} must be a data property.`);
  return descriptor;
}

function isAborted(signal: AbortSignal): boolean {
  if (!ABORTED_GETTER) throw new HonuaPluginRegistryError("PLUGIN_ABORT_SIGNAL_UNAVAILABLE");
  try {
    return ABORTED_GETTER.call(signal) as boolean;
  } catch (cause) {
    throw new HonuaPluginRegistryError("PLUGIN_ABORT_SIGNAL_INVALID", { cause });
  }
}

function requiredCallback<T extends (...args: never[]) => unknown>(object: object, key: string): T {
  const value = data(object, key)?.value;
  if (typeof value !== "function") throw new TypeError(`Plugin input ${key} must be a function.`);
  return value.bind(object) as T;
}

function optionalCallback<T extends (...args: never[]) => unknown>(object: object, key: string): T | undefined {
  const descriptor = data(object, key);
  if (!descriptor) return undefined;
  if (typeof descriptor.value !== "function") throw new TypeError(`Plugin input ${key} must be a function.`);
  return descriptor.value.bind(object) as T;
}

function snapshotDependencies(value: unknown): readonly HonuaPluginDependency[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new TypeError("Plugin dependencies must be an array.");
  const length = data(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_DEPENDENCIES) {
    throw new TypeError(`Plugin dependencies must contain at most ${MAX_DEPENDENCIES} entries.`);
  }
  const dependencies: HonuaPluginDependency[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const dependency = data(value, String(index))?.value;
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
      throw new TypeError("Every plugin dependency must be an object.");
    }
    const id = data(dependency, "id")?.value;
    const version = data(dependency, "version")?.value;
    const kind = data(dependency, "kind")?.value;
    if (typeof id !== "string" || id.length === 0) throw new TypeError("Plugin dependency id must be non-empty.");
    if (ids.has(id)) throw new HonuaPluginRegistryError("PLUGIN_DEPENDENCY_DUPLICATE");
    ids.add(id);
    if (version !== undefined && typeof version !== "string")
      throw new TypeError("Plugin dependency version must be a string.");
    if (kind !== undefined && typeof kind !== "string") throw new TypeError("Plugin dependency kind must be a string.");
    dependencies.push(
      freeze({
        id,
        ...(version === undefined ? {} : { version }),
        ...(kind === undefined ? {} : { kind }),
      }) as HonuaPluginDependency,
    );
  }
  return Object.freeze(dependencies);
}

function snapshotFactory(factory: AnyFactory): FactorySnapshot {
  if (!factory || typeof factory !== "object" || Array.isArray(factory))
    throw new TypeError("Plugin factory must be an object.");
  const manifestText = data(factory, "manifest")?.value;
  if (typeof manifestText !== "string") throw new TypeError("Plugin factory manifest must be JSON text.");
  const dependencies = snapshotDependencies(data(factory, "dependencies")?.value);
  const initialize = requiredCallback<ErasedInitialize>(factory, "initialize");
  return freeze({ manifestText, dependencies, initialize }) as FactorySnapshot;
}

function snapshotFactoryBatch(factories: readonly AnyFactory[]): readonly FactorySnapshot[] {
  if (!Array.isArray(factories)) throw new HonuaPluginRegistryError("PLUGIN_BATCH_INVALID");
  const length = data(factories, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_BATCH)
    throw new HonuaPluginRegistryError("PLUGIN_BATCH_INVALID");
  const snapshots: FactorySnapshot[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = data(factories, String(index));
    if (!descriptor) throw new HonuaPluginRegistryError("PLUGIN_BATCH_SPARSE");
    snapshots.push(snapshotFactory(descriptor.value as AnyFactory));
  }
  return Object.freeze(snapshots);
}

function snapshotServices(services: HonuaPluginHostServices | undefined): HonuaPluginHostServices {
  if (services === undefined) return Object.freeze({});
  if (!services || typeof services !== "object" || Array.isArray(services))
    throw new TypeError("Plugin services must be an object.");
  const result: Record<string, unknown> = {};
  for (const name of ["network", "credentials", "storage", "mutation", "cache", "provenance", "realtime"] as const) {
    const service = data(services, name)?.value;
    if (service === undefined) continue;
    if (!service || typeof service !== "object" || Array.isArray(service))
      throw new TypeError(`Plugin ${name} service must be an object.`);
    if (name === "network") result.network = freeze({ request: requiredCallback(service, "request") });
    if (name === "credentials") result.credentials = freeze({ get: requiredCallback(service, "get") });
    if (name === "storage")
      result.storage = freeze({
        get: requiredCallback(service, "get"),
        set: requiredCallback(service, "set"),
        delete: requiredCallback(service, "delete"),
      });
    if (name === "mutation") result.mutation = freeze({ execute: requiredCallback(service, "execute") });
    if (name === "cache") {
      const set = optionalCallback(service, "set");
      result.cache = freeze({ get: requiredCallback(service, "get"), ...(set ? { set } : {}) });
    }
    if (name === "provenance") result.provenance = freeze({ record: requiredCallback(service, "record") });
    if (name === "realtime") result.realtime = freeze({ subscribe: requiredCallback(service, "subscribe") });
  }
  return freeze(result) as HonuaPluginHostServices;
}

function scopedServices(manifest: HonuaPluginManifest, services: HonuaPluginHostServices): HonuaPluginScopedServices {
  const scoped: Record<string, unknown> = {};
  const origins = new Set(manifest.requestedGrants.networkOrigins ?? []);
  if (origins.size > 0 && services.network) {
    const request = services.network.request;
    scoped.network = freeze({
      request: async (url: string, init?: unknown) => {
        let origin: string;
        try {
          origin = new URL(url).origin;
        } catch {
          throw new HonuaPluginRegistryError("PLUGIN_NETWORK_URL_INVALID");
        }
        if (!origins.has(origin)) throw new HonuaPluginRegistryError("PLUGIN_NETWORK_ORIGIN_DENIED");
        return request(url, init);
      },
    });
  }
  const scopes = new Set(manifest.requestedGrants.credentialScopes ?? []);
  if (scopes.size > 0 && services.credentials) {
    const get = services.credentials.get;
    scoped.credentials = freeze({
      get: (scope: string) => {
        if (!scopes.has(scope)) throw new HonuaPluginRegistryError("PLUGIN_CREDENTIAL_SCOPE_DENIED");
        return get(scope);
      },
    });
  }
  if (manifest.requestedGrants.storage === "scoped" && services.storage) scoped.storage = services.storage;
  if (manifest.requestedGrants.mutation === true && manifest.data.mutation === "explicit" && services.mutation)
    scoped.mutation = services.mutation;
  if (manifest.data.cache !== "none" && services.cache) scoped.cache = services.cache;
  if (services.provenance) scoped.provenance = services.provenance;
  if (manifest.data.realtime !== "none" && services.realtime) scoped.realtime = services.realtime;
  return freeze(scoped);
}

function snapshotInstance(instance: AnyInstance, manifest: HonuaPluginManifest): ErasedInstance {
  if (!instance || typeof instance !== "object" || Array.isArray(instance))
    throw new TypeError("Plugin initialize must return an instance object.");
  const extension = data(instance, "extension")?.value;
  if (!extension || typeof extension !== "object" || Array.isArray(extension))
    throw new TypeError("Plugin instance extension must be an object.");
  if (data(extension, "id")?.value !== manifest.id || data(extension, "kind")?.value !== manifest.kind) {
    throw new TypeError("Plugin extension identity must match its certified manifest.");
  }
  const start = optionalCallback<ErasedHook>(instance, "start");
  const stop = optionalCallback<ErasedHook>(instance, "stop");
  const dispose = optionalCallback<ErasedHook>(instance, "dispose");
  if (manifest.lifecycle.disposal === "required" && !dispose) {
    throw new HonuaPluginRegistryError("PLUGIN_DISPOSE_HOOK_REQUIRED");
  }
  return freeze({
    extension: freeze(extension) as HonuaPluginExtensionKindMap[HonuaPluginKind],
    ...(start ? { start } : {}),
    ...(stop ? { stop } : {}),
    ...(dispose ? { dispose } : {}),
  }) as ErasedInstance;
}

const PLUGIN_ERROR_SDK_CODES = {
  PLUGIN_ABORT_SIGNAL_INVALID: "plugin.registry.validation",
  PLUGIN_DEPENDENCY_DUPLICATE: "plugin.registry.validation",
  PLUGIN_BATCH_INVALID: "plugin.registry.validation",
  PLUGIN_BATCH_SPARSE: "plugin.registry.validation",
  PLUGIN_REGISTRY_DISPOSED: "plugin.registry.validation",
  PLUGIN_DUPLICATE_ID: "plugin.registry.validation",
  PLUGIN_DEPENDENCY_CYCLE: "plugin.registry.validation",
  PLUGIN_HOST_REJECTED: "plugin.compatibility",
  PLUGIN_CERTIFICATION_FAILED: "plugin.compatibility",
  PLUGIN_DEPENDENCY_VERSION_CONFLICT: "plugin.compatibility",
  PLUGIN_DEPENDENCY_KIND_CONFLICT: "plugin.compatibility",
  PLUGIN_NETWORK_ORIGIN_DENIED: "plugin.execution.policy-denied",
  PLUGIN_CREDENTIAL_SCOPE_DENIED: "plugin.execution.policy-denied",
  PLUGIN_ABORT_SIGNAL_UNAVAILABLE: "plugin.capability-unavailable",
  PLUGIN_DEPENDENCY_MISSING: "plugin.capability-unavailable",
  PLUGIN_DISPOSE_HOOK_REQUIRED: "plugin.lifecycle.activation",
  PLUGIN_REGISTRATION_FAILED: "plugin.lifecycle.activation",
  PLUGIN_NETWORK_URL_INVALID: "plugin.execution.validation",
  PLUGIN_DISPOSAL_FAILED: "plugin.lifecycle.cleanup",
  PLUGIN_REGISTRATION_CANCELLED: "plugin.cancelled",
  PLUGIN_REVALIDATION_FAILED: "plugin.internal",
} as const satisfies Readonly<Record<string, HonuaErrorCode>>;

type KnownPluginRegistryErrorCode = keyof typeof PLUGIN_ERROR_SDK_CODES;

function isKnownPluginRegistryErrorCode(code: unknown): code is KnownPluginRegistryErrorCode {
  return typeof code === "string" && Object.hasOwn(PLUGIN_ERROR_SDK_CODES, code);
}

function pluginSdkCode(code: unknown): HonuaErrorCode {
  return isKnownPluginRegistryErrorCode(code) ? PLUGIN_ERROR_SDK_CODES[code] : "plugin.internal";
}

function pluginReasonCode(code: unknown): KnownPluginRegistryErrorCode | "PLUGIN_UNKNOWN" {
  return isKnownPluginRegistryErrorCode(code) ? code : "PLUGIN_UNKNOWN";
}

/**
 * Stable tagged error carrying cleanup failures separately from the primary
 * cause. Raw causes and cleanup failures remain local to the instance.
 */
export class HonuaPluginRegistryError extends HonuaSdkError {
  readonly code: string;
  readonly cleanupErrors: readonly unknown[];

  constructor(code: string, options: { cause?: unknown; cleanupErrors?: readonly unknown[] } = {}) {
    const cause = ownDataProperty(options, "cause");
    const sdkCode = pluginSdkCode(code);
    super(
      sdkCode,
      typeof code === "string" ? code : "PLUGIN_UNKNOWN",
      withHonuaErrorReasonClassification(
        cause === undefined ? {} : { cause },
        "plugin",
        pluginErrorCategory(sdkCode),
        false,
        pluginReasonCode(code),
      ),
    );
    this.name = "HonuaPluginRegistryError";
    this.code = code;
    const cleanupErrors = ownDataProperty(options, "cleanupErrors");
    this.cleanupErrors = Object.freeze(Array.isArray(cleanupErrors) ? [...cleanupErrors] : []);
  }
}

function pluginErrorCategory(code: HonuaErrorCode) {
  if (code === "plugin.registry.validation" || code === "plugin.execution.validation") return "validation" as const;
  if (
    code === "plugin.compatibility" ||
    code === "plugin.execution.policy-denied" ||
    code === "plugin.capability-unavailable"
  )
    return "capability" as const;
  if (code === "plugin.cancelled") return "cancellation" as const;
  return "internal" as const;
}

/** Instance-scoped registry. It never imports plugin entrypoints or mutates global state. */
export class HonuaPluginRegistry {
  readonly #hostText: string;
  readonly #environment: HonuaPluginLifecycleContext["environment"];
  readonly #services: HonuaPluginHostServices;
  readonly #plugins = new Map<string, RegisteredPlugin>();
  readonly #events: HonuaPluginLifecycleDiagnostic[] = [];
  #queue: Promise<void> = Promise.resolve();
  #disposePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: HonuaPluginRegistryOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new TypeError("Plugin registry options must be an object.");
    const hostText = data(options, "host")?.value;
    if (typeof hostText !== "string") throw new TypeError("Plugin registry host must be JSON text.");
    const validation = validateHonuaPluginCertificationHost(hostText);
    if (!validation.ok || !validation.host) throw new HonuaPluginRegistryError("PLUGIN_HOST_REJECTED");
    this.#hostText = hostText;
    this.#environment = validation.host.environment;
    this.#services = snapshotServices(data(options, "services")?.value as HonuaPluginHostServices | undefined);
  }

  get diagnostics(): readonly HonuaPluginLifecycleDiagnostic[] {
    return Object.freeze([...this.#events]);
  }

  get<K extends HonuaPluginKind, E extends HonuaPluginExtensionKindMap[K] = HonuaPluginExtensionKindMap[K]>(
    kind: K,
    id: string,
  ): E | undefined {
    if (this.#closed) return undefined;
    const plugin = this.#plugins.get(id);
    return plugin?.manifest.kind === kind ? (plugin.instance.extension as E) : undefined;
  }

  list<K extends HonuaPluginKind, E extends HonuaPluginExtensionKindMap[K] = HonuaPluginExtensionKindMap[K]>(
    kind: K,
  ): readonly E[] {
    if (this.#closed) return Object.freeze([]);
    return Object.freeze(
      [...this.#plugins.values()]
        .filter((plugin) => plugin.manifest.kind === kind)
        .map((plugin) => plugin.instance.extension as E),
    );
  }

  register(factories: readonly AnyFactory[], options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    let snapshots: readonly FactorySnapshot[];
    let signal: AbortSignal | undefined;
    try {
      snapshots = snapshotFactoryBatch(factories);
      if (!options || typeof options !== "object" || Array.isArray(options))
        throw new TypeError("Plugin registration options must be an object.");
      signal = data(options, "signal")?.value as AbortSignal | undefined;
      if (signal !== undefined) isAborted(signal);
    } catch (cause) {
      const code = cause instanceof HonuaPluginRegistryError ? cause.code : "PLUGIN_INPUT_REJECTED";
      this.#event(code, "registry", "failed", null);
      return Promise.reject(cause);
    }
    const run = async () => {
      try {
        await this.#register(snapshots, signal);
      } catch (cause) {
        const code = cause instanceof HonuaPluginRegistryError ? cause.code : "PLUGIN_REGISTRATION_FAILED";
        this.#event(code, "registry", code === "PLUGIN_REGISTRATION_CANCELLED" ? "cancelled" : "failed", null);
        throw cause;
      }
    };
    const task = this.#queue.then(run, run);
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    const run = () => this.#dispose();
    this.#disposePromise = this.#queue.then(run, run);
    this.#queue = this.#disposePromise.then(
      () => undefined,
      () => undefined,
    );
    return this.#disposePromise;
  }

  async #register(snapshots: readonly FactorySnapshot[], signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new HonuaPluginRegistryError("PLUGIN_REGISTRY_DISPOSED");
    this.#throwIfAborted(signal, null);
    const manifests = new Map<string, HonuaPluginManifest>();
    const reports = new Map<string, ReturnType<typeof certifyHonuaPluginManifest>>();
    for (const snapshot of snapshots) {
      const report = certifyHonuaPluginManifest(snapshot.manifestText, this.#hostText);
      const manifest = report.manifest.snapshot as unknown as HonuaPluginManifest | null;
      if (report.status !== "certified" || !manifest) {
        this.#event("PLUGIN_CERTIFICATION_FAILED", "certify", "failed", manifest);
        throw new HonuaPluginRegistryError("PLUGIN_CERTIFICATION_FAILED");
      }
      if (this.#plugins.has(manifest.id) || manifests.has(manifest.id))
        throw new HonuaPluginRegistryError("PLUGIN_DUPLICATE_ID");
      manifests.set(manifest.id, manifest);
      reports.set(manifest.id, report);
    }
    const ids = [...manifests.keys()];
    const byId = new Map(snapshots.map((snapshot, index) => [ids[index]!, snapshot]));
    const order = this.#dependencyOrder(byId, manifests);
    const pending = new Map<string, RegisteredPlugin>();
    const initialized: RegisteredPlugin[] = [];
    try {
      for (const id of order) {
        this.#throwIfAborted(signal, manifests.get(id) ?? null);
        const snapshot = byId.get(id)!;
        const fresh = certifyHonuaPluginManifest(snapshot.manifestText, this.#hostText);
        if (fresh.status !== "certified" || fresh.sha256 !== reports.get(id)?.sha256)
          throw new HonuaPluginRegistryError("PLUGIN_REVALIDATION_FAILED");
        const manifest = manifests.get(id)!;
        const services = scopedServices(manifest, this.#services);
        const declaredDependencies = new Set(snapshot.dependencies.map((dependency) => dependency.id));
        const context = freeze({
          manifest,
          environment: this.#environment,
          services,
          signal: signal ?? new AbortController().signal,
          resolve: <
            K extends HonuaPluginKind,
            E extends HonuaPluginExtensionKindMap[K] = HonuaPluginExtensionKindMap[K],
          >(
            kind: K,
            dependencyId: string,
          ) => {
            if (!declaredDependencies.has(dependencyId)) return undefined;
            const dependency = pending.get(dependencyId) ?? this.#plugins.get(dependencyId);
            return dependency?.manifest.kind === kind ? (dependency.instance.extension as E) : undefined;
          },
        }) as HonuaPluginLifecycleContext;
        this.#event("PLUGIN_INITIALIZE_STARTED", "initialize", "started", manifest);
        let instance: ErasedInstance;
        try {
          instance = snapshotInstance(await snapshot.initialize(context), manifest);
        } catch (cause) {
          if (signal && isAborted(signal)) {
            this.#event("PLUGIN_INITIALIZE_CANCELLED", "initialize", "cancelled", manifest);
            throw new HonuaPluginRegistryError("PLUGIN_REGISTRATION_CANCELLED", { cause });
          }
          this.#event("PLUGIN_INITIALIZE_FAILED", "initialize", "failed", manifest);
          throw cause;
        }
        const record: RegisteredPlugin = { manifest, instance, context, started: false };
        initialized.push(record);
        if (signal && isAborted(signal)) {
          this.#event("PLUGIN_INITIALIZE_CANCELLED", "initialize", "cancelled", manifest);
        }
        this.#throwIfAborted(signal, manifest);
        this.#event("PLUGIN_INITIALIZE_SUCCEEDED", "initialize", "succeeded", manifest);
        if (instance.start) {
          this.#event("PLUGIN_START_STARTED", "start", "started", manifest);
          try {
            await instance.start(context);
          } catch (cause) {
            if (signal && isAborted(signal)) {
              this.#event("PLUGIN_START_CANCELLED", "start", "cancelled", manifest);
              throw new HonuaPluginRegistryError("PLUGIN_REGISTRATION_CANCELLED", { cause });
            }
            this.#event("PLUGIN_START_FAILED", "start", "failed", manifest);
            throw cause;
          }
          record.started = true;
          if (signal && isAborted(signal)) {
            this.#event("PLUGIN_START_CANCELLED", "start", "cancelled", manifest);
          }
          this.#throwIfAborted(signal, manifest);
          this.#event("PLUGIN_START_SUCCEEDED", "start", "succeeded", manifest);
        }
        pending.set(id, record);
      }
      for (const id of order) this.#plugins.set(id, pending.get(id)!);
    } catch (cause) {
      const cleanupErrors = await this.#rollback(initialized);
      const code = cause instanceof HonuaPluginRegistryError ? cause.code : "PLUGIN_REGISTRATION_FAILED";
      throw new HonuaPluginRegistryError(code, { cause, cleanupErrors });
    }
  }

  #dependencyOrder(
    factories: Map<string, FactorySnapshot>,
    manifests: Map<string, HonuaPluginManifest>,
  ): readonly string[] {
    const edges = new Map<string, Set<string>>();
    for (const [id, factory] of factories) {
      const dependencies = new Set<string>();
      for (const dependency of factory.dependencies) {
        const target = manifests.get(dependency.id) ?? this.#plugins.get(dependency.id)?.manifest;
        if (!target) throw new HonuaPluginRegistryError("PLUGIN_DEPENDENCY_MISSING");
        if (dependency.version !== undefined && target.version !== dependency.version)
          throw new HonuaPluginRegistryError("PLUGIN_DEPENDENCY_VERSION_CONFLICT");
        if (dependency.kind !== undefined && target.kind !== dependency.kind)
          throw new HonuaPluginRegistryError("PLUGIN_DEPENDENCY_KIND_CONFLICT");
        if (factories.has(dependency.id)) dependencies.add(dependency.id);
      }
      edges.set(id, dependencies);
    }
    const result: string[] = [];
    while (result.length < factories.size) {
      const ready = [...edges]
        .filter(
          ([id, dependencies]) =>
            !result.includes(id) && [...dependencies].every((dependency) => result.includes(dependency)),
        )
        .map(([id]) => id)
        .sort();
      if (ready.length === 0) throw new HonuaPluginRegistryError("PLUGIN_DEPENDENCY_CYCLE");
      result.push(...ready);
    }
    return Object.freeze(result);
  }

  async #rollback(records: readonly RegisteredPlugin[]): Promise<readonly unknown[]> {
    const failures: unknown[] = [];
    for (const record of [...records].reverse()) {
      if (record.started && record.instance.stop) {
        try {
          await record.instance.stop(this.#cleanupContext(record.context));
          this.#event("PLUGIN_STOP_ROLLED_BACK", "stop", "rolled-back", record.manifest);
        } catch (error) {
          failures.push(error);
          this.#event("PLUGIN_ROLLBACK_STOP_FAILED", "stop", "failed", record.manifest);
        }
      }
      if (record.instance.dispose) {
        try {
          await record.instance.dispose(this.#cleanupContext(record.context));
          this.#event("PLUGIN_DISPOSE_ROLLED_BACK", "dispose", "rolled-back", record.manifest);
        } catch (error) {
          failures.push(error);
          this.#event("PLUGIN_ROLLBACK_DISPOSE_FAILED", "dispose", "failed", record.manifest);
        }
      }
    }
    return Object.freeze(failures);
  }

  async #dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const record of [...this.#plugins.values()].reverse()) {
      if (record.started && record.instance.stop) {
        this.#event("PLUGIN_STOP_STARTED", "stop", "started", record.manifest);
        try {
          await record.instance.stop(this.#cleanupContext(record.context));
          this.#event("PLUGIN_STOP_SUCCEEDED", "stop", "succeeded", record.manifest);
        } catch (error) {
          failures.push(error);
          this.#event("PLUGIN_STOP_FAILED", "stop", "failed", record.manifest);
        }
      }
      if (record.instance.dispose) {
        this.#event("PLUGIN_DISPOSE_STARTED", "dispose", "started", record.manifest);
        try {
          await record.instance.dispose(this.#cleanupContext(record.context));
          this.#event("PLUGIN_DISPOSE_SUCCEEDED", "dispose", "succeeded", record.manifest);
        } catch (error) {
          failures.push(error);
          this.#event("PLUGIN_DISPOSE_FAILED", "dispose", "failed", record.manifest);
        }
      }
    }
    this.#plugins.clear();
    if (failures.length > 0) throw new HonuaPluginRegistryError("PLUGIN_DISPOSAL_FAILED", { cleanupErrors: failures });
  }

  #throwIfAborted(signal: AbortSignal | undefined, manifest: HonuaPluginManifest | null): void {
    if (!signal || !isAborted(signal)) return;
    this.#event("PLUGIN_REGISTRATION_CANCELLED", "registry", "cancelled", manifest);
    throw new HonuaPluginRegistryError("PLUGIN_REGISTRATION_CANCELLED", { cause: signal.reason });
  }

  #cleanupContext(context: HonuaPluginLifecycleContext): HonuaPluginLifecycleContext {
    return freeze({ ...context, signal: new AbortController().signal }) as HonuaPluginLifecycleContext;
  }

  #event(
    code: string,
    phase: HonuaPluginLifecyclePhase,
    status: HonuaPluginLifecycleStatus,
    manifest: HonuaPluginManifest | null,
  ): void {
    this.#events.push(
      freeze({
        sequence: this.#events.length + 1,
        code,
        phase,
        status,
        plugin: manifest ? freeze({ id: manifest.id, version: manifest.version, kind: manifest.kind }) : null,
      }) as HonuaPluginLifecycleDiagnostic,
    );
  }
}
