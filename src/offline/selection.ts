import type { PaginationSpec, Query } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import { screenPersistedString } from "./credential-screen.js";
import { canonicalJson, compareCodeUnits, identityDigest, sha256 } from "./digest.js";
import { HonuaOfflineRegionError, type OfflineRegionBounds, type OfflineRegionResourceKind } from "./types.js";

/**
 * Protocol-neutral selection identity for offline reads.
 *
 * A persisted region is addressed by what the caller asked for — a source, a
 * canonical query, a bounded extent, an authorization scope, and the source /
 * schema / plan versions it was captured at — never by a request URL. Snapshot
 * planning and the read path both derive resource identity here, so a read can
 * only ever find bytes that were stored for exactly that selection.
 *
 * @experimental
 */

/** Protocol name reported by capability failures raised on the offline read path. */
export const OFFLINE_REGION_PROTOCOL = "offline-region" as const;

/** Query members the offline read path understands. Anything else fails closed. */
const SUPPORTED_QUERY_KEYS = new Set([
  "filter",
  "temporalFilter",
  "where",
  "spatialFilter",
  "outFields",
  "orderBy",
  "pagination",
  "aggregation",
  "returnGeometry",
  "outSr",
  "signal",
]);

const MAX_SELECTOR_SEGMENTS = 16;
const MAX_SELECTOR_TEXT_LENGTH = 512;
const MAX_CANONICAL_QUERY_BYTES = 64 * 1024;
const MAX_QUERY_DEPTH = 32;

/**
 * Kind-specific discriminator that separates several resources of one kind
 * inside a single selection: tile coordinates, an asset key, or a document name.
 * Values are credential-screened and persisted only inside a digest.
 */
export type OfflineRegionResourceSelector = string | number | readonly (string | number)[];

/**
 * The pagination-free canonical form of a {@link Query}.
 *
 * Every constraint that changes *which* records match is part of this value and
 * therefore part of resource identity. Pagination is deliberately excluded: it
 * selects a window over an already-determined match set, and the read path
 * answers it from the stored batch's own recorded window instead of pretending a
 * different page was captured.
 */
export interface OfflineRegionCanonicalQueryV1 {
  readonly filter: unknown;
  readonly temporalFilter: unknown;
  readonly where: string | null;
  readonly spatialFilter: unknown;
  readonly outFields: readonly string[] | null;
  readonly orderBy: readonly { readonly field: string; readonly direction: "asc" | "desc" }[] | null;
  readonly returnGeometry: boolean | null;
  readonly outSr: string | number | null;
}

/** A canonical query plus the pagination window the caller asked for. */
export interface OfflineRegionQueryScopeV1 {
  readonly canonical: OfflineRegionCanonicalQueryV1;
  readonly pagination: { readonly offset: number; readonly limit?: number };
}

/** Credential-free, protocol-neutral identity of one offline selection. */
export interface OfflineRegionSelectionIdentityV1 {
  readonly sourceId: string;
  /** Already-normalized credential-free endpoint identity. */
  readonly endpoint: string;
  readonly authorizationScopeDigest: `sha256:${string}`;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planVersion: string;
  readonly bounds: OfflineRegionBounds;
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

/**
 * Reduce a {@link Query} to its canonical identity plus its pagination window.
 *
 * Fails closed twice over. An unknown member is refused rather than dropped,
 * because dropping it would answer a narrower question than the caller asked;
 * and `aggregation` is refused outright, because a stored feature batch is not
 * an aggregate and computing one locally would return a number the region never
 * observed.
 */
export function canonicalizeOfflineRegionQuery(query?: Query, sourceId?: string): OfflineRegionQueryScopeV1 {
  if (query === undefined) return { canonical: emptyCanonicalQuery(), pagination: { offset: 0 } };
  const record = plainRecord(query, "query");
  for (const key in record) {
    if (Object.hasOwn(record, key) && !SUPPORTED_QUERY_KEYS.has(key)) {
      throw new HonuaCapabilityNotSupportedError(`query.${key}`, OFFLINE_REGION_PROTOCOL, sourceId, {
        context: { reasonCode: "unsupported-query-member" },
      });
    }
  }
  if (record.aggregation !== undefined) {
    throw new HonuaCapabilityNotSupportedError("queryAggregate", OFFLINE_REGION_PROTOCOL, sourceId, {
      context: { reasonCode: "aggregation-not-stored" },
    });
  }
  const canonical: OfflineRegionCanonicalQueryV1 = {
    filter: jsonValue(record.filter, "query.filter"),
    temporalFilter: jsonValue(record.temporalFilter, "query.temporalFilter"),
    where: optionalText(record.where, "query.where"),
    spatialFilter: jsonValue(record.spatialFilter, "query.spatialFilter"),
    outFields: normalizeOutFields(record.outFields),
    orderBy: normalizeOrderBy(record.orderBy),
    returnGeometry:
      record.returnGeometry === undefined ? null : requireBoolean(record.returnGeometry, "query.returnGeometry"),
    outSr: normalizeOutSr(record.outSr),
  };
  const encoded = canonicalJson(canonical);
  if (encoded.length > MAX_CANONICAL_QUERY_BYTES) {
    throw invalid("query exceeds the canonical offline identity budget.", "query");
  }
  return { canonical, pagination: normalizePagination(record.pagination) };
}

/** Domain-separated fingerprint of a canonical query. */
export function offlineRegionQueryFingerprint(canonical: OfflineRegionCanonicalQueryV1): Promise<`sha256:${string}`> {
  return identityDigest("honua-offline-query", canonical);
}

/**
 * Deterministic, credential-free identity for one resource of one selection.
 *
 * The digest binds the resource kind, its selector, the source identity, the
 * authorization-scope digest, the captured versions, the bounded extent, and the
 * canonical query. Two selections that differ in any of those — including a
 * scope change — can never address the same stored bytes.
 */
export async function offlineRegionResourceId(input: {
  readonly kind: OfflineRegionResourceKind;
  readonly selection: OfflineRegionSelectionIdentityV1;
  readonly queryFingerprint: `sha256:${string}`;
  readonly selector?: OfflineRegionResourceSelector;
}): Promise<string> {
  const kind = input.kind;
  const digest = await identityDigest("honua-offline-resource", {
    kind,
    selector: normalizeSelector(input.selector),
    query: input.queryFingerprint,
    source: {
      id: input.selection.sourceId,
      endpoint: input.selection.endpoint,
      authorizationScopeDigest: input.selection.authorizationScopeDigest,
      sourceVersion: input.selection.sourceVersion,
      schemaVersion: input.selection.schemaVersion,
      planVersion: input.selection.planVersion,
    },
    bounds: input.selection.bounds,
    minZoom: input.selection.minZoom ?? null,
    maxZoom: input.selection.maxZoom ?? null,
  });
  return `${kind}/${digest.slice("sha256:".length)}`;
}

/**
 * Digest of the opaque authorization-scope partition input. Never persisted raw.
 *
 * Domain separation and the trimmed pre-image match
 * `createOfflineRegionManifest()` exactly, so a read can compare its caller's
 * current scope against a stored manifest's digest without re-deriving either.
 */
export function offlineRegionAuthorizationScopeDigest(fingerprint: string): Promise<`sha256:${string}`> {
  if (typeof fingerprint !== "string" || fingerprint.trim().length === 0) {
    throw invalid("authorizationScopeFingerprint must be a non-empty string.", "authorizationScopeFingerprint");
  }
  return sha256(`honua-offline-scope:v1:${fingerprint.trim()}`);
}

/** How a requested extent relates to a stored region's extent. */
export type OfflineRegionBoundsRelation = "equal" | "contained" | "outside";

/** Compare a requested extent to a region extent in the region's own CRS. */
export function compareOfflineRegionBounds(
  requested: OfflineRegionBounds,
  region: OfflineRegionBounds,
): OfflineRegionBoundsRelation {
  if (requested.crs !== region.crs) return "outside";
  if (
    requested.minX === region.minX &&
    requested.minY === region.minY &&
    requested.maxX === region.maxX &&
    requested.maxY === region.maxY
  ) {
    return "equal";
  }
  const contained =
    requested.minX >= region.minX &&
    requested.minY >= region.minY &&
    requested.maxX <= region.maxX &&
    requested.maxY <= region.maxY;
  return contained ? "contained" : "outside";
}

function normalizeSelector(value: OfflineRegionResourceSelector | undefined): readonly (string | number)[] | null {
  if (value === undefined) return null;
  const segments = Array.isArray(value) ? value : [value as string | number];
  if (segments.length > MAX_SELECTOR_SEGMENTS) throw invalid("selector exceeds its segment limit.", "selector");
  return segments.map((segment, index) => {
    const path = `selector[${index}]`;
    if (typeof segment === "number") {
      if (!Number.isSafeInteger(segment)) throw invalid(`${path} must be a safe integer.`, path);
      return segment;
    }
    if (typeof segment !== "string" || segment.length === 0 || segment.length > MAX_SELECTOR_TEXT_LENGTH) {
      throw invalid(`${path} must be a bounded non-empty string.`, path);
    }
    if (screenPersistedString(segment, "identity")) {
      throw invalid(`${path} must not carry credential or request-URL shape.`, path);
    }
    return segment;
  });
}

function emptyCanonicalQuery(): OfflineRegionCanonicalQueryV1 {
  return {
    filter: null,
    temporalFilter: null,
    where: null,
    spatialFilter: null,
    outFields: null,
    orderBy: null,
    returnGeometry: null,
    outSr: null,
  };
}

function normalizePagination(value: unknown): { readonly offset: number; readonly limit?: number } {
  if (value === undefined) return { offset: 0 };
  const record = plainRecord(value, "query.pagination") as PaginationSpec & Record<string, unknown>;
  for (const key in record) {
    if (Object.hasOwn(record, key) && key !== "offset" && key !== "limit") {
      throw invalid(`query.pagination.${key} is not supported.`, `query.pagination.${key}`);
    }
  }
  const offset = record.offset === undefined ? 0 : nonNegativeInteger(record.offset, "query.pagination.offset");
  if (record.limit === undefined) return { offset };
  return { offset, limit: nonNegativeInteger(record.limit, "query.pagination.limit") };
}

function normalizeOutFields(value: unknown): readonly string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw invalid("query.outFields must be an array.", "query.outFields");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const field = value[index];
    if (typeof field !== "string" || field.trim().length === 0) {
      throw invalid(`query.outFields[${index}] must be a non-empty string.`, `query.outFields[${index}]`);
    }
    seen.add(field.trim());
  }
  // Projection order carries no meaning, so a stable order keeps two callers
  // that request the same fields on the same stored resource.
  return [...seen].sort(compareCodeUnits);
}

function normalizeOrderBy(
  value: unknown,
): readonly { readonly field: string; readonly direction: "asc" | "desc" }[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw invalid("query.orderBy must be an array.", "query.orderBy");
  return value.map((entry, index) => {
    const path = `query.orderBy[${index}]`;
    const record = plainRecord(entry, path);
    for (const key in record) {
      if (Object.hasOwn(record, key) && key !== "field" && key !== "direction") {
        throw invalid(`${path}.${key} is not supported.`, `${path}.${key}`);
      }
    }
    if (typeof record.field !== "string" || record.field.trim().length === 0) {
      throw invalid(`${path}.field must be a non-empty string.`, `${path}.field`);
    }
    if (record.direction !== undefined && record.direction !== "asc" && record.direction !== "desc") {
      throw invalid(`${path}.direction must be asc or desc.`, `${path}.direction`);
    }
    return { field: record.field.trim(), direction: (record.direction as "asc" | "desc" | undefined) ?? "asc" };
  });
}

function normalizeOutSr(value: unknown): string | number | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw invalid("query.outSr must be a safe integer or string.", "query.outSr");
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid("query.outSr must be a safe integer or non-empty string.", "query.outSr");
  }
  return value.trim();
}

function optionalText(value: unknown, path: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) throw invalid(`${path} must be a non-empty string.`, path);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${path} must be a boolean.`, path);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${path} must be a non-negative safe integer.`, path);
  }
  return value;
}

/** Detach an untrusted query member into plain JSON, refusing anything else. */
function jsonValue(value: unknown, path: string, depth = 0): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(`${path} must be finite.`, path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (depth >= MAX_QUERY_DEPTH) throw invalid(`${path} exceeds the canonical nesting limit.`, path);
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`, depth + 1));
  const record = plainRecord(value, path);
  const out: Record<string, unknown> = {};
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    const child = record[key];
    if (child === undefined) continue;
    out[key] = jsonValue(child, `${path}.${key}`, depth + 1);
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
