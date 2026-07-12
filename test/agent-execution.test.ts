import { describe, expect, it, vi } from "vitest";

import {
  AGENT_CONSUMPTION_KIND,
  AGENT_PLAN_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalUseConsumer,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  type AgentExecutionAuditV1,
  digestAgentOperationInput,
  dryRunAgentPlan,
  executeAgentPlanStep,
  issueAgentApproval,
} from "../src/agent-safety/index.js";
import { sha256 } from "../src/query-planner/index.js";

const NOW = "2026-07-10T20:00:00.000Z";
const EXPIRES = "2026-07-10T21:00:00.000Z";
const FINGERPRINT = sha256("accepted-query-plan");
const OPERATION = {
  tool: "query",
  effect: "read",
  sourceId: "incidents",
  queryPlan: { id: "query-plan-1", fingerprint: FINGERPRINT },
  fields: ["OBJECTID", "status"],
  parameters: { where: "status = 'open'" },
} as const;

function source() {
  return {
    id: "incidents",
    schemaVersion: "schema-7",
    sourceVersion: "snapshot-9",
    authorizationScope: ["incidents:read"],
    provenance: {
      dataMode: "live",
      observedAt: "2026-07-10T19:59:30.000Z",
      attribution: "Honua incident service",
      citations: [{ uri: "https://data.example.test/incidents", digest: sha256("citation") }],
    },
  };
}

function policy() {
  return {
    allowedTools: ["query"],
    sources: {
      incidents: {
        fields: ["OBJECTID", "status"],
        authorizationScope: ["incidents:read"],
        schemaVersions: ["schema-7"],
        sourceVersions: ["snapshot-9"],
        dataModes: ["live"],
        maxProvenanceAgeMs: 60_000,
        citationOrigins: ["https://data.example.test"],
        citationResourcePrefixes: ["/incidents"],
      },
    },
    maxSteps: 1,
    maxRows: 10,
    maxBytes: 1_024,
    maxFieldsPerStep: 8,
    maxAuthorizationScopesPerSource: 4,
    maxCitationsPerSource: 4,
    maxOperationParameterBytes: 1_024,
    maxOperationParameterNodes: 64,
    maxOperationParameterDepth: 8,
  };
}

function plan() {
  return {
    kind: AGENT_PLAN_KIND,
    version: AGENT_SAFETY_VERSION,
    id: "plan-1",
    actor: "operator@example.test",
    provider: "deterministic",
    model: "none",
    steps: [
      {
        id: "query-incidents",
        tool: "query",
        effect: "read",
        source: source(),
        queryPlan: OPERATION.queryPlan,
        parametersDigest: sha256('{"where":"status = \'open\'"}'),
        inputDigest: digestAgentOperationInput(OPERATION),
        fields: OPERATION.fields,
        limits: { rows: 10, bytes: 1_024 },
      },
    ],
  };
}

function cryptoPair(secret: string): { signer: AgentEnvelopeSigner; verifier: AgentEnvelopeVerifier } {
  return {
    signer: {
      algorithm: "test-sha256",
      keyId: `${secret}-key`,
      async sign(payload) {
        return sha256(`${secret}:${payload}`);
      },
    },
    verifier: {
      algorithm: "test-sha256",
      keyId: `${secret}-key`,
      async verify(payload, signature) {
        return signature === sha256(`${secret}:${payload}`);
      },
    },
  };
}

function useStore(): AgentApprovalUseConsumer {
  const consumed = new Set<string>();
  return {
    async consume(use) {
      const key = `${use.approvalDigest}:${use.stepId}`;
      if (consumed.has(key)) return undefined;
      consumed.add(key);
      const record = {
        kind: AGENT_CONSUMPTION_KIND,
        version: AGENT_SAFETY_VERSION,
        id: "use-1",
        nonce: "opaque-nonce-secret",
        consumedAt: NOW,
        ...use,
      };
      return { ...record, token: sha256(JSON.stringify(record)) };
    },
    async verify(input) {
      if (!input || typeof input !== "object") return false;
      const { token, ...record } = input as Record<string, unknown>;
      return token === sha256(JSON.stringify(record));
    },
  };
}

async function fixture() {
  const dryRun = dryRunAgentPlan(plan(), policy(), { now: NOW });
  const approvalCrypto = cryptoPair("approval");
  const approval = await issueAgentApproval(
    dryRun,
    policy(),
    { id: "approval-1", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES },
    approvalCrypto.signer,
    { now: NOW },
  );
  return { dryRun, approval, approvalCrypto, receiptCrypto: cryptoPair("receipt") };
}

async function run(
  overrides: Partial<Parameters<typeof executeAgentPlanStep>[0]> = {},
  events: AgentExecutionAuditV1[] = [],
) {
  const data = await fixture();
  return executeAgentPlanStep({
    dryRun: data.dryRun,
    policy: policy(),
    approval: data.approval,
    approvalVerifier: data.approvalCrypto.verifier,
    context: { sources: { incidents: source() } },
    stepId: "query-incidents",
    operation: OPERATION,
    useConsumer: useStore(),
    executor: {
      tool: "query",
      effect: "read",
      async execute(operation) {
        expect(Object.isFrozen(operation)).toBe(true);
        return { rows: 1, value: { features: [{ id: 7, status: "open" }] } };
      },
    },
    auditSink: {
      async append(event) {
        events.push(event);
      },
    },
    receiptSigner: data.receiptCrypto.signer,
    executionId: "execution-1",
    now: () => NOW,
    ...overrides,
  });
}

describe("approved agent execution", () => {
  it("executes only the frozen operation and emits signed, secret-safe audit evidence", async () => {
    const events: AgentExecutionAuditV1[] = [];
    const result = await run({}, events);

    expect(result.value).toEqual({ features: [{ id: 7, status: "open" }] });
    expect(result.receipt).toMatchObject({ outcome: "succeeded", rows: 1 });
    expect(result.receipt.bytes).toBeGreaterThan(0);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ phase: "started", actor: "operator@example.test", dataMode: "live" });
    expect(events[1]).toMatchObject({
      phase: "completed",
      outcome: "succeeded",
      resultDigest: result.receipt.resultDigest,
      receiptDigest: result.receipt.receiptDigest,
    });
    const serialized = JSON.stringify(events);
    for (const secret of ["status = 'open'", "incidents:read", "opaque-nonce-secret", "token", "citation"])
      expect(serialized).not.toContain(secret);
  });

  it("does not invoke an effect after start-audit failure, executor mismatch, or replay", async () => {
    const execute = vi.fn(async () => ({ rows: 0, value: {} }));
    await expect(
      run({
        executor: { tool: "query", effect: "read", execute },
        auditSink: { append: async () => Promise.reject() },
      }),
    ).rejects.toMatchObject({ code: "audit-failed", phase: "start-audit" });
    expect(execute).not.toHaveBeenCalled();

    await expect(run({ executor: { tool: "different", effect: "read", execute } })).rejects.toMatchObject({
      code: "execution-failed",
      phase: "authorization",
    });
    expect(execute).not.toHaveBeenCalled();

    const data = await fixture();
    const store = useStore();
    const shared = {
      dryRun: data.dryRun,
      policy: policy(),
      approval: data.approval,
      approvalVerifier: data.approvalCrypto.verifier,
      context: { sources: { incidents: source() } },
      stepId: "query-incidents",
      operation: OPERATION,
      useConsumer: store,
      executor: { tool: "query", effect: "read" as const, execute },
      auditSink: { append: async () => undefined },
      receiptSigner: data.receiptCrypto.signer,
      executionId: "replay",
      now: () => NOW,
    };
    await executeAgentPlanStep(shared);
    await expect(executeAgentPlanStep(shared)).rejects.toMatchObject({ code: "policy-denied" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["row overflow", { rows: 11, value: {} }],
    ["byte overflow", { rows: 1, value: { text: "x".repeat(2_000) } }],
  ])("signs and audits a failed outcome for %s without exposing executor data", async (_label, output) => {
    const events: AgentExecutionAuditV1[] = [];
    await expect(
      run({ executor: { tool: "query", effect: "read", execute: async () => output as never } }, events),
    ).rejects.toMatchObject({ code: "execution-failed", receipt: { outcome: "failed" } });
    expect(events[1]).toMatchObject({ phase: "completed", outcome: "failed", rows: 0, bytes: 0 });
    expect(JSON.stringify(events)).not.toContain("x".repeat(20));
  });

  it("rejects executor accessors without invoking them", async () => {
    const getter = vi.fn(() => ({ Bearer: "secret" }));
    const output = { rows: 1 };
    Object.defineProperty(output, "value", { enumerable: true, get: getter });
    await expect(
      run({ executor: { tool: "query", effect: "read", execute: async () => output as never } }),
    ).rejects.toMatchObject({ code: "execution-failed", receipt: { outcome: "failed" } });
    expect(getter).not.toHaveBeenCalled();
  });

  it("records a generic failure and retains the receipt when terminal audit persistence fails", async () => {
    const events: AgentExecutionAuditV1[] = [];
    await expect(
      run(
        {
          executor: {
            tool: "query",
            effect: "read",
            async execute() {
              throw new Error("Bearer super-secret customer payload");
            },
          },
          auditSink: {
            async append(event) {
              events.push(event);
              if (event.phase === "completed") throw new Error("sink secret");
            },
          },
        },
        events,
      ),
    ).rejects.toMatchObject({ code: "audit-failed", phase: "terminal-audit", receipt: { outcome: "failed" } });
    expect(JSON.stringify(events)).not.toMatch(/Bearer|super-secret|customer payload|sink secret/);
  });

  it("does not execute when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    await expect(
      run({ signal: controller.signal, executor: { tool: "query", effect: "read", execute } }),
    ).rejects.toMatchObject({
      code: "aborted",
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
