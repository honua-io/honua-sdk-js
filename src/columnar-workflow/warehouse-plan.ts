import type { QueryFilterExpression } from "../contract/query-filter.js";
import type { SourceFreshnessContract } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  type GovernedWarehouseProvider,
  HonuaWarehouseError,
  assertNoRawVendorSql,
  assertNoWarehouseSecrets,
  assertOpaqueGovernedIdentifier,
  isGovernedWarehouseProvider,
  isPlainRecord,
} from "./warehouse-security.js";
import {
  type WarehouseCapabilityCheckOptions,
  type WarehouseEffectiveSourceCapabilities,
  type WarehouseOutputFormat,
  assertWarehouseCapability,
} from "./warehouse-source.js";

export const WAREHOUSE_EXECUTION_PLAN_SCHEMA_VERSION = "honua.warehouse-execution-plan.v1" as const;
export const DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS = 10_000;

export type WarehouseRepresentation = "geoarrow" | "geoparquet" | "tiles" | "objects";
export type WarehouseStageKind = "warehouse" | "server" | "worker" | "gpu" | "browser";
export type WarehouseFidelityLevel = "exact" | "approximate" | "lossy";
export type WarehouseEstimateConfidence = "exact" | "bounded" | "heuristic" | "unknown";

export interface WarehouseSemanticIntent {
  readonly sourceId: string;
  readonly governedQueryId?: string;
  readonly columns?: readonly string[];
  readonly filter?: QueryFilterExpression;
  readonly bbox?: readonly [number, number, number, number];
  readonly temporalWindow?: { readonly field: string; readonly start?: string; readonly end?: string };
  readonly aggregations?: readonly {
    readonly name: string;
    readonly operation: "count" | "sum" | "min" | "max" | "avg";
    readonly field?: string;
  }[];
  readonly h3?: { readonly resolution: number; readonly geometryField?: string };
  readonly orderBy?: readonly { readonly field: string; readonly direction: "asc" | "desc" }[];
  readonly limit?: number;
  readonly preferredRepresentation?: WarehouseRepresentation;
}

export interface WarehousePlanBudgets {
  readonly maxScannedRows?: number;
  readonly maxScannedBytes?: number;
  readonly maxReturnedRows?: number;
  readonly maxReturnedBytes?: number;
  readonly maxTransferBytes?: number;
  readonly maxObjectMaterializationRows?: number;
  readonly maxEstimatedCost?: number;
  readonly deadlineMs?: number;
  readonly allowUnknownEstimates?: boolean;
  readonly minFidelity?: WarehouseFidelityLevel;
}

export interface WarehouseExplainRequest {
  readonly sourceId: string;
  readonly connectionId: string;
  readonly provider: GovernedWarehouseProvider;
  readonly policyScopeFingerprint: string;
  readonly intent: WarehouseSemanticIntent;
  readonly budgets: WarehousePlanBudgets;
}

export interface WarehousePlanStage {
  readonly id: string;
  readonly stage: WarehouseStageKind;
  readonly operation: string;
  readonly pushedDown: boolean;
  readonly detail?: string;
}

export interface WarehouseTransferBoundary {
  readonly from: WarehouseStageKind;
  readonly to: WarehouseStageKind;
  readonly format: WarehouseOutputFormat | "objects";
  readonly estimatedRows: number | null;
  readonly estimatedBytes: number | null;
}

export interface WarehousePlanEstimates {
  readonly scannedRows: number | null;
  readonly scannedBytes: number | null;
  readonly returnedRows: number | null;
  readonly returnedBytes: number | null;
  readonly transferBytes: number | null;
  readonly estimatedCost: number | null;
  readonly costCurrency?: string;
  readonly confidence: WarehouseEstimateConfidence;
}

export interface WarehousePlanFidelityLoss {
  readonly code: string;
  readonly reason: string;
}

export interface WarehousePlanFidelity {
  readonly level: WarehouseFidelityLevel;
  readonly losses: readonly WarehousePlanFidelityLoss[];
}

/** Server-authored execution plan and explain payload. */
export interface WarehouseExecutionPlan {
  readonly schemaVersion: typeof WAREHOUSE_EXECUTION_PLAN_SCHEMA_VERSION;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly sourceId: string;
  readonly provider: GovernedWarehouseProvider;
  readonly policyScopeFingerprint: string;
  readonly sourceVersion: string;
  readonly schemaVersionToken: string;
  readonly parameterRedacted: true;
  readonly representation: WarehouseRepresentation;
  readonly outputFormat: WarehouseOutputFormat;
  readonly pushedDownPredicates: readonly string[];
  readonly residualPredicates: readonly string[];
  readonly bboxPushdown: boolean;
  readonly h3Pushdown: boolean;
  readonly stages: readonly WarehousePlanStage[];
  readonly transfers: readonly WarehouseTransferBoundary[];
  readonly estimates: WarehousePlanEstimates;
  readonly fidelity: WarehousePlanFidelity;
  readonly deadlineMs?: number;
  readonly freshness?: SourceFreshnessContract;
}

export type WarehousePlanViolationCode =
  | "scanned-rows-exceeded"
  | "scanned-bytes-exceeded"
  | "returned-rows-exceeded"
  | "returned-bytes-exceeded"
  | "transfer-bytes-exceeded"
  | "cost-budget-exceeded"
  | "deadline-exceeded"
  | "unknown-estimate-refused"
  | "fidelity-below-minimum"
  | "object-materialization-unbounded";

export interface WarehousePlanViolation {
  readonly code: WarehousePlanViolationCode;
  readonly metric: string;
  readonly limit: number | string;
  readonly observed: number | string | null;
  readonly message: string;
}

export interface WarehousePlanPolicyDecision {
  readonly accepted: boolean;
  readonly plan: WarehouseExecutionPlan;
  readonly selectedRepresentation: WarehouseRepresentation;
  readonly violations: readonly WarehousePlanViolation[];
}

export interface AcceptedWarehouseExecutionPlan extends WarehouseExecutionPlan {
  readonly budgets: WarehousePlanBudgets;
}

export interface WarehouseObservedMetrics {
  readonly scannedRows?: number;
  readonly scannedBytes?: number;
  readonly returnedRows: number;
  readonly returnedBytes: number;
  readonly transferBytes: number;
  readonly elapsedMs: number;
  readonly cost?: number;
}

export type WarehouseReconciliationStatus = "within-budget" | "divergent" | "budget-exceeded";

export interface WarehouseExecutionReconciliation {
  readonly planId: string;
  readonly status: WarehouseReconciliationStatus;
  readonly findings: readonly string[];
  readonly observed: WarehouseObservedMetrics;
}

const VALID_STAGES = new Set<string>(["warehouse", "server", "worker", "gpu", "browser"]);
const VALID_REPRESENTATIONS = new Set<string>(["geoarrow", "geoparquet", "tiles", "objects"]);
const VALID_FIDELITY = new Set<string>(["exact", "approximate", "lossy"]);
const VALID_CONFIDENCE = new Set<string>(["exact", "bounded", "heuristic", "unknown"]);
const FIDELITY_RANK: Readonly<Record<WarehouseFidelityLevel, number>> = { exact: 3, approximate: 2, lossy: 1 };

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new HonuaWarehouseError("plan-invalid", `${label} must be a non-negative finite number or null.`, { label });
  }
  return value;
}

function validateStages(raw: unknown): readonly WarehousePlanStage[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HonuaWarehouseError("plan-invalid", "Warehouse execution plan requires at least one stage.");
  }
  return Object.freeze(
    raw.map((entry, index) => {
      if (
        !isPlainRecord(entry) ||
        typeof entry.id !== "string" ||
        !VALID_STAGES.has(String(entry.stage)) ||
        typeof entry.operation !== "string" ||
        typeof entry.pushedDown !== "boolean"
      ) {
        throw new HonuaWarehouseError("plan-invalid", `Plan stage at index ${index} is malformed.`);
      }
      assertNoRawVendorSql(entry.operation, `stages[${index}].operation`);
      if (typeof entry.detail === "string") assertNoRawVendorSql(entry.detail, `stages[${index}].detail`);
      return Object.freeze({
        id: entry.id,
        stage: entry.stage as WarehouseStageKind,
        operation: entry.operation,
        pushedDown: entry.pushedDown,
        ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
      });
    }),
  );
}

function validateTransfers(raw: unknown): readonly WarehouseTransferBoundary[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(
    raw.map((entry, index) => {
      if (
        !isPlainRecord(entry) ||
        !VALID_STAGES.has(String(entry.from)) ||
        !VALID_STAGES.has(String(entry.to)) ||
        typeof entry.format !== "string"
      ) {
        throw new HonuaWarehouseError("plan-invalid", `Transfer boundary at index ${index} is malformed.`);
      }
      return Object.freeze({
        from: entry.from as WarehouseStageKind,
        to: entry.to as WarehouseStageKind,
        format: entry.format as WarehouseTransferBoundary["format"],
        estimatedRows: nullableNumber(entry.estimatedRows, `transfers[${index}].estimatedRows`),
        estimatedBytes: nullableNumber(entry.estimatedBytes, `transfers[${index}].estimatedBytes`),
      });
    }),
  );
}

function validateEstimates(raw: unknown): WarehousePlanEstimates {
  if (!isPlainRecord(raw) || !VALID_CONFIDENCE.has(String(raw.confidence))) {
    throw new HonuaWarehouseError("plan-invalid", "Warehouse plan estimates with explicit confidence are required.");
  }
  return Object.freeze({
    scannedRows: nullableNumber(raw.scannedRows, "estimates.scannedRows"),
    scannedBytes: nullableNumber(raw.scannedBytes, "estimates.scannedBytes"),
    returnedRows: nullableNumber(raw.returnedRows, "estimates.returnedRows"),
    returnedBytes: nullableNumber(raw.returnedBytes, "estimates.returnedBytes"),
    transferBytes: nullableNumber(raw.transferBytes, "estimates.transferBytes"),
    estimatedCost: nullableNumber(raw.estimatedCost, "estimates.estimatedCost"),
    ...(typeof raw.costCurrency === "string" && raw.costCurrency ? { costCurrency: raw.costCurrency } : {}),
    confidence: raw.confidence as WarehouseEstimateConfidence,
  });
}

function validateFidelity(raw: unknown): WarehousePlanFidelity {
  if (!isPlainRecord(raw) || !VALID_FIDELITY.has(String(raw.level))) {
    throw new HonuaWarehouseError("plan-invalid", "Warehouse plan fidelity level is required.");
  }
  const losses = Array.isArray(raw.losses)
    ? raw.losses.map((loss) => {
        if (!isPlainRecord(loss) || typeof loss.code !== "string" || typeof loss.reason !== "string") {
          throw new HonuaWarehouseError("plan-invalid", "Warehouse plan fidelity loss entry is malformed.");
        }
        return Object.freeze({ code: loss.code, reason: loss.reason });
      })
    : [];
  return Object.freeze({ level: raw.level as WarehouseFidelityLevel, losses: Object.freeze(losses) });
}

/** Build a validated semantic explain request against a governed warehouse source (no browser SQL compilation). */
export function buildWarehouseExplainRequest(
  source: WarehouseEffectiveSourceCapabilities,
  intent: WarehouseSemanticIntent,
  budgets: WarehousePlanBudgets = {},
  options: WarehouseCapabilityCheckOptions = {},
): WarehouseExplainRequest {
  assertNoWarehouseSecrets(intent, "intent");
  assertNoWarehouseSecrets(budgets, "budgets");
  if (intent.sourceId !== source.sourceId) {
    throw new HonuaWarehouseError(
      "plan-invalid",
      `Intent sourceId "${intent.sourceId}" does not match "${source.sourceId}".`,
    );
  }
  assertWarehouseCapability(source, "query", options);
  if (intent.h3) assertWarehouseCapability(source, "h3Aggregation", options);
  if (intent.bbox) assertWarehouseCapability(source, "spatial:bbox-intersects", options);
  if (intent.temporalWindow) assertWarehouseCapability(source, "temporalFilter", options);
  if (intent.aggregations?.length) assertWarehouseCapability(source, "queryAggregate", options);
  if (intent.preferredRepresentation === "geoarrow") assertWarehouseCapability(source, "format.geoarrow", options);
  if (intent.preferredRepresentation === "geoparquet") assertWarehouseCapability(source, "format.geoparquet", options);
  return Object.freeze({
    sourceId: source.sourceId,
    connectionId: source.connectionId,
    provider: source.provider,
    policyScopeFingerprint: source.policy.policyScopeFingerprint,
    intent: Object.freeze({ ...intent }),
    budgets: Object.freeze({ ...budgets }),
  });
}

/** Validate a server-authored warehouse execution plan without trusting raw vendor SQL. */
export function validateWarehouseExecutionPlan(
  input: unknown,
  expectedSource?: WarehouseEffectiveSourceCapabilities,
): WarehouseExecutionPlan {
  if (!isPlainRecord(input)) {
    throw new HonuaWarehouseError("plan-invalid", "Warehouse execution plan must be an object.");
  }
  assertNoWarehouseSecrets(input);
  if (input.parameterRedacted !== true) {
    throw new HonuaWarehouseError("plan-invalid", "Warehouse execution plan must declare parameterRedacted: true.");
  }
  if (!isGovernedWarehouseProvider(input.provider)) {
    throw new HonuaCapabilityNotSupportedError(`provider.${String(input.provider ?? "unknown")}`, "warehouse");
  }
  const planId = assertOpaqueGovernedIdentifier(input.planId, "planId");
  const planFingerprint = assertOpaqueGovernedIdentifier(input.planFingerprint, "planFingerprint");
  const sourceId = assertOpaqueGovernedIdentifier(input.sourceId, "sourceId");
  const policyScopeFingerprint = assertOpaqueGovernedIdentifier(input.policyScopeFingerprint, "policyScopeFingerprint");
  const sourceVersion = assertOpaqueGovernedIdentifier(input.sourceVersion, "sourceVersion");
  const schemaVersionToken = assertOpaqueGovernedIdentifier(input.schemaVersionToken, "schemaVersionToken");
  if (!VALID_REPRESENTATIONS.has(String(input.representation))) {
    throw new HonuaWarehouseError("plan-invalid", `Unsupported plan representation "${String(input.representation)}".`);
  }
  if (expectedSource) {
    if (
      expectedSource.sourceId !== sourceId ||
      expectedSource.provider !== input.provider ||
      expectedSource.policy.policyScopeFingerprint !== policyScopeFingerprint
    ) {
      throw new HonuaWarehouseError(
        "plan-invalid",
        "Warehouse execution plan identity does not match the governed source or policy scope.",
      );
    }
  }
  return Object.freeze({
    schemaVersion: WAREHOUSE_EXECUTION_PLAN_SCHEMA_VERSION,
    planId,
    planFingerprint,
    sourceId,
    provider: input.provider,
    policyScopeFingerprint,
    sourceVersion,
    schemaVersionToken,
    parameterRedacted: true,
    representation: input.representation as WarehouseRepresentation,
    outputFormat: input.outputFormat as WarehouseOutputFormat,
    pushedDownPredicates: Object.freeze(
      Array.isArray(input.pushedDownPredicates) ? [...(input.pushedDownPredicates as string[])] : [],
    ),
    residualPredicates: Object.freeze(
      Array.isArray(input.residualPredicates) ? [...(input.residualPredicates as string[])] : [],
    ),
    bboxPushdown: Boolean(input.bboxPushdown),
    h3Pushdown: Boolean(input.h3Pushdown),
    stages: validateStages(input.stages),
    transfers: validateTransfers(input.transfers),
    estimates: validateEstimates(input.estimates),
    fidelity: validateFidelity(input.fidelity),
    ...(typeof input.deadlineMs === "number" ? { deadlineMs: input.deadlineMs } : {}),
    ...(isPlainRecord(input.freshness)
      ? { freshness: Object.freeze({ ...(input.freshness as unknown as SourceFreshnessContract) }) }
      : {}),
  });
}

function checkNumericBound(
  violations: WarehousePlanViolation[],
  code: WarehousePlanViolationCode,
  metric: string,
  observed: number | null,
  limit: number | undefined,
  allowUnknown: boolean,
): void {
  if (limit === undefined) return;
  if (observed === null) {
    if (!allowUnknown) {
      violations.push({
        code: "unknown-estimate-refused",
        metric,
        limit,
        observed: null,
        message: `Plan estimate for ${metric} is unknown while a budget of ${limit} is enforced.`,
      });
    }
    return;
  }
  if (observed > limit) {
    violations.push({
      code,
      metric,
      limit,
      observed,
      message: `Plan ${metric} (${observed}) exceeds configured budget (${limit}).`,
    });
  }
}

/** Evaluate a server-authored execution plan against client row, byte, transfer, cost, and fidelity guardrails. */
export function evaluateWarehouseExecutionPlan(
  plan: WarehouseExecutionPlan,
  budgets: WarehousePlanBudgets,
): WarehousePlanPolicyDecision {
  const violations: WarehousePlanViolation[] = [];
  const allowUnknown = budgets.allowUnknownEstimates === true;
  if (plan.estimates.confidence === "unknown" && !allowUnknown) {
    violations.push({
      code: "unknown-estimate-refused",
      metric: "estimates.confidence",
      limit: "bounded",
      observed: "unknown",
      message: "Plan has unknown estimate confidence; allowUnknownEstimates is disabled.",
    });
  }
  checkNumericBound(
    violations,
    "scanned-rows-exceeded",
    "scannedRows",
    plan.estimates.scannedRows,
    budgets.maxScannedRows,
    allowUnknown,
  );
  checkNumericBound(
    violations,
    "scanned-bytes-exceeded",
    "scannedBytes",
    plan.estimates.scannedBytes,
    budgets.maxScannedBytes,
    allowUnknown,
  );
  checkNumericBound(
    violations,
    "returned-rows-exceeded",
    "returnedRows",
    plan.estimates.returnedRows,
    budgets.maxReturnedRows,
    allowUnknown,
  );
  checkNumericBound(
    violations,
    "returned-bytes-exceeded",
    "returnedBytes",
    plan.estimates.returnedBytes,
    budgets.maxReturnedBytes,
    allowUnknown,
  );
  checkNumericBound(
    violations,
    "transfer-bytes-exceeded",
    "transferBytes",
    plan.estimates.transferBytes,
    budgets.maxTransferBytes,
    allowUnknown,
  );
  checkNumericBound(
    violations,
    "cost-budget-exceeded",
    "estimatedCost",
    plan.estimates.estimatedCost,
    budgets.maxEstimatedCost,
    allowUnknown,
  );
  if (budgets.deadlineMs !== undefined && plan.deadlineMs !== undefined && plan.deadlineMs > budgets.deadlineMs) {
    violations.push({
      code: "deadline-exceeded",
      metric: "deadlineMs",
      limit: budgets.deadlineMs,
      observed: plan.deadlineMs,
      message: `Plan deadline (${plan.deadlineMs} ms) exceeds budget (${budgets.deadlineMs} ms).`,
    });
  }
  if (budgets.minFidelity && FIDELITY_RANK[plan.fidelity.level] < FIDELITY_RANK[budgets.minFidelity]) {
    violations.push({
      code: "fidelity-below-minimum",
      metric: "fidelity",
      limit: budgets.minFidelity,
      observed: plan.fidelity.level,
      message: `Plan fidelity "${plan.fidelity.level}" is below required "${budgets.minFidelity}".`,
    });
  }
  const maxObjectRows = budgets.maxObjectMaterializationRows ?? DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS;
  if (
    plan.representation === "objects" &&
    (plan.estimates.returnedRows === null || plan.estimates.returnedRows > maxObjectRows)
  ) {
    violations.push({
      code: "object-materialization-unbounded",
      metric: "returnedRows",
      limit: maxObjectRows,
      observed: plan.estimates.returnedRows,
      message: `Object representation requires bounded returnedRows <= ${maxObjectRows}; select geoarrow or geoparquet instead.`,
    });
  }
  return Object.freeze({
    accepted: violations.length === 0,
    plan,
    selectedRepresentation: plan.representation,
    violations: Object.freeze(violations),
  });
}

/** Accept a server-authored plan under policy or throw HonuaWarehouseError("plan-rejected") before execution. */
export function acceptWarehouseExecutionPlan(
  plan: WarehouseExecutionPlan,
  budgets: WarehousePlanBudgets,
): AcceptedWarehouseExecutionPlan {
  const decision = evaluateWarehouseExecutionPlan(plan, budgets);
  if (!decision.accepted) {
    throw new HonuaWarehouseError(
      "plan-rejected",
      `Warehouse execution plan ${plan.planId} was refused by policy: ${decision.violations.map((v) => v.message).join("; ")}`,
      { planId: plan.planId, violations: decision.violations },
    );
  }
  return Object.freeze({ ...plan, budgets: Object.freeze({ ...budgets }) });
}

/** Reconcile observed execution metrics against the accepted plan and classify material divergence. */
export function reconcileWarehouseExecutionMetrics(
  plan: AcceptedWarehouseExecutionPlan,
  observed: WarehouseObservedMetrics,
): WarehouseExecutionReconciliation {
  const findings: string[] = [];
  let exceeded = false;
  let divergent = false;

  const checkLimit = (
    label: string,
    actual: number | undefined,
    budget: number | undefined,
    estimate: number | null,
  ) => {
    if (actual === undefined) return;
    if (budget !== undefined && actual > budget) {
      exceeded = true;
      findings.push(`Observed ${label} (${actual}) exceeded budget (${budget}).`);
    }
    if (estimate !== null && estimate > 0 && actual > estimate * 2) {
      divergent = true;
      findings.push(`Observed ${label} (${actual}) materially diverged from estimate (${estimate}).`);
    }
  };

  checkLimit("scannedRows", observed.scannedRows, plan.budgets.maxScannedRows, plan.estimates.scannedRows);
  checkLimit("scannedBytes", observed.scannedBytes, plan.budgets.maxScannedBytes, plan.estimates.scannedBytes);
  checkLimit("returnedRows", observed.returnedRows, plan.budgets.maxReturnedRows, plan.estimates.returnedRows);
  checkLimit("returnedBytes", observed.returnedBytes, plan.budgets.maxReturnedBytes, plan.estimates.returnedBytes);
  checkLimit("transferBytes", observed.transferBytes, plan.budgets.maxTransferBytes, plan.estimates.transferBytes);
  checkLimit("cost", observed.cost, plan.budgets.maxEstimatedCost, plan.estimates.estimatedCost);
  if (plan.budgets.deadlineMs !== undefined && observed.elapsedMs > plan.budgets.deadlineMs) {
    exceeded = true;
    findings.push(`Observed elapsedMs (${observed.elapsedMs}) exceeded deadline (${plan.budgets.deadlineMs}).`);
  }

  return Object.freeze({
    planId: plan.planId,
    status: exceeded ? "budget-exceeded" : divergent ? "divergent" : "within-budget",
    findings: Object.freeze(findings),
    observed: Object.freeze({ ...observed }),
  });
}
