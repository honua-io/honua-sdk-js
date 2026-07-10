import type { Query, Result, Source, SourceDescriptor } from "@honua/sdk-js/contract";
import { capabilities } from "@honua/sdk-js/contract";
import { canonicalStringify, executeQueryPlan, explainQuery, sha256, toJsonValue } from "@honua/sdk-js/query-planner";
import type { QueryExecutionPlanV1 } from "@honua/sdk-js/query-planner";

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
  readonly approvalDigest: `sha256:${string}`;
  readonly validatedAt: string;
  readonly valid: boolean;
  readonly refusals: readonly string[];
}

export interface AgentApprovalV1 {
  readonly kind: "honua.agent-approval";
  readonly version: "1.0";
  readonly decision: Decision;
  readonly planDigest: `sha256:${string}`;
  readonly approvedMaxRows: number;
  readonly approvedMaxBytes: number;
  readonly actor: "fixture-reviewer";
  readonly approvedAt: string;
  readonly approvalDigest: `sha256:${string}`;
}

export interface AgentExecutionReceiptV1 {
  readonly kind: "honua.agent-execution-receipt";
  readonly version: "1.0";
  readonly id: string;
  readonly planDigest: `sha256:${string}`;
  readonly approvalDigest: `sha256:${string}`;
  readonly resultDigest: `sha256:${string}`;
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly authorizationScope: readonly string[];
  readonly effect: "read";
  readonly dataMode: SourceProvenanceV1["dataMode"];
  readonly observedAt: string;
  readonly attribution: string;
  readonly approvedMaxRows: number;
  readonly approvedMaxBytes: number;
  readonly resultBytes: number;
  readonly rowCount: number;
  readonly executedAt: string;
  readonly previousReceiptDigest: null;
  readonly receiptDigest: `sha256:${string}`;
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
  readonly approval?: AgentApprovalV1;
  readonly receipt?: AgentExecutionReceiptV1;
  readonly rows: readonly ParcelAttributes[];
  validate(proposalOverride?: AgentProposalV1): ValidatedAgentPlanV1;
  decide(decision: Decision, narrowedMaxRows?: number): AgentApprovalV1;
  execute(options?: {
    readonly planOverride?: ValidatedAgentPlanV1;
    readonly sourceVersion?: string;
    readonly schemaVersion?: string;
    readonly authorizationScope?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<AgentExecutionReceiptV1>;
  verifyReceipt(receipt?: AgentExecutionReceiptV1): boolean;
  dispose(): void;
}

export interface CreateSafeAgentSessionOptions {
  readonly source?: Source<ParcelAttributes>;
  /** Required with an injected source so receipts never mislabel arbitrary data as fixture output. */
  readonly sourceBinding?: SourceBindingV1;
  /** Required for live-host sources; evaluated after materialization succeeds. */
  readonly executionClock?: () => string;
}

export interface SourceProvenanceV1 {
  readonly dataMode: "fixture-replay" | "live-host";
  readonly observedAt: string;
  readonly attribution: string;
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

export const fixtureSourceBinding: SourceBindingV1 = deepFreeze({
  sourceVersion: SOURCE_VERSION,
  schemaVersion: SCHEMA_VERSION,
  authorizationScope: ["parcels:read"],
  provenance: {
    dataMode: "fixture-replay",
    observedAt: FIXTURE_TIME,
    attribution: "City and County of Honolulu — deterministic demonstration fixture",
  },
} satisfies SourceBindingV1);

export const fixturePolicy: ExecutionPolicyV1 = deepFreeze({
  kind: "honua.agent-execution-policy",
  version: "1.0",
  id: "fixture-read-only-v1",
  allowedEffects: ["read"],
  allowedTools: ["query"],
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
  toolCalls: [{ name: "query", effect: "read", reason: "Read only the approved, bounded parcel rows." }],
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
  let approval: AgentApprovalV1 | undefined;
  let receipt: AgentExecutionReceiptV1 | undefined;
  let rows: readonly ParcelAttributes[] = [];
  let executionCount = 0;
  let executionGeneration = 0;
  let activeExecution: AbortController | undefined;
  if (!options.source && options.sourceBinding) {
    throw new Error("sourceBinding is only valid with an explicitly injected source.");
  }
  if (options.source && !options.sourceBinding) {
    throw new Error("Injected sources require an explicit sourceBinding with truthful provenance.");
  }
  const boundPolicy = immutableSnapshot(policy);
  const sessionProposal = immutableSnapshot(proposal);
  const sourceBinding = immutableSnapshot(options.sourceBinding ?? fixtureSourceBinding);
  validateSourceBinding(sourceBinding, boundPolicy, Boolean(options.source));
  if (sourceBinding.provenance.dataMode === "live-host" && !options.executionClock) {
    throw new Error("live-host sources require an injected executionClock.");
  }
  const executionClock = options.executionClock ?? (() => FIXTURE_TIME);
  const source = countReads(options.source ?? createFixtureSource(), () => {
    executionCount += 1;
  });

  const invalidateExecution = (reason: string): void => {
    executionGeneration += 1;
    activeExecution?.abort(reason);
    activeExecution = undefined;
    rows = [];
    receipt = undefined;
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
    get rows() {
      return rows;
    },
    validate(proposalOverride = sessionProposal) {
      invalidateExecution("Plan validation invalidated the active execution");
      approval = undefined;
      const proposalSnapshot = immutableSnapshot(proposalOverride);
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
      const unsigned = immutableSnapshot({
        kind: "honua.validated-agent-plan" as const,
        version: "1.0" as const,
        proposal: proposalSnapshot,
        queryPlan: queryPlanSnapshot,
        policy: boundPolicy,
        sourceProvenance: sourceBinding.provenance,
        validatedAt: FIXTURE_TIME,
        valid: refusals.length === 0,
        refusals,
      });
      validatedPlan = deepFreeze({ ...unsigned, approvalDigest: digest(unsigned) });
      state = validatedPlan.valid ? "validated" : "refused";
      return validatedPlan;
    },
    decide(decision, narrowedMaxRows) {
      if (!validatedPlan?.valid || state !== "validated")
        throw new Error("Only a valid, freshly validated plan can be reviewed.");
      const proposedLimit = validatedPlan.queryPlan.ir.query.pagination?.limit ?? boundPolicy.maxRows;
      const approvedMaxRows =
        decision === "narrow" ? (narrowedMaxRows ?? Math.max(1, Math.floor(proposedLimit / 2))) : proposedLimit;
      if (!Number.isInteger(approvedMaxRows) || approvedMaxRows < 1 || approvedMaxRows > proposedLimit) {
        throw new Error(`Narrowed limit must be between 1 and ${proposedLimit}.`);
      }
      const unsigned = {
        kind: "honua.agent-approval" as const,
        version: "1.0" as const,
        decision,
        planDigest: validatedPlan.approvalDigest,
        approvedMaxRows,
        approvedMaxBytes: validatedPlan.policy.maxBytes,
        actor: "fixture-reviewer" as const,
        approvedAt: FIXTURE_TIME,
      };
      approval = deepFreeze({ ...unsigned, approvalDigest: digest(unsigned) });
      state = decision === "reject" ? "rejected" : "approved";
      return approval;
    },
    async execute(options = {}) {
      const rawCandidate = options.planOverride ?? validatedPlan;
      const rawApproval = approval;
      if (!rawCandidate || !rawApproval || state !== "approved")
        throw new Error("Execution requires explicit approval of a valid plan.");
      const candidate = immutableSnapshot(rawCandidate);
      const candidateApproval = immutableSnapshot(rawApproval);
      if (digest(withoutApprovalDigest(candidate)) !== candidate.approvalDigest)
        throw new Error("Validated plan was tampered after review.");
      if (
        candidateApproval.planDigest !== candidate.approvalDigest ||
        digest(withoutApprovalSignature(candidateApproval)) !== candidateApproval.approvalDigest
      ) {
        throw new Error("Approval does not match the reviewed plan.");
      }
      if (candidateApproval.decision === "reject") throw new Error("Rejected plans cannot execute.");
      if (options.signal?.aborted) throw abortError(options.signal.reason);
      const context = immutableSnapshot({
        sourceVersion: options.sourceVersion ?? sourceBinding.sourceVersion,
        schemaVersion: options.schemaVersion ?? sourceBinding.schemaVersion,
        authorizationScope: options.authorizationScope ?? sourceBinding.authorizationScope,
      });
      executionGeneration += 1;
      const generation = executionGeneration;
      const controller = new AbortController();
      activeExecution?.abort();
      activeExecution = controller;
      const onExternalAbort = () => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) onExternalAbort();
      else options.signal?.addEventListener("abort", onExternalAbort, { once: true });
      state = "executing";
      try {
        const execution = await executeQueryPlan(
          candidate.queryPlan,
          approvalBoundSource(
            source,
            candidateApproval.approvedMaxRows,
            candidate.policy.allowedFields.map(String),
            candidate.proposal.origin,
          ),
          { ...context, signal: controller.signal },
        );
        if (generation !== executionGeneration || controller.signal.aborted) {
          throw new Error("Execution was cancelled before its result could be committed.");
        }
        const materializedResult = immutableSnapshot(execution.result);
        if (!Array.isArray(materializedResult.features)) throw new Error("Source returned an invalid feature payload.");
        const aggregateRows = materializedResult.aggregateRows ?? [];
        if (!Array.isArray(aggregateRows)) throw new Error("Source returned an invalid aggregate payload.");
        const resultBytes = byteLength(materializedResult);
        if (materializedResult.exceededTransferLimit) {
          throw new Error("Source reported an incomplete transfer; partial results cannot be receipted.");
        }
        if (aggregateRows.length > 0) {
          throw new Error("Query-only execution refused unexpected aggregate rows.");
        }
        if (materializedResult.features.length > candidateApproval.approvedMaxRows) {
          throw new Error(
            `Source returned ${materializedResult.features.length} rows, exceeding approved maximum ${candidateApproval.approvedMaxRows}.`,
          );
        }
        if (resultBytes > candidateApproval.approvedMaxBytes) {
          throw new Error(
            `Result payload ${resultBytes} bytes exceeds approved maximum ${candidateApproval.approvedMaxBytes} bytes.`,
          );
        }
        if (generation !== executionGeneration || controller.signal.aborted) {
          throw new Error("Execution was cancelled before its result could be committed.");
        }
        const candidateRows = immutableSnapshot(materializedResult.features.map((feature) => feature.attributes));
        const executedAt = executionClock();
        assertExecutionTime(executedAt, candidate.sourceProvenance.observedAt);
        const unsignedReceipt = {
          kind: "honua.agent-execution-receipt" as const,
          version: "1.0" as const,
          id: `receipt-${candidate.queryPlan.id}`,
          planDigest: candidate.approvalDigest,
          approvalDigest: candidateApproval.approvalDigest,
          resultDigest: digest(candidateRows),
          sourceId: candidate.queryPlan.ir.source.id,
          sourceVersion: context.sourceVersion,
          schemaVersion: context.schemaVersion,
          authorizationScope: context.authorizationScope,
          effect: "read" as const,
          dataMode: candidate.sourceProvenance.dataMode,
          observedAt: candidate.sourceProvenance.observedAt,
          attribution: candidate.sourceProvenance.attribution,
          approvedMaxRows: candidateApproval.approvedMaxRows,
          approvedMaxBytes: candidateApproval.approvedMaxBytes,
          resultBytes,
          rowCount: candidateRows.length,
          executedAt,
          previousReceiptDigest: null,
        };
        const candidateReceipt = deepFreeze({ ...unsignedReceipt, receiptDigest: digest(unsignedReceipt) });
        rows = candidateRows;
        receipt = candidateReceipt;
        state = "executed";
        return receipt;
      } catch (error) {
        if (generation === executionGeneration && state === "executing") state = "approved";
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", onExternalAbort);
        if (activeExecution === controller) activeExecution = undefined;
      }
    },
    verifyReceipt(candidate = receipt) {
      return Boolean(candidate && digest(withoutReceiptDigest(candidate)) === candidate.receiptDigest);
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
  return { ...fixtureProposal, ...overrides, query: overrides.query ?? fixtureProposal.query };
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
  if (proposal.requestedEffect !== "read") {
    refusals.push(`Proposal effect '${proposal.requestedEffect}' does not match the planned 'read' effect.`);
  }
  if (
    queryPlan.steps.length !== 1 ||
    queryPlan.steps[0]?.engine !== "remote" ||
    queryPlan.steps[0].operation !== "query"
  ) {
    refusals.push("This safe-agent sample permits exactly one remote query operation.");
  }
  if (queryPlan.estimates.bytes !== undefined && queryPlan.estimates.bytes > policy.maxBytes) {
    refusals.push(`Estimated payload exceeds the policy-bound ${policy.maxBytes}-byte ceiling.`);
  }
  const plannedTools = queryPlan.steps.filter((step) => step.engine === "remote").map((step) => step.operation);
  if (
    proposal.toolCalls.length !== plannedTools.length ||
    plannedTools.some((name, index) => {
      const declared = proposal.toolCalls[index];
      return declared?.name !== name || declared.effect !== "read";
    })
  ) {
    refusals.push(
      `Declared tool/effect sequence must exactly match planned read operations: ${plannedTools.join(" → ")}.`,
    );
  }
  return refusals;
}

function validateQueryFields(
  query: Readonly<Query<ParcelAttributes>>,
  allowedFields: readonly string[],
  origin: AgentProposalV1["origin"],
): string[] {
  const refusals: string[] = [];
  if (!query.outFields || query.outFields.some((field) => !allowedFields.includes(String(field)))) {
    refusals.push("Requested outFields exceed the policy-bound parcel field allowlist.");
  }
  if (query.orderBy?.some((sort) => !allowedFields.includes(String(sort.field)))) {
    refusals.push("Requested orderBy fields exceed the policy-bound parcel field allowlist.");
  }
  if (query.where) refusals.push(...validateWhere(query.where, allowedFields, origin));
  return refusals;
}

function validateCanonicalQueryFields(
  query: QueryExecutionPlanV1["ir"]["query"],
  allowedFields: readonly string[],
  origin: AgentProposalV1["origin"],
): string[] {
  const refusals: string[] = [];
  if (!query.outFields || query.outFields.some((field) => !allowedFields.includes(field))) {
    refusals.push("Planned outFields exceed the approved field boundary.");
  }
  if (query.orderBy?.some((sort) => !allowedFields.includes(sort.field))) {
    refusals.push("Planned orderBy fields exceed the approved field boundary.");
  }
  if (query.where) refusals.push(...validateWhere(query.where.expression, allowedFields, origin));
  return refusals;
}

/**
 * Accept only a deliberately small SQL predicate grammar. This rejects comments,
 * functions, statement separators, and unconsumed tokens before a source-native
 * expression can cross the host boundary.
 */
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
    if (!match || match.index !== cursor) {
      return [`${origin} where expression is not in the trusted predicate grammar.`];
    }
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
  if (tokens.length === 0 || !parseOr() || index !== tokens.length) {
    return [`${origin} where expression is not in the trusted predicate grammar or references an unapproved field.`];
  }
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
  origin: AgentProposalV1["origin"],
): Source<ParcelAttributes> {
  const boundedQuery = (request: Query<ParcelAttributes> = {}): Query<ParcelAttributes> => {
    const refusals = validateQueryFields(request, allowedFields, origin);
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
  const message = typeof reason === "string" ? reason : "Execution was aborted before it started.";
  return new DOMException(message, "AbortError");
}

function validateSourceBinding(binding: SourceBindingV1, policy: ExecutionPolicyV1, injectedSource: boolean): void {
  if (!isNonEmpty(binding.sourceVersion) || !isNonEmpty(binding.schemaVersion)) {
    throw new Error("Source bindings require non-empty sourceVersion and schemaVersion fields.");
  }
  if (
    !Array.isArray(binding.authorizationScope) ||
    binding.authorizationScope.length === 0 ||
    binding.authorizationScope.some((scope) => !isNonEmpty(scope) || !policy.authorizationScope.includes(scope))
  ) {
    throw new Error("Source binding authorizationScope must be a non-empty subset of host policy.");
  }
  if (binding.provenance.dataMode !== "fixture-replay" && binding.provenance.dataMode !== "live-host") {
    throw new Error("Source binding dataMode must be fixture-replay or live-host.");
  }
  if (!isNonEmpty(binding.provenance.attribution) || !isValidTimestamp(binding.provenance.observedAt)) {
    throw new Error("Source binding provenance requires non-empty attribution and a valid observedAt timestamp.");
  }
  if (
    !injectedSource &&
    (binding.provenance.dataMode !== "fixture-replay" ||
      binding.sourceVersion !== SOURCE_VERSION ||
      binding.schemaVersion !== SCHEMA_VERSION)
  ) {
    throw new Error("Only the default fixture binding may be used without an injected source.");
  }
}

function assertExecutionTime(executedAt: string, observedAt: string): void {
  if (!isValidTimestamp(executedAt)) throw new Error("Execution clock returned an invalid timestamp.");
  if (Date.parse(executedAt) < Date.parse(observedAt)) {
    throw new Error("Execution time cannot pre-date the source observation time.");
  }
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

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

function digest(value: unknown): `sha256:${string}` {
  return sha256(canonicalStringify(toJsonValue(value)));
}

function withoutApprovalDigest(plan: ValidatedAgentPlanV1): Omit<ValidatedAgentPlanV1, "approvalDigest"> {
  const { approvalDigest: _approvalDigest, ...unsigned } = plan;
  return unsigned;
}

function withoutApprovalSignature(approval: AgentApprovalV1): Omit<AgentApprovalV1, "approvalDigest"> {
  const { approvalDigest: _approvalDigest, ...unsigned } = approval;
  return unsigned;
}

function withoutReceiptDigest(receipt: AgentExecutionReceiptV1): Omit<AgentExecutionReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  return unsigned;
}
