import { describe, expect, it } from "vitest";
import {
  AGENT_SAFETY_EVIDENCE_KIND,
  deriveAgentSafetyEvidence,
  verifyAgentSafetyEvidence,
} from "../src/agent-safety/index.js";
import { type ConnectDiscoverySnapshot, HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION } from "../src/connect.js";
import { type SourceDescriptor, capabilities } from "../src/contract/index.js";
import { explainQuery } from "../src/query-planner/index.js";

const descriptor: SourceDescriptor = {
  id: "incidents",
  protocol: "ogc-features",
  locator: { url: "https://data.example.test/ogc?token=secret", collectionId: "incidents" },
  capabilities: capabilities(["query"]),
};

function plan() {
  return explainQuery({
    descriptor,
    query: { where: "status = 'open'", outFields: ["id", "status"], pagination: { limit: 100 } },
    schemaVersion: "schema-7",
    sourceVersion: "snapshot-9",
    authorizationScope: ["incidents:read"],
  });
}

function discovery(): ConnectDiscoverySnapshot {
  const evidence = [
    {
      kind: "metadata" as const,
      capabilities: ["query" as const],
      provenance: [
        {
          source: "https://data.example.test/ogc?token=must-not-persist",
          retrievedAt: "2026-07-12T09:00:00.000Z",
          validator: "etag-secret",
        },
      ],
    },
  ];
  return {
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: "credential-free-cache-key",
    endpoint: "https://data.example.test/ogc",
    protocol: "ogc-features",
    retrievedAt: "2026-07-12T09:00:00.000Z",
    evidence,
    sources: [
      {
        id: "incidents",
        locator: { url: "https://data.example.test/ogc", collectionId: "incidents" },
        evidence,
      },
    ],
  };
}

describe("derived agent safety evidence", () => {
  it("binds accepted plan and discovery facts without retaining credentials or cursors", () => {
    const first = deriveAgentSafetyEvidence(plan(), discovery(), {
      freshness: { mode: "snapshot", maxAgeMs: 60_000 },
      realtimeCursorPresent: true,
    });
    const second = deriveAgentSafetyEvidence(plan(), discovery(), {
      freshness: { mode: "snapshot", maxAgeMs: 60_000 },
      realtimeCursorPresent: true,
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: AGENT_SAFETY_EVIDENCE_KIND,
      source: {
        id: "incidents",
        schemaVersion: "schema-7",
        sourceVersion: "snapshot-9",
        capabilities: ["query"],
      },
      freshness: { mode: "snapshot", maxAgeMs: 60_000, cursorPresent: true },
      unavailableFacts: [],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.provenance)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/secret|token=|etag|cursor-/i);
  });

  it("fails closed on plan, discovery, capability, and receipt substitution", () => {
    const acceptedPlan = plan();
    const acceptedDiscovery = discovery();
    const evidence = deriveAgentSafetyEvidence(acceptedPlan, acceptedDiscovery);
    expect(() =>
      verifyAgentSafetyEvidence(evidence, acceptedPlan, {
        ...acceptedDiscovery,
        retrievedAt: "2026-07-12T09:01:00.000Z",
      }),
    ).toThrow(/drifted/);
    expect(() =>
      deriveAgentSafetyEvidence(acceptedPlan, {
        ...acceptedDiscovery,
        evidence: [{ kind: "metadata", capabilities: [] }],
        sources: acceptedDiscovery.sources.map((source) => ({ ...source, evidence: [] })),
      }),
    ).toThrow(/lacks discovery evidence/);
    expect(() =>
      verifyAgentSafetyEvidence(
        { ...evidence, observedAt: "2026-07-12T10:00:00.000Z" },
        acceptedPlan,
        acceptedDiscovery,
      ),
    ).toThrow(/integrity check failed/);
  });

  it("records unavailable facts explicitly and never invokes hostile accessors", () => {
    const minimal = explainQuery({ descriptor, query: { pagination: { limit: 1 } } });
    const evidence = deriveAgentSafetyEvidence(minimal, discovery());
    expect(evidence.unavailableFacts).toEqual(["freshness-contract", "schema-version", "source-version"]);
    let invoked = 0;
    const hostile = Object.create(null, {
      kind: {
        enumerable: true,
        get() {
          invoked += 1;
          return "honua.query-plan";
        },
      },
    });
    expect(() => deriveAgentSafetyEvidence(hostile, discovery())).toThrow(/accessor/);
    expect(invoked).toBe(0);
  });
});
