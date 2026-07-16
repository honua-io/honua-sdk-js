import {
  AGENT_CONSUMPTION_KIND,
  AGENT_SAFETY_VERSION,
  type AgentApprovalUseConsumer,
  type AgentEnvelopeSigner,
  type AgentEnvelopeVerifier,
} from "@honua/sdk-js/agent-safety";
import type { HonuaAgentRuntime } from "@honua/sdk-js/agent-tools";
import { type NlMapPlan, approveNlMapPlan, nlMapRuntimeBinding } from "@honua/sdk-js/nl-map-control";
import { canonicalStringify, sha256, toJsonValue } from "@honua/sdk-js/query-planner";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../src/index.js";
import {
  type McpNlMapExecutionResponse,
  type McpNlMapPlanResponse,
  type NlMapControlMcpHost,
  createNlMapControlMcpHost,
} from "../../src/nl-map-control.js";
import { asClient, createMockClient } from "../test-helpers.js";

const NOW = "2026-07-15T20:00:00.000Z";
const EXPIRES = "2026-07-15T20:05:00.000Z";
const INSTRUCTION = "Center the map on Honolulu for incident review";

interface Harness {
  readonly client: Client;
  readonly server: McpServer;
  readonly host: NlMapControlMcpHost;
  readonly effects: unknown[];
  readonly store: DeterministicUseStore;
  setNow(value: string): void;
  setScopes(value: readonly string[]): void;
  close(): Promise<void>;
}

const openHarnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

describe("MCP certification — NL map control", () => {
  it("discovers proposeMapPlan and executeMapPlan with their safety annotations", async () => {
    const harness = await createHarness();
    const tools = (await harness.client.listTools()).tools;
    const propose = tools.find((tool) => tool.name === "proposeMapPlan");
    const execute = tools.find((tool) => tool.name === "executeMapPlan");

    expect(propose?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(execute?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
  });

  it("round-trips propose, signed approval, and execute through MCP transport", async () => {
    const harness = await createHarness();
    const proposed = await propose(harness);
    const approval = await approve(proposed.plan);
    const result = await call<McpNlMapExecutionResponse>(harness.client, "executeMapPlan", {
      plan: proposed.plan,
      approval,
    });

    expect(result.isError).toBe(false);
    expect(result.value).toMatchObject({
      planId: proposed.plan.id,
      planFingerprint: proposed.plan.fingerprint,
      mode: "approved",
      outcome: "succeeded",
      receipt: {
        kind: "honua.mcp-nl-map-receipt",
        planId: proposed.plan.id,
        planFingerprint: proposed.plan.fingerprint,
        approvalDigest: approval.approval.envelopeDigest,
      },
    });
    expect(result.value.receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(harness.effects).toHaveLength(1);
  });

  it("refuses missing, expired, replayed, wrong-scope, and tampered approvals before mutation", async () => {
    const harness = await createHarness();
    const proposed = await propose(harness);

    const missing = await call(harness.client, "executeMapPlan", { plan: proposed.plan });
    expect(missing).toMatchObject({ isError: true, value: { error: { code: "approval-required" } } });
    expect(harness.effects).toHaveLength(0);

    const valid = await approve(proposed.plan);
    harness.setScopes(["map:read"]);
    const wrongScope = await call(harness.client, "executeMapPlan", { plan: proposed.plan, approval: valid });
    expect(wrongScope).toMatchObject({
      isError: true,
      value: { error: { code: "authorization-scope-denied" } },
    });
    expect(harness.effects).toHaveLength(0);

    harness.setScopes(["map:control"]);
    const tamperedApproval = structuredClone(valid);
    (tamperedApproval.approval as { signature: string }).signature = "sha256:tampered";
    const tampered = await call(harness.client, "executeMapPlan", {
      plan: proposed.plan,
      approval: tamperedApproval,
    });
    expect(tampered.isError).toBe(true);
    expect(harness.effects).toHaveLength(0);

    harness.setNow("2026-07-15T20:06:00.000Z");
    const expired = await call(harness.client, "executeMapPlan", {
      plan: proposed.plan,
      approval: await approve(proposed.plan, { approvalId: "expired-approval" }),
    });
    expect(expired.isError).toBe(true);
    expect(harness.effects).toHaveLength(0);

    harness.setNow(NOW);
    const first = await call(harness.client, "executeMapPlan", { plan: proposed.plan, approval: valid });
    expect(first.isError).toBe(false);
    expect(harness.effects).toHaveLength(1);
    const replay = await call(harness.client, "executeMapPlan", { plan: proposed.plan, approval: valid });
    expect(replay).toMatchObject({ isError: true, value: { error: { code: "policy-denied" } } });
    expect(harness.effects).toHaveLength(1);
  });

  it("rejects tampered plan content and plan ids before consuming approval or mutating", async () => {
    const harness = await createHarness();
    const proposed = await propose(harness);
    const approval = await approve(proposed.plan);
    const contentTamper = structuredClone(proposed.plan);
    (contentTamper.steps[0].call as { args: { zoom: number } }).args.zoom = 20;
    const contentResult = await call(harness.client, "executeMapPlan", {
      plan: contentTamper,
      approval,
    });
    expect(contentResult.isError).toBe(true);

    const identityTamper = structuredClone(proposed.plan);
    (identityTamper as { id: string }).id = "nlplan_0000000000000000";
    const identityResult = await call(harness.client, "executeMapPlan", {
      plan: identityTamper,
      approval,
    });
    expect(identityResult.isError).toBe(true);
    expect(harness.store.consumedCount).toBe(0);
    expect(harness.effects).toHaveLength(0);
  });

  it("propagates MCP cancellation into approval consumption and never mutates", async () => {
    const harness = await createHarness();
    const proposed = await propose(harness);
    const approval = await approve(proposed.plan, { approvalId: "cancelled-approval" });
    const blocked = harness.store.blockNextConsumption();
    const abort = new AbortController();
    const pending = harness.client.callTool(
      { name: "executeMapPlan", arguments: { plan: proposed.plan, approval } },
      undefined,
      { signal: abort.signal },
    );

    await blocked.started;
    abort.abort();
    blocked.release();
    await pending.catch(() => undefined);
    await Promise.resolve();

    expect(harness.store.consumedCount).toBe(0);
    expect(harness.effects).toHaveLength(0);
  });

  it("emits byte-identical redacted receipts bound to the plan", async () => {
    const firstHarness = await createHarness();
    const firstPlan = await propose(firstHarness);
    const first = await call<McpNlMapExecutionResponse>(firstHarness.client, "executeMapPlan", {
      plan: firstPlan.plan,
      approval: await approve(firstPlan.plan),
    });

    const secondHarness = await createHarness();
    const secondPlan = await propose(secondHarness);
    const second = await call<McpNlMapExecutionResponse>(secondHarness.client, "executeMapPlan", {
      plan: secondPlan.plan,
      approval: await approve(secondPlan.plan),
    });

    expect(JSON.stringify(first.value.receipt)).toBe(JSON.stringify(second.value.receipt));
    const serialized = JSON.stringify(first.value.receipt);
    expect(serialized).not.toContain("instruction");
    expect(serialized).not.toContain("credentials");
    expect(serialized).not.toContain("cursor");
    expect(first.value.receipt.planFingerprint).toBe(firstPlan.plan.fingerprint);
  });

  it("refuses a proposal rather than returning credential-bearing endpoint or query values", async () => {
    const harness = await createHarness();
    const secret = "do-not-return-this-token";
    const result = await call(harness.client, "proposeMapPlan", {
      instruction: `Open https://maps.example.test/private?token=${secret}&cursor=raw-cursor`,
    });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({ isError: true, value: { error: { code: "unsafe-output" } } });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("raw-cursor");
    expect(harness.effects).toHaveLength(0);
  });
});

async function createHarness(): Promise<Harness> {
  let currentTime = NOW;
  let scopes: readonly string[] = ["map:control"];
  const effects: unknown[] = [];
  const runtime: HonuaAgentRuntime = {
    id: "mcp-nl-fixture",
    listSources: () => [],
    listLayers: () => [],
    getSelection: () => [],
    getViewport: () => ({ center: [-157.8583, 21.3069], zoom: 9 }),
    setViewport: (viewport) => {
      effects.push({ op: "setViewport", viewport });
      return viewport;
    },
  };
  const crypto = testCrypto();
  const store = new DeterministicUseStore(() => currentTime);
  const host = createNlMapControlMcpHost({
    control: {
      tools: { runtime, context: { includeSafeExamples: false } },
      llm: async () => ({
        toolCalls: [{ name: "setViewport", arguments: { center: [-157.8583, 21.3069], zoom: 12 } }],
      }),
      policy: { actor: "mcp-certifier", now: () => currentTime },
      approvalVerifier: crypto.verifier,
      receiptSigner: testCrypto("receipt-secret").signer,
    },
    approvalUseConsumer: store,
    resolveAuthorizationScopes: () => scopes,
  });
  const server = createServer(asClient(createMockClient()), { nlMapControl: host });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nl-map-control-certifier", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const harness: Harness = {
    client,
    server,
    host,
    effects,
    store,
    setNow(value) {
      currentTime = value;
    },
    setScopes(value) {
      scopes = value;
    },
    async close() {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
  openHarnesses.push(harness);
  return harness;
}

async function propose(harness: Harness): Promise<McpNlMapPlanResponse> {
  const result = await call<McpNlMapPlanResponse>(harness.client, "proposeMapPlan", { instruction: INSTRUCTION });
  expect(result.isError).toBe(false);
  return result.value;
}

async function approve(
  plan: NlMapPlan,
  overrides: { readonly approvalId?: string } = {},
): ReturnType<typeof approveNlMapPlan> {
  return approveNlMapPlan({
    plan,
    actor: "mcp-certifier",
    approver: "fixture-reviewer",
    signer: testCrypto().signer,
    bindings: {
      map: nlMapRuntimeBinding({ observedAt: NOW, authorizationScope: ["map:control"] }),
    },
    issuedAt: NOW,
    expiresAt: EXPIRES,
    now: NOW,
    ...overrides,
  });
}

async function call<T = { error: { code: string; message: string } }>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly isError: boolean; readonly value: T }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    readonly isError?: boolean;
    readonly content: readonly { readonly type: string; readonly text?: string }[];
  };
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no text content`);
  return { isError: result.isError === true, value: JSON.parse(text) as T };
}

function testCrypto(secret = "approval-secret"): {
  readonly signer: AgentEnvelopeSigner;
  readonly verifier: AgentEnvelopeVerifier;
} {
  return {
    signer: {
      algorithm: "fixture-sha256",
      keyId: "fixture-key",
      sign: async (payload) => sha256(`${secret}:${payload}`),
    },
    verifier: {
      algorithm: "fixture-sha256",
      keyId: "fixture-key",
      verify: async (payload, signature) => signature === sha256(`${secret}:${payload}`),
    },
  };
}

class DeterministicUseStore implements AgentApprovalUseConsumer {
  readonly #uses = new Set<string>();
  readonly #now: () => string;
  #block:
    | {
        readonly started: () => void;
        readonly wait: Promise<void>;
        release(): void;
      }
    | undefined;

  public constructor(now: () => string) {
    this.#now = now;
  }

  public get consumedCount(): number {
    return this.#uses.size;
  }

  public blockNextConsumption(): { readonly started: Promise<void>; release(): void } {
    let announce!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#block = { started: announce, wait, release };
    return { started, release };
  }

  public async consume(
    use: {
      readonly approvalDigest: `sha256:${string}`;
      readonly stepId: string;
      readonly inputDigest: `sha256:${string}`;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    const blocked = this.#block;
    if (blocked) {
      this.#block = undefined;
      blocked.started();
      await blocked.wait;
    }
    signal?.throwIfAborted();
    const key = `${use.approvalDigest}:${use.stepId}:${use.inputDigest}`;
    if (this.#uses.has(key)) return false;
    this.#uses.add(key);
    const unsigned = {
      kind: AGENT_CONSUMPTION_KIND,
      version: AGENT_SAFETY_VERSION,
      id: `mcp-use-${sha256(key).slice("sha256:".length, "sha256:".length + 16)}`,
      nonce: sha256(`nonce:${key}`),
      consumedAt: this.#now(),
      ...use,
    };
    return { ...unsigned, token: sha256(canonicalStringify(toJsonValue(unsigned))) };
  }

  public async verify(input: unknown): Promise<boolean> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const { token, ...unsigned } = input as Record<string, unknown>;
    return token === sha256(canonicalStringify(toJsonValue(unsigned)));
  }
}
