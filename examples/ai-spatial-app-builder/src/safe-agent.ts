import {
  AGENT_CONSUMPTION_KIND,
  AGENT_PLAN_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalUseConsumer,
  type AgentApprovalV1,
  type AgentDataMode,
  type AgentDryRunV1,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  type AgentExecutionContextV1,
  type AgentExecutionReceiptV1,
  type AgentOperationInputV1,
  type AgentPlanPolicyV1,
  digestAgentOperationInput,
  dryRunAgentPlan,
  issueAgentApproval,
  issueAgentExecutionReceipt,
  verifyAgentExecutionReceipt,
  verifyAgentStepAuthorization,
} from "@honua/sdk-js/agent-safety";
import { HONUA_AGENT_TOOL_NAMES } from "@honua/sdk-js/agent-tools";
import type { Query, Result, Source, SourceDescriptor } from "@honua/sdk-js/contract";
import { capabilities } from "@honua/sdk-js/contract";
import { canonicalStringify, executeQueryPlan, explainQuery, sha256, toJsonValue } from "@honua/sdk-js/query-planner";
import type { JsonValue, QueryExecutionPlanV1 } from "@honua/sdk-js/query-planner";

export type AgentEffect = "read" | "mutation" | "realtime" | "generated-app";
export type Decision = "approve" | "narrow" | "reject";
export type SafetyState =
  | "proposed"
  | "validated"
  | "approved"
  | "executing"
  | "rejected"
  | "executed"
  | "refused"
  | "cancelled";

export interface ParcelAttributes {
  readonly OBJECTID: number;
  readonly title: string;
  readonly floodZone: string;
  readonly builtYear: number;
  readonly assessedValue: number;
}

export interface AgentProposalV1 {
  readonly kind: "honua.agent-proposal";
  readonly version: "1.0";
  readonly id: string;
  readonly origin: "deterministic-fixture" | "host-model";
  readonly prompt: string;
  readonly requestedEffect: AgentEffect;
  readonly query: Readonly<Query<ParcelAttributes>>;
  readonly toolCalls: readonly { readonly name: string; readonly effect: AgentEffect; readonly reason: string }[];
}

export interface ExecutionPolicyV1 {
  readonly kind: "honua.agent-execution-policy";
  readonly version: "1.0";
  readonly id: string;
  readonly allowedEffects: readonly AgentEffect[];
  readonly allowedTools: readonly string[];
  readonly allowedFields: readonly (keyof ParcelAttributes)[];
  readonly authorizationScope: readonly string[];
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly crs: "EPSG:4326";
  readonly mutationEnabled: boolean;
  readonly realtimeEnabled: boolean;
}

export interface ValidatedAgentPlanV1 {
  readonly kind: "honua.validated-agent-plan";
  readonly version: "1.0";
  readonly proposal: AgentProposalV1;
  readonly queryPlan: QueryExecutionPlanV1;
  readonly policy: ExecutionPolicyV1;
  readonly sourceProvenance: SourceProvenanceV1;
  readonly dryRun?: AgentDryRunV1;
  readonly approvalDigest: `sha256:${string}`;
  readonly validatedAt: string;
  readonly valid: boolean;
  readonly refusals: readonly string[];
}

export interface ReviewedAgentApprovalV1 {
  readonly decision: Decision;
  readonly approvedMaxRows: number;
  readonly approvedMaxBytes: number;
  readonly actor: "fixture-reviewer";
  readonly approvalDigest: `sha256:${string}`;
  readonly grant?: AgentApprovalV1;
}

export interface HostLaneStatus {
  readonly state: "available" | "skipped";
  readonly model: "host-mediated";
  readonly liveData: "host-mediated";
  readonly reason?: string;
  readonly browserSecrets: false;
}

export interface SafeAgentSession {
  readonly state: SafetyState;
  readonly executionCount: number;
  readonly proposal: AgentProposalV1;
  readonly validatedPlan?: ValidatedAgentPlanV1;
  readonly approval?: ReviewedAgentApprovalV1;
  readonly receipt?: AgentExecutionReceiptV1;
  readonly receiptVerified: boolean;
  readonly rows: readonly ParcelAttributes[];
  validate(proposalOverride?: AgentProposalV1): ValidatedAgentPlanV1;
  decide(decision: Decision, narrowedMaxRows?: number): Promise<ReviewedAgentApprovalV1>;
  execute(options?: {
    readonly planOverride?: ValidatedAgentPlanV1;
    readonly sourceVersion?: string;
    readonly schemaVersion?: string;
    readonly authorizationScope?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<AgentExecutionReceiptV1>;
  verifyReceipt(receipt?: AgentExecutionReceiptV1): Promise<boolean>;
  dispose(): void;
}

export interface CreateSafeAgentSessionOptions {
  readonly source?: Source<ParcelAttributes>;
  /** Required with an injected source; injected sources must identify as live host data. */
  readonly sourceBinding?: SourceBindingV1;
  /** Required for live-host sources and used as the trusted authorization/receipt clock. */
  readonly executionClock?: () => string;
}

export interface SourceProvenanceV1 {
  readonly dataMode: "fixture-replay" | "live-host";
  readonly observedAt: string;
  readonly attribution: string;
  readonly citationUri: string;
}

export interface SourceBindingV1 {
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly authorizationScope: readonly string[];
  readonly provenance: SourceProvenanceV1;
}

export const FIXTURE_TIME = "2026-07-10T18:00:00.000Z";
export const SOURCE_VERSION = "parcels-snapshot-2026-07-10";
export const SCHEMA_VERSION = "parcels-schema-v5";
const STEP_ID = "query-honolulu-parcels";

export const fixtureSourceBinding: SourceBindingV1 = deepFreeze({
  sourceVersion: SOURCE_VERSION,
  schemaVersion: SCHEMA_VERSION,
  authorizationScope: ["parcels:read"],
  provenance: {
    dataMode: "fixture-replay",
    observedAt: FIXTURE_TIME,
    attribution: "City and County of Honolulu — deterministic demonstration fixture",
    citationUri: "https://demo.honua.io/FeatureServer/parcels/0",
  },
} satisfies SourceBindingV1);

export const fixturePolicy: ExecutionPolicyV1 = deepFreeze({
  kind: "honua.agent-execution-policy",
  version: "1.0",
  id: "fixture-read-only-v1",
  allowedEffects: ["read"],
  allowedTools: ["runWidgetQuery"],
  allowedFields: ["OBJECTID", "title", "floodZone", "builtYear", "assessedValue"],
  authorizationScope: ["parcels:read"],
  maxRows: 25,
  maxBytes: 128_000,
  crs: "EPSG:4326",
  mutationEnabled: false,
  realtimeEnabled: false,
} satisfies ExecutionPolicyV1);

export const fixtureDescriptor: SourceDescriptor = Object.freeze({
  id: "honolulu-parcels",
  protocol: "geoservices-feature-service",
  locator: { url: "https://demo.honua.io/FeatureServer", serviceId: "parcels", layerId: 0 },
  capabilities: capabilities(["query"]),
  schema: { primaryKey: "OBJECTID" },
  attribution: "City and County of Honolulu — deterministic demonstration fixture",
});

export const fixtureProposal: AgentProposalV1 = deepFreeze({
  kind: "honua.agent-proposal",
  version: "1.0",
  id: "proposal-pre1970-flood-risk",
  origin: "deterministic-fixture",
  prompt: "Show pre-1970 parcels in flood zones, capped at five rows.",
  requestedEffect: "read",
  query: {
    where: "builtYear < 1970",
    outFields: ["OBJECTID", "title", "floodZone", "builtYear", "assessedValue"],
    orderBy: [{ field: "OBJECTID", direction: "asc" }],
    pagination: { offset: 0, limit: 5 },
    returnGeometry: true,
    outSr: 4326,
  },
  toolCalls: [{ name: "runWidgetQuery", effect: "read", reason: "Read only the approved, bounded parcel rows." }],
} satisfies AgentProposalV1);

const fixtureRows: readonly ParcelAttributes[] = Object.freeze([
  { OBJECTID: 1001, title: "Kalihi warehouse parcel", floodZone: "AE", builtYear: 1958, assessedValue: 1_200_000 },
  { OBJECTID: 1002, title: "Iwilei apartment block", floodZone: "X", builtYear: 1964, assessedValue: 870_000 },
  { OBJECTID: 1003, title: "Downtown mixed-use lot", floodZone: "AE", builtYear: 1948, assessedValue: 1_780_000 },
  { OBJECTID: 1005, title: "Kakaako civic parcel", floodZone: "AE", builtYear: 1968, assessedValue: 990_000 },
  { OBJECTID: 1006, title: "Airport logistics parcel", floodZone: "X", builtYear: 1962, assessedValue: 1_430_000 },
]);

export function createSafeAgentSession(
  proposal: AgentProposalV1 = fixtureProposal,
  policy: ExecutionPolicyV1 = fixturePolicy,
  options: CreateSafeAgentSessionOptions = {},
): SafeAgentSession {
  let state: SafetyState = "proposed";
  let validatedPlan: ValidatedAgentPlanV1 | undefined;
  let approval: ReviewedAgentApprovalV1 | undefined;
  let receipt: AgentExecutionReceiptV1 | undefined;
  let receiptContext: AgentExecutionContextV1 | undefined;
  let receiptVerified = false;
  let rows: readonly ParcelAttributes[] = [];
  let executionCount = 0;
  let executionGeneration = 0;
  let activeExecution: AbortController | undefined;
  let approvalGeneration = 0;
  let activeApproval: AbortController | undefined;
  if (!options.source && options.sourceBinding) throw new Error("sourceBinding is only valid with an injected source.");
  if (options.source && !options.sourceBinding)
    throw new Error("Injected sources require an explicit sourceBinding with truthful provenance.");
  const boundPolicy = snapshotJsonData<ExecutionPolicyV1>(policy, "$policy");
  const sessionProposal = snapshotJsonData<AgentProposalV1>(proposal, "$proposal");
  assertProposalShape(sessionProposal);
  const sourceBinding = snapshotJsonData<SourceBindingV1>(
    options.sourceBinding ?? fixtureSourceBinding,
    "$sourceBinding",
  );
  validateSourceBinding(sourceBinding, boundPolicy, Boolean(options.source));
  if (sourceBinding.provenance.dataMode === "live-host" && !options.executionClock)
    throw new Error("live-host sources require an injected executionClock.");
  const executionClock = options.executionClock ?? (() => FIXTURE_TIME);
  const reviewTime = sourceBinding.provenance.observedAt;
  let authorityTime = reviewTime;
  const source = countReads(options.source ?? createFixtureSource(), () => {
    executionCount += 1;
  });
  const approvalCrypto = fixtureCryptoPair("approval");
  const receiptCrypto = fixtureCryptoPair("receipt");
  const useStore = fixtureApprovalUseStore(() => authorityTime);

  const invalidateExecution = (reason: string): void => {
    executionGeneration += 1;
    approvalGeneration += 1;
    activeApproval?.abort(reason);
    activeApproval = undefined;
    activeExecution?.abort(reason);
    activeExecution = undefined;
    rows = [];
    receipt = undefined;
    receiptContext = undefined;
    receiptVerified = false;
  };

  const session: SafeAgentSession = {
    get state() {
      return state;
    },
    get executionCount() {
      return executionCount;
    },
    proposal: sessionProposal,
    get validatedPlan() {
      return validatedPlan;
    },
    get approval() {
      return approval;
    },
    get receipt() {
      return receipt;
    },
    get receiptVerified() {
      return receiptVerified;
    },
    get rows() {
      return rows;
    },
    validate(proposalOverride = sessionProposal) {
      invalidateExecution("Plan validation invalidated the active execution");
      approval = undefined;
      const proposalSnapshot = snapshotJsonData<AgentProposalV1>(proposalOverride, "$proposal");
      assertProposalShape(proposalSnapshot);
      const refusals = validateProposalPolicy(proposalSnapshot, boundPolicy);
      let queryPlan: QueryExecutionPlanV1;
      try {
        queryPlan = explainQuery({
          descriptor: source.descriptor,
          query: proposalSnapshot.query,
          capabilityPolicy: "strict",
          fallback: { mode: "disabled" },
          schemaVersion: sourceBinding.schemaVersion,
          sourceVersion: sourceBinding.sourceVersion,
          authorizationScope: sourceBinding.authorizationScope,
          estimates: { rows: fixtureRows.length, bytes: 4_096, requests: 1 },
        });
      } catch (error) {
        refusals.push(error instanceof Error ? error.message : "Query planning failed.");
        queryPlan = explainQuery({
          descriptor: source.descriptor,
          query: { where: "1=0", pagination: { limit: 1 }, outSr: 4326 },
          schemaVersion: sourceBinding.schemaVersion,
          sourceVersion: sourceBinding.sourceVersion,
          authorizationScope: sourceBinding.authorizationScope,
        });
      }
      const queryPlanSnapshot = immutableSnapshot(queryPlan);
      refusals.push(...validatePlanBindings(proposalSnapshot, queryPlanSnapshot, boundPolicy));
      let dryRun: AgentDryRunV1 | undefined;
      if (refusals.length === 0) {
        try {
          const operation = operationFor(queryPlanSnapshot, boundPolicy.allowedFields.map(String));
          dryRun = dryRunAgentPlan(
            agentPlanFor(proposalSnapshot, queryPlanSnapshot, sourceBinding, boundPolicy, operation),
            agentPolicyFor(boundPolicy, sourceBinding, source.descriptor.id),
            { now: reviewTime },
          );
        } catch (error) {
          refusals.push(error instanceof Error ? error.message : "Shared agent-safety validation failed.");
        }
      }
      validatedPlan = deepFreeze({
        kind: "honua.validated-agent-plan",
        version: "1.0",
        proposal: proposalSnapshot,
        queryPlan: queryPlanSnapshot,
        policy: boundPolicy,
        sourceProvenance: sourceBinding.provenance,
        ...(dryRun ? { dryRun } : {}),
        approvalDigest: dryRun?.planDigest ?? queryPlanSnapshot.fingerprint,
        validatedAt: reviewTime,
        valid: refusals.length === 0 && dryRun !== undefined,
        refusals,
      });
      state = validatedPlan.valid ? "validated" : "refused";
      return validatedPlan;
    },
    async decide(decision, narrowedMaxRows) {
      if (decision !== "approve" && decision !== "narrow" && decision !== "reject")
        throw new Error("Decision must be approve, narrow, or reject.");
      if (!validatedPlan?.valid || !validatedPlan.dryRun || state !== "validated")
        throw new Error("Only a valid, freshly validated plan can be reviewed.");
      const proposedLimit = validatedPlan.queryPlan.ir.query.pagination?.limit ?? boundPolicy.maxRows;
      const approvedMaxRows =
        decision === "narrow" ? (narrowedMaxRows ?? Math.max(1, Math.floor(proposedLimit / 2))) : proposedLimit;
      if (!Number.isInteger(approvedMaxRows) || approvedMaxRows < 1 || approvedMaxRows > proposedLimit)
        throw new Error(`Narrowed limit must be between 1 and ${proposedLimit}.`);
      approvalGeneration += 1;
      const generation = approvalGeneration;
      activeApproval?.abort("Approval review was superseded");
      const approvalController = new AbortController();
      activeApproval = approvalController;
      if (decision === "reject") {
        approval = deepFreeze({
          decision,
          approvedMaxRows,
          approvedMaxBytes: boundPolicy.maxBytes,
          actor: "fixture-reviewer",
          approvalDigest: validatedPlan.dryRun.planDigest,
        });
        state = "rejected";
        if (activeApproval === approvalController) activeApproval = undefined;
        return approval;
      }
      const issuedAt = reviewTime;
      const expiresAt = new Date(Date.parse(issuedAt) + 60 * 60 * 1_000).toISOString();
      try {
        const grant = await issueAgentApproval(
          validatedPlan.dryRun,
          agentPolicyFor(boundPolicy, sourceBinding, source.descriptor.id),
          {
            id: `approval-${validatedPlan.proposal.id}`,
            approver: "fixture-reviewer",
            issuedAt,
            expiresAt,
            maxRows: approvedMaxRows,
            maxBytes: boundPolicy.maxBytes,
          },
          approvalCrypto.signer,
          { now: issuedAt, signal: approvalController.signal },
        );
        if (generation !== approvalGeneration || approvalController.signal.aborted || state !== "validated")
          throw abortError(approvalController.signal.reason ?? "Approval review was superseded");
        approval = deepFreeze({
          decision,
          approvedMaxRows,
          approvedMaxBytes: boundPolicy.maxBytes,
          actor: "fixture-reviewer",
          approvalDigest: grant.envelopeDigest,
          grant,
        });
        state = "approved";
        return approval;
      } finally {
        if (activeApproval === approvalController) activeApproval = undefined;
      }
    },
    async execute(options = {}) {
      const safeOptions = snapshotExecuteOptions(options);
      const rawCandidate = safeOptions.planOverride ?? validatedPlan;
      const rawApproval = approval;
      if (!rawCandidate || !rawApproval?.grant || state !== "approved")
        throw new Error("Execution requires explicit approval of a valid plan.");
      const candidate =
        rawCandidate === validatedPlan
          ? rawCandidate
          : snapshotJsonData<ValidatedAgentPlanV1>(rawCandidate, "$planOverride");
      if (!candidate.dryRun) throw new Error("Execution requires a shared agent-safety dry run.");
      if (
        !validatedPlan ||
        canonicalStringify(toJsonValue(candidate)) !== canonicalStringify(toJsonValue(validatedPlan))
      )
        throw new Error("Validated plan was tampered after review.");
      if (safeOptions.signal?.aborted) throw abortError(safeOptions.signal.reason);
      const executionAt = executionClock();
      assertExecutionTime(executionAt, candidate.sourceProvenance.observedAt);
      authorityTime = executionAt;
      const contextBinding = sharedSourceBinding(
        sourceBinding,
        {
          sourceVersion: safeOptions.sourceVersion,
          schemaVersion: safeOptions.schemaVersion,
          authorizationScope: safeOptions.authorizationScope,
        },
        source.descriptor.id,
      );
      const context = snapshotJsonData<AgentExecutionContextV1>(
        { sources: { [source.descriptor.id]: contextBinding } },
        "$executionContext",
      );
      const authorizedContextBinding = context.sources[source.descriptor.id];
      if (!authorizedContextBinding) throw new Error("Authorized source context is missing.");
      executionGeneration += 1;
      const generation = executionGeneration;
      const controller = new AbortController();
      activeExecution?.abort();
      activeExecution = controller;
      const onExternalAbort = () => controller.abort(safeOptions.signal?.reason);
      if (safeOptions.signal?.aborted) onExternalAbort();
      else safeOptions.signal?.addEventListener("abort", onExternalAbort, { once: true });
      state = "executing";
      try {
        const authorization = await verifyAgentStepAuthorization(
          candidate.dryRun,
          agentPolicyFor(boundPolicy, sourceBinding, source.descriptor.id),
          rawApproval.grant,
          approvalCrypto.verifier,
          context,
          STEP_ID,
          operationFor(candidate.queryPlan, boundPolicy.allowedFields.map(String)),
          useStore,
          { now: executionAt, signal: controller.signal },
        );
        const authorizedPlan = authorization.operation.parameters as unknown as QueryExecutionPlanV1;
        const execution = await executeQueryPlan(
          authorizedPlan,
          approvalBoundSource(source, authorization.step.limits.rows, candidate.policy.allowedFields.map(String)),
          {
            sourceVersion: authorizedContextBinding.sourceVersion,
            schemaVersion: authorizedContextBinding.schemaVersion,
            authorizationScope: authorizedContextBinding.authorizationScope,
            signal: controller.signal,
          },
        );
        if (generation !== executionGeneration || controller.signal.aborted)
          throw new Error("Execution was cancelled before its result could be committed.");
        const materializedResult = snapshotJsonData<Result<ParcelAttributes>>(execution.result, "$result");
        if (!Array.isArray(materializedResult.features)) throw new Error("Source returned an invalid feature payload.");
        const aggregateRows = materializedResult.aggregateRows ?? [];
        if (!Array.isArray(aggregateRows)) throw new Error("Source returned an invalid aggregate payload.");
        const resultBytes = byteLength(materializedResult);
        if (materializedResult.exceededTransferLimit)
          throw new Error("Source reported an incomplete transfer; partial results cannot be receipted.");
        if (aggregateRows.length > 0) throw new Error("Query-only execution refused unexpected aggregate rows.");
        if (materializedResult.features.length > authorization.step.limits.rows)
          throw new Error(
            `Source returned ${materializedResult.features.length} rows, exceeding approved maximum ${authorization.step.limits.rows}.`,
          );
        if (resultBytes > authorization.step.limits.bytes)
          throw new Error(
            `Result payload ${resultBytes} bytes exceeds approved maximum ${authorization.step.limits.bytes} bytes.`,
          );
        const candidateRows = immutableSnapshot(materializedResult.features.map((feature) => feature.attributes));
        const resultDigest = sha256(canonicalStringify(toJsonValue(materializedResult)));
        const candidateReceipt = await issueAgentExecutionReceipt(
          candidate.dryRun,
          agentPolicyFor(boundPolicy, sourceBinding, source.descriptor.id),
          rawApproval.grant,
          approvalCrypto.verifier,
          context,
          {
            id: `receipt-${candidate.queryPlan.id}`,
            stepId: STEP_ID,
            inputDigest: authorization.inputDigest,
            useDigest: authorization.useDigest,
            consumption: authorization.consumption,
            outcome: "succeeded",
            completedAt: executionAt,
            rows: candidateRows.length,
            bytes: resultBytes,
            resultDigest,
          },
          useStore,
          receiptCrypto.signer,
          { now: executionAt, signal: controller.signal },
        );
        if (generation !== executionGeneration || controller.signal.aborted)
          throw new Error("Execution was cancelled before its receipt could be committed.");
        await verifyAgentExecutionReceipt(
          candidate.dryRun,
          agentPolicyFor(boundPolicy, sourceBinding, source.descriptor.id),
          rawApproval.grant,
          approvalCrypto.verifier,
          context,
          candidateReceipt,
          useStore,
          receiptCrypto.verifier,
          { now: executionAt, signal: controller.signal },
        );
        rows = candidateRows;
        receipt = candidateReceipt;
        receiptContext = context;
        receiptVerified = true;
        state = "executed";
        return receipt;
      } catch (error) {
        if (generation === executionGeneration && state === "executing") state = "refused";
        throw error;
      } finally {
        safeOptions.signal?.removeEventListener("abort", onExternalAbort);
        if (activeExecution === controller) activeExecution = undefined;
      }
    },
    async verifyReceipt(candidate = receipt) {
      if (!candidate || !validatedPlan?.dryRun || !approval?.grant || !receiptContext) return false;
      try {
        await verifyAgentExecutionReceipt(
          validatedPlan.dryRun,
          agentPolicyFor(boundPolicy, sourceBinding, source.descriptor.id),
          approval.grant,
          approvalCrypto.verifier,
          receiptContext,
          candidate,
          useStore,
          receiptCrypto.verifier,
          { now: receipt?.completedAt ?? executionClock() },
        );
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      invalidateExecution("Safe-agent session disposed");
      state = "cancelled";
    },
  };
  return session;
}

export function describeHostLane(
  config: { readonly proposalEndpoint?: string; readonly liveDataEndpoint?: string } = {},
): HostLaneStatus {
  if (!config.proposalEndpoint || !config.liveDataEndpoint) {
    return {
      state: "skipped",
      model: "host-mediated",
      liveData: "host-mediated",
      reason: "Host proposal and live-data endpoints are not configured; deterministic fixture mode remains active.",
      browserSecrets: false,
    };
  }
  return { state: "available", model: "host-mediated", liveData: "host-mediated", browserSecrets: false };
}

export function createProposal(overrides: Partial<AgentProposalV1>): AgentProposalV1 {
  const snapshot = snapshotJsonData<Partial<AgentProposalV1>>(overrides, "$proposalOverrides");
  return snapshotJsonData<AgentProposalV1>(
    { ...fixtureProposal, ...snapshot, query: snapshot.query ?? fixtureProposal.query },
    "$proposal",
  );
}

function assertProposalShape(value: unknown): asserts value is AgentProposalV1 {
  if (value === null || typeof value !== "object") throw new Error("Agent proposal must be an object.");
  const proposal = value as Record<string, unknown>;
  if (
    proposal.kind !== "honua.agent-proposal" ||
    proposal.version !== "1.0" ||
    !isNonEmpty(proposal.id) ||
    (proposal.origin !== "deterministic-fixture" && proposal.origin !== "host-model") ||
    typeof proposal.prompt !== "string" ||
    !["read", "mutation", "realtime", "generated-app"].includes(String(proposal.requestedEffect)) ||
    proposal.query === null ||
    typeof proposal.query !== "object" ||
    !Array.isArray(proposal.toolCalls)
  )
    throw new Error("Agent proposal does not match honua.agent-proposal v1.");
  for (const call of proposal.toolCalls) {
    if (
      call === null ||
      typeof call !== "object" ||
      !isNonEmpty((call as Record<string, unknown>).name) ||
      !isNonEmpty((call as Record<string, unknown>).reason) ||
      !["read", "mutation", "realtime", "generated-app"].includes(String((call as Record<string, unknown>).effect))
    )
      throw new Error("Agent proposal toolCalls must contain typed data-only calls.");
  }
}

function agentPlanFor(
  proposal: AgentProposalV1,
  queryPlan: QueryExecutionPlanV1,
  binding: SourceBindingV1,
  policy: ExecutionPolicyV1,
  operation: AgentOperationInputV1,
) {
  const parameters = toJsonValue(queryPlan);
  return {
    kind: AGENT_PLAN_KIND,
    version: AGENT_SAFETY_VERSION,
    id: proposal.id,
    actor: "fixture-operator",
    provider: proposal.origin === "host-model" ? "host-mediated" : "fixture",
    model: proposal.origin === "host-model" ? "host-owned" : "none",
    steps: [
      {
        id: STEP_ID,
        tool: operation.tool,
        effect: "read",
        source: sharedSourceBinding(binding, {}, queryPlan.ir.source.id),
        queryPlan: { id: queryPlan.id, fingerprint: queryPlan.fingerprint },
        parametersDigest: sha256(canonicalStringify(parameters)),
        inputDigest: digestAgentOperationInput(operation),
        fields: operation.fields,
        limits: {
          rows: queryPlan.ir.query.pagination?.limit ?? policy.maxRows,
          bytes: policy.maxBytes,
        },
      },
    ],
  };
}

function operationFor(queryPlan: QueryExecutionPlanV1, allowedFields: readonly string[]): AgentOperationInputV1 {
  return {
    tool: "runWidgetQuery",
    effect: "read",
    sourceId: queryPlan.ir.source.id,
    queryPlan: { id: queryPlan.id, fingerprint: queryPlan.fingerprint },
    fields: fieldsForQuery(queryPlan.ir.query, allowedFields),
    parameters: toJsonValue(queryPlan),
  };
}

function fieldsForQuery(query: QueryExecutionPlanV1["ir"]["query"], allowedFields: readonly string[]): string[] {
  const fields = new Set(query.outFields ?? []);
  for (const order of query.orderBy ?? []) fields.add(order.field);
  if (query.where) {
    for (const match of query.where.expression.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const value = match[0];
      if (allowedFields.includes(value)) fields.add(value);
    }
  }
  return [...fields].sort();
}

function agentPolicyFor(policy: ExecutionPolicyV1, binding: SourceBindingV1, sourceId: string): AgentPlanPolicyV1 {
  const citation = new URL(binding.provenance.citationUri);
  return {
    allowedTools: [...policy.allowedTools],
    allowedEffects: ["read"],
    sources: {
      [sourceId]: {
        fields: policy.allowedFields.map(String),
        authorizationScope: [...policy.authorizationScope],
        schemaVersions: [binding.schemaVersion],
        sourceVersions: [binding.sourceVersion],
        dataModes: [sharedDataMode(binding.provenance.dataMode)],
        citationOrigins: [citation.origin],
        citationResourcePrefixes: [citation.pathname],
      },
    },
    maxSteps: 1,
    maxRows: policy.maxRows,
    maxBytes: policy.maxBytes,
    maxFieldsPerStep: policy.allowedFields.length,
    maxAuthorizationScopesPerSource: policy.authorizationScope.length,
    maxCitationsPerSource: 1,
    maxOperationParameterBytes: 32_768,
    maxOperationParameterNodes: 512,
    maxOperationParameterDepth: 16,
  };
}

function sharedSourceBinding(
  binding: SourceBindingV1,
  overrides: {
    readonly sourceVersion?: string;
    readonly schemaVersion?: string;
    readonly authorizationScope?: readonly string[];
  } = {},
  sourceId = fixtureDescriptor.id,
) {
  return {
    id: sourceId,
    schemaVersion: overrides.schemaVersion ?? binding.schemaVersion,
    sourceVersion: overrides.sourceVersion ?? binding.sourceVersion,
    authorizationScope: overrides.authorizationScope ?? binding.authorizationScope,
    provenance: {
      dataMode: sharedDataMode(binding.provenance.dataMode),
      observedAt: binding.provenance.observedAt,
      attribution: binding.provenance.attribution,
      citations: [{ uri: binding.provenance.citationUri }],
    },
  };
}

function sharedDataMode(mode: SourceProvenanceV1["dataMode"]): AgentDataMode {
  return mode === "fixture-replay" ? "replayed" : "live";
}

function fixtureCryptoPair(label: string): { signer: AgentEnvelopeSigner; verifier: AgentEnvelopeVerifier } {
  const key = fixtureHmacKey();
  const signature = async (payload: string) => hmac(key, `${label}:${payload}`);
  return {
    signer: {
      algorithm: "HMAC-SHA256",
      keyId: `${label}-ephemeral-session-key`,
      async sign(payload) {
        return await signature(payload);
      },
    },
    verifier: {
      algorithm: "HMAC-SHA256",
      keyId: `${label}-ephemeral-session-key`,
      async verify(payload, candidate) {
        return candidate === (await signature(payload));
      },
    },
  };
}

function fixtureApprovalUseStore(now: () => string): AgentApprovalUseConsumer {
  const key = fixtureHmacKey();
  const consumed = new Set<string>();
  const tokenFor = async (record: {
    approvalDigest: string;
    stepId: string;
    inputDigest: string;
    nonce: string;
    consumedAt: string;
  }) =>
    hmac(key, `${record.approvalDigest}:${record.stepId}:${record.inputDigest}:${record.nonce}:${record.consumedAt}`);
  return {
    async consume(use) {
      const key = `${use.approvalDigest}:${use.stepId}`;
      if (consumed.has(key)) return undefined;
      consumed.add(key);
      const record = {
        kind: AGENT_CONSUMPTION_KIND,
        version: AGENT_SAFETY_VERSION,
        id: `use-${consumed.size}`,
        nonce: randomHex(16),
        consumedAt: now(),
        ...use,
      };
      return { ...record, token: await tokenFor(record) };
    },
    async verify(input) {
      if (input === null || typeof input !== "object") return false;
      const record = input as Record<string, unknown>;
      if (
        typeof record.approvalDigest !== "string" ||
        typeof record.stepId !== "string" ||
        typeof record.inputDigest !== "string" ||
        typeof record.nonce !== "string" ||
        typeof record.consumedAt !== "string" ||
        typeof record.token !== "string"
      )
        return false;
      return record.token === (await tokenFor(record as Parameters<typeof tokenFor>[0]));
    },
  };
}

function fixtureHmacKey(): Promise<CryptoKey> {
  const secret = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secret);
  return globalThis.crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function hmac(key: Promise<CryptoKey>, value: string): Promise<string> {
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign("HMAC", await key, new TextEncoder().encode(value)),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function validateProposalPolicy(proposal: AgentProposalV1, policy: ExecutionPolicyV1): string[] {
  const refusals: string[] = [];
  if (proposal.query.aggregation)
    refusals.push("This safe-agent sample permits query-only plans; aggregation is refused.");
  if (!policy.allowedEffects.includes(proposal.requestedEffect))
    refusals.push(`Effect '${proposal.requestedEffect}' is not allowed by host policy.`);
  if (proposal.requestedEffect === "mutation" && !policy.mutationEnabled)
    refusals.push("Mutation requires a separate host capability and approval; it is disabled.");
  if (proposal.requestedEffect === "realtime" && !policy.realtimeEnabled)
    refusals.push("Realtime subscription requires separate host authorization; it is disabled.");
  const limit = proposal.query.pagination?.limit;
  if (limit === undefined || limit > policy.maxRows)
    refusals.push(`Requested row limit exceeds host maximum ${policy.maxRows}.`);
  if (proposal.query.outSr !== 4326 && proposal.query.outSr !== "EPSG:4326")
    refusals.push("Requested CRS does not match policy-bound EPSG:4326.");
  refusals.push(...validateQueryFields(proposal.query, policy.allowedFields.map(String), proposal.origin));
  for (const tool of proposal.toolCalls) {
    if (!HONUA_AGENT_TOOL_NAMES.includes(tool.name as (typeof HONUA_AGENT_TOOL_NAMES)[number]))
      refusals.push(`Tool '${tool.name}' is not a typed @honua/sdk-js/agent-tools operation.`);
    if (!policy.allowedTools.includes(tool.name)) refusals.push(`Tool '${tool.name}' is not in the host allowlist.`);
    if (!policy.allowedEffects.includes(tool.effect))
      refusals.push(`Tool '${tool.name}' requests unsupported '${tool.effect}' capability.`);
  }
  return refusals;
}

function validatePlanBindings(
  proposal: AgentProposalV1,
  queryPlan: QueryExecutionPlanV1,
  policy: ExecutionPolicyV1,
): string[] {
  const refusals = validateCanonicalQueryFields(queryPlan.ir.query, policy.allowedFields.map(String), proposal.origin);
  if (proposal.requestedEffect !== "read")
    refusals.push(`Proposal effect '${proposal.requestedEffect}' does not match the planned 'read' effect.`);
  if (
    queryPlan.steps.length !== 1 ||
    queryPlan.steps[0]?.engine !== "remote" ||
    queryPlan.steps[0].operation !== "query"
  )
    refusals.push("This safe-agent sample permits exactly one remote query operation.");
  if (queryPlan.estimates.bytes !== undefined && queryPlan.estimates.bytes > policy.maxBytes)
    refusals.push(`Estimated payload exceeds the policy-bound ${policy.maxBytes}-byte ceiling.`);
  const plannedTools = queryPlan.steps
    .filter((step) => step.engine === "remote")
    .map((step) => (step.operation === "query" ? "runWidgetQuery" : step.operation));
  if (
    proposal.toolCalls.length !== plannedTools.length ||
    plannedTools.some((name, index) => {
      const declared = proposal.toolCalls[index];
      return declared?.name !== name || declared.effect !== "read";
    })
  )
    refusals.push(
      `Declared tool/effect sequence must exactly match planned read operations: ${plannedTools.join(" → ")}.`,
    );
  return refusals;
}

function validateQueryFields(
  query: Readonly<Query<ParcelAttributes>>,
  allowedFields: readonly string[],
  origin: AgentProposalV1["origin"],
): string[] {
  const refusals: string[] = [];
  if (!query.outFields || query.outFields.some((field) => !allowedFields.includes(String(field))))
    refusals.push("Requested outFields exceed the policy-bound parcel field allowlist.");
  if (query.orderBy?.some((sort) => !allowedFields.includes(String(sort.field))))
    refusals.push("Requested orderBy fields exceed the policy-bound parcel field allowlist.");
  if (query.where) refusals.push(...validateWhere(query.where, allowedFields, origin));
  return refusals;
}

function validateCanonicalQueryFields(
  query: QueryExecutionPlanV1["ir"]["query"],
  allowedFields: readonly string[],
  origin: AgentProposalV1["origin"],
): string[] {
  const refusals: string[] = [];
  if (!query.outFields || query.outFields.some((field) => !allowedFields.includes(field)))
    refusals.push("Planned outFields exceed the approved field boundary.");
  if (query.orderBy?.some((sort) => !allowedFields.includes(sort.field)))
    refusals.push("Planned orderBy fields exceed the approved field boundary.");
  if (query.where) refusals.push(...validateWhere(query.where.expression, allowedFields, origin));
  return refusals;
}

function validateWhere(
  expression: string,
  allowedFields: readonly string[],
  origin: AgentProposalV1["origin"],
): string[] {
  type Token = { readonly kind: "word" | "literal" | "operator" | "(" | ")"; readonly value: string };
  const matcher = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|('(?:''|[^'])*')|(<=|>=|<>|!=|=|<|>)|(\()|(\)))/gy;
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < expression.length) {
    if (expression.slice(cursor).trim() === "") break;
    matcher.lastIndex = cursor;
    const match = matcher.exec(expression);
    if (!match || match.index !== cursor)
      return [`${origin} where expression is not in the trusted predicate grammar.`];
    cursor = matcher.lastIndex;
    if (match[1]) tokens.push({ kind: "word", value: match[1] });
    else if (match[2] || match[3]) tokens.push({ kind: "literal", value: match[2] ?? match[3] });
    else if (match[4]) tokens.push({ kind: "operator", value: match[4] });
    else if (match[5]) tokens.push({ kind: "(", value: match[5] });
    else if (match[6]) tokens.push({ kind: ")", value: match[6] });
  }
  let index = 0;
  const consumeWord = (value: string): boolean => {
    if (tokens[index]?.kind !== "word" || tokens[index]?.value.toUpperCase() !== value) return false;
    index += 1;
    return true;
  };
  const parsePredicate = (): boolean => {
    const field = tokens[index];
    if (field?.kind !== "word" || !allowedFields.includes(field.value)) return false;
    index += 1;
    if (consumeWord("IS")) {
      consumeWord("NOT");
      return consumeWord("NULL");
    }
    if (tokens[index]?.kind !== "operator") return false;
    index += 1;
    if (tokens[index]?.kind !== "literal") return false;
    index += 1;
    return true;
  };
  const parseFactor = (): boolean => {
    if (consumeWord("NOT")) return parseFactor();
    if (tokens[index]?.kind === "(") {
      index += 1;
      if (!parseOr() || tokens[index]?.kind !== ")") return false;
      index += 1;
      return true;
    }
    return parsePredicate();
  };
  const parseAnd = (): boolean => {
    if (!parseFactor()) return false;
    while (consumeWord("AND")) if (!parseFactor()) return false;
    return true;
  };
  function parseOr(): boolean {
    if (!parseAnd()) return false;
    while (consumeWord("OR")) if (!parseAnd()) return false;
    return true;
  }
  if (tokens.length === 0 || !parseOr() || index !== tokens.length)
    return [`${origin} where expression is not in the trusted predicate grammar or references an unapproved field.`];
  return [];
}

function createFixtureSource(): Source<ParcelAttributes> {
  const query = async (request: Query<ParcelAttributes> = {}): Promise<Result<ParcelAttributes>> => {
    const limit = request.pagination?.limit ?? fixtureRows.length;
    return {
      features: fixtureRows.slice(0, limit).map((attributes) => ({ id: attributes.OBJECTID, attributes })),
      exceededTransferLimit: false,
      totalCount: fixtureRows.length,
    };
  };
  return {
    descriptor: fixtureDescriptor,
    capabilities: fixtureDescriptor.capabilities,
    query,
    queryAll: query,
    queryAggregate: async () => ({ features: [], exceededTransferLimit: false, aggregateRows: [] }),
  } as unknown as Source<ParcelAttributes>;
}

function countReads(source: Source<ParcelAttributes>, onRead: () => void): Source<ParcelAttributes> {
  return {
    ...source,
    query: async (request) => {
      onRead();
      return await source.query(request);
    },
    queryAll: async (request) => {
      onRead();
      return await source.queryAll(request);
    },
    queryAggregate: async (request) => {
      onRead();
      return await source.queryAggregate(request);
    },
  };
}

function approvalBoundSource(
  source: Source<ParcelAttributes>,
  approvedMaxRows: number,
  allowedFields: readonly string[],
): Source<ParcelAttributes> {
  const boundedQuery = (request: Query<ParcelAttributes> = {}): Query<ParcelAttributes> => {
    const refusals = validateQueryFields(request, allowedFields, "host-model");
    if (refusals.length > 0) throw new Error(`Final source request refused: ${refusals.join(" ")}`);
    return {
      ...request,
      pagination: {
        ...request.pagination,
        limit: Math.min(request.pagination?.limit ?? approvedMaxRows, approvedMaxRows),
      },
    };
  };
  return {
    ...source,
    query: (request) => source.query(boundedQuery(request)),
    queryAll: (request) => source.queryAll(boundedQuery(request)),
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(canonicalStringify(toJsonValue(value))).byteLength;
}

function abortError(reason: unknown): Error {
  return new DOMException(
    typeof reason === "string" ? reason : "Execution was aborted before it started.",
    "AbortError",
  );
}

function validateSourceBinding(binding: SourceBindingV1, policy: ExecutionPolicyV1, injectedSource: boolean): void {
  if (!isNonEmpty(binding.sourceVersion) || !isNonEmpty(binding.schemaVersion))
    throw new Error("Source bindings require non-empty sourceVersion and schemaVersion fields.");
  if (
    !Array.isArray(binding.authorizationScope) ||
    binding.authorizationScope.length === 0 ||
    binding.authorizationScope.some((scope) => !isNonEmpty(scope) || !policy.authorizationScope.includes(scope))
  )
    throw new Error("Source binding authorizationScope must be a non-empty subset of host policy.");
  if (!isNonEmpty(binding.provenance.attribution) || !isValidTimestamp(binding.provenance.observedAt))
    throw new Error("Source binding provenance requires non-empty attribution and a valid observedAt timestamp.");
  try {
    const citation = new URL(binding.provenance.citationUri);
    if (citation.protocol !== "https:" || citation.username || citation.password || citation.search || citation.hash)
      throw new Error("unsafe");
  } catch {
    throw new Error("Source binding provenance requires a credential-free HTTPS citationUri.");
  }
  if (injectedSource && binding.provenance.dataMode !== "live-host")
    throw new Error(
      "Injected sources require live-host provenance; fixture-replay is reserved for the committed source.",
    );
  if (
    !injectedSource &&
    (binding.provenance.dataMode !== "fixture-replay" ||
      binding.sourceVersion !== SOURCE_VERSION ||
      binding.schemaVersion !== SCHEMA_VERSION)
  )
    throw new Error("Only the default fixture binding may be used without an injected source.");
}

function assertExecutionTime(executedAt: string, observedAt: string): void {
  if (!isValidTimestamp(executedAt)) throw new Error("Execution clock returned an invalid timestamp.");
  if (Date.parse(executedAt) < Date.parse(observedAt))
    throw new Error("Execution time cannot pre-date source observation.");
}

function isValidTimestamp(value: unknown): value is string {
  if (!isNonEmpty(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function snapshotExecuteOptions(input: unknown): {
  readonly planOverride?: ValidatedAgentPlanV1;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
  readonly authorizationScope?: readonly string[];
  readonly signal?: AbortSignal;
} {
  if (input === null || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype)
    throw new Error("$executeOptions must be a plain data object.");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const allowed = new Set(["planOverride", "sourceVersion", "schemaVersion", "authorizationScope", "signal"]);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(key)) throw new Error(`$executeOptions.${key} is not supported.`);
    if (descriptor.get || descriptor.set || !descriptor.enumerable)
      throw new Error(`$executeOptions.${key} must be enumerable data-only input.`);
  }
  const value = (key: string): unknown => descriptors[key]?.value;
  const sourceVersion = value("sourceVersion");
  const schemaVersion = value("schemaVersion");
  const authorizationScope = value("authorizationScope");
  const signal = value("signal");
  if (sourceVersion !== undefined && typeof sourceVersion !== "string")
    throw new Error("$executeOptions.sourceVersion must be a string.");
  if (schemaVersion !== undefined && typeof schemaVersion !== "string")
    throw new Error("$executeOptions.schemaVersion must be a string.");
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new Error("$executeOptions.signal must be an AbortSignal.");
  return {
    ...(value("planOverride") === undefined ? {} : { planOverride: value("planOverride") as ValidatedAgentPlanV1 }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(authorizationScope === undefined
      ? {}
      : { authorizationScope: snapshotJsonData<readonly string[]>(authorizationScope, "$authorizationScope") }),
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Snapshot JSON-parsed proposal data without invoking property accessors. Proxies remain an unsupported JS boundary. */
function snapshotJsonData<T>(input: unknown, root: string): T {
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  const visit = (value: unknown, path: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > 8_192 || depth > 32) throw new Error(`${root} exceeds the bounded JSON proposal budget.`);
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${path} must be a finite JSON number.`);
      return value;
    }
    if (typeof value === "string") {
      bytes += encoder.encode(value).byteLength;
      if (bytes > 1_048_576) throw new Error(`${root} exceeds the bounded JSON proposal byte budget.`);
      return value;
    }
    if (typeof value !== "object") throw new Error(`${path} must contain JSON-compatible data.`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype)
      throw new Error(`${path} must be a plain JSON object or array.`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > (Array.isArray(value) ? 1_024 : 128)) throw new Error(`${path} has too many entries.`);
    if (Array.isArray(value)) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 1_024) throw new Error(`${path} has invalid length.`);
      const output: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set) throw new Error(`${path}[${index}] must be data-only.`);
        output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
      }
      return output;
    }
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable)
        throw new Error(`${path}.${key} must be enumerable data-only JSON.`);
      bytes += encoder.encode(key).byteLength;
      if (bytes > 1_048_576) throw new Error(`${root} exceeds the bounded JSON proposal byte budget.`);
      output[key] = visit(descriptor.value, `${path}.${key}`, depth + 1);
    }
    return output;
  };
  return deepFreeze(visit(input, root, 0) as T);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  return Object.freeze(value);
}
