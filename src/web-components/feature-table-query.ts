import type { DegradedReason, FeatureId, SortSpec } from "../contract/types.js";
import { isSourceQualifiedSelectionTarget } from "../exploration/selection.js";
import type { FeatureSelectionTarget } from "../exploration/types.js";
import type { QueryExecutionPlan } from "../query-planner/types.js";
import type {
  HonuaFeatureTableQueryEvidence,
  HonuaFeatureTableResolvedColumn,
  HonuaFeatureTableRowKey,
  HonuaFeatureTableWindow,
  HonuaFeatureTableWorkItem,
  HonuaFeatureTableWorkTier,
} from "./feature-table-engine.js";

/** Build the engine's row key. Shares the realtime key space (`sourceId:id`). */
export function featureTableRowKey(sourceId: string, id: FeatureId): HonuaFeatureTableRowKey {
  return `${sourceId}:${String(id)}`;
}

type ColumnList = readonly { readonly field: string; readonly visible: boolean }[];

export function tableProjection(
  columns: ColumnList,
  identityField: string | undefined,
  maxFields: number,
): readonly string[] | undefined {
  const fields = columns
    .filter((column) => column.visible)
    .slice(0, maxFields)
    .map((column) => column.field);
  if (fields.length === 0) return undefined;
  return identityField && !fields.includes(identityField) ? [...fields, identityField] : fields;
}

export function tableQueryOrder(sort: readonly SortSpec[], identityField: string | undefined): readonly SortSpec[] {
  if (!identityField || sort.some((entry) => entry.field === identityField)) return sort;
  return [...sort, { field: identityField, direction: "asc" }];
}

export function tableOrderedFields(columns: ColumnList, maxFields: number): readonly string[] {
  const visible = columns
    .filter((column) => column.visible)
    .slice(0, maxFields)
    .map((column) => column.field);
  return visible.length > 0 ? visible : columns.slice(0, maxFields).map((column) => column.field);
}

type FeatureTableEvidenceInput = {
  readonly plan: QueryExecutionPlan | undefined;
  readonly degraded: readonly DegradedReason[];
  readonly cacheKey: string;
  readonly residualTier: HonuaFeatureTableWorkTier;
  readonly sort: readonly SortSpec[];
  readonly window: HonuaFeatureTableWindow;
  readonly residentPages: number;
  readonly columns: readonly HonuaFeatureTableResolvedColumn[];
};

/** Attribute one refresh to the plan, the residual tier, and presentation work. */
export function featureTableQueryEvidence(input: FeatureTableEvidenceInput): HonuaFeatureTableQueryEvidence {
  const { plan, degraded, cacheKey, residualTier, sort, window, residentPages, columns } = input;
  const work: HonuaFeatureTableWorkItem[] = [];
  for (const step of plan?.steps ?? []) {
    if (step.engine === "remote") {
      work.push({
        tier: "server",
        concern: step.pushdown === "full" ? "filter" : "paging",
        detail: `${step.operation} pushdown=${step.pushdown} fidelity=${step.fidelity}: ${step.reason}`,
        planStepId: step.id,
      });
    } else {
      work.push({
        tier: residualTier,
        concern: "filter",
        detail: `residual ${step.operation} bounded to ${step.maxRows} rows: ${step.reason}`,
        planStepId: step.id,
      });
    }
  }
  for (const reason of degraded) {
    work.push({
      tier: residualTier,
      concern: "filter",
      detail: `residual for ${reason.capability}: ${reason.reason}`,
    });
  }
  if (sort.length > 0) {
    work.push({
      tier: plan === undefined || plan.pushdown === "full" ? "server" : residualTier,
      concern: "sort",
      detail: `orderBy ${sort.map((entry) => `${entry.field} ${entry.direction ?? "asc"}`).join(", ")}`,
    });
  }
  work.push({
    tier: "client",
    concern: "virtualization",
    detail: `window ${window.startIndex}-${window.endIndex} over ${residentPages} resident page(s)`,
  });
  const formatted = columns.filter((column) => column.format).length;
  if (formatted > 0) {
    work.push({
      tier: "client",
      concern: "format",
      detail: `${formatted} column formatter(s) applied at render`,
    });
  }
  return Object.freeze({
    ...(plan ? { planId: plan.id, planFingerprint: plan.fingerprint, pushdown: plan.pushdown } : {}),
    ...(plan ? { fidelity: plan.fidelity } : {}),
    work: Object.freeze(work.map((item) => Object.freeze(item))),
    degraded: Object.freeze([...degraded]),
    cacheKey,
  });
}

export function featureTableKeyForTarget(
  sourceId: string,
  target: FeatureSelectionTarget,
): HonuaFeatureTableRowKey | undefined {
  if (!isSourceQualifiedSelectionTarget(target)) return featureTableRowKey(sourceId, target);
  if (target.sourceId !== sourceId) return undefined;
  return featureTableRowKey(sourceId, target.id);
}
