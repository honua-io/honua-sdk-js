import type { ConnectDiscoverySnapshot, ConnectResolvedProtocol } from "./connect.js";
import type { DiscoveryCapabilityEvidence } from "./contract/discovery.js";
import { resolveDiscoveryCapabilities } from "./contract/discovery.js";
import { HonuaDiscoveryError } from "./core/errors.js";

export const MAX_CACHE_SNAPSHOT_SINGLE_STRING_CODE_UNITS = 1_000_000;
const MAX_CACHE_SNAPSHOT_DEPTH = 32;
const MAX_CACHE_SNAPSHOT_NODES = 10_000;
const MAX_CACHE_SNAPSHOT_PROPERTIES = 20_000;
const MAX_CACHE_SNAPSHOT_ARRAY_LENGTH = 10_000;
const MAX_CACHE_SNAPSHOT_STRING_CODE_UNITS = 4_000_000;

interface CacheCloneBudget {
  nodes: number;
  properties: number;
  stringCodeUnits: number;
}

export function snapshotCacheData(value: unknown): ConnectDiscoverySnapshot {
  try {
    const cloned = cloneCacheData(value, "$", new Set(), { nodes: 0, properties: 0, stringCodeUnits: 0 }, 0);
    if (!isPlainObject(cloned)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache snapshot must be a plain object.");
    }
    return cloned as unknown as ConnectDiscoverySnapshot;
  } catch (cause) {
    if (cause instanceof HonuaDiscoveryError && cause.code === "invalid-discovery-cache") throw cause;
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache contains unsafe or invalid data.");
  }
}

function cloneCacheData(
  value: unknown,
  path: string,
  seen: Set<object>,
  budget: CacheCloneBudget,
  depth: number,
): unknown {
  if (depth > MAX_CACHE_SNAPSHOT_DEPTH) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum nesting depth.");
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_CACHE_SNAPSHOT_NODES) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum node count.");
  }
  if (typeof value === "string") {
    consumeCacheStringBudget(value, budget);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} is not serializable data.`);
  }
  if (seen.has(value)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} contains a cycle.`);
  }
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} contains symbol keys.`);
    }
    budget.properties += keys.length;
    if (budget.properties > MAX_CACHE_SNAPSHOT_PROPERTIES) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum property count.");
    }
    for (const key of keys as string[]) consumeCacheStringBudget(key, budget);
    if (Array.isArray(value)) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || "get" in lengthDescriptor || !Number.isSafeInteger(lengthDescriptor.value)) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} has an invalid length.`);
      }
      const length = lengthDescriptor.value as number;
      if (length > MAX_CACHE_SNAPSHOT_ARRAY_LENGTH) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum array length.");
      }
      const out: unknown[] = [];
      const stringKeys = keys.filter((key): key is string => typeof key === "string");
      const numericKeys = stringKeys.filter((key) => /^(0|[1-9]\d*)$/.test(key));
      if (numericKeys.length !== length) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} must be dense data.`);
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || "get" in descriptor || !descriptor.enumerable) {
          throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} must be dense data.`);
        }
        out.push(cloneCacheData(descriptor.value, `${path}[${index}]`, seen, budget, depth + 1));
      }
      const extra = stringKeys.filter((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key));
      if (extra.length > 0) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} has extra properties.`);
      }
      return Object.freeze(out);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} must be a plain object.`);
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached property ${path}.${key} is unstable.`);
      }
      if ("get" in descriptor || !descriptor.enumerable) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached property ${path}.${key} must be data.`);
      }
      out[key] = cloneCacheData(descriptor.value, `${path}.${key}`, seen, budget, depth + 1);
    }
    return Object.freeze(out);
  } finally {
    seen.delete(value);
  }
}

function consumeCacheStringBudget(value: string, budget: CacheCloneBudget): void {
  if (value.length > MAX_CACHE_SNAPSHOT_SINGLE_STRING_CODE_UNITS) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot contains an oversized string.");
  }
  budget.stringCodeUnits += value.length;
  if (budget.stringCodeUnits > MAX_CACHE_SNAPSHOT_STRING_CODE_UNITS) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the total string-size limit.");
  }
}

export function validateCachedEvidence(
  protocol: ConnectResolvedProtocol,
  evidence: readonly DiscoveryCapabilityEvidence[],
  allowEmpty: boolean,
): readonly DiscoveryCapabilityEvidence[] {
  if (!Array.isArray(evidence) || (!allowEmpty && evidence.length === 0)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence is invalid.");
  }
  if (evidence.length === 0) return Object.freeze([]);
  for (const record of evidence) {
    if (!isPlainObject(record)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence must contain objects.");
    }
    if (
      (record.kind === "inferred" || record.kind === "unavailable") &&
      (typeof record.reason !== "string" || !record.reason.trim())
    ) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence reason is invalid.");
    }
    if (record.provenance !== undefined && !Array.isArray(record.provenance)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability provenance must be an array.");
    }
    for (const provenance of record.provenance ?? []) {
      if (
        !isPlainObject(provenance) ||
        typeof provenance.source !== "string" ||
        !provenance.source.trim() ||
        (provenance.retrievedAt !== undefined && typeof provenance.retrievedAt !== "string") ||
        (provenance.validator !== undefined && typeof provenance.validator !== "string")
      ) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability provenance is invalid.");
      }
    }
  }
  try {
    return resolveDiscoveryCapabilities(protocol, evidence).evidence;
  } catch (cause) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence is invalid.", {
      cause: cause instanceof Error ? cause.message : "invalid evidence",
    });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
