import { tryNormalizeDiscoveryEndpoint } from "../contract/discovery-endpoint.js";
import {
  type CreateOfflineRegionManifestInput,
  DEFAULT_OFFLINE_REGION_MAX_ATTRIBUTIONS,
  DEFAULT_OFFLINE_REGION_MAX_LOGICAL_BYTES,
  DEFAULT_OFFLINE_REGION_MAX_METADATA_ENTRIES,
  DEFAULT_OFFLINE_REGION_MAX_RESOURCES,
  DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES,
  HONUA_OFFLINE_REGION_KIND,
  HONUA_OFFLINE_REGION_VERSION,
  HonuaOfflineRegionError,
  type OfflineRegionAdmissionPlan,
  type OfflineRegionBounds,
  type OfflineRegionCacheInventory,
  type OfflineRegionDownloadOptions,
  type OfflineRegionDownloadProgress,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionLimits,
  type OfflineRegionManifestV1,
  type OfflineRegionObservation,
  type OfflineRegionResourceInput,
  type OfflineRegionResourceV1,
  type OfflineRegionStoredRegion,
  type OfflineRegionValidator,
  type OfflineRegionWriteTransaction,
} from "./types.js";

const INTEGRITY_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_KINDS = new Set(["metadata", "features", "tile", "asset", "attribution"]);
const encoder = new TextEncoder();

const MANIFEST_KEYS = new Set([
  "kind",
  "version",
  "id",
  "name",
  "source",
  "bounds",
  "minZoom",
  "maxZoom",
  "expiresAt",
  "attribution",
  "resources",
  "totalLogicalBytes",
]);
const SOURCE_KEYS = new Set([
  "id",
  "endpoint",
  "authorizationScopeDigest",
  "sourceVersion",
  "schemaVersion",
  "planVersion",
  "observation",
  "validator",
]);
const RESOURCE_KEYS = new Set([
  "id",
  "kind",
  "byteLength",
  "integrity",
  "contentType",
  "sourceVersion",
  "schemaVersion",
  "planVersion",
  "attributionIds",
]);
const CREATE_KEYS = new Set([
  "name",
  "sourceId",
  "endpoint",
  "authorizationScopeFingerprint",
  "bounds",
  "minZoom",
  "maxZoom",
  "sourceVersion",
  "schemaVersion",
  "planVersion",
  "observation",
  "validator",
  "expiresAt",
  "attribution",
  "resources",
  "limits",
]);
const BOUNDS_KEYS = new Set(["minX", "minY", "maxX", "maxY", "crs"]);
const OBSERVATION_KEYS = new Set(["state", "observedAt", "validAt"]);
const VALIDATOR_KEYS = new Set(["etag", "lastModified"]);
const LIMIT_KEYS = new Set([
  "maxResources",
  "maxLogicalBytes",
  "maxStringBytes",
  "maxAttributions",
  "maxMetadataEntries",
]);

interface NormalizedLimits {
  readonly maxResources: number;
  readonly maxLogicalBytes: number;
  readonly maxStringBytes: number;
  readonly maxAttributions: number;
  readonly maxMetadataEntries: number;
}

interface CreationSnapshot {
  readonly name: string;
  readonly sourceId: string;
  readonly endpoint: string;
  readonly authorizationScopeFingerprint: string;
  readonly bounds: OfflineRegionBounds;
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planVersion: string;
  readonly observation: OfflineRegionObservation;
  readonly validator?: OfflineRegionValidator;
  readonly expiresAt?: string;
  readonly attribution: Readonly<Record<string, string>>;
  readonly resources: readonly OfflineRegionResourceV1[];
  readonly totalLogicalBytes: number;
  readonly limits: NormalizedLimits;
}

interface PreparedManifest {
  readonly manifest: OfflineRegionManifestV1;
  readonly canonicalIdentity: string;
}

class TrustBudget {
  #stringBytes = 0;
  #metadataEntries = 0;

  public constructor(private readonly limits: NormalizedLimits) {}

  public string(value: unknown, path: string, normalizedRequired: boolean): string {
    if (typeof value !== "string") invalid(`${path} must be a string.`, path);
    const remaining = this.limits.maxStringBytes - this.#stringBytes;
    if (value.length > remaining) limit(`${path} exceeds the remaining descriptor string budget.`, path);
    const inputBytes = encoder.encode(value).byteLength;
    if (inputBytes > remaining) limit(`${path} exceeds the remaining descriptor string budget.`, path);
    const normalized = value.trim();
    if (normalized.length === 0) invalid(`${path} must be non-empty.`, path);
    if (normalizedRequired && normalized !== value) invalid(`${path} is not normalized.`, path);
    this.#stringBytes += inputBytes;
    return normalized;
  }

  public metadata(count: number, path: string): void {
    if (count < 0 || this.#metadataEntries > this.limits.maxMetadataEntries - count) {
      limit(`${path} exceeds the metadata entry limit.`, path);
    }
    this.#metadataEntries += count;
  }
}

/** Create an immutable, deterministic, credential-free downloadable-region manifest. */
export async function createOfflineRegionManifest(
  input: CreateOfflineRegionManifestInput,
): Promise<OfflineRegionManifestV1> {
  const snapshot = captureCreationInput(input);
  const authorizationScopeDigest = await sha256(`honua-offline-scope:v1:${snapshot.authorizationScopeFingerprint}`);
  const identity = {
    kind: HONUA_OFFLINE_REGION_KIND,
    version: HONUA_OFFLINE_REGION_VERSION,
    name: snapshot.name,
    source: {
      id: snapshot.sourceId,
      endpoint: snapshot.endpoint,
      authorizationScopeDigest,
      sourceVersion: snapshot.sourceVersion,
      schemaVersion: snapshot.schemaVersion,
      planVersion: snapshot.planVersion,
      observation: snapshot.observation,
      ...(snapshot.validator ? { validator: snapshot.validator } : {}),
    },
    bounds: snapshot.bounds,
    ...(snapshot.minZoom !== undefined ? { minZoom: snapshot.minZoom } : {}),
    ...(snapshot.maxZoom !== undefined ? { maxZoom: snapshot.maxZoom } : {}),
    ...(snapshot.expiresAt !== undefined ? { expiresAt: snapshot.expiresAt } : {}),
    attribution: snapshot.attribution,
    resources: snapshot.resources,
    totalLogicalBytes: snapshot.totalLogicalBytes,
  };
  const canonicalIdentity = canonicalJson(identity);
  const id = await sha256(`honua-offline-region:v1:${canonicalIdentity}`);
  return deepFreeze({ ...identity, id });
}

/**
 * Produce a deterministic logical-byte quota decision. Expired entries are
 * evicted first, then least-recently-used entries, with code-unit id ordering.
 */
export function planOfflineRegionAdmission(
  inputManifest: OfflineRegionManifestV1,
  inventory: OfflineRegionCacheInventory,
  options: { readonly logicalQuotaBytes: number; readonly now?: Date },
): OfflineRegionAdmissionPlan {
  const prepared = captureManifest(inputManifest);
  return planPreparedAdmission(prepared.manifest, inventory, options);
}

function planPreparedAdmission(
  manifest: OfflineRegionManifestV1,
  inventory: OfflineRegionCacheInventory,
  options: { readonly logicalQuotaBytes: number; readonly now?: Date },
): OfflineRegionAdmissionPlan {
  const logicalQuotaBytes = nonNegativeInteger(options.logicalQuotaBytes, "logicalQuotaBytes");
  const requiredLogicalBytes = nonNegativeInteger(manifest.totalLogicalBytes, "manifest.totalLogicalBytes");
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) invalid("now must be a valid Date.", "now");
  if (
    manifest.expiresAt !== undefined &&
    Date.parse(normalizeTimestamp(manifest.expiresAt, "expiresAt", true)) <= nowMs
  ) {
    throw new HonuaOfflineRegionError("expired", `Offline region "${manifest.id}" has expired.`);
  }
  const normalized = normalizeInventory(inventory);
  const logicalBytesBefore = normalized.regions.reduce(
    (total, region) => safeAdd(total, region.logicalByteLength, "inventory.regions"),
    0,
  );
  const existing = normalized.regions.find((region) => region.id === manifest.id);
  const replacementLogicalBytes = existing?.logicalByteLength ?? 0;
  let projected = logicalBytesBefore - replacementLogicalBytes + requiredLogicalBytes;
  const evictions: OfflineRegionStoredRegion[] = [];
  const candidates = normalized.regions
    .filter((region) => region.id !== manifest.id && region.pinned !== true)
    .sort((left, right) => {
      const expiryOrder = Number(isExpired(left, nowMs)) - Number(isExpired(right, nowMs));
      return (
        -expiryOrder ||
        Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt) ||
        compareCodeUnits(left.id, right.id)
      );
    });
  for (const candidate of candidates) {
    if (projected <= logicalQuotaBytes) break;
    evictions.push(candidate);
    projected -= candidate.logicalByteLength;
  }
  if (projected > logicalQuotaBytes) {
    const pinned = normalized.regions
      .filter((region) => region.id !== manifest.id && region.pinned === true)
      .reduce((total, region) => safeAdd(total, region.logicalByteLength, "inventory.regions"), 0);
    throw new HonuaOfflineRegionError(
      "quota-exceeded",
      `Offline region requires ${requiredLogicalBytes} logical bytes but only ${Math.max(0, logicalQuotaBytes - pinned)} remain after preserving pinned data.`,
    );
  }
  return deepFreeze({
    logicalQuotaBytes,
    logicalBytesBefore,
    replacementLogicalBytes,
    requiredLogicalBytes,
    evictRegionIds: evictions.map((region) => region.id),
    evictedLogicalBytes: evictions.reduce(
      (total, region) => safeAdd(total, region.logicalByteLength, "inventory.regions"),
      0,
    ),
    logicalBytesAfter: projected,
  });
}

/** Download and atomically commit a manifest through caller-injected adapters. */
export async function downloadOfflineRegion(
  inputManifest: OfflineRegionManifestV1,
  options: OfflineRegionDownloadOptions,
): Promise<OfflineRegionDownloadReceipt> {
  // This entire owned snapshot is captured synchronously before the first await.
  const prepared = captureManifest(inputManifest);
  const manifest = prepared.manifest;
  throwIfAborted(options.signal);
  const expectedId = await sha256(`honua-offline-region:v1:${prepared.canonicalIdentity}`);
  if (manifest.id !== expectedId) invalid("Offline region identity does not match its normalized contents.", "id");

  const now = options.now ?? (() => new Date());
  let inventory: OfflineRegionCacheInventory;
  try {
    inventory = await options.store.inventory();
  } catch (cause) {
    throw new HonuaOfflineRegionError("store-failed", "Failed to inspect the offline region store.", { cause });
  }
  throwIfAborted(options.signal);
  const normalizedInventory = normalizeInventory(inventory);
  const plan = planPreparedAdmission(manifest, normalizedInventory, {
    logicalQuotaBytes: options.logicalQuotaBytes,
    now: now(),
  });
  emit(options, {
    phase: "planned",
    completedResources: 0,
    totalResources: manifest.resources.length,
    completedLogicalBytes: 0,
    totalLogicalBytes: manifest.totalLogicalBytes,
    evictionRegionIds: plan.evictRegionIds,
  });

  let transaction: OfflineRegionWriteTransaction;
  try {
    transaction = await options.store.beginWrite(manifest.id);
  } catch (cause) {
    throw new HonuaOfflineRegionError("store-failed", "Failed to begin an offline region transaction.", { cause });
  }
  let settled = false;
  try {
    for (const regionId of plan.evictRegionIds) {
      throwIfAborted(options.signal);
      await transaction.evict(regionId);
    }
    let completedResources = 0;
    let completedLogicalBytes = 0;
    for (const resource of manifest.resources) {
      throwIfAborted(options.signal);
      emit(options, {
        phase: "downloading",
        completedResources,
        totalResources: manifest.resources.length,
        completedLogicalBytes,
        totalLogicalBytes: manifest.totalLogicalBytes,
        resourceId: resource.id,
      });
      const ownedBytes = await loadOwnedResource(resource, manifest, options);
      throwIfAborted(options.signal);
      if (ownedBytes.byteLength !== resource.byteLength) {
        throw new HonuaOfflineRegionError(
          "integrity-mismatch",
          `Resource "${resource.id}" declared ${resource.byteLength} bytes but loaded ${ownedBytes.byteLength}.`,
          { resourceId: resource.id },
        );
      }
      const integrity = await sha256(ownedBytes);
      if (integrity !== resource.integrity) {
        throw new HonuaOfflineRegionError(
          "integrity-mismatch",
          `Resource "${resource.id}" failed SHA-256 verification.`,
          {
            resourceId: resource.id,
          },
        );
      }
      throwIfAborted(options.signal);
      emit(options, {
        phase: "writing",
        completedResources,
        totalResources: manifest.resources.length,
        completedLogicalBytes,
        totalLogicalBytes: manifest.totalLogicalBytes,
        resourceId: resource.id,
      });
      await transaction.write(resource, ownedBytes);
      completedResources += 1;
      completedLogicalBytes += ownedBytes.byteLength;
    }
    throwIfAborted(options.signal);
    emit(options, {
      phase: "committing",
      completedResources: manifest.resources.length,
      totalResources: manifest.resources.length,
      completedLogicalBytes: manifest.totalLogicalBytes,
      totalLogicalBytes: manifest.totalLogicalBytes,
    });
    const receipt: OfflineRegionDownloadReceipt = deepFreeze({
      regionId: manifest.id,
      resourceCount: manifest.resources.length,
      logicalByteLength: manifest.totalLogicalBytes,
      evictedRegionIds: [...plan.evictRegionIds],
      integrity: "verified",
      quotaAccounting: "logical-payload-bytes",
      completedAt: normalizeTimestamp(now().toISOString(), "completedAt", false),
    });
    const commit = await transaction.commit(manifest, receipt, {
      expectedInventoryRevision: normalizedInventory.revision,
      logicalQuotaBytes: plan.logicalQuotaBytes,
      admission: plan,
    });
    if (commit === "inventory-changed") {
      throw new HonuaOfflineRegionError(
        "inventory-changed",
        "Offline region inventory changed before commit; retry against a fresh quota snapshot.",
      );
    }
    if (commit !== "committed") {
      throw new HonuaOfflineRegionError("store-failed", "Offline region store returned an invalid commit result.");
    }
    settled = true;
    emit(options, {
      phase: "complete",
      completedResources: manifest.resources.length,
      totalResources: manifest.resources.length,
      completedLogicalBytes: manifest.totalLogicalBytes,
      totalLogicalBytes: manifest.totalLogicalBytes,
    });
    return receipt;
  } catch (cause) {
    if (!settled) {
      try {
        await transaction.rollback();
      } catch (rollbackCause) {
        throw new HonuaOfflineRegionError("store-failed", "Offline region rollback failed.", {
          cause: new AggregateError([cause, rollbackCause]),
        });
      }
    }
    if (cause instanceof HonuaOfflineRegionError) throw cause;
    throw new HonuaOfflineRegionError("store-failed", "Offline region transaction failed.", { cause });
  }
}

function captureCreationInput(input: CreateOfflineRegionManifestInput): CreationSnapshot {
  try {
    const record = plainRecord(input, "input");
    allowedKeys(record, CREATE_KEYS, "input");
    const limits = normalizeLimits(record.limits);
    const budget = new TrustBudget(limits);
    const name = budget.string(record.name, "name", false);
    const sourceId = budget.string(record.sourceId, "sourceId", false);
    const authorizationScopeFingerprint = budget.string(
      record.authorizationScopeFingerprint,
      "authorizationScopeFingerprint",
      false,
    );
    const endpoint = credentialFreeEndpoint(record.endpoint, budget, false);
    const sourceVersion = budget.string(record.sourceVersion, "sourceVersion", false);
    const schemaVersion = budget.string(record.schemaVersion, "schemaVersion", false);
    const planVersion = budget.string(record.planVersion, "planVersion", false);
    const observation = normalizeObservation(record.observation, budget, false);
    const validator = normalizeValidator(record.validator, budget, false);
    const bounds = normalizeBounds(record.bounds, budget, false);
    const minZoom = normalizeZoom(record.minZoom, "minZoom");
    const maxZoom = normalizeZoom(record.maxZoom, "maxZoom");
    if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
      invalid("minZoom must be less than or equal to maxZoom.", "minZoom");
    }
    const expiresAt =
      record.expiresAt === undefined ? undefined : normalizeTimestamp(record.expiresAt, "expiresAt", false, budget);
    const attribution = normalizeAttribution(record.attribution ?? {}, budget, limits, false);
    const resources = normalizeResources(
      record.resources,
      { sourceVersion, schemaVersion, planVersion, attributionIds: ownKeys(attribution) },
      budget,
      limits,
      false,
    );
    const totalLogicalBytes = resources.reduce(
      (total, resource) => safeAdd(total, resource.byteLength, "resources"),
      0,
    );
    if (totalLogicalBytes > limits.maxLogicalBytes) {
      limit(
        `Offline region requires ${totalLogicalBytes} logical bytes; maximum is ${limits.maxLogicalBytes}.`,
        "resources",
      );
    }
    return deepFreeze({
      name,
      sourceId,
      endpoint,
      authorizationScopeFingerprint,
      bounds,
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
      sourceVersion,
      schemaVersion,
      planVersion,
      observation,
      ...(validator ? { validator } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      attribution,
      resources,
      totalLogicalBytes,
      limits,
    });
  } catch (cause) {
    throwStructured(cause, "Invalid offline region creation input.");
  }
}

function captureManifest(input: OfflineRegionManifestV1): PreparedManifest {
  try {
    const limits = defaultLimits();
    const budget = new TrustBudget(limits);
    const record = plainRecord(input, "manifest");
    allowedKeys(record, MANIFEST_KEYS, "manifest");
    if (record.kind !== HONUA_OFFLINE_REGION_KIND) invalid("Unsupported offline region kind.", "kind");
    if (record.version !== HONUA_OFFLINE_REGION_VERSION) invalid("Unsupported offline region version.", "version");
    const id = integrityString(record.id, "id", budget, true);
    const name = budget.string(record.name, "name", true);
    const sourceRecord = plainRecord(record.source, "source");
    allowedKeys(sourceRecord, SOURCE_KEYS, "source");
    const sourceId = budget.string(sourceRecord.id, "source.id", true);
    const endpoint = credentialFreeEndpoint(sourceRecord.endpoint, budget, true);
    const authorizationScopeDigest = integrityString(
      sourceRecord.authorizationScopeDigest,
      "source.authorizationScopeDigest",
      budget,
      true,
    );
    const sourceVersion = budget.string(sourceRecord.sourceVersion, "source.sourceVersion", true);
    const schemaVersion = budget.string(sourceRecord.schemaVersion, "source.schemaVersion", true);
    const planVersion = budget.string(sourceRecord.planVersion, "source.planVersion", true);
    const observation = normalizeObservation(sourceRecord.observation, budget, true);
    const validator = normalizeValidator(sourceRecord.validator, budget, true);
    const bounds = normalizeBounds(record.bounds, budget, true);
    const minZoom = normalizeZoom(record.minZoom, "minZoom");
    const maxZoom = normalizeZoom(record.maxZoom, "maxZoom");
    if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
      invalid("minZoom must be less than or equal to maxZoom.", "minZoom");
    }
    const expiresAt =
      record.expiresAt === undefined ? undefined : normalizeTimestamp(record.expiresAt, "expiresAt", true, budget);
    const attribution = normalizeAttribution(record.attribution, budget, limits, true);
    const resources = normalizeResources(
      record.resources,
      { sourceVersion, schemaVersion, planVersion, attributionIds: ownKeys(attribution) },
      budget,
      limits,
      true,
    );
    const totalLogicalBytes = nonNegativeInteger(record.totalLogicalBytes, "totalLogicalBytes");
    const summed = resources.reduce((total, resource) => safeAdd(total, resource.byteLength, "resources"), 0);
    if (summed !== totalLogicalBytes)
      invalid("totalLogicalBytes does not match resource payload lengths.", "totalLogicalBytes");
    if (summed > limits.maxLogicalBytes) limit("Offline region exceeds the logical-byte limit.", "totalLogicalBytes");
    const identity = {
      kind: HONUA_OFFLINE_REGION_KIND,
      version: HONUA_OFFLINE_REGION_VERSION,
      name,
      source: {
        id: sourceId,
        endpoint,
        authorizationScopeDigest,
        sourceVersion,
        schemaVersion,
        planVersion,
        observation,
        ...(validator ? { validator } : {}),
      },
      bounds,
      ...(minZoom !== undefined ? { minZoom } : {}),
      ...(maxZoom !== undefined ? { maxZoom } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      attribution,
      resources,
      totalLogicalBytes,
    };
    const manifest = deepFreeze({ ...identity, id }) as OfflineRegionManifestV1;
    return { manifest, canonicalIdentity: canonicalJson(identity) };
  } catch (cause) {
    throwStructured(cause, "Invalid offline region manifest.");
  }
}

async function loadOwnedResource(
  resource: OfflineRegionResourceV1,
  manifest: OfflineRegionManifestV1,
  options: OfflineRegionDownloadOptions,
): Promise<Uint8Array> {
  try {
    const loaded = await options.load(resource, {
      manifest,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!(loaded instanceof ArrayBuffer) && !(loaded instanceof Uint8Array)) {
      invalid(`Loader returned an unsupported payload for resource "${resource.id}".`, "load");
    }
    const view = loaded instanceof Uint8Array ? loaded : new Uint8Array(loaded);
    // Establish coordinator ownership before hashing or exposing progress/write.
    return Uint8Array.from(view);
  } catch (cause) {
    throwIfAborted(options.signal);
    if (cause instanceof HonuaOfflineRegionError) throw cause;
    throw new HonuaOfflineRegionError("resource-load-failed", `Failed to load resource "${resource.id}".`, {
      cause,
      resourceId: resource.id,
    });
  }
}

function normalizeResources(
  value: unknown,
  defaults: {
    readonly sourceVersion: string;
    readonly schemaVersion: string;
    readonly planVersion: string;
    readonly attributionIds: readonly string[];
  },
  budget: TrustBudget,
  limits: NormalizedLimits,
  normalizedRequired: boolean,
): readonly OfflineRegionResourceV1[] {
  const input = denseArray(value, "resources", limits.maxResources);
  const ids = new Set<string>();
  const out: OfflineRegionResourceV1[] = [];
  let cumulativeLogicalBytes = 0;
  let previousId: string | undefined;
  for (let index = 0; index < input.length; index += 1) {
    const path = `resources[${index}]`;
    const record = plainRecord(input[index], path);
    allowedKeys(record, RESOURCE_KEYS, path);
    budget.metadata(1, path);
    const id = budget.string(record.id, `${path}.id`, normalizedRequired);
    if (ids.has(id)) invalid(`Duplicate resource id "${id}".`, `${path}.id`);
    ids.add(id);
    if (normalizedRequired && previousId !== undefined && compareCodeUnits(previousId, id) >= 0) {
      invalid("resources must be in deterministic code-unit order.", path);
    }
    previousId = id;
    if (typeof record.kind !== "string" || !RESOURCE_KINDS.has(record.kind))
      invalid(`${path}.kind is invalid.`, `${path}.kind`);
    const byteLength = nonNegativeInteger(record.byteLength, `${path}.byteLength`);
    cumulativeLogicalBytes = safeAdd(cumulativeLogicalBytes, byteLength, `${path}.byteLength`);
    if (cumulativeLogicalBytes > limits.maxLogicalBytes) {
      limit(`${path} exceeds the cumulative logical-byte limit.`, `${path}.byteLength`);
    }
    const integrity = integrityString(record.integrity, `${path}.integrity`, budget, normalizedRequired);
    const contentType =
      record.contentType === undefined
        ? undefined
        : budget.string(record.contentType, `${path}.contentType`, normalizedRequired);
    const sourceVersion = budget.string(
      record.sourceVersion ?? defaults.sourceVersion,
      `${path}.sourceVersion`,
      normalizedRequired,
    );
    const schemaVersion = budget.string(
      record.schemaVersion ?? defaults.schemaVersion,
      `${path}.schemaVersion`,
      normalizedRequired,
    );
    const planVersion = budget.string(
      record.planVersion ?? defaults.planVersion,
      `${path}.planVersion`,
      normalizedRequired,
    );
    if (
      normalizedRequired &&
      (record.sourceVersion === undefined || record.schemaVersion === undefined || record.planVersion === undefined)
    ) {
      invalid(`${path} must carry explicit source, schema, and plan versions.`, path);
    }
    const rawAttributionIds = record.attributionIds ?? defaults.attributionIds;
    const attributionInput = denseArray(rawAttributionIds, `${path}.attributionIds`, limits.maxAttributions);
    budget.metadata(attributionInput.length, `${path}.attributionIds`);
    const attributionIds: string[] = [];
    let previousAttribution: string | undefined;
    const seenAttribution = new Set<string>();
    for (let item = 0; item < attributionInput.length; item += 1) {
      const attributionId = budget.string(
        attributionInput[item],
        `${path}.attributionIds[${item}]`,
        normalizedRequired,
      );
      if (!defaults.attributionIds.includes(attributionId)) {
        invalid(
          `Resource "${id}" references unknown attribution "${attributionId}".`,
          `${path}.attributionIds[${item}]`,
        );
      }
      if (seenAttribution.has(attributionId)) invalid("Duplicate attribution id.", `${path}.attributionIds[${item}]`);
      if (
        normalizedRequired &&
        previousAttribution !== undefined &&
        compareCodeUnits(previousAttribution, attributionId) >= 0
      ) {
        invalid("attributionIds must be in deterministic code-unit order.", `${path}.attributionIds`);
      }
      seenAttribution.add(attributionId);
      previousAttribution = attributionId;
      attributionIds.push(attributionId);
    }
    if (!normalizedRequired) attributionIds.sort(compareCodeUnits);
    out.push({
      id,
      kind: record.kind as OfflineRegionResourceV1["kind"],
      byteLength,
      integrity,
      ...(contentType ? { contentType } : {}),
      sourceVersion,
      schemaVersion,
      planVersion,
      attributionIds,
    });
  }
  if (!normalizedRequired) out.sort((left, right) => compareCodeUnits(left.id, right.id));
  return out;
}

function normalizeAttribution(
  value: unknown,
  budget: TrustBudget,
  limits: NormalizedLimits,
  normalizedRequired: boolean,
): Readonly<Record<string, string>> {
  const record = plainRecord(value, "attribution");
  const entries: Array<readonly [string, string]> = [];
  for (const rawId in record) {
    if (!Object.hasOwn(record, rawId)) continue;
    if (entries.length >= limits.maxAttributions) limit("attribution exceeds the entry limit.", "attribution");
    budget.metadata(1, `attribution.${rawId}`);
    const id = budget.string(rawId, "attribution id", normalizedRequired);
    const text = budget.string(record[rawId], `attribution.${id}`, normalizedRequired);
    entries.push([id, text]);
  }
  entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return Object.fromEntries(entries);
}

function normalizeObservation(
  value: unknown,
  budget: TrustBudget,
  normalizedRequired: boolean,
): OfflineRegionObservation {
  const record = plainRecord(value, "observation");
  allowedKeys(record, OBSERVATION_KEYS, "observation");
  budget.metadata(1, "observation");
  if (record.state !== "live" && record.state !== "cached" && record.state !== "replayed") {
    invalid("observation.state must be live, cached, or replayed.", "observation.state");
  }
  return {
    state: record.state,
    observedAt: normalizeTimestamp(record.observedAt, "observation.observedAt", normalizedRequired, budget),
    ...(record.validAt !== undefined
      ? { validAt: normalizeTimestamp(record.validAt, "observation.validAt", normalizedRequired, budget) }
      : {}),
  };
}

function normalizeValidator(
  value: unknown,
  budget: TrustBudget,
  normalizedRequired: boolean,
): OfflineRegionValidator | undefined {
  if (value === undefined) return undefined;
  const record = plainRecord(value, "validator");
  allowedKeys(record, VALIDATOR_KEYS, "validator");
  budget.metadata(1, "validator");
  const etag = record.etag === undefined ? undefined : budget.string(record.etag, "validator.etag", normalizedRequired);
  const lastModified =
    record.lastModified === undefined
      ? undefined
      : normalizeTimestamp(record.lastModified, "validator.lastModified", normalizedRequired, budget);
  if (etag === undefined && lastModified === undefined)
    invalid("validator must include etag or lastModified.", "validator");
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

function normalizeBounds(value: unknown, budget: TrustBudget, normalizedRequired: boolean): OfflineRegionBounds {
  const record = plainRecord(value, "bounds");
  allowedKeys(record, BOUNDS_KEYS, "bounds");
  const minX = finiteNumber(record.minX, "bounds.minX");
  const minY = finiteNumber(record.minY, "bounds.minY");
  const maxX = finiteNumber(record.maxX, "bounds.maxX");
  const maxY = finiteNumber(record.maxY, "bounds.maxY");
  if (minX >= maxX || minY >= maxY) {
    invalid("bounds must have positive width and height; antimeridian crossing is not supported in v1.", "bounds");
  }
  return { minX, minY, maxX, maxY, crs: budget.string(record.crs, "bounds.crs", normalizedRequired) };
}

function normalizeInventory(value: unknown): OfflineRegionCacheInventory {
  try {
    const limits = defaultLimits();
    const budget = new TrustBudget(limits);
    const record = plainRecord(value, "inventory");
    allowedKeys(record, new Set(["revision", "regions"]), "inventory");
    const revision = budget.string(record.revision, "inventory.revision", true);
    const input = denseArray(record.regions, "inventory.regions", limits.maxResources);
    const ids = new Set<string>();
    const regions: OfflineRegionStoredRegion[] = [];
    for (let index = 0; index < input.length; index += 1) {
      const path = `inventory.regions[${index}]`;
      const item = plainRecord(input[index], path);
      allowedKeys(item, new Set(["id", "logicalByteLength", "lastAccessedAt", "expiresAt", "pinned"]), path);
      const id = budget.string(item.id, `${path}.id`, true);
      if (ids.has(id)) invalid(`Duplicate stored region id "${id}".`, `${path}.id`);
      ids.add(id);
      regions.push({
        id,
        logicalByteLength: nonNegativeInteger(item.logicalByteLength, `${path}.logicalByteLength`),
        lastAccessedAt: normalizeTimestamp(item.lastAccessedAt, `${path}.lastAccessedAt`, true, budget),
        ...(item.expiresAt !== undefined
          ? { expiresAt: normalizeTimestamp(item.expiresAt, `${path}.expiresAt`, true, budget) }
          : {}),
        ...(item.pinned !== undefined ? { pinned: requiredBoolean(item.pinned, `${path}.pinned`) } : {}),
      });
    }
    return deepFreeze({ revision, regions });
  } catch (cause) {
    throwStructured(cause, "Invalid offline region inventory.");
  }
}

function normalizeLimits(value: unknown): NormalizedLimits {
  if (value === undefined) return defaultLimits();
  const record = plainRecord(value, "limits");
  allowedKeys(record, LIMIT_KEYS, "limits");
  return {
    maxResources: tightened(record.maxResources, DEFAULT_OFFLINE_REGION_MAX_RESOURCES, "limits.maxResources"),
    maxLogicalBytes: tightened(
      record.maxLogicalBytes,
      DEFAULT_OFFLINE_REGION_MAX_LOGICAL_BYTES,
      "limits.maxLogicalBytes",
    ),
    maxStringBytes: tightened(record.maxStringBytes, DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES, "limits.maxStringBytes"),
    maxAttributions: tightened(
      record.maxAttributions,
      DEFAULT_OFFLINE_REGION_MAX_ATTRIBUTIONS,
      "limits.maxAttributions",
    ),
    maxMetadataEntries: tightened(
      record.maxMetadataEntries,
      DEFAULT_OFFLINE_REGION_MAX_METADATA_ENTRIES,
      "limits.maxMetadataEntries",
    ),
  };
}

function defaultLimits(): NormalizedLimits {
  return {
    maxResources: DEFAULT_OFFLINE_REGION_MAX_RESOURCES,
    maxLogicalBytes: DEFAULT_OFFLINE_REGION_MAX_LOGICAL_BYTES,
    maxStringBytes: DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES,
    maxAttributions: DEFAULT_OFFLINE_REGION_MAX_ATTRIBUTIONS,
    maxMetadataEntries: DEFAULT_OFFLINE_REGION_MAX_METADATA_ENTRIES,
  };
}

function tightened(value: unknown, ceiling: number, path: string): number {
  return Math.min(value === undefined ? ceiling : nonNegativeInteger(value, path), ceiling);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(`${path} must be a plain object.`, path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${path} must be a plain object.`, path);
  if (Object.getOwnPropertySymbols(value).length > 0) invalid(`${path} must not contain symbol properties.`, path);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid(`${path}.${key} must be a data property.`, `${path}.${key}`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key in record) {
    if (Object.hasOwn(record, key) && !allowed.has(key)) invalid(`${path}.${key} is not supported.`, `${path}.${key}`);
  }
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) {
      invalid(`${path}.${key} must be an enumerable data property.`, `${path}.${key}`);
    }
  }
}

function denseArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) invalid(`${path} must be an array.`, path);
  if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
    invalid(`${path} must be a plain array.`, path);
  }
  if (value.length > maximum) limit(`${path} contains ${value.length} entries; maximum is ${maximum}.`, path);
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
      invalid(`${path} must not contain named properties.`, `${path}.${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalid(`${path}[${key}] must be a data property.`, `${path}[${key}]`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`${path} must not contain sparse entries.`, `${path}[${index}]`);
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor)) {
      invalid(`${path}[${index}] must be a data property.`, `${path}[${index}]`);
    }
  }
  return value;
}

function ownKeys(record: Readonly<Record<string, string>>): readonly string[] {
  const keys: string[] = [];
  for (const key in record) if (Object.hasOwn(record, key)) keys.push(key);
  return keys;
}

function credentialFreeEndpoint(value: unknown, budget: TrustBudget, normalizedRequired: boolean): string {
  if (typeof value !== "string" && !(value instanceof URL)) invalid("endpoint must be a string or URL.", "endpoint");
  const raw = value instanceof URL ? value.href : value;
  budget.string(raw, "endpoint", false);
  const normalized = tryNormalizeDiscoveryEndpoint(value as string | URL);
  if (normalized === undefined) invalid("endpoint must be a valid absolute URL.", "endpoint");
  if (normalizedRequired && raw !== normalized)
    invalid("endpoint contains credentials or is not normalized.", "endpoint");
  return normalized;
}

function integrityString(
  value: unknown,
  path: string,
  budget: TrustBudget,
  normalizedRequired: boolean,
): `sha256:${string}` {
  const normalized = budget.string(value, path, normalizedRequired);
  if (!INTEGRITY_PATTERN.test(normalized)) invalid(`${path} must be a lowercase SHA-256 digest.`, path);
  return normalized as `sha256:${string}`;
}

function normalizeTimestamp(value: unknown, path: string, normalizedRequired: boolean, budget?: TrustBudget): string {
  const raw = budget ? budget.string(value, path, normalizedRequired) : typeof value === "string" ? value : "";
  if (raw.length === 0) invalid(`${path} must be an ISO-8601 timestamp.`, path);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) invalid(`${path} must be an ISO-8601 timestamp.`, path);
  const normalized = date.toISOString();
  if (normalizedRequired && normalized !== raw) invalid(`${path} is not a normalized ISO-8601 timestamp.`, path);
  return normalized;
}

function normalizeZoom(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const zoom = nonNegativeInteger(value, path);
  if (zoom > 30) invalid(`${path} must be between 0 and 30.`, path);
  return zoom;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${path} must be finite.`, path);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${path} must be a non-negative safe integer.`, path);
  }
  return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(`${path} must be a boolean.`, path);
  return value;
}

function safeAdd(left: number, right: number, path: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalid(`${path} logical-byte accounting exceeds Number.MAX_SAFE_INTEGER.`, path);
  return result;
}

function isExpired(region: OfflineRegionStoredRegion, nowMs: number): boolean {
  return region.expiresAt !== undefined && Date.parse(region.expiresAt) <= nowMs;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) invalid("Offline region identity cannot contain undefined values.", "identity");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries: Array<readonly [string, unknown]> = [];
  for (const key in value as Record<string, unknown>) {
    if (Object.hasOwn(value as object, key)) entries.push([key, (value as Record<string, unknown>)[key]]);
  }
  entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

async function sha256(value: string | Uint8Array): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) invalid("Offline region identity and integrity require Web Crypto SHA-256.", "crypto");
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digestInput: BufferSource =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as unknown as BufferSource)
      : (Uint8Array.from(bytes) as unknown as BufferSource);
  const digest = await subtle.digest("SHA-256", digestInput);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new HonuaOfflineRegionError("aborted", "Offline region download was aborted.", { cause: signal.reason });
  }
}

function emit(options: OfflineRegionDownloadOptions, progress: OfflineRegionDownloadProgress): void {
  try {
    options.onProgress?.(deepFreeze(progress));
  } catch {
    // Progress is observational and must not influence atomic transaction state.
  }
}

function invalid(message: string, path?: string): never {
  throw new HonuaOfflineRegionError("invalid-manifest", message, { path });
}

function limit(message: string, path?: string): never {
  throw new HonuaOfflineRegionError("resource-limit-exceeded", message, { path });
}

function throwStructured(cause: unknown, message: string): never {
  if (cause instanceof HonuaOfflineRegionError) throw cause;
  throw new HonuaOfflineRegionError("invalid-manifest", message, { cause });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
