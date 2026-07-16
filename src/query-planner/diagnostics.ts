import { sourceSchemaV2EnvelopeFingerprint } from "../contract/schema-envelope.js";
import type { CapabilityPolicy, SourceDescriptor } from "../contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import type {
  CanonicalQuery,
  ExplainQueryOptions,
  QueryFallbackPolicy,
  QueryIrSourceIdentity,
  QueryIrSourceIdentityV2,
  QueryIrV1,
  QueryIrV2,
  QueryPlanBoundsV1,
  QueryPlanCacheDecisionV1,
  QueryPlanCacheOptions,
  QueryPlanDiscoveryContext,
  QueryPlanFidelity,
  QueryPlanFidelityLoss,
  QueryPlanProvenanceV1,
  QueryPlanQuantityBound,
  QueryPlanStepProvenanceV1,
  QueryPlanValidatorInput,
  QueryPlanValidityV1,
  QueryPlanWarning,
  QueryPlanningEstimates,
} from "./types.js";
import { HonuaQueryPlanningError, QUERY_PLANNER_VERSION, QUERY_PLAN_DIAGNOSTICS_VERSION } from "./types.js";

type SourceIdentity = QueryIrSourceIdentity | QueryIrSourceIdentityV2;
type Sha256 = `sha256:${string}`;

interface DiagnosticStep {
  readonly engine: "remote" | "client";
  readonly operation: string;
  readonly requests?: number;
  readonly query?: CanonicalQuery;
  readonly compiled?: object;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

export function createQueryPlanProvenance(
  descriptor: SourceDescriptor,
  source: SourceIdentity,
  options: Pick<ExplainQueryOptions, "discovery" | "schemaVersion">,
): QueryPlanProvenanceV1 {
  const schema = schemaProvenance(descriptor, options.schemaVersion);
  const discovery = discoveryProvenance(options.discovery);
  const endpointFingerprint = digest("endpoint", source.endpoint);
  const authorizationScope = {
    fingerprint: digest("authorization-scope", [...source.authorizationScope].sort()),
    count: source.authorizationScope.length,
  } as const;
  const descriptorFingerprint = digest("descriptor", {
    source,
    schema,
  });
  return {
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    source: { id: source.id, protocol: source.protocol, endpointFingerprint, descriptorFingerprint },
    schema,
    discovery,
    authorizationScope,
  };
}

export function createStepProvenance(provenance: QueryPlanProvenanceV1): QueryPlanStepProvenanceV1 {
  return {
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    sourceFingerprint: provenance.source.descriptorFingerprint,
    ...(provenance.schema.state === "known" ? { schemaFingerprint: provenance.schema.fingerprint } : {}),
    discoveryFingerprint: provenance.discovery.fingerprint,
    authorizationScopeFingerprint: provenance.authorizationScope.fingerprint,
  };
}

export function createCacheDecision(options?: QueryPlanCacheOptions): QueryPlanCacheDecisionV1 {
  const policy = options?.policy ?? "bypass";
  const freshness = options?.freshness ?? "unknown";
  if (!(["bypass", "prefer-cache", "require-fresh"] as const).includes(policy)) invalid("cache.policy");
  if (!(["fresh", "stale", "unknown"] as const).includes(freshness)) invalid("cache.freshness");
  const validator = options?.validator ? normalizeValidator(options.validator, "cache.validator") : undefined;
  if (policy === "bypass") {
    return {
      version: QUERY_PLAN_DIAGNOSTICS_VERSION,
      policy,
      action: "bypass",
      freshness,
      ...(validator ? { validator } : {}),
      reason: "policy-bypass",
    };
  }
  if (freshness === "fresh") {
    return {
      version: QUERY_PLAN_DIAGNOSTICS_VERSION,
      policy,
      action: "reuse",
      freshness,
      ...(validator ? { validator } : {}),
      reason: "fresh-entry",
    };
  }
  if (validator) {
    return {
      version: QUERY_PLAN_DIAGNOSTICS_VERSION,
      policy,
      action: "revalidate",
      freshness,
      validator,
      reason: "validator-available",
    };
  }
  return {
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    policy,
    action: "refresh",
    freshness,
    reason: freshness === "stale" ? "stale-entry" : "cache-miss",
  };
}

export function createStepDiagnostics(
  step: DiagnosticStep,
  estimates: QueryPlanningEstimates,
  provenance: QueryPlanProvenanceV1,
): {
  readonly fidelity: QueryPlanFidelity;
  readonly losses: readonly QueryPlanFidelityLoss[];
  readonly bounds: QueryPlanBoundsV1;
  readonly provenance: QueryPlanStepProvenanceV1;
} {
  const losses = bboxApproximated(step) ? [spatialEnvelopeLoss()] : [];
  const fidelity: QueryPlanFidelity =
    losses.length > 0 ? "approximate" : step.engine === "client" ? "equivalent" : "exact";
  return {
    fidelity,
    losses,
    bounds: stepBounds(step, estimates),
    provenance: createStepProvenance(provenance),
  };
}

export function summarizePlanBounds(steps: readonly { readonly bounds: QueryPlanBoundsV1 }[]): QueryPlanBoundsV1 {
  const remote = steps.find((step) => step.bounds.requests.lower !== 0)?.bounds ?? steps[0]?.bounds;
  const materialized = steps.find((step) => step.bounds.materializationBytes.confidence !== "unknown")?.bounds;
  return {
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    requests: remote?.requests ?? unknown("request"),
    rows: remote?.rows ?? unknown("row"),
    bytes: remote?.bytes ?? unknown("byte"),
    transferBytes: remote?.transferBytes ?? unknown("byte"),
    materializationBytes: materialized?.materializationBytes ?? remote?.materializationBytes ?? unknown("byte"),
  };
}

export function summarizeFidelity(
  steps: readonly { readonly fidelity: QueryPlanFidelity; readonly losses: readonly QueryPlanFidelityLoss[] }[],
): { readonly fidelity: QueryPlanFidelity; readonly losses: readonly QueryPlanFidelityLoss[] } {
  const fidelity = steps.some((step) => step.fidelity === "approximate")
    ? "approximate"
    : steps.some((step) => step.fidelity === "equivalent")
      ? "equivalent"
      : "exact";
  return { fidelity, losses: steps.flatMap((step) => step.losses) };
}

export function createPlanWarnings(
  steps: readonly DiagnosticStep[],
  source: SourceIdentity,
): readonly QueryPlanWarning[] {
  const warnings: QueryPlanWarning[] = [];
  if (steps.some((step) => step.engine === "client")) {
    warnings.push({
      code: "bounded-local-fallback",
      severity: "warning",
      path: "$.steps[1]",
      message: "Execution uses a bounded local fallback and fails closed if its materialization ceiling is exceeded.",
      remediation: "Enable server pushdown or reduce the query input bound.",
    });
  }
  if (source.protocol === "ogc-features" && steps.some((step) => step.engine === "client")) {
    warnings.push({
      code: "geometry-transfer-required",
      severity: "warning",
      path: "$.steps[0].query.returnGeometry",
      message: "OGC API Features may transfer geometry because portable geometry suppression is unavailable.",
      remediation: "Use a server projection that omits geometry when the endpoint supports one.",
    });
  }
  if (steps.some(bboxApproximated)) {
    warnings.push({
      code: "approximate-spatial-filter",
      severity: "warning",
      path: "$.ir.query.spatialFilter",
      message: "A spatial predicate was reduced to its bounding envelope.",
      remediation: "Use an envelope query or an exact spatial compiler.",
    });
  }
  return warnings;
}

function bboxApproximated(step: DiagnosticStep): boolean {
  return step.compiled !== undefined && "bboxApproximated" in step.compiled && step.compiled.bboxApproximated === true;
}

export function createPlanValidity(
  ir: QueryIrV1 | QueryIrV2,
  provenance: QueryPlanProvenanceV1,
  capabilityPolicy: CapabilityPolicy,
  fallback: QueryFallbackPolicy,
  executionMode: "snapshot" | "delta",
): QueryPlanValidityV1 {
  const unsigned = {
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    plannerVersion: QUERY_PLANNER_VERSION,
    contractVersion: `${ir.kind}@${ir.version}`,
    executionMode,
    sourceFingerprint: provenance.source.descriptorFingerprint,
    schemaFingerprint: digest("schema-identity", provenance.schema),
    discoveryFingerprint: provenance.discovery.fingerprint,
    authorizationScopeFingerprint: provenance.authorizationScope.fingerprint,
    queryFingerprint: digest("query", ir.query),
    crsFingerprint: digest("crs", { outSr: ir.query.outSr ?? null }),
    policyFingerprint: digest("policy", { capabilityPolicy, fallback }),
  } as const;
  return { ...unsigned, fingerprint: digest("validity", unsigned) };
}

function stepBounds(step: DiagnosticStep, estimates: QueryPlanningEstimates): QueryPlanBoundsV1 {
  if (step.engine === "client") {
    return {
      version: QUERY_PLAN_DIAGNOSTICS_VERSION,
      requests: exact("request", 0),
      rows: step.maxRows === undefined ? unknown("row") : bounded("row", 0, step.maxRows, "fallback-policy"),
      bytes: step.maxBytes === undefined ? unknown("byte") : bounded("byte", 0, step.maxBytes, "fallback-policy"),
      transferBytes: exact("byte", 0),
      materializationBytes:
        step.maxBytes === undefined
          ? estimates.bytes === undefined
            ? unknown("byte")
            : estimated("byte", estimates.bytes)
          : bounded("byte", 0, step.maxBytes, "fallback-policy"),
    };
  }
  const queryLimit = step.query?.pagination?.limit;
  const queryAll = step.operation === "queryAll";
  const requests = queryAll
    ? estimates.requests === undefined
      ? { ...unknown("request"), lower: 1 }
      : estimated("request", estimates.requests)
    : exact("request", 1);
  const rows =
    queryLimit !== undefined
      ? bounded("row", 0, queryLimit, "query-limit")
      : estimates.rows === undefined
        ? unknown("row")
        : estimated("row", estimates.rows);
  const bytes = estimates.bytes === undefined ? unknown("byte") : estimated("byte", estimates.bytes);
  return {
    version: QUERY_PLAN_DIAGNOSTICS_VERSION,
    requests,
    rows,
    bytes,
    transferBytes: bytes,
    materializationBytes: unknown("byte"),
  };
}

function schemaProvenance(
  descriptor: SourceDescriptor,
  schemaVersion: string | undefined,
): QueryPlanProvenanceV1["schema"] {
  if (descriptor.schemaV2 !== undefined) {
    try {
      return {
        state: "known",
        fingerprint: sourceSchemaV2EnvelopeFingerprint(descriptor.schemaV2),
        basis: "schema-v2",
      };
    } catch {
      throw new HonuaQueryPlanningError("invalid-query", "descriptor.schemaV2 identity is invalid");
    }
  }
  if (schemaVersion !== undefined) {
    return { state: "known", fingerprint: digest("schema-version", schemaVersion), basis: "version" };
  }
  return { state: "unavailable", reason: "not-provided" };
}

function discoveryProvenance(context?: QueryPlanDiscoveryContext): QueryPlanProvenanceV1["discovery"] {
  const state = context?.state ?? "unavailable";
  if (!(["metadata", "declared", "inferred", "unavailable"] as const).includes(state)) invalid("discovery.state");
  if (context?.source !== undefined && context.sourceFingerprint !== undefined) invalid("discovery.source");
  const sourceFingerprint = context?.sourceFingerprint
    ? verifiedFingerprint(context.sourceFingerprint, "discovery.sourceFingerprint")
    : context?.source !== undefined
      ? digest("discovery-source", stableText(context.source, "discovery.source"))
      : undefined;
  if (state !== "unavailable" && !sourceFingerprint) invalid("discovery.source");
  const validator = context?.validator ? normalizeValidator(context.validator, "discovery.validator") : undefined;
  const unsigned = { state, ...(sourceFingerprint ? { sourceFingerprint } : {}), ...(validator ? { validator } : {}) };
  return { ...unsigned, fingerprint: digest("discovery", unsigned) };
}

function normalizeValidator(
  input: QueryPlanValidatorInput,
  path: string,
): { readonly kind: QueryPlanValidatorInput["kind"]; readonly fingerprint: Sha256 } {
  if (!(["etag", "last-modified", "revision", "fingerprint"] as const).includes(input.kind)) invalid(`${path}.kind`);
  if ((input.value === undefined) === (input.fingerprint === undefined)) invalid(path);
  const fingerprint = input.fingerprint
    ? verifiedFingerprint(input.fingerprint, `${path}.fingerprint`)
    : digest("validator", { kind: input.kind, value: stableText(input.value as string, `${path}.value`) });
  return { kind: input.kind, fingerprint };
}

function spatialEnvelopeLoss(): QueryPlanFidelityLoss {
  return {
    code: "spatial-envelope-reduction",
    path: "$.ir.query.spatialFilter",
    description: "The source evaluates the input geometry's bounding envelope instead of its exact shape.",
    remediation: "Use an envelope query or select a compiler with exact geometry predicate support.",
  };
}

function exact(unit: QueryPlanQuantityBound["unit"], value: number): QueryPlanQuantityBound {
  return { unit, confidence: "exact", source: "compiler", lower: value, upper: value, estimate: value };
}

function bounded(
  unit: QueryPlanQuantityBound["unit"],
  lower: number,
  upper: number,
  source: QueryPlanQuantityBound["source"],
): QueryPlanQuantityBound {
  return { unit, confidence: "bounded", source, lower, upper };
}

function estimated(unit: QueryPlanQuantityBound["unit"], estimate: number): QueryPlanQuantityBound {
  return { unit, confidence: "estimated", source: "caller-estimate", estimate };
}

function unknown(unit: QueryPlanQuantityBound["unit"]): QueryPlanQuantityBound {
  return { unit, confidence: "unknown", source: "unavailable" };
}

function digest(namespace: string, value: unknown): Sha256 {
  return sha256(`${namespace}:v1:${canonicalStringify(toJsonValue(value))}`);
}

function verifiedFingerprint(value: string, path: string): Sha256 {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid(path);
  return value as Sha256;
}

function stableText(value: string, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || containsControlCharacter(value)) {
    invalid(path);
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalid(path: string): never {
  throw new HonuaQueryPlanningError("invalid-query", `${path} is invalid`);
}
