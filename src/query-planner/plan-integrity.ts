import { sha256 } from "./canonical.js";
import { containsControlCharacter, containsCredentialMaterial } from "./ir.js";
import {
  QUERY_PLAN_DIAGNOSTICS_VERSION,
  QUERY_PLAN_KIND,
  QUERY_PLAN_V2_VERSION,
  QUERY_PLAN_VERSION,
  type QueryExecutionPlan,
  type QueryExecutionPlanV1,
  type QueryPlanDiscoveryContext,
} from "./types.js";

const CREDENTIAL_BEARING_PLAN_KEYS =
  /^((proxy)?authorization|(set)?cookie|username|password|passwd|secret|(access|refresh|id)?token|x?apikey|(access|secret|account)key|clientsecret|credentials?|(sharedaccess|xamz)?signature|xgoogcredential)$/;

/** @internal Lightweight v1 integrity path for stable consumers that cannot execute v2 resources. */
export function hashQueryPlanV1(plan: QueryExecutionPlanV1): `sha256:${string}` | undefined {
  const canonical = canonicalQueryPlanV1(plan);
  return canonical === undefined ? undefined : sha256(canonical);
}

/** @internal Exact async counterpart for already-asynchronous browser workflows. */
export async function hashQueryPlanV1WithSubtleCrypto(
  plan: QueryExecutionPlanV1,
): Promise<`sha256:${string}` | undefined> {
  const canonical = canonicalQueryPlanV1(plan);
  return canonical === undefined ? undefined : subtleSha256(canonical);
}

/** @internal Recreates planner discovery evidence without retaining raw metadata. */
export async function discoveryFingerprintWithSubtleCrypto(
  context?: QueryPlanDiscoveryContext,
): Promise<`sha256:${string}` | undefined> {
  const input = context?.validator;
  if (
    (context?.source !== undefined && context.sourceFingerprint !== undefined) ||
    (input && (input.value === undefined) === (input.fingerprint === undefined))
  ) {
    return undefined;
  }
  const sourceFingerprint =
    context?.sourceFingerprint ??
    (context?.source === undefined ? undefined : await evidenceDigest("discovery-source", context.source));
  const validatorFingerprint =
    input?.fingerprint ??
    (input?.value === undefined
      ? undefined
      : await evidenceDigest("validator", { kind: input.kind, value: input.value }));
  const validator = input ? { fingerprint: validatorFingerprint, kind: input.kind } : undefined;
  return evidenceDigest("discovery", {
    sourceFingerprint,
    state: context?.state ?? "unavailable",
    validator,
  });
}

function evidenceDigest(namespace: string, value: unknown): Promise<`sha256:${string}` | undefined> {
  return subtleSha256(`${namespace}:v1:${JSON.stringify(value)}`);
}

async function subtleSha256(value: string): Promise<`sha256:${string}` | undefined> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    let hex = "";
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
    return `sha256:${hex}`;
  } catch {
    return;
  }
}

function canonicalQueryPlanV1(plan: QueryExecutionPlanV1): string | undefined {
  try {
    const detached = toHonuaPlanJsonValue(plan) as unknown;
    if (!isQueryPlanV1Envelope(detached) || detached.ir.version !== "1.0") {
      return undefined;
    }
    if (detached.ir.source.protocol === "geoparquet") {
      const sources = detached.ir.source.geoparquet?.sources;
      if (!sources?.length || sources.some((source) => !isCredentialFreeLegacySource(source))) {
        return undefined;
      }
    }
    if (containsCredentialBearingPlanMaterial(detached)) return undefined;
    const { id: _id, fingerprint: _fingerprint, ...unsigned } = detached;
    return JSON.stringify(unsigned);
  } catch {
    return undefined;
  }
}

/** @internal Compact canonical JSON conversion for focused accepted-plan consumers. */
export function toHonuaPlanJsonValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidPlanJson();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || ancestors.has(value)) invalidPlanJson();
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    invalidPlanJson();
  }
  ancestors.add(value);
  let converted: unknown;
  if (Array.isArray(value)) {
    converted = value.map((entry) => {
      if (entry === undefined) invalidPlanJson();
      return toHonuaPlanJsonValue(entry, ancestors);
    });
  } else {
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) record[key] = toHonuaPlanJsonValue(entry, ancestors);
    }
    converted = record;
  }
  ancestors.delete(value);
  return converted;
}

function invalidPlanJson(): never {
  throw new TypeError();
}

export function containsCredentialBearingPlanMaterial(value: unknown, parent = ""): boolean {
  if (typeof value === "string") {
    return (
      containsCredentialMaterial(value) || /\b(?:proxy[-_]?authorization|x-api-key)\s*(?:=|:)\s*[^\s,;]+/i.test(value)
    );
  }
  if (Array.isArray(value)) {
    return value.some((child) => containsCredentialBearingPlanMaterial(child));
  }
  if (value === null || typeof value !== "object") return false;
  const normalizedParent = parent.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const sensitiveNestedKey =
      (normalizedParent === "headers" && /^x(?:auth|authtoken|accesskey|sessiontoken)$/.test(normalizedKey)) ||
      (normalizedParent === "locator" && /^user(?:info)?$/.test(normalizedKey)) ||
      (normalizedParent === "query" && /^(?:auth|key|session)$/.test(normalizedKey));
    return (
      CREDENTIAL_BEARING_PLAN_KEYS.test(normalizedKey) ||
      sensitiveNestedKey ||
      containsCredentialBearingPlanMaterial(child, key)
    );
  });
}

export function isCredentialFreeLegacySource(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || containsControlCharacter(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return !value.includes("?") && !value.includes("#") && !value.includes("@");
  }
}

export { containsControlCharacter };

export function isPlanEnvelope(value: unknown): value is QueryExecutionPlan {
  const plan = queryPlanEnvelope(value);
  return plan !== undefined && (plan.version === QUERY_PLAN_VERSION || plan.version === QUERY_PLAN_V2_VERSION);
}

function isQueryPlanV1Envelope(value: unknown): value is QueryExecutionPlanV1 {
  return queryPlanEnvelope(value)?.version === QUERY_PLAN_VERSION;
}

function queryPlanEnvelope(value: unknown): Partial<QueryExecutionPlan> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const plan = value as Partial<QueryExecutionPlan>;
  return plan.kind === QUERY_PLAN_KIND &&
    plan.diagnosticsVersion === QUERY_PLAN_DIAGNOSTICS_VERSION &&
    typeof plan.id === "string" &&
    typeof plan.fingerprint === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(plan.fingerprint) &&
    plan.ir !== null &&
    typeof plan.ir === "object" &&
    Array.isArray(plan.steps) &&
    Array.isArray(plan.warnings)
    ? plan
    : undefined;
}
