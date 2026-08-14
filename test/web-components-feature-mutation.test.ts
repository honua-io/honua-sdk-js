import { describe, expect, it, vi } from "vitest";

import {
  HONUA_FEATURE_MUTATION_RECEIPT_KIND,
  type HonuaFeatureMutationParticipant,
  createHonuaFeatureMutationReceipt,
  createHonuaFeatureMutationReconciler,
} from "../src/web-components/feature-mutation.js";

describe("feature mutation receipts", () => {
  it("describes one accepted edit without credentials or attachment payloads", () => {
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-1",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "ogc-features",
      operation: "update",
      status: "accepted",
      featureId: 7,
      feature: { id: 7, attributes: { status: "approved" } },
      attachmentMutations: 1,
      optimistic: { applied: true, rolledBack: false },
    });

    expect(receipt).toMatchObject({
      kind: HONUA_FEATURE_MUTATION_RECEIPT_KIND,
      version: 1,
      mutationId: "edit-1",
      sourceId: "permits",
      protocol: "ogc-features",
      operation: "update",
      selection: "select",
    });
    expect(receipt.invalidates).toEqual([
      "query",
      "feature",
      "map",
      "table",
      "details",
      "counts",
      "selection",
      "tiles",
      "offline",
    ]);
    expect(JSON.stringify(receipt)).not.toMatch(/authorization|bearer|attachment.*bytes/i);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("clears selection for a delete", () => {
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-delete",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "geoservices-feature-service",
      operation: "delete",
      status: "accepted",
      featureId: 7,
    });
    expect(receipt.selection).toBe("clear");
    expect(receipt.feature).toBeUndefined();
  });
});

describe("feature mutation reconciliation", () => {
  it("updates every configured owner once and deduplicates a realtime echo", async () => {
    const calls: string[] = [];
    const targets = ["map", "table", "details", "counts", "selection"] as const;
    const participants: HonuaFeatureMutationParticipant[] = targets.map((target) => ({
      target,
      apply: vi.fn(() => {
        calls.push(target);
      }),
    }));
    const reconciler = createHonuaFeatureMutationReconciler(participants);
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-2",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "wfs",
      operation: "create",
      status: "accepted",
      featureId: "permit.8",
    });

    await expect(reconciler.reconcile(receipt)).resolves.toMatchObject({ status: "applied" });
    expect(calls).toEqual(["map", "table", "details", "counts", "selection"]);
    await expect(reconciler.reconcile(receipt)).resolves.toEqual({
      mutationId: "edit-2",
      status: "duplicate",
      applied: [],
      failures: [],
    });
    expect(calls).toHaveLength(5);
  });

  it("reports a partial reconciliation and permits a safe retry", async () => {
    let tableAttempts = 0;
    const applyMap = vi.fn();
    const reconciler = createHonuaFeatureMutationReconciler([
      { target: "map", apply: applyMap },
      {
        target: "table",
        apply: () => {
          tableAttempts += 1;
          if (tableAttempts === 1) throw new Error("refresh failed");
        },
      },
    ]);
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-3",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "odata",
      operation: "update",
      status: "partially-accepted",
      featureId: 9,
    });

    const first = await reconciler.reconcile(receipt);
    expect(first.status).toBe("partial");
    expect(first.failures).toMatchObject([{ target: "table" }]);
    await expect(reconciler.reconcile(receipt)).resolves.toMatchObject({ status: "applied" });
    expect(tableAttempts).toBe(2);
    expect(applyMap).toHaveBeenCalledOnce();
  });

  it("does not invoke participants after reconciliation is aborted", async () => {
    const applyMap = vi.fn();
    const reconciler = createHonuaFeatureMutationReconciler([{ target: "map", apply: applyMap }]);
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-aborted",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "ogc-features",
      operation: "update",
      status: "accepted",
      featureId: 10,
    });
    const controller = new AbortController();
    controller.abort(new Error("host disposed"));

    await expect(reconciler.reconcile(receipt, { signal: controller.signal })).rejects.toThrow("host disposed");
    expect(applyMap).not.toHaveBeenCalled();
  });
});
