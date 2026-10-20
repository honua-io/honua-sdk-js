import { describe, expect, it, vi } from "vitest";

import type { EditWorkflowField } from "../src/contract/edit-session.js";
import type { CanonicalFeature, Capability, EditEnvelope, Source } from "../src/contract/types.js";
import type { HonuaEditorSubtypeConfig } from "../src/web-components/feature-editor-model.js";
import { createFeatureEditorWorkflow } from "../src/web-components/feature-editor-workflow.js";

const FIELDS: readonly EditWorkflowField[] = [
  { name: "OBJECTID", type: "esriFieldTypeOID", editable: false, nullable: false, defaultValue: 999 },
  { name: "category", type: "esriFieldTypeInteger", defaultValue: 2 },
  { name: "label", type: "esriFieldTypeString", nullable: false },
  { name: "status", type: "esriFieldTypeString", defaultValue: "schema" },
  { name: "count", type: "esriFieldTypeInteger", defaultValue: 5 },
  { name: "enabled", type: "boolean", defaultValue: true },
  { name: "note", type: "esriFieldTypeString", defaultValue: "fallback" },
];
const SUBTYPES: HonuaEditorSubtypeConfig = {
  field: "category",
  defaultCode: 1,
  subtypes: [
    {
      code: 1,
      name: "First",
      fieldOverrides: { label: { defaultValue: "First label" }, status: { defaultValue: "subtype-one" } },
    },
    {
      code: 2,
      name: "Second",
      fieldOverrides: { label: { defaultValue: "Second label" }, status: { defaultValue: "subtype-two" } },
    },
  ],
};

function fixture(fields = FIELDS, subtypes: HonuaEditorSubtypeConfig | null = SUBTYPES) {
  // The read path only reads stored envelopes; it never reconstructs values from
  // workflow snapshots, field metadata, or expected test constants.
  const stored = new Map<number, CanonicalFeature>();
  const capabilities = new Set<Capability>(["query", "applyEdits"]);
  const applyEdits = vi.fn(async (envelope: EditEnvelope) => {
    for (const row of envelope.adds ?? []) stored.set(7, { ...structuredClone(row), id: 7 });
    for (const row of envelope.updates ?? []) stored.set(Number(row.id), structuredClone(row));
    for (const id of envelope.deletes ?? []) stored.delete(Number(id));
    return {
      added: (envelope.adds ?? []).map(() => ({ id: 7, success: true })),
      updated: (envelope.updates ?? []).map((row) => ({ id: row.id, success: true })),
      deleted: (envelope.deletes ?? []).map((id) => ({ id, success: true })),
    };
  });
  const source = {
    descriptor: {
      id: "defaults",
      protocol: "geoservices-feature-service",
      locator: { url: "https://fixture.invalid/FeatureServer/0" },
      capabilities,
    },
    capabilities,
    applyEdits,
    query: vi.fn(async () => ({ features: [...stored.values()].map((row) => structuredClone(row)) })),
  } as unknown as Source;
  const workflow = createFeatureEditorWorkflow({
    source,
    metadata: { fields, primaryKey: "OBJECTID" },
    subtypes: subtypes ?? undefined,
  });
  return { workflow, applyEdits, source };
}

describe("Editor create default materialization", () => {
  it("shows, validates, transports and independently reads back untouched subtype and schema defaults", async () => {
    const { workflow, source, applyEdits } = fixture();
    const state = workflow.begin("create");
    expect(state.form?.controls.find((field) => field.name === "label")?.value).toBe("First label");
    expect(workflow.preflight().ready).toBe(true);
    expect(applyEdits).not.toHaveBeenCalled();
    expect((await workflow.submit()).status).toBe("committed");
    const expected = {
      category: 1,
      label: "First label",
      status: "subtype-one",
      count: 5,
      enabled: true,
      note: "fallback",
    };
    expect(applyEdits.mock.calls[0]?.[0].adds?.[0]?.attributes).toEqual(expected);
    const rows = await source.query();
    expect(rows.features).toEqual([{ id: 7, attributes: expected }]);
    expect(rows.features[0]?.attributes).not.toHaveProperty("OBJECTID");
  });

  it("gives explicit template values precedence and preserves null, zero, false and empty strings", async () => {
    const { workflow, source } = fixture();
    const attributes = { category: 2, label: "Template label", status: null, count: 0, enabled: false, note: "" };
    const before = structuredClone(attributes);
    const state = workflow.begin("create", { attributes });
    expect(state.form?.controls.find((field) => field.name === "category")?.value).toBe(2);
    expect((await workflow.submit()).status).toBe("committed");
    expect((await source.query()).features[0]?.attributes).toEqual(before);
    expect(attributes).toEqual(before);
  });

  it("resolves missing defaults for the explicit selected subtype, not the fallback subtype", async () => {
    const { workflow, source } = fixture();
    workflow.begin("create", { attributes: { category: 2 } });
    expect(workflow.preflight().ready).toBe(true);
    await workflow.submit();
    expect((await source.query()).features[0]?.attributes).toMatchObject({
      category: 2,
      label: "Second label",
      status: "subtype-two",
    });
  });

  it("uses a subtype field's schema default only when no default code or explicit code exists", async () => {
    const { workflow, source } = fixture(FIELDS, { field: "category", subtypes: SUBTYPES.subtypes });
    workflow.begin("create");
    await workflow.submit();
    expect((await source.query()).features[0]?.attributes).toMatchObject({ category: 2, label: "Second label" });
  });

  it("seeds writable field defaults without requiring a subtype configuration", async () => {
    const { workflow, source } = fixture(
      [{ name: "label", type: "esriFieldTypeString", nullable: false, defaultValue: "Schema label" }],
      null,
    );
    workflow.begin("create");
    expect(workflow.preflight().ready).toBe(true);
    await workflow.submit();
    expect((await source.query()).features[0]?.attributes).toEqual({ label: "Schema label" });
  });

  it("does not replace explicit invalid zero/null/empty subtype values or turn invalid defaults into accepted writes", async () => {
    for (const category of [0, null, ""]) {
      const { workflow, applyEdits } = fixture();
      const state = workflow.begin("create", { attributes: { category, label: "Provided" } });
      expect(state.form?.controls.find((field) => field.name === "category")?.value).toBe(category);
      expect((await workflow.submit()).transported).toBe(false);
      expect(applyEdits).not.toHaveBeenCalled();
    }
    const { workflow, applyEdits } = fixture(
      [
        {
          name: "status",
          defaultValue: "invalid",
          domain: { type: "coded-value", codedValues: [{ code: "ok", name: "OK" }] },
        },
      ],
      null,
    );
    workflow.begin("create");
    expect((await workflow.submit()).transported).toBe(false);
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it("does not seed defaults into existing update or delete features", async () => {
    const original = {
      id: 3,
      attributes: { OBJECTID: 3, category: 2, label: "Existing", count: 0, enabled: false, note: null },
    };
    const { workflow, source, applyEdits } = fixture();
    workflow.begin("update", original);
    workflow.setValue("label", "Updated");
    expect((await workflow.submit()).status).toBe("committed");
    expect((await source.query()).features[0]?.attributes).toEqual({ ...original.attributes, label: "Updated" });
    expect(applyEdits.mock.calls[0]?.[0].updates?.[0]?.attributes).not.toHaveProperty("status");
    workflow.begin("delete", original);
    expect((await workflow.submit()).status).toBe("committed");
    expect(applyEdits.mock.calls[1]?.[0].deletes).toEqual([3]);
    expect((await source.query()).features).toEqual([]);
    expect(original.attributes.label).toBe("Existing");
  });

  it("does not write a server-owned subtype code even when configured with a create default", async () => {
    const fields = FIELDS.map((field) =>
      field.name === "category" ? { ...field, editable: false, defaultValue: 1 } : field,
    );
    const { workflow, source, applyEdits } = fixture(fields);
    workflow.begin("create");
    expect(workflow.snapshot().form?.controls.find((field) => field.name === "category")?.readOnly).toBe(true);
    expect((await workflow.submit()).status).toBe("committed");
    expect(applyEdits.mock.calls[0]?.[0].adds?.[0]?.attributes).not.toHaveProperty("category");
    expect((await source.query()).features[0]?.attributes).not.toHaveProperty("category");
  });
});
