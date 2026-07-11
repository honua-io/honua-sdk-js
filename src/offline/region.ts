import { normalizeDiscoveryEndpoint } from "../contract/discovery.js";
import {
  type CreateOfflineRegionManifestInput,
  DEFAULT_OFFLINE_REGION_MAX_BYTES,
  DEFAULT_OFFLINE_REGION_MAX_RESOURCES,
  DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES,
  HONUA_OFFLINE_REGION_KIND,
  HONUA_OFFLINE_REGION_VERSION,
  HonuaOfflineRegionError,
  type OfflineRegionAdmissionPlan,
  type OfflineRegionCacheInventory,
  type OfflineRegionDownloadOptions,
  type OfflineRegionDownloadProgress,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionLimits,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceInput,
  type OfflineRegionResourceV1,
  type OfflineRegionStoredRegion,
  type OfflineRegionWriteTransaction,
} from "./types.js";

const INTEGRITY_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RESOURCE_KINDS = new Set(["metadata", "features", "tile", "asset", "attribution"]);
const encoder = new TextEncoder();

/** Create an immutable, deterministic, credential-free downloadable-region manifest. */
export async function createOfflineRegionManifest(
  input: CreateOfflineRegionManifestInput,
): Promise<OfflineRegionManifestV1> {
  const limits = normalizeLimits(input.limits);
  if (input.resources.length > limits.maxResources) {
    throw new HonuaOfflineRegionError(
      "resource-limit-exceeded",
      `Offline region contains ${input.resources.length} resources; maximum is ${limits.maxResources}.`,
    );
  }

  const name = requiredString(input.name, "name");
  const sourceId = requiredString(input.sourceId, "sourceId");
  const sourceVersion = requiredString(input.sourceVersion, "sourceVersion");
  const schemaVersion = requiredString(input.schemaVersion, "schemaVersion");
  const planVersion = requiredString(input.planVersion, "planVersion");
  const observation = normalizeObservation(input.observation);
  const validator = normalizeValidator(input.validator);
  const scope = requiredString(input.authorizationScopeFingerprint, "authorizationScopeFingerprint");
  const endpoint = credentialFreeEndpoint(input.endpoint);
  const bounds = normalizeBounds(input.bounds);
  const minZoom = normalizeZoom(input.minZoom, "minZoom");
  const maxZoom = normalizeZoom(input.maxZoom, "maxZoom");
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    invalid("minZoom must be less than or equal to maxZoom.");
  }
  const expiresAt = input.expiresAt === undefined ? undefined : normalizeTimestamp(input.expiresAt, "expiresAt");
  const attribution = normalizeAttribution(input.attribution ?? {});
  const resources = normalizeResources(input.resources, {
    sourceVersion,
    schemaVersion,
    planVersion,
    attributionIds: Object.keys(attribution),
  });
  const totalBytes = resources.reduce((total, resource) => safeAdd(total, resource.byteLength), 0);
  if (totalBytes > limits.maxBytes) {
    throw new HonuaOfflineRegionError(
      "resource-limit-exceeded",
      `Offline region requires ${totalBytes} bytes; maximum is ${limits.maxBytes}.`,
    );
  }

  const authorizationScopeDigest = await sha256(`honua-offline-scope:v1:${scope}`);
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
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    attribution,
    resources,
    totalBytes,
  };
  const canonicalIdentity = canonicalJson(identity);
  if (encoder.encode(canonicalIdentity).byteLength > limits.maxStringBytes) {
    throw new HonuaOfflineRegionError(
      "resource-limit-exceeded",
      `Offline region descriptor strings exceed the ${limits.maxStringBytes}-byte limit.`,
    );
  }
  const id = await sha256(`honua-offline-region:v1:${canonicalIdentity}`);
  return deepFreeze({ ...identity, id });
}

/**
 * Produce a deterministic quota/eviction decision. Expired entries are evicted
 * first, then least-recently-used entries, with region id as the final tie-break.
 */
export function planOfflineRegionAdmission(
  manifest: OfflineRegionManifestV1,
  inventory: OfflineRegionCacheInventory,
  options: { readonly quotaBytes: number; readonly now?: Date },
): OfflineRegionAdmissionPlan {
  const quotaBytes = nonNegativeInteger(options.quotaBytes, "quotaBytes");
  const requiredBytes = nonNegativeInteger(manifest.totalBytes, "manifest.totalBytes");
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) invalid("now must be a valid Date.");
  if (manifest.expiresAt !== undefined && Date.parse(normalizeTimestamp(manifest.expiresAt, "expiresAt")) <= nowMs) {
    throw new HonuaOfflineRegionError("expired", `Offline region "${manifest.id}" has expired.`);
  }
  const regions = normalizeInventory(inventory);
  const usedBytesBefore = regions.reduce((total, region) => safeAdd(total, region.byteLength), 0);
  const existing = regions.find((region) => region.id === manifest.id);
  const replacementBytes = existing?.byteLength ?? 0;
  let projected = usedBytesBefore - replacementBytes + requiredBytes;
  const evictions: OfflineRegionStoredRegion[] = [];

  const candidates = regions
    .filter((region) => region.id !== manifest.id && region.pinned !== true)
    .sort((left, right) => {
      const leftExpired = isExpired(left, nowMs) ? 0 : 1;
      const rightExpired = isExpired(right, nowMs) ? 0 : 1;
      return (
        leftExpired - rightExpired ||
        Date.parse(left.lastAccessedAt) - Date.parse(right.lastAccessedAt) ||
        left.id.localeCompare(right.id)
      );
    });
  for (const candidate of candidates) {
    if (projected <= quotaBytes) break;
    evictions.push(candidate);
    projected -= candidate.byteLength;
  }
  if (projected > quotaBytes) {
    const retainedPinnedBytes = regions
      .filter((region) => region.id !== manifest.id && region.pinned === true)
      .reduce((total, region) => safeAdd(total, region.byteLength), 0);
    throw new HonuaOfflineRegionError(
      "quota-exceeded",
      `Offline region requires ${requiredBytes} bytes but only ${Math.max(0, quotaBytes - retainedPinnedBytes)} bytes remain after preserving pinned data.`,
    );
  }
  const evictedBytes = evictions.reduce((total, region) => safeAdd(total, region.byteLength), 0);
  return deepFreeze({
    quotaBytes,
    usedBytesBefore,
    replacementBytes,
    requiredBytes,
    evictRegionIds: evictions.map((region) => region.id),
    evictedBytes,
    usedBytesAfter: projected,
  });
}

/** Download and atomically commit a manifest through caller-injected adapters. */
export async function downloadOfflineRegion(
  manifest: OfflineRegionManifestV1,
  options: OfflineRegionDownloadOptions,
): Promise<OfflineRegionDownloadReceipt> {
  await assertManifest(manifest);
  deepFreeze(manifest);
  throwIfAborted(options.signal);
  const now = options.now ?? (() => new Date());
  let inventory: OfflineRegionCacheInventory;
  try {
    inventory = await options.store.inventory();
  } catch (cause) {
    throw new HonuaOfflineRegionError("store-failed", "Failed to inspect the offline region store.", { cause });
  }
  throwIfAborted(options.signal);
  const plan = planOfflineRegionAdmission(manifest, inventory, { quotaBytes: options.quotaBytes, now: now() });
  emit(options, {
    phase: "planned",
    completedResources: 0,
    totalResources: manifest.resources.length,
    completedBytes: 0,
    totalBytes: manifest.totalBytes,
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
    let completedBytes = 0;
    for (const resource of manifest.resources) {
      throwIfAborted(options.signal);
      emit(options, {
        phase: "downloading",
        completedResources,
        totalResources: manifest.resources.length,
        completedBytes,
        totalBytes: manifest.totalBytes,
        resourceId: resource.id,
      });
      const bytes = await loadResource(resource, manifest, options);
      throwIfAborted(options.signal);
      if (bytes.byteLength !== resource.byteLength) {
        throw new HonuaOfflineRegionError(
          "integrity-mismatch",
          `Resource "${resource.id}" declared ${resource.byteLength} bytes but loaded ${bytes.byteLength}.`,
          { resourceId: resource.id },
        );
      }
      const integrity = await sha256(bytes);
      if (integrity !== resource.integrity) {
        throw new HonuaOfflineRegionError(
          "integrity-mismatch",
          `Resource "${resource.id}" failed SHA-256 verification.`,
          { resourceId: resource.id },
        );
      }
      throwIfAborted(options.signal);
      emit(options, {
        phase: "writing",
        completedResources,
        totalResources: manifest.resources.length,
        completedBytes,
        totalBytes: manifest.totalBytes,
        resourceId: resource.id,
      });
      await transaction.write(resource, bytes);
      completedResources += 1;
      completedBytes += bytes.byteLength;
    }
    throwIfAborted(options.signal);
    emit(options, {
      phase: "committing",
      completedResources: manifest.resources.length,
      totalResources: manifest.resources.length,
      completedBytes: manifest.totalBytes,
      totalBytes: manifest.totalBytes,
    });
    const receipt: OfflineRegionDownloadReceipt = deepFreeze({
      regionId: manifest.id,
      resourceCount: manifest.resources.length,
      byteLength: manifest.totalBytes,
      evictedRegionIds: [...plan.evictRegionIds],
      integrity: "verified",
      completedAt: normalizeTimestamp(now().toISOString(), "completedAt"),
    });
    await transaction.commit(manifest, receipt);
    settled = true;
    emit(options, {
      phase: "complete",
      completedResources: manifest.resources.length,
      totalResources: manifest.resources.length,
      completedBytes: manifest.totalBytes,
      totalBytes: manifest.totalBytes,
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

async function loadResource(
  resource: OfflineRegionResourceV1,
  manifest: OfflineRegionManifestV1,
  options: OfflineRegionDownloadOptions,
): Promise<Uint8Array> {
  try {
    const loaded = await options.load(resource, {
      manifest,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return loaded instanceof Uint8Array ? loaded : new Uint8Array(loaded);
  } catch (cause) {
    throwIfAborted(options.signal);
    throw new HonuaOfflineRegionError("resource-load-failed", `Failed to load resource "${resource.id}".`, {
      cause,
      resourceId: resource.id,
    });
  }
}

function normalizeResources(
  resources: readonly OfflineRegionResourceInput[],
  defaults: {
    readonly sourceVersion: string;
    readonly schemaVersion: string;
    readonly planVersion: string;
    readonly attributionIds: readonly string[];
  },
): readonly OfflineRegionResourceV1[] {
  const ids = new Set<string>();
  const out = resources.map((resource, index) => {
    const id = requiredString(resource.id, `resources[${index}].id`);
    if (ids.has(id)) invalid(`Duplicate resource id "${id}".`);
    ids.add(id);
    if (!RESOURCE_KINDS.has(resource.kind)) invalid(`resources[${index}].kind is invalid.`);
    const byteLength = nonNegativeInteger(resource.byteLength, `resources[${index}].byteLength`);
    if (!INTEGRITY_PATTERN.test(resource.integrity)) {
      invalid(`resources[${index}].integrity must be a lowercase SHA-256 digest.`);
    }
    const attributionIds = [
      ...new Set(
        (resource.attributionIds ?? defaults.attributionIds).map((value) => requiredString(value, "attributionId")),
      ),
    ].sort();
    for (const attributionId of attributionIds) {
      if (!defaults.attributionIds.includes(attributionId)) {
        invalid(`Resource "${id}" references unknown attribution "${attributionId}".`);
      }
    }
    return {
      id,
      kind: resource.kind,
      byteLength,
      integrity: resource.integrity,
      ...(resource.contentType ? { contentType: requiredString(resource.contentType, "contentType") } : {}),
      sourceVersion: requiredString(resource.sourceVersion ?? defaults.sourceVersion, "sourceVersion"),
      schemaVersion: requiredString(resource.schemaVersion ?? defaults.schemaVersion, "schemaVersion"),
      planVersion: requiredString(resource.planVersion ?? defaults.planVersion, "planVersion"),
      attributionIds,
    } satisfies OfflineRegionResourceV1;
  });
  return out.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeAttribution(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, text]) => [requiredString(id, "attribution id"), requiredString(text, "attribution text")] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeObservation(
  value: CreateOfflineRegionManifestInput["observation"],
): CreateOfflineRegionManifestInput["observation"] {
  if (value.state !== "live" && value.state !== "cached" && value.state !== "replayed") {
    invalid("observation.state must be live, cached, or replayed.");
  }
  return {
    state: value.state,
    observedAt: normalizeTimestamp(value.observedAt, "observation.observedAt"),
    ...(value.validAt ? { validAt: normalizeTimestamp(value.validAt, "observation.validAt") } : {}),
  };
}

function normalizeValidator(
  value: CreateOfflineRegionManifestInput["validator"],
): CreateOfflineRegionManifestInput["validator"] {
  if (value === undefined) return undefined;
  const etag = value.etag === undefined ? undefined : requiredString(value.etag, "validator.etag");
  const lastModified =
    value.lastModified === undefined ? undefined : normalizeTimestamp(value.lastModified, "validator.lastModified");
  if (etag === undefined && lastModified === undefined) invalid("validator must include etag or lastModified.");
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

function normalizeBounds(
  bounds: CreateOfflineRegionManifestInput["bounds"],
): CreateOfflineRegionManifestInput["bounds"] {
  for (const key of ["minX", "minY", "maxX", "maxY"] as const) {
    if (!Number.isFinite(bounds[key])) invalid(`bounds.${key} must be finite.`);
  }
  if (bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) {
    invalid("Offline region bounds must have positive width and height; antimeridian crossing is not supported in v1.");
  }
  return {
    minX: bounds.minX,
    minY: bounds.minY,
    maxX: bounds.maxX,
    maxY: bounds.maxY,
    crs: requiredString(bounds.crs, "bounds.crs"),
  };
}

function normalizeInventory(inventory: OfflineRegionCacheInventory): OfflineRegionStoredRegion[] {
  const ids = new Set<string>();
  return inventory.regions.map((region, index) => {
    const id = requiredString(region.id, `inventory.regions[${index}].id`);
    if (ids.has(id)) invalid(`Duplicate stored region id "${id}".`);
    ids.add(id);
    const lastAccessedAt = normalizeTimestamp(region.lastAccessedAt, "lastAccessedAt");
    return {
      id,
      byteLength: nonNegativeInteger(region.byteLength, "byteLength"),
      lastAccessedAt,
      ...(region.expiresAt ? { expiresAt: normalizeTimestamp(region.expiresAt, "expiresAt") } : {}),
      ...(region.pinned !== undefined ? { pinned: requiredBoolean(region.pinned, "pinned") } : {}),
    };
  });
}

async function assertManifest(manifest: OfflineRegionManifestV1): Promise<void> {
  if (
    manifest.kind !== HONUA_OFFLINE_REGION_KIND ||
    manifest.version !== HONUA_OFFLINE_REGION_VERSION ||
    !INTEGRITY_PATTERN.test(manifest.id)
  ) {
    invalid("Unsupported or malformed offline region manifest.");
  }
  requiredString(manifest.name, "name");
  requiredString(manifest.source.id, "source.id");
  requiredString(manifest.source.sourceVersion, "source.sourceVersion");
  requiredString(manifest.source.schemaVersion, "source.schemaVersion");
  requiredString(manifest.source.planVersion, "source.planVersion");
  if (canonicalJson(normalizeObservation(manifest.source.observation)) !== canonicalJson(manifest.source.observation)) {
    invalid("Offline region observation is not normalized.");
  }
  if (
    manifest.source.validator !== undefined &&
    canonicalJson(normalizeValidator(manifest.source.validator)) !== canonicalJson(manifest.source.validator)
  ) {
    invalid("Offline region validator is not normalized.");
  }
  if (!INTEGRITY_PATTERN.test(manifest.source.authorizationScopeDigest)) {
    invalid("Offline region authorization scope digest is malformed.");
  }
  if (credentialFreeEndpoint(manifest.source.endpoint) !== manifest.source.endpoint) {
    invalid("Offline region endpoint contains credentials or transient authorization parameters.");
  }
  normalizeBounds(manifest.bounds);
  const minZoom = normalizeZoom(manifest.minZoom, "minZoom");
  const maxZoom = normalizeZoom(manifest.maxZoom, "maxZoom");
  if (minZoom !== undefined && maxZoom !== undefined && minZoom > maxZoom) {
    invalid("minZoom must be less than or equal to maxZoom.");
  }
  if (manifest.expiresAt !== undefined) normalizeTimestamp(manifest.expiresAt, "expiresAt");
  const attribution = normalizeAttribution(manifest.attribution);
  const resources = normalizeResources(manifest.resources, {
    sourceVersion: manifest.source.sourceVersion,
    schemaVersion: manifest.source.schemaVersion,
    planVersion: manifest.source.planVersion,
    attributionIds: Object.keys(attribution),
  });
  if (canonicalJson(resources) !== canonicalJson(manifest.resources)) {
    invalid("Offline region resources are not in canonical order or contain non-normalized values.");
  }
  const total = manifest.resources.reduce((sum, resource) => safeAdd(sum, resource.byteLength), 0);
  if (total !== manifest.totalBytes) invalid("Offline region totalBytes does not match its resources.");
  if (manifest.resources.length > DEFAULT_OFFLINE_REGION_MAX_RESOURCES || total > DEFAULT_OFFLINE_REGION_MAX_BYTES) {
    throw new HonuaOfflineRegionError("resource-limit-exceeded", "Offline region exceeds the default download limits.");
  }
  const { id: _id, ...identity } = manifest;
  const canonicalIdentity = canonicalJson(identity);
  if (encoder.encode(canonicalIdentity).byteLength > DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES) {
    throw new HonuaOfflineRegionError(
      "resource-limit-exceeded",
      "Offline region descriptor strings exceed the default download limit.",
    );
  }
  const expectedId = await sha256(`honua-offline-region:v1:${canonicalIdentity}`);
  if (manifest.id !== expectedId) invalid("Offline region identity does not match its normalized contents.");
}

function normalizeLimits(limits: OfflineRegionLimits = {}): Required<OfflineRegionLimits> {
  return {
    maxResources: Math.min(
      nonNegativeInteger(limits.maxResources ?? DEFAULT_OFFLINE_REGION_MAX_RESOURCES, "maxResources"),
      DEFAULT_OFFLINE_REGION_MAX_RESOURCES,
    ),
    maxBytes: Math.min(
      nonNegativeInteger(limits.maxBytes ?? DEFAULT_OFFLINE_REGION_MAX_BYTES, "maxBytes"),
      DEFAULT_OFFLINE_REGION_MAX_BYTES,
    ),
    maxStringBytes: Math.min(
      nonNegativeInteger(limits.maxStringBytes ?? DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES, "maxStringBytes"),
      DEFAULT_OFFLINE_REGION_MAX_STRING_BYTES,
    ),
  };
}

function normalizeZoom(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const zoom = nonNegativeInteger(value, name);
  if (zoom > 30) invalid(`${name} must be between 0 and 30.`);
  return zoom;
}

function isExpired(region: OfflineRegionStoredRegion, nowMs: number): boolean {
  return region.expiresAt !== undefined && Date.parse(region.expiresAt) <= nowMs;
}

function requiredString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${name} must be a non-empty string.`);
  return value.trim();
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative safe integer.`);
  return value;
}

function requiredBoolean(value: boolean, name: string): boolean {
  if (typeof value !== "boolean") invalid(`${name} must be a boolean.`);
  return value;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalid("Offline region byte accounting exceeds Number.MAX_SAFE_INTEGER.");
  return result;
}

function normalizeTimestamp(value: string, name: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) invalid(`${name} must be an ISO-8601 timestamp.`);
  return date.toISOString();
}

function credentialFreeEndpoint(value: string | URL): string {
  try {
    return normalizeDiscoveryEndpoint(value);
  } catch (cause) {
    throw new HonuaOfflineRegionError("invalid-manifest", "endpoint must be a valid absolute URL.", { cause });
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) invalid("Offline region identity cannot contain undefined values.");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

async function sha256(value: string | Uint8Array): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) invalid("Offline region identity and integrity require Web Crypto SHA-256.");
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

function invalid(message: string): never {
  throw new HonuaOfflineRegionError("invalid-manifest", message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
