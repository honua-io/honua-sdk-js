import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  type WarehouseExecutionPlan,
  type WarehousePlanBudgets,
  type WarehouseSemanticIntent,
  acceptWarehouseExecutionPlan,
  buildWarehouseExplainRequest,
  evaluateWarehouseExecutionPlan,
  validateWarehouseExecutionPlan,
} from "./warehouse-plan.js";
import {
  type GovernedWarehouseProvider,
  HonuaWarehouseError,
  isGovernedWarehouseProvider,
} from "./warehouse-security.js";
import {
  type WarehouseEffectiveSourceCapabilities,
  type WarehouseSourceTransport,
  createGovernedWarehouseSource,
  validateWarehouseSourceCapabilities,
} from "./warehouse-source.js";
import {
  type WarehouseColumnarStreamTransport,
  type WarehouseDeckGlGeometryKind,
  collectWarehouseColumnarStream,
  handoffWarehouseBatchToDeckGl,
  handoffWarehouseBatchToMapLibre,
} from "./warehouse-stream.js";

export interface WarehouseConformanceHarness {
  readonly provider: GovernedWarehouseProvider;
  readonly capabilities: WarehouseEffectiveSourceCapabilities;
  readonly intent: WarehouseSemanticIntent;
  readonly budgets: WarehousePlanBudgets;
  readonly plan: WarehouseExecutionPlan;
  readonly overBudgetPlan: WarehouseExecutionPlan;
  readonly queryTransport: WarehouseSourceTransport;
  readonly streamTransport: WarehouseColumnarStreamTransport;
  readonly deckGlGeometry: WarehouseDeckGlGeometryKind;
  readonly now?: () => Date;
}

export interface WarehouseConformanceCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface WarehouseConformanceReport {
  readonly provider: GovernedWarehouseProvider;
  readonly sourceId: string;
  readonly passed: boolean;
  readonly supportedFormats: readonly string[];
  readonly checks: readonly WarehouseConformanceCheckResult[];
}

/**
 * Execute the provider-neutral read-only spatial analytics conformance suite
 * across Redshift, Snowflake, Databricks, or DuckDB (BigQuery and CARTO excluded).
 */
export async function runWarehouseProviderConformance(
  harness: WarehouseConformanceHarness,
): Promise<WarehouseConformanceReport> {
  if (!isGovernedWarehouseProvider(harness.provider)) {
    throw new HonuaCapabilityNotSupportedError(`provider.${String(harness.provider)}`, "warehouse");
  }
  const checks: WarehouseConformanceCheckResult[] = [];
  const capabilities = validateWarehouseSourceCapabilities(harness.capabilities);
  const source = createGovernedWarehouseSource(capabilities, harness.queryTransport, { now: harness.now });

  // 1. Credential-free source projection + read-only fail-closed check
  let readOnlyRefused = false;
  try {
    await source.applyEdits({});
  } catch (error) {
    readOnlyRefused = error instanceof HonuaCapabilityNotSupportedError;
  }
  checks.push({ name: "read-only-applyEdits-refused", passed: readOnlyRefused });

  // 2. Governed explain request + server-authored plan validation
  const explainRequest = buildWarehouseExplainRequest(capabilities, harness.intent, harness.budgets, {
    now: harness.now,
  });
  const validatedPlan = validateWarehouseExecutionPlan(harness.plan, capabilities);
  const acceptedPlan = acceptWarehouseExecutionPlan(validatedPlan, harness.budgets);
  checks.push({
    name: "explain-and-accept-plan",
    passed: explainRequest.provider === harness.provider && acceptedPlan.parameterRedacted === true,
  });

  // 3. Cost/budget refusal before execution
  const refusedDecision = evaluateWarehouseExecutionPlan(
    validateWarehouseExecutionPlan(harness.overBudgetPlan, capabilities),
    harness.budgets,
  );
  checks.push({
    name: "cost-budget-refusal",
    passed: !refusedDecision.accepted && refusedDecision.violations.length > 0,
  });

  // 4. Bounded columnar streaming + observed reconciliation
  const receipt = await collectWarehouseColumnarStream(acceptedPlan, harness.streamTransport);
  checks.push({
    name: "bounded-columnar-stream",
    passed: receipt.batches.length > 0 && receipt.reconciliation.status === "within-budget",
    detail: `rows=${receipt.totals.rows},batches=${receipt.totals.batches}`,
  });

  // 5. Cancellation check (pre-aborted signal stops before reading)
  let cancelObserved = false;
  try {
    await collectWarehouseColumnarStream(acceptedPlan, harness.streamTransport, { signal: AbortSignal.abort() });
  } catch (error) {
    cancelObserved = error instanceof HonuaAbortError;
  }
  checks.push({ name: "stream-cancellation", passed: cancelObserved });

  // 6. Zero-copy deck.gl + bounded MapLibre handoff
  const firstBatch = receipt.batches[0]?.batch;
  if (!firstBatch) {
    throw new HonuaWarehouseError("corrupt-batch", "Conformance stream produced no batches.");
  }
  const deckHandoff = handoffWarehouseBatchToDeckGl(firstBatch, {
    layerId: `${harness.provider}-conformance-layer`,
    geometry: harness.deckGlGeometry,
  });
  const maplibreHandoff = handoffWarehouseBatchToMapLibre(firstBatch, acceptedPlan);
  checks.push({
    name: "renderer-handoffs",
    passed:
      deckHandoff.metrics.copiedBytes === 0 &&
      deckHandoff.metrics.geoJsonFeaturesMaterialized === 0 &&
      maplibreHandoff.geojson.features.length === firstBatch.rowCount,
  });

  return Object.freeze({
    provider: harness.provider,
    sourceId: capabilities.sourceId,
    passed: checks.every((check) => check.passed),
    supportedFormats: capabilities.formats,
    checks: Object.freeze(checks),
  });
}
