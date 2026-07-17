import { sha256, toJsonValue } from "./canonical.js";
import { containsControlCharacter, containsCredentialMaterial } from "./ir.js";
import {
  QUERY_PLAN_DIAGNOSTICS_VERSION,
  QUERY_PLAN_KIND,
  QUERY_PLAN_V2_VERSION,
  QUERY_PLAN_VERSION,
  type QueryExecutionPlan,
  type QueryExecutionPlanV1,
} from "./types.js";

/** Canonical synchronous v1 fingerprint used by public projection and planner APIs. */
export function hashQueryPlanV1(plan: QueryExecutionPlanV1): `sha256:${string}` | undefined {
  const canonical = canonicalQueryPlanV1(plan);
  return canonical === undefined ? undefined : sha256(canonical);
}

/** @internal Exact async counterpart for already-asynchronous browser workflows. */
export async function hashQueryPlanV1WithSubtleCrypto(
  plan: QueryExecutionPlanV1,
): Promise<`sha256:${string}` | undefined> {
  const canonical = canonicalQueryPlanV1(plan);
  const subtle = globalThis.crypto?.subtle;
  if (canonical === undefined || subtle === undefined) return undefined;
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return undefined;
  }
}

function canonicalQueryPlanV1(plan: QueryExecutionPlanV1): string | undefined {
  try {
    const detached = toJsonValue(plan) as unknown;
    if (!isQueryPlanV1Envelope(detached) || detached.ir.version !== "1.0") {
      return undefined;
    }
    if (detached.ir.source.protocol === "geoparquet") {
      const sources = detached.ir.source.geoparquet?.sources;
      if (!sources || sources.length === 0 || sources.some((source) => !isCredentialFreeLegacySource(source))) {
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

const CREDENTIAL_BEARING_PLAN_KEYS =
  "|authorization|proxyauthorization|cookie|setcookie|username|password|passwd|secret|token|accesstoken|refreshtoken|idtoken|apikey|xapikey|accesskey|secretkey|clientsecret|credential|credentials|signature|xamzsignature|xgoogcredential|accountkey|sharedaccesssignature|";

/** @internal Shared persistence and focused-v1 credential boundary. */
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
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const normalizedParent = parent.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const sensitiveHeader =
      normalizedParent === "headers" &&
      (normalizedKey === "xauth" ||
        normalizedKey === "xauthtoken" ||
        normalizedKey === "xaccesskey" ||
        normalizedKey === "xsessiontoken");
    const sensitiveLocator =
      normalizedParent === "locator" && (normalizedKey === "user" || normalizedKey === "userinfo");
    const sensitiveQueryParameter =
      normalizedParent === "query" &&
      (normalizedKey === "auth" || normalizedKey === "key" || normalizedKey === "session");
    return (
      CREDENTIAL_BEARING_PLAN_KEYS.includes(`|${normalizedKey}|`) ||
      sensitiveHeader ||
      sensitiveLocator ||
      sensitiveQueryParameter ||
      containsCredentialBearingPlanMaterial(child, key)
    );
  });
}

/** @internal Shared v1 legacy-resource admission. */
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

/** @internal Shared shallow envelope guard; deeper validation remains version-specific. */
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
