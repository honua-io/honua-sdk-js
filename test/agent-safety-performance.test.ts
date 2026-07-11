import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import {
  AGENT_PLAN_KIND,
  AGENT_SAFETY_VERSION,
  digestAgentOperationInput,
  dryRunAgentPlan,
} from "../src/agent-safety/index.js";
import { sha256 } from "../src/query-planner/index.js";

it("keeps 500 strict dry runs inside the deterministic in-process budget", () => {
  const operation = {
    tool: "query",
    effect: "read",
    sourceId: "incidents",
    queryPlan: { id: "query-plan", fingerprint: sha256("plan") },
    fields: ["OBJECTID", "status"],
    parameters: { where: "1=1" },
  };
  const plan = {
    kind: AGENT_PLAN_KIND,
    version: AGENT_SAFETY_VERSION,
    id: "perf-plan",
    actor: "fixture",
    steps: [
      {
        id: "query",
        tool: "query",
        effect: "read",
        source: {
          id: "incidents",
          schemaVersion: "s1",
          sourceVersion: "v1",
          authorizationScope: ["read"],
          provenance: {
            dataMode: "replayed",
            observedAt: "2026-07-10T20:00:00.000Z",
            attribution: "fixture",
            citations: [{ uri: "https://example.test/data" }],
          },
        },
        queryPlan: { id: "query-plan", fingerprint: sha256("plan") },
        parametersDigest: sha256('{"where":"1=1"}'),
        inputDigest: digestAgentOperationInput(operation),
        fields: ["OBJECTID", "status"],
        limits: { rows: 100, bytes: 10_000 },
      },
    ],
  };
  const policy = {
    allowedTools: ["query"],
    sources: {
      incidents: {
        fields: ["status", "OBJECTID"],
        authorizationScope: ["read"],
        citationOrigins: ["https://example.test"],
        citationResourcePrefixes: ["/data"],
      },
    },
    maxSteps: 1,
    maxRows: 100,
    maxBytes: 10_000,
    maxFieldsPerStep: 8,
    maxAuthorizationScopesPerSource: 4,
    maxCitationsPerSource: 2,
    maxOperationParameterBytes: 1_024,
    maxOperationParameterNodes: 32,
    maxOperationParameterDepth: 4,
  };

  const started = performance.now();
  for (let index = 0; index < 500; index++) dryRunAgentPlan(plan, policy);
  const elapsedMs = performance.now() - started;

  expect(elapsedMs).toBeLessThan(1_000);
});
