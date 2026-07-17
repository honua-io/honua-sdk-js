import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { sha256 } from "../src/query-planner/canonical.js";
import {
  hashQueryPlanV1 as hashQueryPlanV1Direct,
  hashQueryPlanV1WithSubtleCrypto,
} from "../src/query-planner/plan-integrity.js";
import { explainQuery, hashQueryPlanV1 } from "../src/query-planner/planner.js";
import type { QueryExecutionPlanV1 } from "../src/query-planner/types.js";

const descriptor: SourceDescriptor = {
  id: "integrity-fixture",
  protocol: "geoservices-feature-service",
  locator: {
    url: "https://demo.honua.io/FeatureServer",
    serviceId: "integrity-fixture",
    layerId: 0,
  },
  capabilities: capabilities(["query"]),
  schema: { primaryKey: "OBJECTID" },
};

function plan(): QueryExecutionPlanV1 {
  return explainQuery({
    descriptor,
    query: { where: "status = 'active'", pagination: { limit: 25 }, returnGeometry: true },
    sourceVersion: "snapshot-7",
    schemaVersion: "schema-3",
    authorizationScope: ["incidents:read"],
  });
}

function asPlan(value: unknown): QueryExecutionPlanV1 {
  return value as QueryExecutionPlanV1;
}

async function expectHashParity(candidate: QueryExecutionPlanV1, expected: string | undefined): Promise<void> {
  expect(hashQueryPlanV1(candidate)).toBe(expected);
  expect(hashQueryPlanV1Direct(candidate)).toBe(expected);
  await expect(hashQueryPlanV1WithSubtleCrypto(candidate)).resolves.toBe(expected);
}

describe("query-plan v1 integrity authority", () => {
  it("keeps planner, direct synchronous, and SubtleCrypto fingerprints byte-for-byte identical", async () => {
    const accepted = plan();
    await expectHashParity(accepted, accepted.fingerprint);

    const tampered = structuredClone(accepted);
    const steps = tampered.steps as unknown as Array<{ reason: string }>;
    steps[0] = { ...steps[0]!, reason: `${steps[0]!.reason} tampered` };
    const tamperedHash = hashQueryPlanV1(tampered);
    expect(tamperedHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(tamperedHash).not.toBe(accepted.fingerprint);
    await expectHashParity(tampered, tamperedHash);
  });

  it("fails closed with identical results for malformed and credential-bearing plans", async () => {
    const accepted = plan();
    const attacks: unknown[] = [
      { ...structuredClone(accepted), version: "2.0" },
      { ...structuredClone(accepted), diagnosticsVersion: "future" },
      { ...structuredClone(accepted), fingerprint: "sha256:not-a-digest" },
      { ...structuredClone(accepted), transport: { locator: { userinfo: "alice:locator-marker" } } },
      { ...structuredClone(accepted), transport: { headers: { "X-Auth": "header-marker" } } },
      { ...structuredClone(accepted), transport: { query: { auth: "query-marker" } } },
      { ...structuredClone(accepted), note: "Bearer credential-marker-12345678" },
      { ...structuredClone(accepted), endpoint: "https://alice:password@example.test/data" },
      { ...structuredClone(accepted), endpoint: "https://example.test/data?token=query-marker" },
    ];
    const cyclic = structuredClone(accepted) as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    attacks.push(cyclic);

    const legacy = structuredClone(accepted) as unknown as {
      ir: { source: Record<string, unknown> };
    };
    legacy.ir.source.protocol = "geoparquet";
    legacy.ir.source.geoparquet = { sources: ["https://example.test/data.parquet?sig=locator-marker"] };
    attacks.push(legacy);

    for (const attack of attacks) await expectHashParity(asPlan(attack), undefined);
  });
});

describe("portable SHA-256 constants", () => {
  it("matches Node's SHA-256 across boundary and Unicode inputs", () => {
    const inputs = [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(65),
      "Honua 🌋 GIS 🗺️",
      "0123456789abcdef".repeat(4_096),
    ];
    for (const input of inputs) {
      const expected = `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
      expect(sha256(input)).toBe(expected);
    }
  });
});
