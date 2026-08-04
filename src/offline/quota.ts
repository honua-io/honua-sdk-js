import { HonuaOfflineRegionError } from "./types.js";

/**
 * Real browser storage-quota interrogation for offline-region admission.
 *
 * `logicalQuotaBytes` is an honest accounting of declared payload lengths, but
 * it has no relationship to the space a browser will actually grant. This module
 * closes that gap in the only way the platform supports: it reads
 * `navigator.storage.estimate()` through an injectable interface, derives a
 * conservative logical budget with an explicit reserve, and reports an explicit
 * `unavailable` result rather than inventing a number when the platform cannot
 * estimate.
 *
 * The estimate is deliberately imprecise and origin-scoped, and the accounting
 * unit stays logical payload bytes: physical occupancy, deduplication, and index
 * overhead are outside the contract and are exactly why a reserve exists. The
 * derived budget is advisory, never a guarantee, so a device can still refuse a
 * write that the budget admitted — which is why storage-pressure failures are
 * classified here too.
 *
 * Nothing in this module performs network I/O, mutates the store, or reads or
 * returns a credential, origin secret, or request URL. Persistence is never
 * requested implicitly: `requestOfflinePersistentStorage()` is the only path to
 * `navigator.storage.persist()` and it exists solely because the caller asked.
 */

/** Stable discriminator and version for storage-budget probe results. */
export const HONUA_OFFLINE_STORAGE_BUDGET_KIND = "honua.offline-storage-budget" as const;
export const HONUA_OFFLINE_STORAGE_BUDGET_VERSION = "1.0" as const;

/** Stable discriminator and version for explicit persistence-request results. */
export const HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND = "honua.offline-storage-persistence" as const;
export const HONUA_OFFLINE_STORAGE_PERSISTENCE_VERSION = "1.0" as const;

/** Fraction of the remaining estimate held back from the derived logical budget. */
export const DEFAULT_OFFLINE_STORAGE_HEADROOM_RATIO = 0.2;

/** Floor for the reserve, so a large-quota origin still keeps real headroom. */
export const DEFAULT_OFFLINE_STORAGE_MIN_RESERVE_BYTES = 16 * 1024 * 1024;

/**
 * Whether the origin's storage survives eviction pressure. `unknown` is a real
 * answer: a platform without `StorageManager.persisted()` has not told us.
 */
export type OfflineStoragePersistence = "persisted" | "best-effort" | "unknown";

/** Why no budget could be derived. Never accompanied by a fabricated number. */
export type OfflineStorageBudgetUnavailableReason =
  | "storage-manager-unavailable"
  | "estimate-unsupported"
  | "estimate-failed"
  | "estimate-incomplete";

/**
 * Injectable subset of the platform `StorageManager`.
 *
 * Every member is optional so a partial host implementation is describable
 * rather than assumed; the probe degrades to an explicit `unavailable` result
 * instead of throwing. A real `navigator.storage` satisfies this structurally.
 */
export interface OfflineStorageManagerLike {
  estimate?: () => Promise<{ readonly quota?: number; readonly usage?: number } | undefined>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

/** A derived, advisory logical budget backed by a real platform estimate. */
export interface OfflineStorageBudgetAvailableV1 {
  readonly kind: typeof HONUA_OFFLINE_STORAGE_BUDGET_KIND;
  readonly version: typeof HONUA_OFFLINE_STORAGE_BUDGET_VERSION;
  readonly status: "available";
  readonly observedAt: string;
  /** Platform-reported origin quota. Imprecise and subject to change. */
  readonly quotaBytes: number;
  readonly usageBytes: number;
  /** `max(0, quota - usage)`; the hard upper bound on any derived budget. */
  readonly remainingBytes: number;
  readonly reserveBytes: number;
  readonly headroomRatio: number;
  /** Pass to `logicalQuotaBytes`. Never exceeds `remainingBytes`. */
  readonly logicalBudgetBytes: number;
  readonly persistence: OfflineStoragePersistence;
}

/** An explicit refusal to estimate. Carries no budget of any kind. */
export interface OfflineStorageBudgetUnavailableV1 {
  readonly kind: typeof HONUA_OFFLINE_STORAGE_BUDGET_KIND;
  readonly version: typeof HONUA_OFFLINE_STORAGE_BUDGET_VERSION;
  readonly status: "unavailable";
  readonly observedAt: string;
  readonly reason: OfflineStorageBudgetUnavailableReason;
  readonly persistence: OfflineStoragePersistence;
}

export type OfflineStorageBudgetV1 = OfflineStorageBudgetAvailableV1 | OfflineStorageBudgetUnavailableV1;

export interface ProbeOfflineStorageBudgetOptions {
  /** Defaults to `navigator.storage`. Inject for tests and non-browser hosts. */
  readonly storage?: OfflineStorageManagerLike;
  /** Fraction of remaining space held in reserve. `0` to `1`; defaults to `0.2`. */
  readonly headroomRatio?: number;
  /** Reserve floor in bytes; defaults to 16 MiB. Clamped by remaining space. */
  readonly minimumReserveBytes?: number;
  /** Explicit clock input so a persisted probe result stays reproducible. */
  readonly now?: Date;
}

export type OfflineStoragePersistenceRequestStatus = "granted" | "denied" | "unavailable";

export type OfflineStoragePersistenceUnavailableReason =
  | "storage-manager-unavailable"
  | "persist-unsupported"
  | "persist-failed";

/** Result of an explicit, caller-initiated persistence request. */
export interface OfflineStoragePersistenceRequestV1 {
  readonly kind: typeof HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND;
  readonly version: typeof HONUA_OFFLINE_STORAGE_PERSISTENCE_VERSION;
  readonly status: OfflineStoragePersistenceRequestStatus;
  readonly persistence: OfflineStoragePersistence;
  readonly reason?: OfflineStoragePersistenceUnavailableReason;
}

export interface RequestOfflinePersistentStorageOptions {
  /** Defaults to `navigator.storage`. Inject for tests and non-browser hosts. */
  readonly storage?: OfflineStorageManagerLike;
}

const PROBE_OPTION_KEYS = new Set(["storage", "headroomRatio", "minimumReserveBytes", "now"]);
const PERSIST_OPTION_KEYS = new Set(["storage"]);
const BUDGET_KEYS = new Set([
  "kind",
  "version",
  "status",
  "observedAt",
  "quotaBytes",
  "usageBytes",
  "remainingBytes",
  "reserveBytes",
  "headroomRatio",
  "logicalBudgetBytes",
  "persistence",
  "reason",
]);
const PERSISTENCE_VALUES = new Set<OfflineStoragePersistence>(["persisted", "best-effort", "unknown"]);
const UNAVAILABLE_REASONS = new Set<OfflineStorageBudgetUnavailableReason>([
  "storage-manager-unavailable",
  "estimate-unsupported",
  "estimate-failed",
  "estimate-incomplete",
]);

/**
 * Read the origin's real storage estimate and derive a conservative logical
 * budget, or report explicitly that the platform cannot estimate.
 *
 * Performs no network I/O, writes nothing, and never calls
 * `StorageManager.persist()`. `persisted()` is read when the platform offers it
 * because persisted state changes the eviction risk of every cached region; a
 * platform that does not offer it yields `persistence: "unknown"` rather than an
 * assumption.
 *
 * Derivation is deterministic integer arithmetic over the reported values:
 *
 * ```text
 * remaining = max(0, quota - usage)
 * reserve   = min(remaining, max(minimumReserveBytes, floor(remaining * headroomRatio)))
 * budget    = remaining - reserve
 * ```
 *
 * so the budget can never exceed the platform-reported remaining quota, and a
 * nearly full origin yields `0` instead of a number that cannot be honoured.
 */
export async function probeOfflineStorageBudget(
  options: ProbeOfflineStorageBudgetOptions = {},
): Promise<OfflineStorageBudgetV1> {
  const record = plainRecord(options, "options");
  allowedKeys(record, PROBE_OPTION_KEYS, "options");
  const headroomRatio = normalizeRatio(record.headroomRatio, "options.headroomRatio");
  const minimumReserveBytes =
    record.minimumReserveBytes === undefined
      ? DEFAULT_OFFLINE_STORAGE_MIN_RESERVE_BYTES
      : nonNegativeInteger(record.minimumReserveBytes, "options.minimumReserveBytes");
  const nowMs = record.now === undefined ? Date.now() : validDate(record.now, "options.now");
  const observedAt = new Date(nowMs).toISOString();
  const storage = resolveStorageManager(record.storage, "options.storage");

  if (!storage) return unavailable(observedAt, "storage-manager-unavailable", "unknown");
  const persistence = await readPersistence(storage);
  if (typeof storage.estimate !== "function") return unavailable(observedAt, "estimate-unsupported", persistence);

  let estimate: { readonly quota?: number; readonly usage?: number } | undefined;
  try {
    estimate = await storage.estimate();
  } catch {
    // An estimate that failed is not a budget of zero; it is no budget at all.
    return unavailable(observedAt, "estimate-failed", persistence);
  }
  if (typeof estimate !== "object" || estimate === null) {
    return unavailable(observedAt, "estimate-incomplete", persistence);
  }
  const quotaBytes = readByteCount(estimate.quota);
  const usageBytes = readByteCount(estimate.usage);
  if (quotaBytes === undefined || usageBytes === undefined) {
    return unavailable(observedAt, "estimate-incomplete", persistence);
  }

  const remainingBytes = Math.max(0, quotaBytes - usageBytes);
  const reserveBytes = Math.min(
    remainingBytes,
    Math.max(minimumReserveBytes, Math.floor(remainingBytes * headroomRatio)),
  );
  return deepFreeze({
    kind: HONUA_OFFLINE_STORAGE_BUDGET_KIND,
    version: HONUA_OFFLINE_STORAGE_BUDGET_VERSION,
    status: "available",
    observedAt,
    quotaBytes,
    usageBytes,
    remainingBytes,
    reserveBytes,
    headroomRatio,
    logicalBudgetBytes: remainingBytes - reserveBytes,
    persistence,
  });
}

/**
 * Ask the browser to make this origin's storage persistent.
 *
 * This is the only call site of `StorageManager.persist()` in the SDK and it
 * runs only because an application called it. It is never invoked by
 * `downloadOfflineRegion`, by the probe, or by any store adapter: the request
 * can show a permission prompt, and a download is not consent to ask.
 */
export async function requestOfflinePersistentStorage(
  options: RequestOfflinePersistentStorageOptions = {},
): Promise<OfflineStoragePersistenceRequestV1> {
  const record = plainRecord(options, "options");
  allowedKeys(record, PERSIST_OPTION_KEYS, "options");
  const storage = resolveStorageManager(record.storage, "options.storage");
  if (!storage) {
    return persistenceResult("unavailable", "unknown", "storage-manager-unavailable");
  }
  if (typeof storage.persist !== "function") {
    return persistenceResult("unavailable", await readPersistence(storage), "persist-unsupported");
  }
  let granted: boolean;
  try {
    granted = (await storage.persist()) === true;
  } catch {
    return persistenceResult("unavailable", await readPersistence(storage), "persist-failed");
  }
  return persistenceResult(granted ? "granted" : "denied", granted ? "persisted" : await readPersistence(storage));
}

const QUOTA_PRESSURE_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED", "QUOTA_EXCEEDED_ERR"]);
const QUOTA_PRESSURE_LEGACY_CODES = new Set([22, 1014]);
const MAX_CAUSE_NODES = 32;

/**
 * Report whether a thrown value is, or wraps, a platform storage-pressure
 * failure — the device refusing a write for lack of space.
 *
 * Recognizes the `QuotaExceededError` `DOMException` every engine raises, the
 * Firefox `NS_ERROR_DOM_QUOTA_REACHED` name, and the legacy numeric
 * `DOMException` codes, then walks a bounded `cause` and `AggregateError` graph
 * so a store adapter that wrapped the failure is still classified correctly.
 * Bounded and cycle-safe: it inspects at most 32 nodes and visits none twice.
 *
 * Exported because a host-supplied `OfflineRegionStore` must classify the same
 * condition the same way; without a shared predicate an adapter's wrapper would
 * silently downgrade a full device to an internal store failure.
 */
export function isStorageQuotaPressureError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let inspected = 0;
  while (pending.length > 0 && inspected < MAX_CAUSE_NODES) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    inspected += 1;
    if (isQuotaPressureShape(current)) return true;
    const cause = readOwnOrInherited(current, "cause");
    if (cause !== undefined) pending.push(cause);
    const errors = readOwnOrInherited(current, "errors");
    if (Array.isArray(errors)) {
      for (const nested of errors.slice(0, MAX_CAUSE_NODES)) pending.push(nested);
    }
  }
  return false;
}

function isQuotaPressureShape(value: object): boolean {
  const name = readOwnOrInherited(value, "name");
  if (typeof name === "string" && QUOTA_PRESSURE_NAMES.has(name)) return true;
  const code = readOwnOrInherited(value, "code");
  if (typeof code === "string" && QUOTA_PRESSURE_NAMES.has(code)) return true;
  // Legacy numeric DOMException codes only count on a DOMException-shaped
  // value; a bare `{ code: 22 }` from an unrelated API is not storage pressure.
  return typeof code === "number" && typeof name === "string" && QUOTA_PRESSURE_LEGACY_CODES.has(code);
}

function readOwnOrInherited(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    // A hostile getter must not be able to break failure classification.
    return undefined;
  }
}

/**
 * Validate and take ownership of a caller-supplied budget envelope.
 *
 * Internal to the offline area: the diagnostic accepts a budget produced by
 * `probeOfflineStorageBudget()`, and a public entry point cannot assume it was
 * not hand-built.
 */
export function captureOfflineStorageBudget(value: unknown, path: string): OfflineStorageBudgetV1 {
  const record = plainRecord(value, path);
  allowedKeys(record, BUDGET_KEYS, path);
  if (record.kind !== HONUA_OFFLINE_STORAGE_BUDGET_KIND) invalid(`${path}.kind is unsupported.`, `${path}.kind`);
  if (record.version !== HONUA_OFFLINE_STORAGE_BUDGET_VERSION) {
    invalid(`${path}.version is unsupported.`, `${path}.version`);
  }
  const observedAt = normalizedTimestamp(record.observedAt, `${path}.observedAt`);
  const persistence = memberOf(record.persistence, PERSISTENCE_VALUES, `${path}.persistence`);
  if (record.status === "unavailable") {
    return unavailable(observedAt, memberOf(record.reason, UNAVAILABLE_REASONS, `${path}.reason`), persistence);
  }
  if (record.status !== "available") invalid(`${path}.status is invalid.`, `${path}.status`);
  if (record.reason !== undefined) invalid(`${path}.reason is not supported.`, `${path}.reason`);
  const quotaBytes = nonNegativeInteger(record.quotaBytes, `${path}.quotaBytes`);
  const usageBytes = nonNegativeInteger(record.usageBytes, `${path}.usageBytes`);
  const remainingBytes = nonNegativeInteger(record.remainingBytes, `${path}.remainingBytes`);
  const reserveBytes = nonNegativeInteger(record.reserveBytes, `${path}.reserveBytes`);
  const logicalBudgetBytes = nonNegativeInteger(record.logicalBudgetBytes, `${path}.logicalBudgetBytes`);
  const headroomRatio = normalizeRatio(record.headroomRatio, `${path}.headroomRatio`);
  // The arithmetic identities are part of the contract, so a forged envelope
  // cannot claim a budget larger than the remaining space it reports.
  if (remainingBytes !== Math.max(0, quotaBytes - usageBytes) || reserveBytes > remainingBytes) {
    invalid(`${path}.remainingBytes does not agree with the reported estimate.`, `${path}.remainingBytes`);
  }
  if (logicalBudgetBytes !== remainingBytes - reserveBytes) {
    invalid(`${path}.logicalBudgetBytes does not agree with the reported reserve.`, `${path}.logicalBudgetBytes`);
  }
  return deepFreeze({
    kind: HONUA_OFFLINE_STORAGE_BUDGET_KIND,
    version: HONUA_OFFLINE_STORAGE_BUDGET_VERSION,
    status: "available",
    observedAt,
    quotaBytes,
    usageBytes,
    remainingBytes,
    reserveBytes,
    headroomRatio,
    logicalBudgetBytes,
    persistence,
  });
}

function resolveStorageManager(value: unknown, path: string): OfflineStorageManagerLike | undefined {
  if (value === undefined) {
    const platform = (globalThis as { navigator?: { storage?: unknown } }).navigator?.storage;
    return typeof platform === "object" && platform !== null ? (platform as OfflineStorageManagerLike) : undefined;
  }
  if (typeof value !== "object" || value === null) invalid(`${path} must be a StorageManager-like object.`, path);
  return value as OfflineStorageManagerLike;
}

async function readPersistence(storage: OfflineStorageManagerLike): Promise<OfflineStoragePersistence> {
  if (typeof storage.persisted !== "function") return "unknown";
  try {
    return (await storage.persisted()) === true ? "persisted" : "best-effort";
  } catch {
    return "unknown";
  }
}

function readByteCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? floored : undefined;
}

function unavailable(
  observedAt: string,
  reason: OfflineStorageBudgetUnavailableReason,
  persistence: OfflineStoragePersistence,
): OfflineStorageBudgetUnavailableV1 {
  return deepFreeze({
    kind: HONUA_OFFLINE_STORAGE_BUDGET_KIND,
    version: HONUA_OFFLINE_STORAGE_BUDGET_VERSION,
    status: "unavailable",
    observedAt,
    reason,
    persistence,
  });
}

function persistenceResult(
  status: OfflineStoragePersistenceRequestStatus,
  persistence: OfflineStoragePersistence,
  reason?: OfflineStoragePersistenceUnavailableReason,
): OfflineStoragePersistenceRequestV1 {
  return deepFreeze({
    kind: HONUA_OFFLINE_STORAGE_PERSISTENCE_KIND,
    version: HONUA_OFFLINE_STORAGE_PERSISTENCE_VERSION,
    status,
    persistence,
    ...(reason === undefined ? {} : { reason }),
  });
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${path} must be a plain object.`, path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object.`, path);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${path} must not contain symbol properties.`, path);
  return value as Record<string, unknown>;
}

function allowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key in record) {
    if (Object.hasOwn(record, key) && !allowed.has(key)) invalid(`${path}.${key} is not supported.`, `${path}.${key}`);
  }
}

function memberOf<T extends string>(value: unknown, allowed: ReadonlySet<T>, path: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) invalid(`${path} is invalid.`, path);
  return value as T;
}

function normalizeRatio(value: unknown, path: string): number {
  if (value === undefined) return DEFAULT_OFFLINE_STORAGE_HEADROOM_RATIO;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${path} must be a finite ratio between 0 and 1.`, path);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative safe integer.`, path);
  }
  return value;
}

function validDate(value: unknown, path: string): number {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(time)) invalid(`${path} must be a valid Date.`, path);
  return time;
}

function normalizedTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`${path} must be an ISO-8601 timestamp.`, path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalid(`${path} must be a normalized ISO-8601 timestamp.`, path);
  }
  return value;
}

function invalid(message: string, path?: string): never {
  throw new HonuaOfflineRegionError("invalid-manifest", message, { path });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
