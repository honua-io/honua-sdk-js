import type { Query, Result, Source, SourceDescriptor } from "@honua/sdk-js/contract";
import { capabilities } from "@honua/sdk-js/contract";
import { canonicalStringify, executeQueryPlan, explainQuery, sha256, toJsonValue } from "@honua/sdk-js/query-planner";
import type { QueryExecutionPlanV1 } from "@honua/sdk-js/query-planner";

export type AgentEffect = "read" | "mutation" | "realtime" | "generated-app";
export type Decision = "approve" | "narrow" | "reject";
export type SafetyState = "proposed" | "validated" | "approved" | "rejected" | "executed" | "refused";

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
  }): Promise<AgentExecutionReceiptV1>;
  verifyReceipt(receipt?: AgentExecutionReceiptV1): boolean;
}

export const FIXTURE_TIME = "2026-07-10T18:00:00.000Z";
export const SOURCE_VERSION = "parcels-snapshot-2026-07-10";
export const SCHEMA_VERSION = "parcels-schema-v5";

export const fixturePolicy: ExecutionPolicyV1 = Object.freeze({
  kind: "honua.agent-execution-policy",
  version: "1.0",
  id: "fixture-read-only-v1",
  allowedEffects: ["read"],
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

export const fixtureProposal: AgentProposalV1 = Object.freeze({
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
  toolCalls: [
    { name: "listCapabilities", effect: "read", reason: "Bind the proposal to discovered source capabilities." },
    { name: "query", effect: "read", reason: "Read only the approved, bounded parcel rows." },
  ],
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
): SafeAgentSession {
  let state: SafetyState = "proposed";
  let validatedPlan: ValidatedAgentPlanV1 | undefined;
  let approval: AgentApprovalV1 | undefined;
  let receipt: AgentExecutionReceiptV1 | undefined;
  let rows: readonly ParcelAttributes[] = [];
  let executionCount = 0;
  const source = createFixtureSource(() => {
    executionCount += 1;
  });

  const session: SafeAgentSession = {
    get state() {
      return state;
    },
    get executionCount() {
      return executionCount;
    },
    proposal,
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
    validate(proposalOverride = proposal) {
      const refusals = validateProposalPolicy(proposalOverride, policy);
      let queryPlan: QueryExecutionPlanV1;
      try {
        queryPlan = explainQuery({
          descriptor: fixtureDescriptor,
          query: proposalOverride.query,
          capabilityPolicy: "strict",
          fallback: { mode: "disabled" },
          schemaVersion: SCHEMA_VERSION,
          sourceVersion: SOURCE_VERSION,
          authorizationScope: policy.authorizationScope,
          estimates: { rows: fixtureRows.length, bytes: 4_096, requests: 1 },
        });
      } catch (error) {
        refusals.push(error instanceof Error ? error.message : "Query planning failed.");
        queryPlan = explainQuery({
          descriptor: fixtureDescriptor,
          query: { where: "1=0", pagination: { limit: 1 }, outSr: 4326 },
          schemaVersion: SCHEMA_VERSION,
          sourceVersion: SOURCE_VERSION,
          authorizationScope: policy.authorizationScope,
        });
      }
      const unsigned = {
        kind: "honua.validated-agent-plan" as const,
        version: "1.0" as const,
        proposal: proposalOverride,
        queryPlan,
        policy,
        validatedAt: FIXTURE_TIME,
        valid: refusals.length === 0,
        refusals,
      };
      validatedPlan = Object.freeze({ ...unsigned, approvalDigest: digest(unsigned) });
      approval = undefined;
      receipt = undefined;
      rows = [];
      state = validatedPlan.valid ? "validated" : "refused";
      return validatedPlan;
    },
    decide(decision, narrowedMaxRows) {
      if (!validatedPlan?.valid || state !== "validated")
        throw new Error("Only a valid, freshly validated plan can be reviewed.");
      const proposedLimit = validatedPlan.queryPlan.ir.query.pagination?.limit ?? policy.maxRows;
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
        actor: "fixture-reviewer" as const,
        approvedAt: FIXTURE_TIME,
      };
      approval = Object.freeze({ ...unsigned, approvalDigest: digest(unsigned) });
      state = decision === "reject" ? "rejected" : "approved";
      return approval;
    },
    async execute(options = {}) {
      const candidate = options.planOverride ?? validatedPlan;
      if (!candidate || !approval || state !== "approved")
        throw new Error("Execution requires explicit approval of a valid plan.");
      if (digest(withoutApprovalDigest(candidate)) !== candidate.approvalDigest)
        throw new Error("Validated plan was tampered after review.");
      if (
        approval.planDigest !== candidate.approvalDigest ||
        digest(withoutApprovalSignature(approval)) !== approval.approvalDigest
      ) {
        throw new Error("Approval does not match the reviewed plan.");
      }
      if (approval.decision === "reject") throw new Error("Rejected plans cannot execute.");
      const context = {
        sourceVersion: options.sourceVersion ?? SOURCE_VERSION,
        schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
        authorizationScope: options.authorizationScope ?? policy.authorizationScope,
      };
      const execution = await executeQueryPlan(candidate.queryPlan, source, context);
      rows = execution.result.features.slice(0, approval.approvedMaxRows).map((feature) => feature.attributes);
      const unsignedReceipt = {
        kind: "honua.agent-execution-receipt" as const,
        version: "1.0" as const,
        id: `receipt-${candidate.queryPlan.id}`,
        planDigest: candidate.approvalDigest,
        approvalDigest: approval.approvalDigest,
        resultDigest: digest(rows),
        sourceId: fixtureDescriptor.id,
        sourceVersion: SOURCE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        authorizationScope: policy.authorizationScope,
        effect: "read" as const,
        rowCount: rows.length,
        executedAt: FIXTURE_TIME,
        previousReceiptDigest: null,
      };
      receipt = Object.freeze({ ...unsignedReceipt, receiptDigest: digest(unsignedReceipt) });
      state = "executed";
      return receipt;
    },
    verifyReceipt(candidate = receipt) {
      return Boolean(candidate && digest(withoutReceiptDigest(candidate)) === candidate.receiptDigest);
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
  for (const tool of proposal.toolCalls) {
    if (!policy.allowedEffects.includes(tool.effect))
      refusals.push(`Tool '${tool.name}' requests unsupported '${tool.effect}' capability.`);
  }
  return refusals;
}

function createFixtureSource(onRead: () => void): Source<ParcelAttributes> {
  const query = async (request: Query<ParcelAttributes> = {}): Promise<Result<ParcelAttributes>> => {
    onRead();
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
