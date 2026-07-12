import {
  AGENT_CONSUMPTION_KIND,
  AGENT_PLAN_KIND,
  AGENT_SAFETY_VERSION,
  digestAgentOperationInput,
  dryRunAgentPlan,
  executeAgentPlanStep,
  issueAgentApproval,
} from "@honua/sdk-js/agent-safety";
import { sha256 } from "@honua/sdk-js/query-planner";
import { describe, expect, it, vi } from "vitest";

import { createReadOnlyMcpAgentExecutor } from "../src/agent-execution.js";

const NOW = "2026-07-10T20:00:00.000Z";
const OPERATION = {
  tool: "honua_query_features",
  effect: "read",
  sourceId: "incidents",
  queryPlan: { id: "accepted-1", fingerprint: sha256("accepted") },
  fields: ["OBJECTID"],
  parameters: { where: "1=1" },
} as const;

describe("MCP approved execution adapter", () => {
  it("executes a named read tool through the identical SDK receipt and audit path", async () => {
    const parse = vi.fn((parameters) => parameters as { where: string });
    const execute = vi.fn(async (parameters: { where: string }) => ({
      content: [{ type: "text", text: parameters.where }],
    }));
    const executor = createReadOnlyMcpAgentExecutor({
      name: "honua_query_features",
      parse,
      execute,
      countRows: () => 1,
    });
    const source = sourceBinding();
    const policy = policyFixture();
    const plan = {
      kind: AGENT_PLAN_KIND,
      version: AGENT_SAFETY_VERSION,
      id: "mcp-plan-1",
      actor: "mcp-host",
      provider: "deterministic",
      model: "none",
      steps: [
        {
          id: "mcp-query",
          tool: OPERATION.tool,
          effect: OPERATION.effect,
          source,
          queryPlan: OPERATION.queryPlan,
          parametersDigest: sha256('{"where":"1=1"}'),
          inputDigest: digestAgentOperationInput(OPERATION),
          fields: OPERATION.fields,
          limits: { rows: 10, bytes: 2_000 },
        },
      ],
    };
    const dryRun = dryRunAgentPlan(plan, policy, { now: NOW });
    const approvalSignature = (payload: string) => sha256(`approval:${payload}`);
    const receiptSignature = (payload: string) => sha256(`receipt:${payload}`);
    const approval = await issueAgentApproval(
      dryRun,
      policy,
      { id: "approval-1", approver: "reviewer", issuedAt: NOW, expiresAt: "2026-07-10T21:00:00.000Z" },
      { algorithm: "test", keyId: "approval-key", sign: async (payload) => approvalSignature(payload) },
      { now: NOW },
    );
    const events: unknown[] = [];
    const result = await executeAgentPlanStep({
      dryRun,
      policy,
      approval,
      approvalVerifier: {
        algorithm: "test",
        keyId: "approval-key",
        verify: async (payload, signature) => signature === approvalSignature(payload),
      },
      context: { sources: { incidents: source } },
      stepId: "mcp-query",
      operation: OPERATION,
      useConsumer: consumptionStore(approval.envelopeDigest),
      executor,
      auditSink: { append: async (event) => void events.push(event) },
      receiptSigner: { algorithm: "test", keyId: "receipt-key", sign: async (payload) => receiptSignature(payload) },
      executionId: "mcp-execution-1",
      now: () => NOW,
    });

    expect(result.value).toEqual({ content: [{ type: "text", text: "1=1" }] });
    expect(result.receipt).toMatchObject({ outcome: "succeeded", rows: 1, stepId: "mcp-query" });
    expect(events).toHaveLength(2);
    expect(parse).toHaveBeenCalledOnce();
    expect(Object.isFrozen(parse.mock.calls[0]?.[0])).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("cannot adapt mutation or wildcard dispatch", async () => {
    const handler = vi.fn();
    const executor = createReadOnlyMcpAgentExecutor({
      name: "safe-read",
      parse: (value) => value,
      execute: handler,
      countRows: () => 0,
    });
    await expect(executor.execute({ ...OPERATION, tool: "different" }, { rows: 1, bytes: 1_000 })).rejects.toThrow(
      /does not match/,
    );
    await expect(
      executor.execute({ ...OPERATION, tool: "safe-read", effect: "mutation" }, { rows: 1, bytes: 1_000 }),
    ).rejects.toThrow(/read-only/);
    expect(handler).not.toHaveBeenCalled();

    for (const name of ["*", "safe-*", " safe-read", "safe read", "", "x".repeat(129)]) {
      expect(() =>
        createReadOnlyMcpAgentExecutor({ name, parse: (value) => value, execute: handler, countRows: () => 0 }),
      ).toThrow(/exact identifier/);
    }
  });

  it("requires and snapshots a trustworthy row-count callback", async () => {
    expect(() =>
      createReadOnlyMcpAgentExecutor({ name: "safe-read", parse: (value) => value, execute: vi.fn() } as never),
    ).toThrow(/countRows/);

    const descriptor = {
      name: "safe-read",
      parse: (value: unknown) => value,
      execute: async () => ({ features: [{ id: 1 }, { id: 2 }] }),
      countRows: () => 2,
    };
    const executor = createReadOnlyMcpAgentExecutor(descriptor);
    descriptor.countRows = () => 0;
    await expect(
      executor.execute({ ...OPERATION, tool: "safe-read" }, { rows: 10, bytes: 1_000 }),
    ).resolves.toMatchObject({
      rows: 2,
    });

    const invalid = createReadOnlyMcpAgentExecutor({ ...descriptor, countRows: () => -1 });
    await expect(invalid.execute({ ...OPERATION, tool: "safe-read" }, { rows: 10, bytes: 1_000 })).rejects.toThrow(
      /row count/,
    );
  });

  it("rejects callback accessors without invoking them", () => {
    const getter = vi.fn(() => vi.fn());
    const descriptor = { name: "safe-read", execute: vi.fn(), countRows: () => 0 };
    Object.defineProperty(descriptor, "parse", { enumerable: true, get: getter });
    expect(() => createReadOnlyMcpAgentExecutor(descriptor as never)).toThrow(/data property/);
    expect(getter).not.toHaveBeenCalled();
  });
});

function sourceBinding() {
  return {
    id: "incidents",
    schemaVersion: "schema-1",
    sourceVersion: "source-1",
    authorizationScope: ["incidents:read"],
    provenance: {
      dataMode: "live",
      observedAt: "2026-07-10T19:59:30.000Z",
      attribution: "Fixture",
      citations: [{ uri: "https://data.example.test/incidents" }],
    },
  };
}

function policyFixture() {
  return {
    allowedTools: ["honua_query_features"],
    sources: {
      incidents: {
        fields: ["OBJECTID"],
        authorizationScope: ["incidents:read"],
        schemaVersions: ["schema-1"],
        sourceVersions: ["source-1"],
        dataModes: ["live"],
        maxProvenanceAgeMs: 60_000,
        citationOrigins: ["https://data.example.test"],
        citationResourcePrefixes: ["/incidents"],
      },
    },
    maxSteps: 1,
    maxRows: 10,
    maxBytes: 2_000,
    maxFieldsPerStep: 4,
    maxAuthorizationScopesPerSource: 4,
    maxCitationsPerSource: 4,
    maxOperationParameterBytes: 1_000,
    maxOperationParameterNodes: 64,
    maxOperationParameterDepth: 8,
  };
}

function consumptionStore(approvalDigest: `sha256:${string}`) {
  return {
    async consume(use: { approvalDigest: string; stepId: string; inputDigest: string }) {
      const record = {
        kind: AGENT_CONSUMPTION_KIND,
        version: AGENT_SAFETY_VERSION,
        id: "mcp-use-1",
        nonce: "opaque",
        consumedAt: NOW,
        ...use,
      };
      return { ...record, token: sha256(JSON.stringify(record)) };
    },
    async verify(input: unknown) {
      if (!input || typeof input !== "object") return false;
      const { token, ...record } = input as Record<string, unknown>;
      return token === sha256(JSON.stringify(record)) && record.approvalDigest === approvalDigest;
    },
  };
}
