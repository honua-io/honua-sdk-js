import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  SOURCE_VERSION,
  createProposal,
  createSafeAgentSession,
  describeHostLane,
  fixtureProposal,
} from "../examples/ai-spatial-app-builder/src/safe-agent.js";

describe("AI Spatial App Builder safe-agent kernel", () => {
  it("runs deterministic proposal → validation → approval → execution → receipt without early effects", async () => {
    const session = createSafeAgentSession();
    expect(session.state).toBe("proposed");
    expect(session.executionCount).toBe(0);

    const plan = session.validate();
    expect(plan.valid).toBe(true);
    expect(plan.queryPlan.ir.source).toMatchObject({
      sourceVersion: SOURCE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      authorizationScope: ["parcels:read"],
      capabilities: ["query"],
    });
    expect(plan.queryPlan.ir.query.outSr).toBe(4326);
    expect(session.executionCount).toBe(0);

    const grant = session.decide("approve");
    expect(grant.planDigest).toBe(plan.approvalDigest);
    expect(session.executionCount).toBe(0);

    const receipt = await session.execute();
    expect(session.executionCount).toBe(1);
    expect(receipt.rowCount).toBe(5);
    expect(receipt.effect).toBe("read");
    expect(session.verifyReceipt(receipt)).toBe(true);
  });

  it("supports narrowing and rejection without widening or executing", async () => {
    const narrowed = createSafeAgentSession();
    narrowed.validate();
    narrowed.decide("narrow", 2);
    expect((await narrowed.execute()).rowCount).toBe(2);

    const rejected = createSafeAgentSession();
    rejected.validate();
    rejected.decide("reject");
    await expect(rejected.execute()).rejects.toThrow(/explicit approval/);
    expect(rejected.executionCount).toBe(0);

    const invalidNarrow = createSafeAgentSession();
    invalidNarrow.validate();
    expect(() => invalidNarrow.decide("narrow", 6)).toThrow(/between 1 and 5/);
  });

  it.each([
    [
      "mutation",
      createProposal({
        requestedEffect: "mutation",
        toolCalls: [{ name: "applyEdits", effect: "mutation", reason: "write" }],
      }),
    ],
    [
      "realtime",
      createProposal({
        requestedEffect: "realtime",
        toolCalls: [{ name: "subscribe", effect: "realtime", reason: "stream" }],
      }),
    ],
    ["excessive limit", createProposal({ query: { ...fixtureProposal.query, pagination: { limit: 500 } } })],
    [
      "unsupported capability",
      createProposal({ toolCalls: [{ name: "publishLayer", effect: "generated-app", reason: "publish" }] }),
    ],
  ])("refuses %s proposals before effects", (_label, proposal) => {
    const session = createSafeAgentSession(proposal);
    expect(session.validate().valid).toBe(false);
    expect(session.state).toBe("refused");
    expect(session.executionCount).toBe(0);
    expect(() => session.decide("approve")).toThrow(/valid/);
  });

  it("rejects plan tampering and approval replay before source access", async () => {
    const first = createSafeAgentSession();
    const plan = first.validate();
    first.decide("approve");
    const tampered = {
      ...plan,
      policy: { ...plan.policy, maxRows: 500 },
    };
    await expect(first.execute({ planOverride: tampered })).rejects.toThrow(/tampered/);
    expect(first.executionCount).toBe(0);

    const other = createSafeAgentSession(createProposal({ id: "other-proposal" }));
    const otherPlan = other.validate();
    other.decide("approve");
    await expect(other.execute({ planOverride: plan })).rejects.toThrow(/Approval does not match/);
    expect(otherPlan.approvalDigest).not.toBe(plan.approvalDigest);
    expect(other.executionCount).toBe(0);
  });

  it.each([
    ["stale source", { sourceVersion: "stale-source" }],
    ["stale schema", { schemaVersion: "stale-schema" }],
    ["authorization drift", { authorizationScope: ["parcels:admin"] }],
  ])("rejects %s context before source access", async (_label, context) => {
    const session = createSafeAgentSession();
    session.validate();
    session.decide("approve");
    await expect(session.execute(context)).rejects.toThrow(/context|changed/i);
    expect(session.executionCount).toBe(0);
  });

  it("detects receipt tampering and reports host lanes honestly", async () => {
    const session = createSafeAgentSession();
    session.validate();
    session.decide("approve");
    const receipt = await session.execute();
    expect(session.verifyReceipt({ ...receipt, rowCount: 99 })).toBe(false);
    expect(describeHostLane()).toMatchObject({ state: "skipped", browserSecrets: false });
    expect(describeHostLane({ proposalEndpoint: "/host/proposal", liveDataEndpoint: "/host/data" })).toMatchObject({
      state: "available",
      model: "host-mediated",
      browserSecrets: false,
    });
  });
});
