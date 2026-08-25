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
  // A local receipt and its realtime echo can enter `reconcile()` in the same
  // tick. Both used to read a ledger that is only written after the last
  // participant resolves, so both applied every participant -- exactly the
  // double-apply the ledger exists to prevent.
  it("applies each participant once when a receipt and its realtime echo reconcile concurrently", async () => {
    const applied: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const participants: HonuaFeatureMutationParticipant<Record<string, unknown>>[] = [
      {
        target: "map",
        apply: async () => {
          applied.push("map");
          await gate;
        },
      },
      {
        target: "table",
        apply: () => {
          applied.push("table");
        },
      },
    ];
    const reconciler = createHonuaFeatureMutationReconciler(participants);
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-echo",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "ogc-features",
      operation: "update",
      status: "accepted",
      featureId: 11,
    });

    const local = reconciler.reconcile(receipt);
    const echo = reconciler.reconcile(receipt);
    release?.();
    const [first, second] = await Promise.all([local, echo]);

    expect(applied.filter((target) => target === "map")).toHaveLength(1);
    expect(applied.filter((target) => target === "table")).toHaveLength(1);
    expect(first.status).toBe("applied");
    expect(second.status).toBe("duplicate");
    expect(second.applied).toEqual([]);
  });

  it("lets a concurrent echo finish the targets a partial run left outstanding", async () => {
    let tableAttempts = 0;
    const applyMap = vi.fn();
    const reconciler = createHonuaFeatureMutationReconciler<Record<string, unknown>>([
      { target: "map", apply: applyMap },
      {
        target: "table",
        apply: () => {
          tableAttempts += 1;
          if (tableAttempts === 1) throw new Error("table refused the first pass");
        },
      },
    ]);
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-partial-echo",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "odata",
      operation: "update",
      status: "partially-accepted",
      featureId: 12,
    });

    const [first, second] = await Promise.all([reconciler.reconcile(receipt), reconciler.reconcile(receipt)]);

    expect(first.status).toBe("partial");
    expect(second.status).toBe("applied");
    expect(second.applied).toEqual(["table"]);
    // The map participant already succeeded; the resumed pass must not repeat it.
    expect(applyMap).toHaveBeenCalledOnce();
    expect(tableAttempts).toBe(2);
  });

  it("a rejected run does not reject the reconciliation queued behind it", async () => {
    const applyMap = vi.fn();
    const reconciler = createHonuaFeatureMutationReconciler<Record<string, unknown>>([
      { target: "map", apply: applyMap },
    ]);
    const receipt = createHonuaFeatureMutationReceipt<Record<string, unknown>>({
      mutationId: "edit-queued",
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceId: "permits",
      protocol: "ogc-features",
      operation: "update",
      status: "accepted",
      featureId: 13,
    });
    const controller = new AbortController();
    controller.abort(new Error("host disposed"));

    const aborted = reconciler.reconcile(receipt, { signal: controller.signal });
    const queued = reconciler.reconcile(receipt);

    await expect(aborted).rejects.toThrow("host disposed");
    await expect(queued).resolves.toMatchObject({ status: "applied" });
    expect(applyMap).toHaveBeenCalledOnce();
  });
});
