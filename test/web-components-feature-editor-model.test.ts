import { describe, expect, it } from "vitest";

import type { EditWorkflowField } from "../src/contract/edit-session.js";
import {
  buildEditorFormModel,
  coerceEditorFieldValue,
  editorControlKind,
  editorDomainFromSchema,
  editorFieldInputValue,
  editorFieldsFromSchema,
  editorOperationAvailability,
  hiddenEditorFieldNames,
  redactEditorAttachment,
  resolveActiveEditorSubtype,
  resolveEditorFields,
  resolveEditorOperations,
} from "../src/web-components/feature-editor-model.js";
import type { HonuaEditorSubtypeConfig } from "../src/web-components/feature-editor-model.js";

/**
 * Production-tier editor presentation model (issue #680): every rendered
 * control, choice, and per-operation verdict is derived from public schema /
 * domain / subtype / capability metadata — no service field is hard-coded and
 * no protocol adapter is involved.
 */

const SCHEMA_FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID", editable: false, nullable: false },
  { name: "permit_no", type: "esriFieldTypeString", alias: "Permit number", length: 24, nullable: false },
  {
    name: "status",
    type: "esriFieldTypeString",
    alias: "Status",
    domain: {
      type: "codedValue",
      name: "PermitStatus",
      codedValues: [
        { name: "Open", code: "open" },
        { name: "Closed", code: "closed" },
      ],
    },
  },
  {
    name: "priority",
    type: "esriFieldTypeInteger",
    alias: "Priority",
    domain: { type: "range", name: "PriorityRange", range: [1, 5] as [number, number] },
  },
  { name: "notes", type: "esriFieldTypeString", alias: "Notes", length: 2000 },
  { name: "inspected", type: "boolean", alias: "Inspected" },
  { name: "filed_on", type: "esriFieldTypeDate", alias: "Filed on" },
];

const SUBTYPES: HonuaEditorSubtypeConfig = {
  field: "permit_kind",
  defaultCode: 1,
  subtypes: [
    {
      code: 1,
      name: "Residential",
      fieldOverrides: {
        status: {
          domain: {
            type: "coded-value",
            codedValues: [
              { name: "Open", code: "open" },
              { name: "Closed", code: "closed" },
            ],
          },
        },
        notes: { hidden: true },
      },
    },
    {
      code: 2,
      name: "Commercial",
      fieldOverrides: {
        status: {
          domain: { type: "coded-value", codedValues: [{ name: "Under review", code: "review" }] },
        },
        priority: { required: true },
      },
    },
  ],
};

function fieldByName(fields: readonly EditWorkflowField[], name: string): EditWorkflowField {
  const field = fields.find((entry) => entry.name === name);
  if (!field) throw new Error(`missing field ${name}`);
  return field;
}

describe("editorFieldsFromSchema", () => {
  it("projects coded-value and range domains the contract's schema mapping drops", () => {
    const fields = editorFieldsFromSchema(SCHEMA_FIELDS);
    expect(fieldByName(fields, "status").domain).toEqual({
      type: "coded-value",
      name: "PermitStatus",
      codedValues: [
        { name: "Open", code: "open" },
        { name: "Closed", code: "closed" },
      ],
    });
    expect(fieldByName(fields, "priority").domain).toEqual({
      type: "range",
      name: "PriorityRange",
      range: [1, 5],
    });
    // Non-domain metadata is preserved verbatim.
    expect(fieldByName(fields, "OBJECTID")).toMatchObject({ editable: false, nullable: false });
    expect(fieldByName(fields, "permit_no")).toMatchObject({ length: 24, nullable: false });
  });

  it("ignores empty and unrecognized domain blocks instead of inventing one", () => {
    expect(editorDomainFromSchema(undefined)).toBeUndefined();
    expect(editorDomainFromSchema(null)).toBeUndefined();
    expect(editorDomainFromSchema({ type: "codedValue", codedValues: [] })).toBeUndefined();
    expect(editorDomainFromSchema({ type: "inherited" })).toBeUndefined();
    expect(editorDomainFromSchema({ type: "range", range: ["a", "b"] })).toBeUndefined();
  });

  it("labels a coded value by its code when the domain omits a name", () => {
    const domain = editorDomainFromSchema({ type: "codedValue", codedValues: [{ code: 7 }] });
    expect(domain).toEqual({ type: "coded-value", codedValues: [{ name: "7", code: 7 }] });
  });
});

describe("resolveEditorFields (subtypes)", () => {
  const base = editorFieldsFromSchema(SCHEMA_FIELDS);

  it("gives the subtype field its own coded-value domain even when the schema omits it", () => {
    const fields = resolveEditorFields(base, SUBTYPES, {});
    const subtypeField = fieldByName(fields, "permit_kind");
    expect(subtypeField.required).toBe(true);
    expect(subtypeField.domain).toEqual({
      type: "coded-value",
      codedValues: [
        { name: "Residential", code: 1 },
        { name: "Commercial", code: 2 },
      ],
    });
  });

  it("swaps the valid choices for a field when the subtype changes", () => {
    const residential = resolveEditorFields(base, SUBTYPES, { permit_kind: 1 });
    const commercial = resolveEditorFields(base, SUBTYPES, { permit_kind: 2 });
    expect(fieldByName(residential, "status").domain?.codedValues?.map((coded) => coded.code)).toEqual([
      "open",
      "closed",
    ]);
    expect(fieldByName(commercial, "status").domain?.codedValues?.map((coded) => coded.code)).toEqual(["review"]);
    // The commercial subtype additionally makes priority required.
    expect(fieldByName(commercial, "priority").required).toBe(true);
    expect(fieldByName(residential, "priority").required).toBeUndefined();
  });

  it("matches the subtype by code across string/number representations", () => {
    expect(resolveActiveEditorSubtype(SUBTYPES, { permit_kind: "2" })?.name).toBe("Commercial");
    expect(resolveActiveEditorSubtype(SUBTYPES, {})?.name).toBe("Residential");
    expect(resolveActiveEditorSubtype(SUBTYPES, { permit_kind: 99 })).toBeUndefined();
    expect(resolveActiveEditorSubtype(undefined, {})).toBeUndefined();
  });

  it("never leaves a hidden field required", () => {
    const fields = resolveEditorFields(base, SUBTYPES, { permit_kind: 1 });
    expect(fieldByName(fields, "notes").required).toBe(false);
    expect(hiddenEditorFieldNames(SUBTYPES, { permit_kind: 1 })).toEqual(new Set(["notes"]));
    expect(hiddenEditorFieldNames(SUBTYPES, { permit_kind: 2 })).toEqual(new Set());
  });

  it("passes the field list through untouched with no subtype configuration", () => {
    expect(resolveEditorFields(base, undefined, {})).toBe(base);
  });
});

describe("resolveEditorOperations", () => {
  const fields = editorFieldsFromSchema(SCHEMA_FIELDS);

  it("reports every operation unavailable, with a reason, on a read-only source", () => {
    const availability = resolveEditorOperations({
      capabilities: { applyEdits: "unsupported" },
      hasFeatureIdentity: true,
      fields,
    });
    expect(availability).toHaveLength(3);
    for (const entry of availability) {
      expect(entry.available).toBe(false);
      expect(entry.code).toBe("capability-unsupported");
      expect(entry.reason).toMatch(/does not support editing/i);
    }
  });

  it("surfaces an authorization gate from the capability profile rather than claiming support", () => {
    const availability = resolveEditorOperations({
      capabilities: { applyEdits: "supported" },
      decisions: [
        { id: "query", effective: "supported", reasons: ["supported-by-claim-and-observation"] },
        { id: "applyEdits", effective: "authorization-required", reasons: ["authorization-required:edit"] },
      ],
      hasFeatureIdentity: true,
      fields,
    });
    expect(availability.every((entry) => !entry.available)).toBe(true);
    expect(editorOperationAvailability(availability, "update")).toMatchObject({
      code: "authorization-required",
    });
    expect(editorOperationAvailability(availability, "update").reason).toContain("authorization-required:edit");
  });

  it.each([
    ["authorization-denied", "authorization-denied"],
    ["policy-disabled", "policy-disabled"],
    ["peer-unavailable", "peer-unavailable"],
    ["unknown", "capability-unknown"],
  ])("maps the %s capability verdict to the %s reason code", (effective, code) => {
    const availability = resolveEditorOperations({
      capabilities: { applyEdits: "supported" },
      decisions: [{ id: "applyEdits", effective }],
      hasFeatureIdentity: true,
      fields,
    });
    expect(editorOperationAvailability(availability, "create").code).toBe(code);
  });

  it("allows create but blocks update/delete without a feature identity", () => {
    const availability = resolveEditorOperations({
      capabilities: { applyEdits: "supported" },
      hasFeatureIdentity: false,
      fields,
    });
    expect(editorOperationAvailability(availability, "create").available).toBe(true);
    expect(editorOperationAvailability(availability, "update")).toMatchObject({
      available: false,
      code: "no-feature-identity",
    });
    expect(editorOperationAvailability(availability, "delete").code).toBe("no-feature-identity");
  });

  it("honours a host per-operation denial but never lets one grant an unsupported operation", () => {
    const partiallyEditable = resolveEditorOperations({
      capabilities: { applyEdits: "supported" },
      hasFeatureIdentity: true,
      fields,
      overrides: { delete: { available: false, reason: "Deletes are disabled for permits." } },
    });
    expect(editorOperationAvailability(partiallyEditable, "update").available).toBe(true);
    expect(editorOperationAvailability(partiallyEditable, "delete")).toMatchObject({
      available: false,
      code: "host-denied",
      reason: "Deletes are disabled for permits.",
    });

    const stillReadOnly = resolveEditorOperations({
      capabilities: { applyEdits: "unsupported" },
      hasFeatureIdentity: true,
      fields,
      overrides: { create: true, update: true, delete: true },
    });
    expect(stillReadOnly.every((entry) => !entry.available)).toBe(true);
  });

  it("blocks create/update — but not delete — when every field is read-only", () => {
    const availability = resolveEditorOperations({
      capabilities: { applyEdits: "supported" },
      hasFeatureIdentity: true,
      fields: [{ name: "OBJECTID", editable: false }],
    });
    expect(editorOperationAvailability(availability, "create")).toMatchObject({ code: "no-editable-fields" });
    expect(editorOperationAvailability(availability, "update")).toMatchObject({ code: "no-editable-fields" });
    expect(editorOperationAvailability(availability, "delete").available).toBe(true);
  });

  it("falls back to a fail-closed verdict for an operation missing from the list", () => {
    expect(editorOperationAvailability([], "update")).toMatchObject({
      available: false,
      code: "capability-unknown",
    });
  });
});

describe("buildEditorFormModel", () => {
  const fields = resolveEditorFields(editorFieldsFromSchema(SCHEMA_FIELDS), SUBTYPES, { permit_kind: 2 });

  it("derives a control kind per field from type and domain metadata", () => {
    const form = buildEditorFormModel({
      operation: "create",
      fields,
      values: { permit_kind: 2 },
      validation: { valid: true, errors: [] },
      subtypes: SUBTYPES,
    });
    const kinds = Object.fromEntries(form.controls.map((control) => [control.name, control.kind]));
    expect(kinds).toMatchObject({
      permit_kind: "select",
      status: "select",
      priority: "number",
      permit_no: "text",
      notes: "textarea",
      inspected: "checkbox",
      filed_on: "date",
    });
    expect(fieldByName(fields, "priority").domain).toMatchObject({ type: "range" });
    const priority = form.controls.find((control) => control.name === "priority");
    expect(priority).toMatchObject({ min: 1, max: 5 });
    expect(form.subtype).toMatchObject({ field: "permit_kind", code: 2, name: "Commercial" });
    expect(form.subtype?.choices).toEqual([
      { value: "1", label: "Residential" },
      { value: "2", label: "Commercial" },
    ]);
  });

  it("marks the subtype control and takes its choices from the active subtype", () => {
    const form = buildEditorFormModel({
      operation: "create",
      fields,
      values: { permit_kind: 2 },
      validation: { valid: true, errors: [] },
      subtypes: SUBTYPES,
    });
    expect(form.controls.find((control) => control.subtypeField)?.name).toBe("permit_kind");
    expect(form.controls.find((control) => control.name === "status")?.choices).toEqual([
      { value: "review", label: "Under review" },
    ]);
  });

  it("does not require a server-assigned field on a create draft, but keeps it read-only", () => {
    const form = buildEditorFormModel({
      operation: "create",
      fields,
      values: {},
      validation: { valid: true, errors: [] },
      subtypes: SUBTYPES,
    });
    const oid = form.controls.find((control) => control.name === "OBJECTID");
    expect(oid).toMatchObject({ readOnly: true, required: false });
  });

  it("renders every control read-only for a delete draft", () => {
    const form = buildEditorFormModel({
      operation: "delete",
      fields,
      values: {},
      validation: { valid: true, errors: [] },
    });
    expect(form.controls.every((control) => control.readOnly)).toBe(true);
  });

  it("routes validation errors to their field and keeps unattributed ones on the form", () => {
    const form = buildEditorFormModel({
      operation: "update",
      fields,
      values: { permit_kind: 2, status: "open" },
      validation: {
        valid: false,
        errors: [
          { fieldName: "status", code: "domain", message: "Status must match its coded-value domain" },
          { code: "unsupported", message: "Source does not support applyEdits" },
        ],
      },
      subtypes: SUBTYPES,
    });
    expect(form.valid).toBe(false);
    expect(form.controls.find((control) => control.name === "status")?.errors).toEqual([
      "Status must match its coded-value domain",
    ]);
    expect(form.formErrors).toEqual(["Source does not support applyEdits"]);
  });

  it("hides subtype-hidden fields but keeps their errors visible on the form", () => {
    const residential = resolveEditorFields(editorFieldsFromSchema(SCHEMA_FIELDS), SUBTYPES, { permit_kind: 1 });
    const form = buildEditorFormModel({
      operation: "update",
      fields: residential,
      values: { permit_kind: 1 },
      validation: {
        valid: false,
        errors: [{ fieldName: "notes", code: "length", message: "Notes exceeds length 2000" }],
      },
      subtypes: SUBTYPES,
    });
    expect(form.controls.some((control) => control.name === "notes")).toBe(false);
    expect(form.formErrors).toEqual(["Notes exceeds length 2000"]);
  });

  it("falls back to the field default value when the draft has no value yet", () => {
    const form = buildEditorFormModel({
      operation: "create",
      fields: [{ name: "status", type: "string", defaultValue: "open" }],
      values: {},
      validation: { valid: true, errors: [] },
    });
    expect(form.controls[0]?.value).toBe("open");
  });
});

describe("editorControlKind", () => {
  it.each([
    [{ name: "a", type: "esriFieldTypeSmallInteger" }, "number"],
    [{ name: "a", type: "esriFieldTypeDouble" }, "number"],
    [{ name: "a", type: "decimal" }, "number"],
    [{ name: "a", type: "timestamp" }, "datetime"],
    [{ name: "a", type: "esriFieldTypeDate" }, "date"],
    [{ name: "a", type: "boolean" }, "checkbox"],
    [{ name: "a", type: "esriFieldTypeString", length: 300 }, "textarea"],
    [{ name: "a", type: "esriFieldTypeString", length: 30 }, "text"],
    [{ name: "a" }, "text"],
  ])("maps %j to %s", (field, expected) => {
    expect(editorControlKind(field as EditWorkflowField)).toBe(expected);
  });

  it("prefers a select for a coded-value domain regardless of the field type", () => {
    expect(
      editorControlKind({
        name: "a",
        type: "esriFieldTypeInteger",
        domain: { type: "coded-value", codedValues: [{ name: "One", code: 1 }] },
      }),
    ).toBe("select");
  });
});

describe("coerceEditorFieldValue", () => {
  const codedNumeric: EditWorkflowField = {
    name: "permit_kind",
    type: "integer",
    domain: {
      type: "coded-value",
      codedValues: [
        { name: "Residential", code: 1 },
        { name: "Commercial", code: 2 },
      ],
    },
  };

  it("resolves a coded value back to the domain code's own type", () => {
    // The DOM only ever hands back "2"; sending that string would fail the
    // contract's own domain check.
    expect(coerceEditorFieldValue(codedNumeric, "2")).toBe(2);
    expect(typeof coerceEditorFieldValue(codedNumeric, "2")).toBe("number");
  });

  it("keeps an unknown coded value verbatim so validation can reject it", () => {
    expect(coerceEditorFieldValue(codedNumeric, "9")).toBe("9");
  });

  it("maps an empty control to null, or to an empty string on a non-nullable field", () => {
    expect(coerceEditorFieldValue({ name: "a", type: "string" }, "")).toBeNull();
    expect(coerceEditorFieldValue({ name: "a", type: "string", nullable: false }, "")).toBe("");
    expect(coerceEditorFieldValue(codedNumeric, "")).toBeNull();
    expect(coerceEditorFieldValue({ name: "a" }, null)).toBeNull();
  });

  it("parses numbers and passes an unparseable value through for validation", () => {
    expect(coerceEditorFieldValue({ name: "a", type: "integer" }, "42")).toBe(42);
    expect(coerceEditorFieldValue({ name: "a", type: "integer" }, "n/a")).toBe("n/a");
  });

  it("passes checkbox state through as a boolean", () => {
    expect(coerceEditorFieldValue({ name: "a", type: "boolean" }, true)).toBe(true);
    expect(coerceEditorFieldValue({ name: "a", type: "boolean" }, "on")).toBe(true);
    expect(coerceEditorFieldValue({ name: "a", type: "boolean" }, "false")).toBe(false);
  });
});

describe("editorFieldInputValue", () => {
  it("renders dates for date and datetime controls", () => {
    const date = new Date("2026-03-04T05:06:07.000Z");
    expect(editorFieldInputValue({ name: "a", type: "date" }, date)).toBe("2026-03-04");
    expect(editorFieldInputValue({ name: "a", type: "timestamp" }, date)).toBe("2026-03-04T05:06");
    expect(editorFieldInputValue({ name: "a", type: "date" }, date.getTime())).toBe("2026-03-04");
    expect(editorFieldInputValue({ name: "a", type: "date" }, new Date(Number.NaN))).toBe("");
  });

  it("renders empty for absent values and JSON for objects", () => {
    expect(editorFieldInputValue({ name: "a" }, null)).toBe("");
    expect(editorFieldInputValue({ name: "a" }, undefined)).toBe("");
    expect(editorFieldInputValue({ name: "a" }, { x: 1 })).toBe('{"x":1}');
    expect(editorFieldInputValue({ name: "a" }, true)).toBe("true");
    expect(editorFieldInputValue({ name: "a" }, 3)).toBe("3");
  });
});

describe("redactEditorAttachment", () => {
  it("never carries a string payload — a signed URL cannot leak through state", () => {
    const secretUrl = "https://storage.example.com/blob?sig=SUPER-SECRET-TOKEN";
    const draft = redactEditorAttachment({ operation: "add", attachment: secretUrl }, 0);
    expect(JSON.stringify(draft)).not.toContain("SUPER-SECRET-TOKEN");
    expect(draft).toEqual({ index: 0, operation: "add", name: "attachment", status: "staged" });
  });

  it("describes a File by name, type and size without the bytes", () => {
    const file = { name: "site-plan.pdf", size: 2048, type: "application/pdf" };
    const draft = redactEditorAttachment({ operation: "add", attachment: file }, 1, "failed", "413 too large");
    expect(draft).toEqual({
      index: 1,
      operation: "add",
      name: "site-plan.pdf",
      contentType: "application/pdf",
      size: 2048,
      status: "failed",
      error: "413 too large",
    });
  });

  it("summarizes a delete mutation by count", () => {
    expect(redactEditorAttachment({ operation: "delete", attachmentIds: [1, 2, 3] }, 0).name).toBe("3 attachment(s)");
    expect(redactEditorAttachment({ operation: "delete" }, 0).name).toBe("0 attachment(s)");
  });

  it("prefers an explicit name over the payload's", () => {
    const draft = redactEditorAttachment(
      { operation: "update", attachment: "https://x/y?sig=abc", name: "revised.pdf", contentType: "application/pdf" },
      2,
    );
    expect(draft.name).toBe("revised.pdf");
    expect(JSON.stringify(draft)).not.toContain("sig=abc");
  });
});
