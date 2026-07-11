import { describe, expect, it, vi } from "vitest";

import {
  AGENT_CONSUMPTION_KIND,
  AGENT_PLAN_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalUseConsumer,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
  HonuaAgentSafetyError,
  digestAgentOperationInput,
  dryRunAgentPlan,
  issueAgentApproval,
  issueAgentExecutionReceipt,
  verifyAgentApproval,
  verifyAgentExecutionReceipt,
  verifyAgentStepAuthorization,
} from "../src/agent-safety/index.js";
import { sha256 } from "../src/query-planner/index.js";

const NOW = "2026-07-10T20:00:00.000Z";
const EXPIRES = "2026-07-10T21:00:00.000Z";
const PLAN_FINGERPRINT = sha256("query-plan");
const RESULT_DIGEST = sha256("result");
const OPERATION_INPUT = {
  tool: "query",
  effect: "read",
  sourceId: "incidents",
  queryPlan: { id: "query-plan-1", fingerprint: PLAN_FINGERPRINT },
  fields: ["status", "OBJECTID"],
  parameters: { where: "status = 'open'" },
};
const PARAMETERS_DIGEST = sha256('{"where":"status = \'open\'"}');

function plan(overrides: Record<string, unknown> = {}) {
  return {
    kind: AGENT_PLAN_KIND,
    version: AGENT_SAFETY_VERSION,
    id: "plan-1",
    actor: "operator@example.test",
    provider: "fixture",
    model: "none",
    steps: [
      {
        id: "query-incidents",
        tool: "query",
        effect: "read",
        source: sourceBinding(),
        queryPlan: { id: "query-plan-1", fingerprint: PLAN_FINGERPRINT },
        parametersDigest: PARAMETERS_DIGEST,
        inputDigest: digestAgentOperationInput(OPERATION_INPUT),
        fields: ["status", "OBJECTID"],
        limits: { rows: 100, bytes: 50_000 },
      },
    ],
    ...overrides,
  };
}

function operationStep(overrides: Record<string, unknown>) {
  const step = { ...plan().steps[0], ...overrides };
  return {
    ...step,
    inputDigest: digestAgentOperationInput({
      ...OPERATION_INPUT,
      tool: step.tool,
      effect: step.effect,
      sourceId: step.source.id,
      queryPlan: step.queryPlan,
      fields: step.fields,
    }),
  };
}

function sourceBinding(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
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
    maxRows: 100,
    maxBytes: 50_000,
    maxFieldsPerStep: 16,
    maxAuthorizationScopesPerSource: 8,
    maxCitationsPerSource: 4,
    maxOperationParameterBytes: 4_096,
    maxOperationParameterNodes: 128,
    maxOperationParameterDepth: 8,
    ...overrides,
  };
}

function context(binding = sourceBinding()) {
  return { sources: { incidents: binding } };
}

function cryptoPair(secret = "test-secret"): {
  signer: AgentEnvelopeSigner;
  verifier: AgentEnvelopeVerifier;
  sign: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
} {
  const sign = vi.fn(async (payload: string) => sha256(`${secret}:${payload}`));
  const verify = vi.fn(async (payload: string, signature: string) => signature === sha256(`${secret}:${payload}`));
  return {
    signer: { algorithm: "test-sha256", keyId: "test-key-1", sign },
    verifier: { algorithm: "test-sha256", keyId: "test-key-1", verify },
    sign,
    verify,
  };
}

function approvalUseStore(secret = "use-secret"): AgentApprovalUseConsumer {
  const consumed = new Set<string>();
  const tokenFor = (record: {
    approvalDigest: string;
    stepId: string;
    inputDigest: string;
    nonce: string;
    consumedAt: string;
  }) =>
    sha256(
      `${secret}:${record.approvalDigest}:${record.stepId}:${record.inputDigest}:${record.nonce}:${record.consumedAt}`,
    );
  return {
    async consume(use) {
      const key = `${use.approvalDigest}:${use.stepId}`;
      if (consumed.has(key)) return undefined;
      consumed.add(key);
      const record = {
        kind: AGENT_CONSUMPTION_KIND,
        version: AGENT_SAFETY_VERSION,
        id: `use-${consumed.size}`,
        nonce: `nonce-${consumed.size}`,
        consumedAt: NOW,
        ...use,
      };
      return { ...record, token: tokenFor(record) };
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
      return record.token === tokenFor(record as Parameters<typeof tokenFor>[0]);
    },
  };
}

async function approvedFixture() {
  const dryRun = dryRunAgentPlan(plan(), policy(), { now: NOW });
  const approvalCrypto = cryptoPair("approval");
  const approval = await issueAgentApproval(
    dryRun,
    policy(),
    { id: "approval-1", approver: "reviewer@example.test", issuedAt: NOW, expiresAt: EXPIRES, maxRows: 80 },
    approvalCrypto.signer,
    { now: NOW },
  );
  return { dryRun, approval, approvalCrypto };
}

async function authorizationFor(fixture: Awaited<ReturnType<typeof approvedFixture>>) {
  return verifyAgentStepAuthorization(
    fixture.dryRun,
    policy(),
    fixture.approval,
    fixture.approvalCrypto.verifier,
    context(),
    "query-incidents",
    OPERATION_INPUT,
    approvalUseStore(),
    { now: NOW },
  );
}

describe("agent safety dry run", () => {
  it("produces deterministic immutable bindings and a complete effect budget without effects", () => {
    const first = dryRunAgentPlan(plan(), policy(), { now: NOW });
    const second = dryRunAgentPlan(
      plan({
        steps: [
          {
            ...plan().steps[0],
            fields: ["OBJECTID", "status"],
            source: sourceBinding({ authorizationScope: ["incidents:read"] }),
          },
        ],
      }),
      policy(),
      { now: NOW },
    );

    expect(first.planDigest).toBe(second.planDigest);
    expect(first.effectBudget).toEqual({
      steps: 1,
      rows: 100,
      bytes: 50_000,
      byEffect: { read: 1, render: 0, mutation: 0, publish: 0, share: 0, realtime: 0, job: 0 },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan.steps[0]?.source.provenance.citations)).toBe(true);
  });

  it.each([
    ["unknown tool", () => plan({ steps: [operationStep({ tool: "applyEdits" })] }), /tool applyEdits/],
    ["mutation", () => plan({ steps: [operationStep({ effect: "mutation" })] }), /effect mutation/],
    ["field exfiltration", () => plan({ steps: [operationStep({ fields: ["status", "password"] })] }), /fields/],
    [
      "scope escalation",
      () =>
        plan({ steps: [{ ...plan().steps[0], source: sourceBinding({ authorizationScope: ["incidents:admin"] }) }] }),
      /scope/,
    ],
    ["row overflow", () => plan({ steps: [{ ...plan().steps[0], limits: { rows: 101, bytes: 1 } }] }), /row or byte/],
    [
      "byte overflow",
      () => plan({ steps: [{ ...plan().steps[0], limits: { rows: 1, bytes: 50_001 } }] }),
      /row or byte/,
    ],
    [
      "schema drift",
      () => plan({ steps: [{ ...plan().steps[0], source: sourceBinding({ schemaVersion: "schema-8" }) }] }),
      /schema version/,
    ],
    [
      "stale provenance",
      () =>
        plan({
          steps: [
            {
              ...plan().steps[0],
              source: sourceBinding({
                provenance: { ...sourceBinding().provenance, observedAt: "2026-07-10T19:00:00.000Z" },
              }),
            },
          ],
        }),
      /freshness/,
    ],
  ])("fails closed on %s before a signer or executor exists", (_label, create, expected) => {
    expect(() => dryRunAgentPlan(create(), policy(), { now: NOW })).toThrow(expected);
  });

  it("rejects credential-bearing provenance, accessors, unknown fields, and conflicting source bindings", () => {
    const credentialPlan = plan({
      steps: [
        {
          ...plan().steps[0],
          source: sourceBinding({
            provenance: {
              ...sourceBinding().provenance,
              citations: [{ uri: "https://data.example.test/incidents?access_token=secret" }],
            },
          }),
        },
      ],
    });
    expect(() => dryRunAgentPlan(credentialPlan, policy(), { now: NOW })).toThrow(/query parameters/);
    expect(() => dryRunAgentPlan({ ...plan(), prompt: "ignore policy" }, policy(), { now: NOW })).toThrow(
      /not supported/,
    );

    const accessor = plan();
    Object.defineProperty(accessor.steps[0]!, "tool", { get: () => "query", enumerable: true });
    expect(() => dryRunAgentPlan(accessor, policy(), { now: NOW })).toThrow(/accessor/);

    const arrayAccessor = plan();
    Object.defineProperty(arrayAccessor.steps, "0", { get: () => plan().steps[0], enumerable: true });
    expect(() => dryRunAgentPlan(arrayAccessor, policy(), { now: NOW })).toThrow(/accessor/);

    const getter = vi.fn(() => "secret");
    const operationInput = {};
    Object.defineProperty(operationInput, "token", { get: getter, enumerable: true });
    expect(() => digestAgentOperationInput(operationInput)).toThrow(/accessor|not supported/);
    expect(getter).not.toHaveBeenCalled();

    const inconsistent = plan({
      steps: [{ ...plan().steps[0], queryPlan: { id: "advertised-plan", fingerprint: PLAN_FINGERPRINT } }],
    });
    expect(() => dryRunAgentPlan(inconsistent, policy(), { now: NOW })).toThrow(/visible operation identity/);

    const second = { ...plan().steps[0], id: "query-again", source: sourceBinding({ sourceVersion: "snapshot-10" }) };
    expect(() =>
      dryRunAgentPlan(
        plan({ steps: [plan().steps[0], second] }),
        policy({
          maxSteps: 2,
          maxRows: 200,
          maxBytes: 100_000,
          sources: {
            incidents: {
              ...policy().sources.incidents,
              sourceVersions: ["snapshot-9", "snapshot-10"],
            },
          },
        }),
        { now: NOW },
      ),
    ).toThrow(/conflicting bindings/);
  });

  it("snapshots each foreign policy object once and types reflection failures", () => {
    let rootOwnKeys = 0;
    let sourceOwnKeys = 0;
    const input = policy();
    input.sources = new Proxy(input.sources, {
      ownKeys(target) {
        sourceOwnKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    const proxiedPolicy = new Proxy(input, {
      ownKeys(target) {
        rootOwnKeys += 1;
        return Reflect.ownKeys(target);
      },
    });

    dryRunAgentPlan(plan(), proxiedPolicy, { now: NOW });
    expect(rootOwnKeys).toBe(1);
    expect(sourceOwnKeys).toBe(1);

    const throwing = new Proxy(policy(), {
      ownKeys() {
        throw new Error("proxy escaped");
      },
    });
    expect(() => dryRunAgentPlan(plan(), throwing, { now: NOW })).toThrow(
      expect.objectContaining({ name: "HonuaAgentSafetyError", code: "invalid-input" }),
    );
    const revoked = Proxy.revocable(policy(), {});
    revoked.revoke();
    expect(() => dryRunAgentPlan(plan(), revoked.proxy, { now: NOW })).toThrow(
      expect.objectContaining({ name: "HonuaAgentSafetyError", code: "invalid-input" }),
    );

    const accessorPolicy = policy();
    const getter = vi.fn(() => ["query"]);
    Object.defineProperty(accessorPolicy, "allowedTools", { get: getter, enumerable: true });
    expect(() => dryRunAgentPlan(plan(), accessorPolicy, { now: NOW })).toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects oversized collections before reading an element and enforces policy counts", () => {
    const oversized: unknown[] = [];
    oversized.length = 1_000_000;
    const getter = vi.fn(() => plan().steps[0]);
    Object.defineProperty(oversized, "0", { get: getter, enumerable: true });
    expect(() => dryRunAgentPlan(plan({ steps: oversized }), policy(), { now: NOW })).toThrow(/128 entry limit/);
    expect(getter).not.toHaveBeenCalled();

    expect(() => dryRunAgentPlan(plan(), policy({ maxFieldsPerStep: 1 }), { now: NOW })).toThrow(/field.*count/i);
    const twoCitations = sourceBinding({
      provenance: {
        ...sourceBinding().provenance,
        citations: [
          { uri: "https://data.example.test/incidents/one" },
          { uri: "https://data.example.test/incidents/two" },
        ],
      },
    });
    expect(() =>
      dryRunAgentPlan(
        plan({ steps: [{ ...plan().steps[0], source: twoCitations }] }),
        policy({ maxCitationsPerSource: 1 }),
        { now: NOW },
      ),
    ).toThrow(/citation.*count/i);
  });

  it("normalizes allowlisted citation resources and rejects encoded traversal, foreign origins, and opaque paths", () => {
    const encoded = sourceBinding({
      provenance: {
        ...sourceBinding().provenance,
        citations: [{ uri: "https://data.example.test/%2569ncidents" }],
      },
    });
    const normalized = dryRunAgentPlan(plan({ steps: [{ ...plan().steps[0], source: encoded }] }), policy(), {
      now: NOW,
    });
    expect(normalized.plan.steps[0]?.source.provenance.citations[0]?.uri).toBe("https://data.example.test/incidents");

    for (const uri of [
      "https://data.example.test/%252e%252e/private",
      "https://evil.example.test/incidents",
      "https://data.example.test/private/opaque-value",
    ]) {
      const source = sourceBinding({
        provenance: { ...sourceBinding().provenance, citations: [{ uri }] },
      });
      expect(() => dryRunAgentPlan(plan({ steps: [{ ...plan().steps[0], source }] }), policy(), { now: NOW })).toThrow(
        /path|origin|resource|traversal/i,
      );
    }
  });
});

describe("agent approval envelope", () => {
  it("uses one frozen policy snapshot throughout approval issuance", async () => {
    const basePolicy = policy();
    const dryRun = dryRunAgentPlan(plan(), basePolicy, { now: NOW });
    let ownKeys = 0;
    const proxied = new Proxy(basePolicy, {
      ownKeys(target) {
        ownKeys += 1;
        return Reflect.ownKeys(target);
      },
    });
    await issueAgentApproval(
      dryRun,
      proxied,
      { id: "snapshot", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES },
      cryptoPair("snapshot").signer,
      { now: NOW },
    );
    expect(ownKeys).toBe(1);
  });

  it("binds the exact plan/policy/context and permits only budget narrowing", async () => {
    const { dryRun, approval, approvalCrypto } = await approvedFixture();
    expect(approval).toMatchObject({
      planDigest: dryRun.planDigest,
      policyDigest: dryRun.policyDigest,
      bindingsDigest: dryRun.bindingsDigest,
      approvedRows: 80,
      approvedBytes: 50_000,
    });
    await expect(
      verifyAgentApproval(dryRun, policy(), approval, approvalCrypto.verifier, context(), { now: NOW }),
    ).resolves.toEqual(approval);
    expect(Object.isFrozen(approval)).toBe(true);

    await expect(
      issueAgentApproval(
        dryRun,
        policy(),
        { id: "bad", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES, maxRows: 101 },
        approvalCrypto.signer,
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "policy-denied" });
  });

  it("rejects forged dry runs, signature tampering, expiry, and context drift", async () => {
    const { dryRun, approval, approvalCrypto } = await approvedFixture();
    await expect(
      verifyAgentApproval(
        { ...dryRun, policyDigest: sha256("forged") },
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    await expect(
      verifyAgentApproval(dryRun, policy(), { ...approval, approver: "attacker" }, approvalCrypto.verifier, context(), {
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    await expect(
      verifyAgentApproval(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(sourceBinding({ sourceVersion: "snapshot-10" })),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "context-mismatch" });
    const shortApproval = await issueAgentApproval(
      dryRun,
      policy(),
      { id: "short", approver: "reviewer", issuedAt: NOW, expiresAt: "2026-07-10T20:00:30.000Z" },
      approvalCrypto.signer,
      { now: NOW },
    );
    await expect(
      verifyAgentApproval(dryRun, policy(), shortApproval, approvalCrypto.verifier, context(), {
        now: "2026-07-10T20:00:30.000Z",
      }),
    ).rejects.toMatchObject({ code: "approval-expired" });
  });

  it("honors cancellation before and across the host signing trust boundary", async () => {
    const dryRun = dryRunAgentPlan(plan(), policy(), { now: NOW });
    const preAborted = new AbortController();
    preAborted.abort();
    const unused = cryptoPair();
    await expect(
      issueAgentApproval(
        dryRun,
        policy(),
        { id: "a", approver: "r", issuedAt: NOW, expiresAt: EXPIRES },
        unused.signer,
        { signal: preAborted.signal, now: NOW },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(unused.sign).not.toHaveBeenCalled();

    const during = new AbortController();
    const signer: AgentEnvelopeSigner = {
      algorithm: "test",
      keyId: "key",
      sign: async () => {
        during.abort();
        return "signature";
      },
    };
    await expect(
      issueAgentApproval(dryRun, policy(), { id: "a", approver: "r", issuedAt: NOW, expiresAt: EXPIRES }, signer, {
        signal: during.signal,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  it("uses an explicit trusted signing clock for future, expiry, and freshness checks", async () => {
    const dryRun = dryRunAgentPlan(plan(), policy(), { now: NOW });
    const crypto = cryptoPair("clock");
    const request = { id: "clock", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES };
    await expect(issueAgentApproval(dryRun, policy(), request, crypto.signer)).rejects.toMatchObject({
      code: "invalid-input",
    });
    await expect(
      issueAgentApproval(dryRun, policy(), { ...request, issuedAt: "2026-07-10T20:01:00.000Z" }, crypto.signer, {
        now: NOW,
        maxClockSkewMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      issueAgentApproval(dryRun, policy(), request, crypto.signer, {
        now: "2026-07-10T20:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(crypto.sign).not.toHaveBeenCalled();

    const relaxedPolicy = policy({
      sources: {
        incidents: { ...policy().sources.incidents, maxProvenanceAgeMs: 7_200_000 },
      },
    });
    const relaxedDryRun = dryRunAgentPlan(plan(), relaxedPolicy, { now: NOW });
    await expect(
      issueAgentApproval(
        relaxedDryRun,
        relaxedPolicy,
        { ...request, expiresAt: "2026-07-10T20:00:30.000Z" },
        crypto.signer,
        { now: "2026-07-10T20:01:00.000Z" },
      ),
    ).rejects.toMatchObject({ code: "approval-expired" });
    expect(crypto.sign).not.toHaveBeenCalled();
  });

  it("enforces the policy operation-parameter budget before replay-store consumption", async () => {
    const boundedPolicy = policy({ maxOperationParameterBytes: 24 });
    const dryRun = dryRunAgentPlan(plan(), boundedPolicy, { now: NOW });
    const crypto = cryptoPair("parameter-budget");
    const approval = await issueAgentApproval(
      dryRun,
      boundedPolicy,
      { id: "bounded", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES },
      crypto.signer,
      { now: NOW },
    );
    const store = approvalUseStore();
    const consume = vi.fn(store.consume.bind(store));
    await expect(
      verifyAgentStepAuthorization(
        dryRun,
        boundedPolicy,
        approval,
        crypto.verifier,
        context(),
        "query-incidents",
        OPERATION_INPUT,
        { consume, verify: store.verify.bind(store) },
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(consume).not.toHaveBeenCalled();

    const nodePolicy = policy({ maxOperationParameterNodes: 2 });
    const nodeDryRun = dryRunAgentPlan(plan(), nodePolicy, { now: NOW });
    const nodeApproval = await issueAgentApproval(
      nodeDryRun,
      nodePolicy,
      { id: "nodes", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES },
      crypto.signer,
      { now: NOW },
    );
    const oversized: unknown[] = [];
    oversized.length = 100;
    const getter = vi.fn(() => "unread");
    Object.defineProperty(oversized, "0", { get: getter, enumerable: true });
    await expect(
      verifyAgentStepAuthorization(
        nodeDryRun,
        nodePolicy,
        nodeApproval,
        crypto.verifier,
        context(),
        "query-incidents",
        { ...OPERATION_INPUT, parameters: oversized },
        approvalUseStore(),
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("binds exact operation input and atomically consumes each approved step once", async () => {
    const { dryRun, approval, approvalCrypto } = await approvedFixture();
    const backingStore = approvalUseStore();
    const consume = vi.fn(backingStore.consume.bind(backingStore));
    const verify = vi.fn(backingStore.verify.bind(backingStore));
    const consumer = { consume, verify };

    await expect(
      verifyAgentStepAuthorization(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        "query-incidents",
        { ...OPERATION_INPUT, queryPlan: { ...OPERATION_INPUT.queryPlan, id: "different-plan" } },
        consumer,
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "integrity-failed" });
    expect(consume).not.toHaveBeenCalled();

    const mutableOperation = structuredClone(OPERATION_INPUT);
    const authorization = await verifyAgentStepAuthorization(
      dryRun,
      policy(),
      approval,
      approvalCrypto.verifier,
      context(),
      "query-incidents",
      mutableOperation,
      consumer,
      { now: NOW },
    );
    expect(authorization).toMatchObject({
      inputDigest: dryRun.plan.steps[0]?.inputDigest,
      step: { limits: { rows: 80 } },
    });
    expect(authorization.consumption).toMatchObject({
      approvalDigest: approval.envelopeDigest,
      stepId: "query-incidents",
      inputDigest: authorization.inputDigest,
    });
    expect(verify).toHaveBeenCalledOnce();
    mutableOperation.parameters.where = "1=1";
    expect(authorization.operation.parameters).toEqual({ where: "status = 'open'" });
    expect(Object.isFrozen(authorization.operation.parameters)).toBe(true);
    await expect(
      verifyAgentStepAuthorization(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        "query-incidents",
        OPERATION_INPUT,
        consumer,
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "policy-denied" });
  });

  it("requires explicit per-step allocation when narrowing a multi-step approval", async () => {
    const secondOperation = {
      ...OPERATION_INPUT,
      queryPlan: { id: "query-plan-2", fingerprint: sha256("query-plan-2") },
      parameters: { where: "status = 'closed'" },
    };
    const secondStep = {
      ...plan().steps[0],
      id: "query-closed-incidents",
      queryPlan: secondOperation.queryPlan,
      parametersDigest: sha256('{"where":"status = \'closed\'"}'),
      inputDigest: digestAgentOperationInput(secondOperation),
    };
    const multiPolicy = policy({ maxSteps: 2, maxRows: 200, maxBytes: 100_000 });
    const dryRun = dryRunAgentPlan(plan({ steps: [plan().steps[0], secondStep] }), multiPolicy, { now: NOW });
    const approvalCrypto = cryptoPair("multi");
    await expect(
      issueAgentApproval(
        dryRun,
        multiPolicy,
        { id: "bad", approver: "reviewer", issuedAt: NOW, expiresAt: EXPIRES, maxRows: 10 },
        approvalCrypto.signer,
        { now: NOW },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });

    const approval = await issueAgentApproval(
      dryRun,
      multiPolicy,
      {
        id: "multi",
        approver: "reviewer",
        issuedAt: NOW,
        expiresAt: EXPIRES,
        stepLimits: {
          "query-incidents": { rows: 10, bytes: 1_000 },
          "query-closed-incidents": { rows: 20, bytes: 2_000 },
        },
      },
      approvalCrypto.signer,
      { now: NOW },
    );
    expect(approval).toMatchObject({ approvedRows: 30, approvedBytes: 3_000 });
    expect(approval.steps).toEqual([
      { id: "query-incidents", inputDigest: plan().steps[0].inputDigest, rows: 10, bytes: 1_000 },
      { id: "query-closed-incidents", inputDigest: secondStep.inputDigest, rows: 20, bytes: 2_000 },
    ]);
  });

  it("rechecks provenance freshness at the execution clock", async () => {
    const { dryRun, approval, approvalCrypto } = await approvedFixture();
    await expect(
      verifyAgentApproval(dryRun, policy(), approval, approvalCrypto.verifier, context(), {
        now: "2026-07-10T20:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "policy-denied" });
  });
});

describe("agent execution receipts", () => {
  it("signs and deterministically verifies bounded outcome evidence", async () => {
    const fixture = await approvedFixture();
    const { dryRun, approval, approvalCrypto } = fixture;
    const authorization = await authorizationFor(fixture);
    const receiptCrypto = cryptoPair("receipt");
    const receipt = await issueAgentExecutionReceipt(
      dryRun,
      policy(),
      approval,
      approvalCrypto.verifier,
      context(),
      {
        id: "receipt-1",
        stepId: authorization.step.id,
        inputDigest: authorization.inputDigest,
        useDigest: authorization.useDigest,
        consumption: authorization.consumption,
        outcome: "succeeded",
        completedAt: "2026-07-10T20:00:20.000Z",
        rows: 70,
        bytes: 40_000,
        resultDigest: RESULT_DIGEST,
      },
      approvalUseStore(),
      receiptCrypto.signer,
      { now: "2026-07-11T20:00:20.000Z" },
    );
    await expect(
      verifyAgentExecutionReceipt(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        receipt,
        approvalUseStore(),
        receiptCrypto.verifier,
        { now: "2026-07-11T20:01:00.000Z" },
      ),
    ).resolves.toEqual(receipt);
    expect(receipt.approvalDigest).toBe(approval.envelopeDigest);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("rejects over-budget evidence before receipt signing and detects receipt tampering", async () => {
    const fixture = await approvedFixture();
    const { dryRun, approval, approvalCrypto } = fixture;
    const authorization = await authorizationFor(fixture);
    const receiptCrypto = cryptoPair("receipt");
    await expect(
      issueAgentExecutionReceipt(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        {
          id: "receipt-1",
          stepId: authorization.step.id,
          inputDigest: authorization.inputDigest,
          useDigest: authorization.useDigest,
          consumption: authorization.consumption,
          outcome: "succeeded",
          completedAt: "2026-07-10T20:00:20.000Z",
          rows: 81,
          bytes: 1,
          resultDigest: RESULT_DIGEST,
        },
        approvalUseStore(),
        receiptCrypto.signer,
        { now: "2026-07-10T20:00:20.000Z" },
      ),
    ).rejects.toMatchObject({ code: "policy-denied" });
    expect(receiptCrypto.sign).not.toHaveBeenCalled();

    const receipt = await issueAgentExecutionReceipt(
      dryRun,
      policy(),
      approval,
      approvalCrypto.verifier,
      context(),
      {
        id: "receipt-1",
        stepId: authorization.step.id,
        inputDigest: authorization.inputDigest,
        useDigest: authorization.useDigest,
        consumption: authorization.consumption,
        outcome: "succeeded",
        completedAt: "2026-07-10T20:00:20.000Z",
        rows: 1,
        bytes: 1,
        resultDigest: RESULT_DIGEST,
      },
      approvalUseStore(),
      receiptCrypto.signer,
      { now: "2026-07-10T20:00:20.000Z" },
    );
    for (const forged of [
      { ...receipt, rows: 2 },
      { ...receipt, resultDigest: sha256("different") },
      { ...receipt, approvalDigest: sha256("different-approval") },
      { ...receipt, stepId: "different-step" },
      { ...receipt, useDigest: sha256("different-use") },
      { ...receipt, signature: "forged" },
    ]) {
      await expect(
        verifyAgentExecutionReceipt(
          dryRun,
          policy(),
          approval,
          approvalCrypto.verifier,
          context(),
          forged,
          approvalUseStore(),
          receiptCrypto.verifier,
          { now: "2026-07-10T20:01:00.000Z" },
        ),
      ).rejects.toBeInstanceOf(HonuaAgentSafetyError);
    }
  });

  it("cannot issue a receipt from public digests without host-authenticated consumption evidence", async () => {
    const fixture = await approvedFixture();
    const authorization = await authorizationFor(fixture);
    const receiptCrypto = cryptoPair("unconsumed");
    await expect(
      issueAgentExecutionReceipt(
        fixture.dryRun,
        policy(),
        fixture.approval,
        fixture.approvalCrypto.verifier,
        context(),
        {
          id: "receipt-unverified-use",
          stepId: authorization.step.id,
          inputDigest: authorization.inputDigest,
          useDigest: authorization.useDigest,
          consumption: authorization.consumption,
          outcome: "failed",
          completedAt: "2026-07-10T20:00:20.000Z",
          rows: 0,
          bytes: 0,
        },
        { verify: async () => false },
        receiptCrypto.signer,
        { now: "2026-07-10T20:00:20.000Z" },
      ),
    ).rejects.toMatchObject({ code: "signature-invalid" });
    expect(receiptCrypto.sign).not.toHaveBeenCalled();
  });

  it("rejects future and post-expiry completion evidence", async () => {
    const fixture = await approvedFixture();
    const { dryRun, approval, approvalCrypto } = fixture;
    const authorization = await authorizationFor(fixture);
    const receiptCrypto = cryptoPair("receipt");
    const base = {
      id: "receipt",
      stepId: authorization.step.id,
      inputDigest: authorization.inputDigest,
      useDigest: authorization.useDigest,
      consumption: authorization.consumption,
      outcome: "failed",
      rows: 0,
      bytes: 0,
    } as const;
    await expect(
      issueAgentExecutionReceipt(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        { ...base, completedAt: "2026-07-10T20:02:00.000Z" },
        approvalUseStore(),
        receiptCrypto.signer,
        { now: "2026-07-10T20:01:00.000Z" },
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      issueAgentExecutionReceipt(
        dryRun,
        policy(),
        approval,
        approvalCrypto.verifier,
        context(),
        { ...base, completedAt: EXPIRES },
        approvalUseStore(),
        receiptCrypto.signer,
        { now: EXPIRES },
      ),
    ).rejects.toMatchObject({ code: "approval-expired" });
    expect(receiptCrypto.sign).not.toHaveBeenCalled();
  });
});
