import { normalizeDiscoveryEndpoint } from "../contract/discovery.js";
import type { Query, Result } from "../contract/types.js";
import type { HonuaFieldInfo, HonuaTypedFeature } from "../core/types.js";
import { canonicalJson, compareCodeUnits, sha256 } from "./digest.js";
import { createOfflineRegionManifest } from "./region.js";
import {
  type OfflineRegionCanonicalQueryV1,
  type OfflineRegionResourceSelector,
  type OfflineRegionSelectionIdentityV1,
  canonicalizeOfflineRegionQuery,
  offlineRegionAuthorizationScopeDigest,
  offlineRegionQueryFingerprint,
  offlineRegionResourceId,
} from "./selection.js";
import {
  type CreateOfflineRegionManifestInput,
  HonuaOfflineRegionError,
  type OfflineRegionBounds,
  type OfflineRegionLimits,
  type OfflineRegionManifestV1,
  type OfflineRegionObservation,
  type OfflineRegionResourceInput,
  type OfflineRegionResourceKind,
  type OfflineRegionResourceLoader,
  type OfflineRegionValidator,
} from "./types.js";

/**
 * Snapshot planning: turn a protocol-neutral selection into a downloadable region.
 *
 * The planner is the missing producer between the contract and the region store.
 * It takes a source identity, a canonical {@link Query}, a bounded extent, and the
 * payloads an application already holds, and emits a manifest whose resource
 * identities are deterministic functions of those inputs — never of a signed or
 * token-bearing request URL. The same identity function answers the later read,
 * so a snapshot and a read agree without persisting any addressing state.
 *
 * @experimental
 */

export const HONUA_OFFLINE_REGION_SNAPSHOT_KIND = "honua.offline-region-snapshot" as const;
export const HONUA_OFFLINE_REGION_SNAPSHOT_VERSION = "1.0" as const;
export const HONUA_OFFLINE_FEATURE_BATCH_KIND = "honua.offline-feature-batch" as const;
export const HONUA_OFFLINE_FEATURE_BATCH_VERSION = "1.0" as const;

/** Default ceiling on how many resources one planned snapshot may contain. */
export const DEFAULT_OFFLINE_REGION_SNAPSHOT_MAX_CONTENTS = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * One stored answer to a canonical query.
 *
 * The envelope records the window it covers and whether more records existed, so
 * a later read can tell the difference between "this is everything" and "this is
 * the first page" without guessing.
 */
export interface OfflineRegionFeatureBatchV1<T = Record<string, unknown>> {
  readonly kind: typeof HONUA_OFFLINE_FEATURE_BATCH_KIND;
  readonly version: typeof HONUA_OFFLINE_FEATURE_BATCH_VERSION;
  /** Window this batch covers, in the canonical query's own pagination terms. */
  readonly pagination: { readonly offset: number; readonly limit?: number };
  /** True when the source signalled that more records matched than were captured. */
  readonly exceededTransferLimit: boolean;
  readonly features: readonly HonuaTypedFeature<T>[];
  readonly totalCount?: number;
  readonly fields?: readonly HonuaFieldInfo[];
}

/** One payload contributed to a planned snapshot. */
export interface OfflineRegionSnapshotContentV1 {
  readonly kind: OfflineRegionResourceKind;
  /** Exact bytes to persist. Tiles and assets stay opaque; nothing is re-encoded. */
  readonly bytes: Uint8Array | ArrayBuffer;
  readonly contentType?: string;
  /** Discriminator when one selection stores several resources of one kind. */
  readonly selector?: OfflineRegionResourceSelector;
  readonly attributionIds?: readonly string[];
}

/** A source, a query, and a bounded extent, plus the payloads they require. */
export interface OfflineRegionSnapshotSelectionV1 {
  readonly name: string;
  readonly sourceId: string;
  /** Credentials and signed parameters are removed before anything is persisted. */
  readonly endpoint: string | URL;
  /** Opaque ACL/auth partition input. Only its digest is persisted or compared. */
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
  readonly attribution?: Readonly<Record<string, string>>;
  /** Protocol-neutral query this snapshot answers. Omitted means "no constraint". */
  readonly query?: Query;
  readonly contents: readonly OfflineRegionSnapshotContentV1[];
  readonly limits?: OfflineRegionLimits & { readonly maxContents?: number };
}

/** One planned resource: its deterministic identity and its verified payload size. */
export interface OfflineRegionSnapshotEntryV1 {
  readonly id: string;
  readonly kind: OfflineRegionResourceKind;
  readonly byteLength: number;
  readonly integrity: `sha256:${string}`;
  readonly contentType?: string;
}

/**
 * A planned snapshot: the manifest to download plus the payloads it names.
 *
 * `payloads` is deliberately not part of the persisted contract — the manifest is
 * the durable artifact. It exists so {@link createOfflineRegionSnapshotLoader}
 * can serve the exact bytes the identities were computed from.
 */
export interface OfflineRegionSnapshotV1 {
  readonly kind: typeof HONUA_OFFLINE_REGION_SNAPSHOT_KIND;
  readonly version: typeof HONUA_OFFLINE_REGION_SNAPSHOT_VERSION;
  readonly manifest: OfflineRegionManifestV1;
  readonly selection: OfflineRegionSelectionIdentityV1;
  readonly query: OfflineRegionCanonicalQueryV1;
  readonly queryFingerprint: `sha256:${string}`;
  readonly entries: readonly OfflineRegionSnapshotEntryV1[];
  readonly payloads: ReadonlyMap<string, Uint8Array>;
}

/**
 * Plan one bounded snapshot of a source, a query, and an extent.
 *
 * Every resource identity is derived from the selection — source identity,
 * authorization-scope digest, captured versions, extent, canonical query, and the
 * resource's own kind and selector. Identities are therefore stable across runs
 * and processes, contain no request URL, and cannot collide across authorization
 * scopes.
 */
export async function planOfflineRegionSnapshot(
  selection: OfflineRegionSnapshotSelectionV1,
): Promise<OfflineRegionSnapshotV1> {
  const record = plainRecord(selection, "selection");
  const authorizationScopeDigest = await offlineRegionAuthorizationScopeDigest(
    record.authorizationScopeFingerprint as string,
  );
  // Pagination is accepted but never enters identity: a window is a property of
  // the captured batch, not of the question. `createOfflineRegionFeatureBatch()`
  // records the window that was actually captured, and the read path answers
  // pagination from that record instead of from a second identity.
  const scope = canonicalizeOfflineRegionQuery(selection.query, selection.sourceId);
  const queryFingerprint = await offlineRegionQueryFingerprint(scope.canonical);

  // Identity binds the *normalized* endpoint, so a caller passing a signed or
  // unnormalized URL can never produce a different identity than the manifest.
  const boundIdentity: OfflineRegionSelectionIdentityV1 = {
    sourceId: selection.sourceId,
    endpoint: normalizeSelectionEndpoint(selection.endpoint),
    authorizationScopeDigest,
    sourceVersion: selection.sourceVersion,
    schemaVersion: selection.schemaVersion,
    planVersion: selection.planVersion,
    bounds: selection.bounds,
    ...(selection.minZoom !== undefined ? { minZoom: selection.minZoom } : {}),
    ...(selection.maxZoom !== undefined ? { maxZoom: selection.maxZoom } : {}),
  };

  const maxContents = selection.limits?.maxContents ?? DEFAULT_OFFLINE_REGION_SNAPSHOT_MAX_CONTENTS;
  const contents = selection.contents;
  if (!Array.isArray(contents)) throw invalid("selection.contents must be an array.", "selection.contents");
  if (contents.length > maxContents) {
    throw new HonuaOfflineRegionError(
      "resource-limit-exceeded",
      `selection.contents contains ${contents.length} entries; maximum is ${maxContents}.`,
      { path: "selection.contents" },
    );
  }

  const payloads = new Map<string, Uint8Array>();
  const entries: OfflineRegionSnapshotEntryV1[] = [];
  const resources: OfflineRegionResourceInput[] = [];
  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index] as OfflineRegionSnapshotContentV1;
    const path = `selection.contents[${index}]`;
    const bytes = ownedBytes(content?.bytes, path);
    const id = await offlineRegionResourceId({
      kind: requireKind(content?.kind, path),
      selection: boundIdentity,
      queryFingerprint,
      ...(content.selector !== undefined ? { selector: content.selector } : {}),
    });
    if (payloads.has(id)) {
      throw invalid(`${path} repeats a resource identity already planned in this snapshot.`, path);
    }
    const integrity = await sha256(bytes);
    payloads.set(id, bytes);
    entries.push({
      id,
      kind: content.kind,
      byteLength: bytes.byteLength,
      integrity,
      ...(content.contentType ? { contentType: content.contentType } : {}),
    });
    resources.push({
      id,
      kind: content.kind,
      byteLength: bytes.byteLength,
      integrity,
      ...(content.contentType ? { contentType: content.contentType } : {}),
      sourceVersion: selection.sourceVersion,
      schemaVersion: selection.schemaVersion,
      planVersion: selection.planVersion,
      ...(content.attributionIds ? { attributionIds: content.attributionIds } : {}),
    });
  }
  entries.sort((left, right) => compareCodeUnits(left.id, right.id));

  const manifestInput: CreateOfflineRegionManifestInput = {
    name: selection.name,
    sourceId: selection.sourceId,
    endpoint: selection.endpoint,
    authorizationScopeFingerprint: selection.authorizationScopeFingerprint,
    bounds: selection.bounds,
    ...(selection.minZoom !== undefined ? { minZoom: selection.minZoom } : {}),
    ...(selection.maxZoom !== undefined ? { maxZoom: selection.maxZoom } : {}),
    sourceVersion: selection.sourceVersion,
    schemaVersion: selection.schemaVersion,
    planVersion: selection.planVersion,
    observation: selection.observation,
    ...(selection.validator ? { validator: selection.validator } : {}),
    ...(selection.expiresAt ? { expiresAt: selection.expiresAt } : {}),
    ...(selection.attribution ? { attribution: selection.attribution } : {}),
    resources,
    ...(selection.limits ? { limits: selection.limits } : {}),
  };
  const manifest = await createOfflineRegionManifest(manifestInput);
  if (manifest.source.authorizationScopeDigest !== authorizationScopeDigest) {
    throw invalid("Snapshot scope digest does not match the manifest it produced.", "authorizationScopeFingerprint");
  }
  return Object.freeze({
    kind: HONUA_OFFLINE_REGION_SNAPSHOT_KIND,
    version: HONUA_OFFLINE_REGION_SNAPSHOT_VERSION,
    manifest,
    selection: Object.freeze(boundIdentity),
    query: scope.canonical,
    queryFingerprint,
    entries: Object.freeze(entries),
    payloads,
  });
}

/**
 * Serve a planned snapshot's payloads to {@link downloadOfflineRegion}.
 *
 * The loader is offline by construction: it hands back the exact bytes the
 * identities were computed from and refuses anything the plan does not name.
 */
export function createOfflineRegionSnapshotLoader(snapshot: OfflineRegionSnapshotV1): OfflineRegionResourceLoader {
  const payloads = snapshot.payloads;
  return async (resource) => {
    const bytes = payloads.get(resource.id);
    if (!bytes) {
      throw new HonuaOfflineRegionError(
        "resource-load-failed",
        `Planned snapshot does not carry a payload for resource "${resource.id}".`,
        { resourceId: resource.id },
      );
    }
    return Uint8Array.from(bytes);
  };
}

/** Capture a `Result` as the durable batch envelope a later read answers from. */
export function createOfflineRegionFeatureBatch<T>(
  result: Pick<Result<T>, "features" | "exceededTransferLimit" | "totalCount" | "fields">,
  options: { readonly pagination?: { readonly offset?: number; readonly limit?: number } } = {},
): OfflineRegionFeatureBatchV1<T> {
  const features = result?.features;
  if (!Array.isArray(features)) throw invalid("result.features must be an array.", "result.features");
  const offset = options.pagination?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw invalid("pagination.offset must be a non-negative safe integer.", "pagination.offset");
  const limit = options.pagination?.limit;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw invalid("pagination.limit must be a non-negative safe integer.", "pagination.limit");
  }
  if (limit !== undefined && features.length > limit) {
    throw invalid("result.features exceeds the captured pagination limit.", "result.features");
  }
  return {
    kind: HONUA_OFFLINE_FEATURE_BATCH_KIND,
    version: HONUA_OFFLINE_FEATURE_BATCH_VERSION,
    pagination: { offset, ...(limit === undefined ? {} : { limit }) },
    exceededTransferLimit: result.exceededTransferLimit === true,
    features: features.map((feature, index) => canonicalFeature(feature, `result.features[${index}]`)),
    ...(result.totalCount === undefined ? {} : { totalCount: requireCount(result.totalCount) }),
    ...(result.fields === undefined ? {} : { fields: jsonClone(result.fields, "result.fields") as HonuaFieldInfo[] }),
  };
}

/** Encode a batch as the deterministic UTF-8 bytes the manifest pins. */
export function encodeOfflineRegionFeatureBatch<T>(batch: OfflineRegionFeatureBatchV1<T>): Uint8Array {
  return encoder.encode(canonicalJson(batch));
}

/** Decode and validate stored batch bytes. Anything unexpected fails closed. */
export function decodeOfflineRegionFeatureBatch<T = Record<string, unknown>>(
  bytes: Uint8Array,
): OfflineRegionFeatureBatchV1<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (cause) {
    throw new HonuaOfflineRegionError("integrity-mismatch", "Stored offline feature batch is not valid UTF-8 JSON.", {
      cause,
    });
  }
  const record = plainRecord(parsed, "batch");
  if (record.kind !== HONUA_OFFLINE_FEATURE_BATCH_KIND || record.version !== HONUA_OFFLINE_FEATURE_BATCH_VERSION) {
    throw invalid("Stored offline feature batch has an unsupported kind or version.", "batch");
  }
  const pagination = plainRecord(record.pagination, "batch.pagination");
  const offset = pagination.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw invalid("batch.pagination.offset must be a non-negative safe integer.", "batch.pagination.offset");
  }
  const limit = pagination.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)) {
    throw invalid("batch.pagination.limit must be a non-negative safe integer.", "batch.pagination.limit");
  }
  if (typeof record.exceededTransferLimit !== "boolean") {
    throw invalid("batch.exceededTransferLimit must be a boolean.", "batch.exceededTransferLimit");
  }
  if (!Array.isArray(record.features)) throw invalid("batch.features must be an array.", "batch.features");
  const features = record.features.map((feature, index) =>
    canonicalFeature(feature as HonuaTypedFeature<T>, `batch.features[${index}]`),
  );
  if (limit !== undefined && features.length > limit) {
    throw invalid("batch.features exceeds its recorded pagination limit.", "batch.features");
  }
  return {
    kind: HONUA_OFFLINE_FEATURE_BATCH_KIND,
    version: HONUA_OFFLINE_FEATURE_BATCH_VERSION,
    pagination: { offset, ...(limit === undefined ? {} : { limit: limit as number }) },
    exceededTransferLimit: record.exceededTransferLimit,
    features,
    ...(record.totalCount === undefined ? {} : { totalCount: requireCount(record.totalCount) }),
    ...(record.fields === undefined ? {} : { fields: jsonClone(record.fields, "batch.fields") as HonuaFieldInfo[] }),
  };
}

/** Reuse the one endpoint normalizer the manifest itself persists through. */
function normalizeSelectionEndpoint(endpoint: string | URL): string {
  if (typeof endpoint !== "string" && !(endpoint instanceof URL)) {
    throw invalid("selection.endpoint must be a string or URL.", "selection.endpoint");
  }
  try {
    return normalizeDiscoveryEndpoint(endpoint);
  } catch (cause) {
    throw new HonuaOfflineRegionError("invalid-manifest", "selection.endpoint must be a valid absolute URL.", {
      cause,
      path: "selection.endpoint",
    });
  }
}

function canonicalFeature<T>(value: HonuaTypedFeature<T>, path: string): HonuaTypedFeature<T> {
  const record = plainRecord(value, path);
  for (const key in record) {
    if (Object.hasOwn(record, key) && key !== "attributes" && key !== "geometry") {
      throw invalid(`${path}.${key} is not supported on a stored feature.`, `${path}.${key}`);
    }
  }
  const attributes = jsonClone(plainRecord(record.attributes, `${path}.attributes`), `${path}.attributes`);
  const geometry = record.geometry;
  return {
    attributes: attributes as T,
    ...(geometry === undefined
      ? {}
      : { geometry: geometry === null ? null : (jsonClone(geometry, `${path}.geometry`) as Record<string, unknown>) }),
  };
}

function requireCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid("totalCount must be a non-negative safe integer.", "totalCount");
  }
  return value;
}

function ownedBytes(value: unknown, path: string): Uint8Array {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw invalid(`${path}.bytes must be a Uint8Array or ArrayBuffer.`, `${path}.bytes`);
}

function requireKind(value: unknown, path: string): OfflineRegionResourceKind {
  if (
    value !== "metadata" &&
    value !== "features" &&
    value !== "tile" &&
    value !== "asset" &&
    value !== "attribution"
  ) {
    throw invalid(`${path}.kind is invalid.`, `${path}.kind`);
  }
  return value;
}

function jsonClone(value: unknown, path: string, depth = 0): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${path} must be finite.`, path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (depth >= 32) throw invalid(`${path} exceeds the stored nesting limit.`, path);
  if (Array.isArray(value)) return value.map((entry, index) => jsonClone(entry, `${path}[${index}]`, depth + 1));
  const record = plainRecord(value, path);
  const out: Record<string, unknown> = {};
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const child = record[key];
    if (child === undefined) continue;
    out[key] = jsonClone(child, `${path}.${key}`, depth + 1);
  }
  return out;
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${path} must be a plain object.`, path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(`${path} must be a plain object.`, path);
  return value as Record<string, unknown>;
}

function invalid(message: string, path: string): HonuaOfflineRegionError {
  return new HonuaOfflineRegionError("invalid-manifest", message, { path });
}
