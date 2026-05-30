import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  TEMPORAL_CAPABILITY,
  TEMPORAL_ROUTES,
  TEMPORAL_SCHEMA_VERSION,
  assertValidTemporalRollbackPlanRequest,
  createTemporalClient,
  isReadOnlyTemporalHistory,
  temporalModeSupports,
  validateTemporalRollbackPlanRequest,
} from "../src/contract/index.js";
import type {
  TemporalContractFixture,
  TemporalErrorCode,
  TemporalMode,
  TemporalRequestClient,
  TemporalRollbackPlanRequest,
  TemporalSourceCapability,
  TemporalValidationIssue,
} from "../src/contract/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/temporal");
const fixture = JSON.parse(
  readFileSync(resolve(fixturesDir, "parcels-history.v1.json"), "utf8"),
) as TemporalContractFixture;

const ALL_MODES: readonly TemporalMode[] = ["none", "as_of", "history", "diff", "rollback"];
const ALL_ERROR_CODES: readonly TemporalErrorCode[] = [
  "unsupported-history",
  "masked-fields",
  "expired-retention",
  "large-diff-job-required",
  "rollback-blocked",
  "approval-required",
];

function capabilityWithMode(mode: TemporalMode): TemporalSourceCapability {
  return {
    ...fixture.capability,
    mode,
    rollbackSupported: mode === "rollback",
  };
}

const paths = (issues: readonly TemporalValidationIssue[]): readonly string[] => issues.map((issue) => issue.path);

describe("temporal contract", () => {
  it("pins a stable schema version, capability id, and route set", () => {
    expect(TEMPORAL_SCHEMA_VERSION).toBe("honua.temporal.v1");
    expect(fixture.schemaVersion).toBe(TEMPORAL_SCHEMA_VERSION);
    expect(TEMPORAL_CAPABILITY).toBe("temporalHistory");
    expect(TEMPORAL_ROUTES.queryAsOf).toBe("/temporal/query-as-of");
    expect(TEMPORAL_ROUTES.rollbackOperationStatus).toContain("{operationId}");
  });

  it("models every declared temporal mode and ranks them additively", () => {
    for (const mode of ALL_MODES) {
      const capability = capabilityWithMode(mode);
      // Every mode supports `none`, and supports itself.
      expect(temporalModeSupports(capability, "none")).toBe(true);
      expect(temporalModeSupports(capability, mode)).toBe(true);
    }

    const rollback = capabilityWithMode("rollback");
    expect(temporalModeSupports(rollback, "diff")).toBe(true);
    expect(temporalModeSupports(rollback, "history")).toBe(true);
    expect(temporalModeSupports(rollback, "as_of")).toBe(true);

    const none = capabilityWithMode("none");
    expect(temporalModeSupports(none, "as_of")).toBe(false);

    const asOf = capabilityWithMode("as_of");
    expect(temporalModeSupports(asOf, "diff")).toBe(false);
    expect(temporalModeSupports(asOf, "rollback")).toBe(false);
  });

  it("distinguishes read-only history from rollback-capable editing", () => {
    expect(isReadOnlyTemporalHistory(capabilityWithMode("history"))).toBe(true);
    expect(isReadOnlyTemporalHistory(capabilityWithMode("diff"))).toBe(true);
    expect(isReadOnlyTemporalHistory(capabilityWithMode("rollback"))).toBe(false);
    expect(isReadOnlyTemporalHistory(capabilityWithMode("none"))).toBe(false);
  });

  it("represents every error/status code explicitly in the fixture", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(fixture.errors[code]?.code).toBe(code);
    }
    expect(fixture.errors["masked-fields"].maskedFields).toEqual(["ssn", "tax_id"]);
    expect(fixture.errors["large-diff-job-required"].job?.jobRunId).toBe("job-diff-1201");
    expect(fixture.errors["approval-required"].requiredApprovals).toContain("data-steward");
  });

  it("validates rollback plan requests by target scope", () => {
    expect(validateTemporalRollbackPlanRequest(fixture.rollback.planRequest)).toEqual([]);
    expect(() => assertValidTemporalRollbackPlanRequest(fixture.rollback.planRequest)).not.toThrow();

    const missingFeatureIds: TemporalRollbackPlanRequest = {
      sourceId: "parcels",
      targetScope: "feature",
      targetCheckpointId: "cp-x",
    };
    expect(paths(validateTemporalRollbackPlanRequest(missingFeatureIds))).toEqual(["featureIds"]);

    const releaseMissingId: TemporalRollbackPlanRequest = {
      sourceId: "parcels",
      targetScope: "release",
      targetCheckpointId: "cp-x",
    };
    expect(paths(validateTemporalRollbackPlanRequest(releaseMissingId))).toEqual(["releaseOperationId"]);

    const empty: TemporalRollbackPlanRequest = {
      sourceId: "",
      targetScope: "layer",
      targetCheckpointId: "",
    };
    expect(paths(validateTemporalRollbackPlanRequest(empty))).toEqual(
      expect.arrayContaining(["sourceId", "targetCheckpointId", "layerId"]),
    );
    expect(() => assertValidTemporalRollbackPlanRequest(empty)).toThrow("Invalid temporal rollback plan request");
  });

  it("builds request paths and bodies for every temporal endpoint", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const stub: TemporalRequestClient = {
      pipelineRequestJson: async <T>(
        method: "GET" | "POST",
        path: string,
        init?: { headers?: HeadersInit; body?: BodyInit | null },
      ): Promise<T> => {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, path, body });
        return undefined as T;
      },
    };
    const client = createTemporalClient(stub);

    await client.capabilities("cadastre/parcels");
    await client.listCheckpoints("parcels");
    await client.queryAsOf(fixture.asOf.request);
    await client.requestDiff(fixture.diff.request);
    await client.getDiff("diff-55aa", { cursor: "page-2" });
    await client.featureTimeline(fixture.featureTimeline.request);
    await client.createRollbackPlan(fixture.rollback.planRequest);
    await client.executeRollback({ rollbackPlanId: "rbp-77", approvedBy: "u-1" });
    await client.rollbackOperationStatus("rbo-91");

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /temporal/capabilities?resourceId=cadastre%2Fparcels",
      "GET /temporal/checkpoints?sourceId=parcels",
      "POST /temporal/query-as-of",
      "POST /temporal/diff",
      "GET /temporal/diffs/diff-55aa?cursor=page-2",
      "POST /temporal/features/parcel-42/timeline",
      "POST /temporal/rollback-plans",
      "POST /temporal/rollback-operations",
      "GET /temporal/rollback-operations/rbo-91",
    ]);

    const diffCall = calls.find((c) => c.path === "/temporal/diff");
    expect(diffCall?.body).toMatchObject({ sourceId: "parcels", includeAttributeChanges: true });
  });

  it("rejects an invalid rollback plan before issuing a request", async () => {
    const stub: TemporalRequestClient = {
      pipelineRequestJson: async <T>(): Promise<T> => {
        throw new Error("should not be called");
      },
    };
    const client = createTemporalClient(stub);
    await expect(
      client.createRollbackPlan({ sourceId: "parcels", targetScope: "feature", targetCheckpointId: "cp-x" }),
    ).rejects.toThrow("Invalid temporal rollback plan request");
  });

  it("exposes a coherent rollback review fixture", () => {
    expect(fixture.rollback.plan.requiresApproval).toBe(true);
    expect(fixture.rollback.plan.rollbackMode).toBe("data_revert");
    expect(fixture.rollback.operation.rollbackPlanId).toBe(fixture.rollback.plan.rollbackPlanId);
    expect(fixture.diff.response.summary?.updatedFeatures).toBe(27);
    expect(fixture.diff.response.sampleFeatureChanges?.[0]?.attributeChanges?.[1]).toMatchObject({
      field: "ssn",
      masked: true,
    });
  });
});
