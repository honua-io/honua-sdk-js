import type { Capability, DegradedReason, Query } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { QueryPlanCacheOptions } from "../query-planner/types.js";
import { sha256 } from "./digest.js";
import { verifyOfflineRegionManifest } from "./region.js";
import {
  OFFLINE_REGION_PROTOCOL,
  type OfflineRegionResourceSelector,
  type OfflineRegionSelectionIdentityV1,
  canonicalizeOfflineRegionQuery,
  compareOfflineRegionBounds,
  offlineRegionAuthorizationScopeDigest,
  offlineRegionQueryFingerprint,
  offlineRegionResourceId,
} from "./selection.js";
import {
  HonuaOfflineRegionError,
  type OfflineRegionBounds,
  type OfflineRegionManifestV1,
  type OfflineRegionObservation,
  type OfflineRegionResourceKind,
  type OfflineRegionResourceV1,
  type OfflineRegionStore,
  type OfflineRegionValidator,
} from "./types.js";

/**
 * The one gate every offline read passes through.
 *
 * Feature batches, tiles, assets, and metadata documents are different payloads
 * answering different questions, but they are admitted by exactly the same
 * discipline and in exactly the same order: region identity, then the caller's
 * authorization scope, then version expectations, then extent, then expiry, then
 * content-addressed lookup, then integrity. Keeping that order in one module is
 * what makes "the narrowest true reason" a property of the contract rather than
 * of whichever read path a caller happened to use.
 *
 * @experimental
 */

export const HONUA_OFFLINE_REGION_READ_KIND = "honua.offline-region-read" as const;
export const HONUA_OFFLINE_REGION_READ_VERSION = "1.0" as const;

/** Default age at which a region's observation is reported stale. */
export const DEFAULT_OFFLINE_REGION_READ_STALE_AFTER_MS = 15 * 60 * 1000;

export type OfflineRegionReadFreshness = "fresh" | "stale";

/**
 * What the persistent cache did, and why.
 *
 * `regionId` is the region manifest's own content digest, so anything served
 * from storage is traceable to the exact snapshot identity that produced it.
 */
export interface OfflineRegionReadCacheDecisionV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_READ_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_READ_VERSION;
  readonly policy: "prefer-cache";
  readonly action: "reuse";
  readonly state: "offline";
  readonly freshness: OfflineRegionReadFreshness;
  readonly completeness: "complete" | "partial";
  readonly reason: "offline-entry" | "stale-entry";
  /** Region manifest identity. Binds this answer to one snapshot. */
  readonly regionId: `sha256:${string}`;
  readonly queryFingerprint: `sha256:${string}`;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly observedAt: string;
  readonly ageMs: number;
  readonly staleAfterMs: number;
  /** Exactly which stored resources answered this read. */
  readonly resources: readonly {
    readonly id: string;
    readonly kind: OfflineRegionResourceKind;
    readonly byteLength: number;
    readonly integrity: `sha256:${string}`;
  }[];
}

/** Credential-free provenance travelling with anything served from storage. */
export interface OfflineRegionReadProvenanceV1 {
  readonly sourceId: string;
  readonly endpoint: string;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planVersion: string;
  readonly observation: OfflineRegionObservation;
  readonly validator?: OfflineRegionValidator;
}

/**
 * Inputs every offline read shares.
 *
 * A store is deliberately absent: admission is decided entirely from the
 * manifest and the caller's own inputs, so the same options resolve a resource
 * identity for a host's request matcher without any storage access at all.
 */
export interface OfflineRegionReadGateOptions {
  /**
   * The caller's current authorization-scope partition input. Its digest must
   * equal the region's, so a scope change can never serve another principal's
   * cached bytes.
   */
  readonly authorizationScopeFingerprint: string;
  /**
   * Protocol-neutral query the snapshot was planned with. Every resource of a
   * snapshot is identified against its selection's canonical query, so a tile or
   * document planned under a query must be read back under the same one.
   */
  readonly query?: Query;
  /** Extent the caller is asking about. Must equal the region's own extent. */
  readonly bounds?: OfflineRegionBounds;
  /** Versions the caller expects. A drift fails closed instead of serving stale schema. */
  readonly expect?: {
    readonly sourceVersion?: string;
    readonly schemaVersion?: string;
    readonly planVersion?: string;
  };
  readonly now?: () => Date;
  readonly staleAfterMs?: number;
  readonly signal?: AbortSignal;
}

/** Gate inputs plus the store a read will resolve its identity against. */
export interface OfflineRegionStoreReadOptions extends OfflineRegionReadGateOptions {
  readonly store: OfflineRegionStore;
}

/** An admitted read: the region is verified, in scope, unexpired, and addressable. */
export interface OfflineRegionReadGateV1 {
  readonly manifest: OfflineRegionManifestV1;
  readonly sourceId: string;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly selection: OfflineRegionSelectionIdentityV1;
  readonly queryFingerprint: `sha256:${string}`;
  readonly pagination: { readonly offset: number; readonly limit?: number };
  readonly now: Date;
  readonly ageMs: number;
  readonly staleAfterMs: number;
  readonly freshness: OfflineRegionReadFreshness;
}

/**
 * Admit a read against a persisted region, or fail with the narrowest true reason.
 *
 * Nothing here touches stored bytes: every failure this raises is knowable from
 * the manifest and the caller's own inputs, so an inadmissible read never causes
 * a storage access at all.
 */
export async function openOfflineRegionRead(
  inputManifest: OfflineRegionManifestV1,
  options: OfflineRegionReadGateOptions,
): Promise<OfflineRegionReadGateV1> {
  throwIfAborted(options.signal);
  const manifest = await verifyOfflineRegionManifest(inputManifest);
  const sourceId = manifest.source.id;

  const authorizationScopeDigest = await offlineRegionAuthorizationScopeDigest(options.authorizationScopeFingerprint);
  if (authorizationScopeDigest !== manifest.source.authorizationScopeDigest) {
    // The single most important invariant: a scope change never reads another
    // principal's cached bytes, and the failure names no scope material.
    throw new HonuaOfflineRegionError(
      "scope-mismatch",
      "Offline region belongs to a different authorization scope than this read.",
      { path: "authorizationScopeFingerprint" },
    );
  }

  assertExpectedVersion(options.expect?.sourceVersion, manifest.source.sourceVersion, "sourceVersion");
  assertExpectedVersion(options.expect?.schemaVersion, manifest.source.schemaVersion, "schemaVersion");
  assertExpectedVersion(options.expect?.planVersion, manifest.source.planVersion, "planVersion");

  if (options.bounds !== undefined) {
    const relation = compareOfflineRegionBounds(options.bounds, manifest.bounds);
    if (relation === "outside") {
      throw new HonuaOfflineRegionError(
        "out-of-region",
        "Requested extent is not covered by this offline region's bounds.",
        { path: "bounds" },
      );
    }
    if (relation === "contained") {
      // Narrowing to a sub-extent means evaluating a spatial predicate over the
      // stored payload. Returning the wider snapshot instead would silently widen
      // the caller's question, so the read refuses rather than approximates.
      throw new HonuaCapabilityNotSupportedError("querySubExtent", OFFLINE_REGION_PROTOCOL, sourceId);
    }
  }

  const scope = canonicalizeOfflineRegionQuery(options.query, sourceId);
  const queryFingerprint = await offlineRegionQueryFingerprint(scope.canonical);

  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw invalid("now must produce a valid Date.", "now");
  if (manifest.expiresAt !== undefined && Date.parse(manifest.expiresAt) <= nowMs) {
    throw new HonuaOfflineRegionError("expired", `Offline region "${manifest.id}" has expired.`, { path: "expiresAt" });
  }

  const observedAtMs = Date.parse(manifest.source.observation.observedAt);
  const ageMs = Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : 0;
  const staleAfterMs = normalizeStaleAfterMs(options.staleAfterMs);
  return {
    manifest,
    sourceId,
    authorizationScopeDigest,
    selection: {
      sourceId,
      endpoint: manifest.source.endpoint,
      authorizationScopeDigest,
      sourceVersion: manifest.source.sourceVersion,
      schemaVersion: manifest.source.schemaVersion,
      planVersion: manifest.source.planVersion,
      bounds: manifest.bounds,
      ...(manifest.minZoom !== undefined ? { minZoom: manifest.minZoom } : {}),
      ...(manifest.maxZoom !== undefined ? { maxZoom: manifest.maxZoom } : {}),
    },
    queryFingerprint,
    pagination: scope.pagination,
    now,
    ageMs,
    staleAfterMs,
    freshness: ageMs >= staleAfterMs ? "stale" : "fresh",
  };
}

/** One verified stored payload plus the descriptor that vouched for it. */
export interface OfflineRegionGatedResourceV1 {
  readonly resource: OfflineRegionResourceV1;
  readonly bytes: Uint8Array;
}

/**
 * Resolve a resource identity against the store and verify what comes back.
 *
 * The identity is content-addressed from the admitted selection, so a lookup can
 * only ever find bytes stored for exactly this selection, kind, and selector; an
 * absent entry is a miss rather than an empty success, and a stored payload that
 * disagrees with its descriptor is an integrity failure rather than data.
 */
export async function readGatedOfflineRegionResource(
  gate: OfflineRegionReadGateV1,
  options: {
    readonly store: OfflineRegionStore;
    readonly kind: OfflineRegionResourceKind;
    readonly selector?: OfflineRegionResourceSelector;
    readonly signal?: AbortSignal;
  },
): Promise<OfflineRegionGatedResourceV1> {
  const resourceId = await offlineRegionResourceId({
    kind: options.kind,
    selection: gate.selection,
    queryFingerprint: gate.queryFingerprint,
    ...(options.selector !== undefined ? { selector: options.selector } : {}),
  });

  throwIfAborted(options.signal);
  let read: Awaited<ReturnType<OfflineRegionStore["readResource"]>>;
  try {
    read = await options.store.readResource(gate.manifest.id, resourceId);
  } catch (cause) {
    if (cause instanceof HonuaOfflineRegionError) throw cause;
    throw new HonuaOfflineRegionError("store-failed", "Failed to read the offline region resource.", { cause });
  }
  if (!read) {
    throw new HonuaOfflineRegionError(
      "cache-miss",
      "This offline region holds no stored answer for the requested selection.",
      { resourceId },
    );
  }
  if (read.regionId !== gate.manifest.id || read.resource.id !== resourceId) {
    throw new HonuaOfflineRegionError("store-failed", "Offline region store returned a foreign resource.", {
      resourceId,
    });
  }
  if (read.resource.kind !== options.kind) {
    throw new HonuaOfflineRegionError(
      "cache-miss",
      `Stored resource for this selection is not a ${options.kind} resource.`,
      { resourceId },
    );
  }
  const bytes = read.bytes;
  if (bytes.byteLength !== read.resource.byteLength || (await sha256(bytes)) !== read.resource.integrity) {
    throw new HonuaOfflineRegionError("integrity-mismatch", `Stored resource "${resourceId}" failed verification.`, {
      resourceId,
    });
  }
  return { resource: read.resource, bytes };
}

/** Report the persistent-cache decision for one admitted read. */
export function createOfflineRegionReadCacheDecision(
  gate: OfflineRegionReadGateV1,
  resources: readonly OfflineRegionResourceV1[],
  completeness: "complete" | "partial",
): OfflineRegionReadCacheDecisionV1 {
  return {
    kind: HONUA_OFFLINE_REGION_READ_KIND,
    version: HONUA_OFFLINE_REGION_READ_VERSION,
    policy: "prefer-cache",
    action: "reuse",
    state: "offline",
    freshness: gate.freshness,
    completeness,
    reason: gate.freshness === "stale" ? "stale-entry" : "offline-entry",
    regionId: gate.manifest.id,
    queryFingerprint: gate.queryFingerprint,
    authorizationScopeDigest: gate.authorizationScopeDigest,
    observedAt: gate.manifest.source.observation.observedAt,
    ageMs: gate.ageMs,
    staleAfterMs: gate.staleAfterMs,
    resources: resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      byteLength: resource.byteLength,
      integrity: resource.integrity,
    })),
  };
}

export function createOfflineRegionReadProvenance(gate: OfflineRegionReadGateV1): OfflineRegionReadProvenanceV1 {
  const manifest = gate.manifest;
  return {
    sourceId: gate.sourceId,
    endpoint: manifest.source.endpoint,
    authorizationScopeDigest: gate.authorizationScopeDigest,
    sourceVersion: manifest.source.sourceVersion,
    schemaVersion: manifest.source.schemaVersion,
    planVersion: manifest.source.planVersion,
    observation: manifest.source.observation,
    ...(manifest.source.validator ? { validator: manifest.source.validator } : {}),
  };
}

/**
 * Every offline answer is a snapshot, so every offline answer says so.
 *
 * `capability` names the canonical capability the cached bytes stand in for — a
 * tile read stands in for `tiles`, a rendering asset for `render`, and a feature
 * or metadata read for `query` — so a consumer that checks degradation before
 * treating an answer as authoritative learns which live capability it replaced.
 */
export function offlineRegionCachedSnapshotDegradation(
  gate: OfflineRegionReadGateV1,
  capability: Capability,
): DegradedReason {
  const manifest = gate.manifest;
  return {
    capability,
    reason: `Served from persisted offline region ${manifest.id} observed at ${manifest.source.observation.observedAt} (${gate.freshness}, ${gate.ageMs}ms old). This is a cached snapshot, not a live read.`,
    sourceId: gate.sourceId,
  };
}

/** Attribution for exactly the resources that answered a read. */
export function pickOfflineRegionAttribution(
  manifest: OfflineRegionManifestV1,
  resources: readonly OfflineRegionResourceV1[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const resource of resources) {
    for (const id of resource.attributionIds) {
      const text = manifest.attribution[id];
      if (typeof text === "string") out[id] = text;
    }
  }
  return out;
}

/**
 * Cache input binding a query plan to a persisted region.
 *
 * A fresh region carries its manifest identity as a `fingerprint` validator, so
 * the plan's own fingerprint changes when the region does. A stale region carries
 * freshness only: reporting a validator would claim a revalidation the offline
 * read will never perform.
 */
export function createOfflineRegionQueryPlanCache(
  manifest: OfflineRegionManifestV1,
  options: { readonly now?: Date; readonly staleAfterMs?: number } = {},
): QueryPlanCacheOptions {
  const nowMs = (options.now ?? new Date()).getTime();
  const observedAtMs = Date.parse(manifest.source?.observation?.observedAt ?? "");
  const staleAfterMs = normalizeStaleAfterMs(options.staleAfterMs);
  const ageMs = Number.isFinite(observedAtMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - observedAtMs) : 0;
  if (ageMs >= staleAfterMs) return { policy: "prefer-cache", freshness: "stale" };
  return {
    policy: "prefer-cache",
    freshness: "fresh",
    validator: { kind: "fingerprint", fingerprint: manifest.id },
  };
}

export function assertExpectedVersion(expected: string | undefined, actual: string, path: string): void {
  if (expected === undefined || expected === actual) return;
  throw new HonuaOfflineRegionError(
    "out-of-region",
    `Offline region was captured at a different ${path} than this read expects.`,
    { path },
  );
}

export function normalizeStaleAfterMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OFFLINE_REGION_READ_STALE_AFTER_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid("staleAfterMs must be a non-negative safe integer.", "staleAfterMs");
  }
  return value;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new HonuaOfflineRegionError("aborted", "Offline region read was aborted.", { cause: signal.reason });
  }
}

export function invalid(message: string, path: string): HonuaOfflineRegionError {
  return new HonuaOfflineRegionError("invalid-manifest", message, { path });
}

/** Freeze a returned read. Typed arrays are caller-owned copies and stay writable. */
export function deepFreezeRead<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreezeRead(child);
  return value;
}
