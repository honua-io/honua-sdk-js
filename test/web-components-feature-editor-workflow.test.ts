import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AttachmentApi, Capability, EditEnvelope, EditResult, Source } from "../src/contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import type { HonuaEditorSubtypeConfig } from "../src/web-components/feature-editor-model.js";
import { createFeatureEditorWorkflow } from "../src/web-components/feature-editor-workflow.js";
import type {
  HonuaFeatureEditorSnapshot,
  HonuaFeatureEditorWorkflow,
} from "../src/web-components/feature-editor-workflow.js";

/**
 * Production-tier editor workflow (issue #680). Every assertion here is about
 * composition over the public contract edit primitives: capability gating,
 * subtype-aware pre-transport validation, optimistic state, partial failure,
 * conflict resolution, realtime reconciliation, and cancellation — with
 * `applyEdits` spied on so "never transported" is a fact, not a hope.
 */

interface PermitAttributes {
  OBJECTID?: number;
  permit_no?: string | null;
  permit_kind?: number | string | null;
  status?: string | null;
  priority?: number | null;
  version?: number;
  [key: string]: unknown;
}

const SCHEMA_FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID", editable: false, nullable: false },
  { name: "permit_no", type: "esriFieldTypeString", alias: "Permit number", length: 12, nullable: false },
  {
    name: "status",
    type: "esriFieldTypeString",
    alias: "Status",
    domain: {
      type: "codedValue",
      codedValues: [
        { name: "Open", code: "open" },
        { name: "Closed", code: "closed" },
        { name: "Under review", code: "review" },
      ],
    },
  },
  {
    name: "priority",
    type: "esriFieldTypeInteger",
    alias: "Priority",
    domain: { type: "range", range: [1, 5] as [number, number] },
  },
  { name: "version", type: "esriFieldTypeInteger", alias: "Version", editable: false },
];

/**
 * Same schema with a writable concurrency token — the shape a GeoServices
 * layer publishes when the host is expected to pass the version back on update.
 */
const EDITABLE_VERSION_FIELDS = SCHEMA_FIELDS.map((field) =>
  field.name === "version" ? { ...field, editable: true } : field,
);

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
      },
    },
    {
      code: 2,
      name: "Commercial",
      fieldOverrides: {
        status: { domain: { type: "coded-value", codedValues: [{ name: "Under review", code: "review" }] } },
        priority: { required: true },
      },
    },
  ],
};

const ok = (
  added: EditResult["added"] = [],
  updated: EditResult["updated"] = [],
  deleted: EditResult["deleted"] = [],
): EditResult => ({
  added,
  updated,
  deleted,
});

interface FakeSourceOptions {
  capabilities?: readonly Capability[];
  applyEdits?: (envelope: EditEnvelope<PermitAttributes>) => Promise<EditResult>;
  attachments?: Partial<AttachmentApi>;
  capabilityProfile?: { entries: readonly { id: string; effective: string; reasons?: readonly string[] }[] };
  fields?: readonly unknown[];
}

interface FakeSource {
  source: Source<PermitAttributes>;
  applyEdits: ReturnType<typeof vi.fn>;
  attachments: { add: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
}

function makeSource(options: FakeSourceOptions = {}): FakeSource {
  const capabilities = new Set<Capability>(options.capabilities ?? ["query", "applyEdits"]);
  // The default echoes the envelope so update/delete outcomes land in the
  // matching bucket, the way a real adapter reports them.
  const applyEdits = vi.fn(
    options.applyEdits ??
      (async (envelope: EditEnvelope<PermitAttributes>) => {
        if (envelope.adds?.length) return ok([{ id: 101, success: true }]);
        if (envelope.updates?.length) return ok([], [{ id: envelope.updates[0]?.id ?? 1, success: true }]);
        if (envelope.deletes?.length) return ok([], [], [{ id: envelope.deletes[0], success: true }]);
        return ok();
      }),
  );
  const unsupported = (capability: string) => async () => {
    throw new HonuaCapabilityNotSupportedError(capability, "geoservices-feature-service", "permits");
  };
  const add = vi.fn(
    options.attachments?.add ??
      (capabilities.has("attachments")
        ? async () => ({ parentId: 101, attachmentId: 1, success: true })
        : unsupported("attachments")),
  );
  const remove = vi.fn(
    options.attachments?.delete ??
      (capabilities.has("attachments") ? async () => [{ success: true }] : unsupported("attachments")),
  );
  const source = {
    descriptor: {
      id: "permits",
      protocol: "geoservices-feature-service",
      locator: { url: "https://example.test/FeatureServer/0" },
      capabilities,
      schema: { fields: options.fields ?? SCHEMA_FIELDS, primaryKey: "OBJECTID" },
      ...(options.capabilityProfile ? { capabilityProfile: options.capabilityProfile } : {}),
    },
    capabilities,
    applyEdits,
    attachments: {
      add,
      delete: remove,
      update: vi.fn(unsupported("attachments")),
      list: vi.fn(async () => []),
      query: vi.fn(async () => []),
    },
  } as unknown as Source<PermitAttributes>;
  return { source, applyEdits, attachments: { add, delete: remove } };
}

function existing(overrides: Partial<PermitAttributes> = {}) {
  return {
    id: 1,
    attributes: {
      OBJECTID: 1,
      permit_no: "P-1",
      permit_kind: 1,
      status: "open",
      priority: 3,
      version: 7,
      ...overrides,
    },
    geometry: { type: "Point", coordinates: [1, 2] } as Record<string, unknown>,
  };
}

function completeCreateDraft(workflow: HonuaFeatureEditorWorkflow<PermitAttributes>, kind = "1"): void {
  workflow.begin("create");
  workflow.setValue("permit_kind", kind);
  workflow.setValue("permit_no", "P-9");
  workflow.setValue("status", kind === "2" ? "review" : "open");
  workflow.setValue("priority", "2");
}

describe("HonuaFeatureEditorWorkflow — capability gating", () => {
  it("refuses every operation on a read-only source and never transports", async () => {
    const { source, applyEdits } = makeSource({ capabilities: ["query"] });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());

    expect(workflow.operations().every((entry) => !entry.available)).toBe(true);
    const snapshot = workflow.begin("update");
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.form).toBeUndefined();
    expect(snapshot.failures[0]).toMatchObject({ kind: "capability" });
    expect(snapshot.message).toMatch(/does not support editing/i);

    const commit = await workflow.submit();
    expect(commit.transported).toBe(false);
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it("reports a partially editable service truthfully per operation", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({
      source,
      operations: { delete: { available: false, reason: "Permits are archived, never deleted." } },
    });
    workflow.setSelection(existing());
    const byOperation = Object.fromEntries(workflow.operations().map((entry) => [entry.operation, entry]));
    expect(byOperation.create?.available).toBe(true);
    expect(byOperation.update?.available).toBe(true);
    expect(byOperation.delete).toMatchObject({
      available: false,
      code: "host-denied",
      reason: "Permits are archived, never deleted.",
    });

    const refused = workflow.begin("delete");
    expect(refused.status).toBe("rejected");
    expect(refused.message).toBe("Permits are archived, never deleted.");
  });

  it("surfaces an authorization gate from the source's capability profile", () => {
    const { source } = makeSource({
      capabilityProfile: {
        entries: [{ id: "applyEdits", effective: "authorization-denied", reasons: ["authorization-denied:edit"] }],
      },
    });
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.setSelection(existing());
    const snapshot = workflow.begin("update");
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.message).toContain("authorization-denied:edit");
    expect(workflow.operations().every((entry) => entry.code === "authorization-denied")).toBe(true);
  });

  it("blocks update/delete until the host records a selection", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source });
    expect(workflow.operations().find((entry) => entry.operation === "update")).toMatchObject({
      available: false,
      code: "no-feature-identity",
    });
    workflow.setSelection(existing());
    expect(workflow.operations().find((entry) => entry.operation === "update")?.available).toBe(true);
    expect(workflow.selection()?.id).toBe(1);
  });

  it("does not let a selection change hijack an open draft", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    workflow.setSelection(existing({ OBJECTID: 42 }));
    expect(workflow.snapshot().identity?.featureId).toBe(1);
    expect(workflow.snapshot().form?.controls.find((c) => c.name === "status")?.value).toBe("closed");
  });

  // Regression (issue #680): a committed draft used to keep owning the
  // selection, so the next `update` reopened on the token the commit already
  // consumed and the service had to reject it.
  it("rebinds a committed draft to the host's re-read so the next update carries the fresh token", async () => {
    const { source, applyEdits } = makeSource({ fields: EDITABLE_VERSION_FIELDS });
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.setSelection(existing({ version: 7 }));
    workflow.begin("update");
    workflow.setValue("status", "closed");
    expect((await workflow.submit()).status).toBe("committed");

    // The host re-reads the record it just wrote; the service moved to 8.
    workflow.setSelection(existing({ version: 8, status: "closed" }));

    const reconciled = workflow.snapshot();
    // Nothing about the commit is retracted, but the finished draft is closed.
    expect(reconciled.status).toBe("committed");
    expect(reconciled.message).toMatch(/updated/i);
    expect(reconciled.form).toBeUndefined();
    expect(workflow.selection()?.attributes.version).toBe(8);
    expect(reconciled.identity?.version).toBe(8);

    applyEdits.mockClear();
    workflow.begin("update");
    workflow.setValue("status", "open");
    expect((await workflow.submit()).status).toBe("committed");
    expect(applyEdits.mock.calls[0]?.[0].updates?.[0]?.attributes.version).toBe(8);
  });
});

describe("HonuaFeatureEditorWorkflow — subtype and domain validation", () => {
  it("rejects a value the active subtype disallows before anything is transported", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow, "2");
    // "review" is the only status the Commercial subtype allows; switch the
    // status to a value only Residential allows.
    workflow.setValue("status", "open");

    const commit = await workflow.submit();
    expect(commit.transported).toBe(false);
    expect(commit.status).toBe("rejected");
    expect(applyEdits).not.toHaveBeenCalled();
    expect(commit.failures.map((failure) => failure.description).join(" ")).toMatch(/coded-value domain/i);
    expect(commit.snapshot.form?.controls.find((control) => control.name === "status")?.errors).not.toEqual([]);
  });

  it("accepts the same value once the subtype allows it", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow, "2");
    workflow.setValue("status", "open");
    expect((await workflow.submit()).transported).toBe(false);

    workflow.setValue("permit_kind", "1");
    const commit = await workflow.submit();
    expect(commit.transported).toBe(true);
    expect(commit.status).toBe("committed");
    expect(applyEdits).toHaveBeenCalledTimes(1);
  });

  it("changes the offered choices when the subtype changes", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.begin("create");
    const residentialChoices = workflow
      .snapshot()
      .form?.controls.find((control) => control.name === "status")
      ?.choices?.map((choice) => choice.value);
    expect(residentialChoices).toEqual(["open", "closed"]);

    workflow.setValue("permit_kind", "2");
    const commercialChoices = workflow
      .snapshot()
      .form?.controls.find((control) => control.name === "status")
      ?.choices?.map((choice) => choice.value);
    expect(commercialChoices).toEqual(["review"]);
    expect(workflow.snapshot().form?.subtype?.name).toBe("Commercial");
  });

  it("enforces a required field the subtype adds", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.begin("create");
    workflow.setValue("permit_kind", "2");
    workflow.setValue("permit_no", "P-9");
    workflow.setValue("status", "review");
    const commit = await workflow.submit();
    expect(commit.transported).toBe(false);
    expect(commit.failures.map((failure) => failure.description).join(" ")).toMatch(/Priority is required/i);
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it("rejects a range-domain violation and a length overflow before transport", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.begin("create");
    workflow.setValue("permit_no", "PERMIT-NUMBER-FAR-TOO-LONG");
    workflow.setValue("priority", "99");
    const commit = await workflow.submit();
    expect(applyEdits).not.toHaveBeenCalled();
    const messages = commit.failures.map((failure) => failure.description).join(" ");
    expect(messages).toMatch(/exceeds length 12/);
    expect(messages).toMatch(/between 1 and 5/);
  });

  it("sends a coded value with its own type, not the DOM's string", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow, "2");
    workflow.setValue("status", "review");
    await workflow.submit();
    const envelope = applyEdits.mock.calls[0]?.[0] as EditEnvelope<PermitAttributes>;
    expect(envelope.adds?.[0]?.attributes.permit_kind).toBe(2);
    expect(envelope.adds?.[0]?.attributes.priority).toBe(2);
  });
});

describe("HonuaFeatureEditorWorkflow — subtype-driven availability from the selection", () => {
  /**
   * Subtype overrides can flip a field's editability, so availability computed
   * before a draft opens has to resolve subtypes from the SELECTED feature's
   * attributes — not from empty values (which would silently fall back to the
   * default subtype).
   */
  const LOCKED = 1;
  const OPEN = 2;

  function lockingSubtypes(lockedCode: number): HonuaEditorSubtypeConfig {
    const lockAll = {
      permit_kind: { editable: false },
      permit_no: { editable: false },
      status: { editable: false },
      priority: { editable: false },
      version: { editable: false },
    };
    return {
      field: "permit_kind",
      defaultCode: LOCKED,
      subtypes: [
        { code: LOCKED, name: "Locked", ...(lockedCode === LOCKED ? { fieldOverrides: lockAll } : {}) },
        { code: OPEN, name: "Open", ...(lockedCode === OPEN ? { fieldOverrides: lockAll } : {}) },
      ],
    };
  }

  it("allows update when the selected subtype is editable although the default subtype is not", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: lockingSubtypes(LOCKED) });

    // No selection: the default (locked) subtype applies.
    expect(workflow.operations().find((entry) => entry.operation === "create")).toMatchObject({
      available: false,
      code: "no-editable-fields",
    });

    workflow.setSelection(existing({ permit_kind: OPEN }));
    expect(workflow.operations().find((entry) => entry.operation === "update")?.available).toBe(true);
    expect(workflow.begin("update").status).toBe("draft");
  });

  it("blocks update when the selected subtype is read-only although the default subtype is editable", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: lockingSubtypes(OPEN) });

    workflow.setSelection(existing({ permit_kind: LOCKED }));
    expect(workflow.operations().find((entry) => entry.operation === "update")?.available).toBe(true);

    workflow.setSelection(existing({ permit_kind: OPEN }));
    expect(workflow.operations().find((entry) => entry.operation === "update")).toMatchObject({
      available: false,
      code: "no-editable-fields",
    });
    const refused = workflow.begin("update");
    expect(refused.status).toBe("rejected");
    expect(refused.message).toMatch(/read-only/i);
  });

  it("resolves availability from an explicit begin() target rather than the standing selection", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: lockingSubtypes(OPEN) });
    workflow.setSelection(existing({ permit_kind: OPEN }));
    expect(workflow.operations().find((entry) => entry.operation === "update")?.available).toBe(false);

    const explicit = workflow.begin("update", existing({ OBJECTID: 9, permit_kind: LOCKED }));
    expect(explicit.status).toBe("draft");
  });

  it("reports the selected subtype's field metadata before a draft is open", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing({ permit_kind: 2 }));
    const status = workflow.fields().find((field) => field.name === "status");
    expect(status?.domain?.codedValues?.map((coded) => coded.code)).toEqual(["review"]);
    expect(workflow.fields().find((field) => field.name === "priority")?.required).toBe(true);
  });
});

describe("HonuaFeatureEditorWorkflow — submit outcomes", () => {
  it("commits a create and records the server-assigned identity", async () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const commit = await workflow.submit();
    expect(commit).toMatchObject({ status: "committed", transported: true, committedFeatureId: 101 });
    expect(commit.snapshot.identity?.featureId).toBe(101);
    expect(commit.snapshot.dirty).toBe(false);
  });

  it("sends the sketched geometry with the edit", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    workflow.setGeometry("point", { type: "Point", coordinates: [10, 20] });
    await workflow.submit();
    const envelope = applyEdits.mock.calls[0]?.[0] as EditEnvelope<PermitAttributes>;
    expect(envelope.adds?.[0]?.geometry).toEqual({ type: "Point", coordinates: [10, 20] });
  });

  it("maps a rejected edit to a failure state, never to committed", async () => {
    const { source } = makeSource({
      applyEdits: async () => ok([{ success: false, error: { code: 500, description: "backend exploded" } }]),
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const commit = await workflow.submit();
    expect(commit.status).toBe("rejected");
    expect(commit.transported).toBe(true);
    expect(commit.committedFeatureId).toBeUndefined();
    expect(commit.failures[0]).toMatchObject({ kind: "server", code: 500 });
  });

  it("maps a server validation rejection to a rejected state with the service's reason", async () => {
    const { source } = makeSource({
      applyEdits: async () => ok([{ success: false, error: { code: 400, description: "permit_no already used" } }]),
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const commit = await workflow.submit();
    expect(commit.status).toBe("rejected");
    expect(commit.failures[0]).toMatchObject({ kind: "validation", description: "permit_no already used" });
  });

  it("reports an explicit partial-failure state when the feature commits but an attachment does not", async () => {
    const { source, attachments } = makeSource({
      capabilities: ["query", "applyEdits", "attachments"],
      attachments: {
        add: async () => {
          throw Object.assign(new Error("attachment store rejected the upload"), { statusCode: 507 });
        },
      },
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    workflow.stageAttachment("https://storage.example.test/plan.pdf?sig=SECRET", { name: "plan.pdf" });
    expect(workflow.snapshot().attachments[0]).toMatchObject({ name: "plan.pdf", status: "staged" });

    const commit = await workflow.submit();
    expect(attachments.add).toHaveBeenCalledTimes(1);
    expect(commit.status).toBe("rejected");
    expect(commit.snapshot.message).toMatch(/only partly applied/i);
    expect(commit.attachments[0]).toMatchObject({ name: "plan.pdf", status: "failed" });
    expect(JSON.stringify(commit)).not.toContain("SECRET");
  });

  // Regression (issue #680): the feature write really did land, so the record
  // on file moved. Without adopting the new token the enabled Retry would
  // re-transport the version the accepted write already consumed and the
  // service would answer with a version conflict the reviewer never caused.
  it("adopts the post-write token after a partial outcome without erasing the failure it follows", async () => {
    const { source, applyEdits } = makeSource({
      capabilities: ["query", "applyEdits", "attachments"],
      fields: EDITABLE_VERSION_FIELDS,
      attachments: {
        add: async () => ({
          parentId: 1,
          attachmentId: 0,
          success: false,
          error: { code: 413, description: "site plan exceeds the upload limit" },
        }),
      },
    });
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.setSelection(existing({ version: 7 }));
    workflow.begin("update");
    workflow.setValue("status", "closed");
    workflow.stageAttachment("blob://plan", { name: "plan.pdf" });

    const commit = await workflow.submit();
    expect(commit.status).toBe("rejected");
    expect(commit.transported).toBe(true);
    expect(commit.attachments[0]).toMatchObject({ name: "plan.pdf", status: "failed" });
    expect(workflow.snapshot().identity?.versionField).toBe("version");

    // The host re-reads: the feature write landed and the service is at 8.
    expect(workflow.adoptServerState(existing({ version: 8, status: "closed" }))).toBe(true);

    const after = workflow.snapshot();
    // The rejected truth survives the reconciliation.
    expect(after.status).toBe("rejected");
    expect(after.message).toMatch(/only partly applied/i);
    expect(after.failures.length).toBeGreaterThan(0);
    expect(after.attachments[0]).toMatchObject({ name: "plan.pdf", status: "failed" });
    expect(after.form?.controls.find((control) => control.name === "status")?.value).toBe("closed");
    expect(after.identity?.version).toBe(8);

    applyEdits.mockClear();
    await workflow.retry();
    expect(applyEdits.mock.calls[0]?.[0].updates?.[0]?.attributes.version).toBe(8);
  });

  it("refuses to adopt server state for a different feature, or with no draft open", async () => {
    const { source } = makeSource({ fields: EDITABLE_VERSION_FIELDS });
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.setSelection(existing({ version: 7 }));
    // No draft open yet.
    expect(workflow.adoptServerState(existing({ version: 8 }))).toBe(false);

    workflow.begin("update");
    expect(workflow.adoptServerState({ ...existing({ version: 9 }), id: 42 })).toBe(false);
    expect(workflow.snapshot().identity?.version).toBe(7);
  });

  it("refuses to stage an attachment for a source without attachment support", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    expect(workflow.snapshot().attachmentsSupported).toBe(false);
    workflow.stageAttachment("plan.pdf", { name: "plan.pdf" });
    const commit = await workflow.submit();
    expect(commit.transported).toBe(false);
    expect(commit.status).toBe("unsupported");
    expect(applyEdits).not.toHaveBeenCalled();
    expect(commit.failures.map((f) => f.description).join(" ")).toMatch(/does not support attachments/i);
  });

  it("stages and applies an attachment delete when supported", async () => {
    const { source, attachments } = makeSource({ capabilities: ["query", "applyEdits", "attachments"] });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.stageAttachmentDelete([5, 6]);
    const commit = await workflow.submit();
    expect(attachments.delete).toHaveBeenCalledTimes(1);
    expect(commit.attachments[0]).toMatchObject({ operation: "delete", name: "2 attachment(s)" });
  });

  it("maps a capability error thrown by the adapter to an unsupported state", async () => {
    const { source } = makeSource({
      applyEdits: async () => {
        throw new HonuaCapabilityNotSupportedError("applyEdits", "wms", "permits");
      },
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const commit = await workflow.submit();
    expect(commit.status).toBe("unsupported");
    expect(commit.failures[0]?.kind).toBe("capability");
  });

  it("drives optimistic apply then rollback for a rejected edit", async () => {
    const apply = vi.fn();
    const rollback = vi.fn();
    const commitHook = vi.fn();
    const { source } = makeSource({
      applyEdits: async () => ok([{ success: false, error: { code: 500, description: "nope" } }]),
    });
    const workflow = createFeatureEditorWorkflow({
      source,
      subtypes: SUBTYPES,
      optimistic: { apply, rollback, commit: commitHook },
    });
    completeCreateDraft(workflow);
    await workflow.submit();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commitHook).not.toHaveBeenCalled();
  });

  it("drives the optimistic commit hook on success", async () => {
    const commitHook = vi.fn();
    const rollback = vi.fn();
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({
      source,
      subtypes: SUBTYPES,
      optimistic: { apply: vi.fn(), commit: commitHook, rollback },
    });
    completeCreateDraft(workflow);
    await workflow.submit();
    expect(commitHook).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });
});

describe("HonuaFeatureEditorWorkflow — conflict resolution", () => {
  function conflictingSource() {
    let attempt = 0;
    return makeSource({
      applyEdits: async () => {
        attempt += 1;
        if (attempt === 1) {
          return ok([], [{ id: 1, success: false, error: { code: 409, description: "row version 7 is stale" } }]);
        }
        return ok([], [{ id: 1, success: true }]);
      },
    });
  }

  it("parks a version conflict and refuses to retransport until it is resolved", async () => {
    const { source, applyEdits } = conflictingSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");

    const first = await workflow.submit();
    expect(first.status).toBe("conflict");
    expect(first.transported).toBe(true);
    expect(first.snapshot.conflict).toMatchObject({
      versionField: "version",
      choices: ["keep-mine", "discard-mine", "reload"],
    });

    const blocked = await workflow.submit();
    expect(blocked.transported).toBe(false);
    expect(blocked.status).toBe("conflict");
    expect(applyEdits).toHaveBeenCalledTimes(1);
  });

  it("retries after keep-mine and clears the conflict on success", async () => {
    const { source, applyEdits } = conflictingSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    await workflow.submit();

    const resolved = workflow.resolveConflict("keep-mine");
    expect(resolved.status).toBe("draft");
    expect(resolved.conflict).toBeUndefined();
    expect(resolved.message).toMatch(/overwrite/i);

    const retried = await workflow.retry();
    expect(applyEdits).toHaveBeenCalledTimes(2);
    expect(retried.status).toBe("committed");
  });

  it("reverts the draft on discard-mine", async () => {
    const { source } = conflictingSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    await workflow.submit();

    const resolved = workflow.resolveConflict("discard-mine");
    expect(resolved.conflict).toBeUndefined();
    expect(resolved.status).toBe("draft");
    expect(resolved.dirty).toBe(false);
    expect(resolved.form?.controls.find((control) => control.name === "status")?.value).toBe("open");
  });

  it("closes the draft on reload so the host can reopen on fresh server state", async () => {
    const { source } = conflictingSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    await workflow.submit();

    const resolved = workflow.resolveConflict("reload");
    expect(resolved.status).toBe("idle");
    expect(resolved.form).toBeUndefined();
    expect(resolved.message).toMatch(/reload/i);
  });

  it("ignores a resolution when nothing is in conflict", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source });
    workflow.setSelection(existing());
    workflow.begin("update");
    expect(workflow.resolveConflict("keep-mine").status).toBe("draft");
  });
});

describe("HonuaFeatureEditorWorkflow — realtime reconciliation", () => {
  let workflow: HonuaFeatureEditorWorkflow<PermitAttributes>;
  let notifications: HonuaFeatureEditorSnapshot[];

  beforeEach(() => {
    const { source } = makeSource();
    workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    notifications = [];
    workflow.subscribe((snapshot) => {
      notifications.push(snapshot);
    });
  });

  it("ignores an unrelated feature change without touching the draft or notifying", () => {
    const outcome = workflow.applyExternalChange({
      id: 99,
      attributes: { OBJECTID: 99, status: "review", version: 12 },
    });
    expect(outcome).toBe("ignored");
    expect(notifications).toHaveLength(0);
    expect(workflow.snapshot().form?.controls.find((control) => control.name === "status")?.value).toBe("closed");
  });

  it("adopts server values only for fields the user has not touched", () => {
    const outcome = workflow.applyExternalChange({
      id: 1,
      attributes: { OBJECTID: 1, permit_no: "P-1-renamed", status: "review", priority: 5, version: 7 },
    });
    expect(outcome).toBe("reconciled");
    const controls = Object.fromEntries(
      (workflow.snapshot().form?.controls ?? []).map((control) => [control.name, control.value]),
    );
    // The user's unsaved status edit survives; untouched fields adopt the server value.
    expect(controls.status).toBe("closed");
    expect(controls.permit_no).toBe("P-1-renamed");
    expect(controls.priority).toBe(5);
  });

  it("requires an explicit resolution when the external change diverges", async () => {
    const outcome = workflow.applyExternalChange({
      id: 1,
      attributes: { OBJECTID: 1, status: "review", version: 8 },
    });
    expect(outcome).toBe("conflict");
    expect(workflow.snapshot().status).toBe("conflict");
    expect(workflow.snapshot().conflict).toMatchObject({ mine: 7, theirs: 8, versionField: "version" });
    // The draft is untouched and nothing can be transported until resolved.
    expect(workflow.snapshot().form?.controls.find((control) => control.name === "status")?.value).toBe("closed");
    expect((await workflow.submit()).transported).toBe(false);
  });

  it("ignores an external change when no draft is open", () => {
    const { source } = makeSource();
    const idle = createFeatureEditorWorkflow({ source });
    expect(idle.applyExternalChange({ id: 1, attributes: {} })).toBe("ignored");
  });
});

describe("HonuaFeatureEditorWorkflow — superseded submissions", () => {
  /**
   * An `AbortSignal` is advisory: a transport may settle a submit that the
   * workflow has already moved on from. A completion that no longer owns the
   * workflow must never stamp its outcome onto the draft that replaced it.
   */
  function gatedSource(result: () => EditResult) {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const made = makeSource({
      applyEdits: async () => {
        await gate;
        return result();
      },
    });
    return { ...made, release: () => release?.() };
  }

  it("discards a superseded success instead of marking the new draft committed", async () => {
    const { source, release } = gatedSource(() => ok([{ id: 101, success: true }]));
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    const seen: string[] = [];
    workflow.subscribe((snapshot) => {
      seen.push(snapshot.status);
    });

    completeCreateDraft(workflow);
    const pending = workflow.submit();
    expect(workflow.snapshot().busy).toBe(true);

    // A brand new draft opens while the first submit is still in flight.
    workflow.begin("create");
    workflow.setValue("permit_no", "P-SECOND");
    release();
    const commit = await pending;

    expect(commit).toMatchObject({ superseded: true, status: "cancelled", transported: true });
    expect(commit.committedFeatureId).toBeUndefined();

    const snapshot = workflow.snapshot();
    expect(snapshot.status).toBe("draft");
    expect(snapshot.committedFeatureId).toBeUndefined();
    expect(snapshot.identity?.featureId).toBeUndefined();
    expect(snapshot.form?.controls.find((control) => control.name === "permit_no")?.value).toBe("P-SECOND");
    expect(snapshot.message).toMatch(/New feature draft/i);
    // The stale completion must not have notified anybody.
    expect(seen).not.toContain("committed");
  });

  it("discards a superseded rejection instead of marking the new draft rejected", async () => {
    const { source, release } = gatedSource(() =>
      ok([{ success: false, error: { code: 500, description: "first draft blew up" } }]),
    );
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const pending = workflow.submit();

    workflow.begin("create");
    release();
    const commit = await pending;

    expect(commit.superseded).toBe(true);
    expect(commit.failures[0]).toMatchObject({ code: 500 });
    const snapshot = workflow.snapshot();
    expect(snapshot.status).toBe("draft");
    expect(snapshot.failures).toEqual([]);
    expect(snapshot.message).not.toContain("first draft blew up");
  });

  it("does not let a superseded update rewrite the new draft's identity or baseline", async () => {
    const { source, release } = gatedSource(() => ok([], [{ id: 1, success: true }]));
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    const pending = workflow.submit();

    // Move to a different feature mid-flight.
    workflow.begin("update", {
      id: 55,
      attributes: { OBJECTID: 55, permit_no: "P-55", permit_kind: 1, status: "open", version: 2 },
    });
    release();
    const commit = await pending;

    expect(commit.superseded).toBe(true);
    const snapshot = workflow.snapshot();
    expect(snapshot.identity).toMatchObject({ featureId: 55, version: 2 });
    expect(snapshot.status).toBe("draft");
    expect(snapshot.dirty).toBe(false);
  });

  it("still reports a plain cancellation when no new draft replaced it", async () => {
    const { source, release } = gatedSource(() => ok([{ id: 101, success: true }]));
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const pending = workflow.submit();
    workflow.cancel();
    release();
    const commit = await pending;

    expect(commit.status).toBe("cancelled");
    expect(commit.superseded).toBeUndefined();
    expect(commit.snapshot.message).toMatch(/unknown/i);
  });

  it("treats a cancel followed by a new draft as superseded, keeping the new draft's message", async () => {
    const { source, release } = gatedSource(() => ok([{ id: 101, success: true }]));
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const pending = workflow.submit();
    workflow.cancel();
    workflow.setSelection(existing());
    workflow.begin("update");
    release();
    const commit = await pending;

    expect(commit.superseded).toBe(true);
    expect(workflow.snapshot().status).toBe("draft");
    expect(workflow.snapshot().message).toMatch(/Editing the selected feature/i);
    expect(workflow.snapshot().identity?.featureId).toBe(1);
  });

  it("does not rebuild the model under an in-flight submit when sketch tools change", async () => {
    const { source, release } = gatedSource(() => ok([{ id: 101, success: true }]));
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const pending = workflow.submit();

    // A sketch adapter attaching mid-submit must not swap the model out, which
    // would make the pending completion look superseded and drop its outcome.
    workflow.configureSketchTools({ rectangle: "supported" });
    release();
    const commit = await pending;

    expect(commit.superseded).toBeUndefined();
    expect(commit.status).toBe("committed");
    expect(workflow.snapshot().status).toBe("committed");
  });
});

describe("HonuaFeatureEditorWorkflow — undo, cancel, retry", () => {
  it("undoes and redoes attribute and geometry edits", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    expect(workflow.snapshot().dirty).toBe(false);

    workflow.setValue("status", "closed");
    workflow.setGeometry("point", { type: "Point", coordinates: [5, 6] });
    expect(workflow.snapshot().dirty).toBe(true);
    expect(workflow.snapshot().undo).toMatchObject({ canUndo: true, undoDepth: 2 });

    expect(workflow.undo()).toBe(true);
    expect(workflow.snapshot().sketch?.geometry).toEqual({ type: "Point", coordinates: [1, 2] });
    expect(workflow.undo()).toBe(true);
    expect(workflow.snapshot().dirty).toBe(false);
    expect(workflow.undo()).toBe(false);

    expect(workflow.redo()).toBe(true);
    expect(workflow.snapshot().form?.controls.find((control) => control.name === "status")?.value).toBe("closed");
  });

  it("cancels a draft without transporting anything", async () => {
    const { source, applyEdits } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const cancelled = workflow.cancel();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.form).toBeUndefined();
    expect(cancelled.message).toMatch(/nothing was sent/i);

    const commit = await workflow.submit();
    expect(commit.transported).toBe(false);
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it("reports a cancellation that lands mid-flight as cancelled, never as committed", async () => {
    let release: (() => void) | undefined;
    const { source } = makeSource({
      applyEdits: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ok([{ id: 101, success: true }]);
      },
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    const pending = workflow.submit();
    expect(workflow.snapshot().busy).toBe(true);
    workflow.cancel();
    release?.();
    const commit = await pending;
    expect(commit.status).toBe("cancelled");
    expect(commit.committedFeatureId).toBeUndefined();
    expect(commit.snapshot.message).toMatch(/unknown/i);
  });

  it("retries a rejected edit and reaches a committed state", async () => {
    let attempt = 0;
    const { source, applyEdits } = makeSource({
      applyEdits: async () => {
        attempt += 1;
        return attempt === 1
          ? ok([{ success: false, error: { code: 503, description: "service unavailable" } }])
          : ok([{ id: 101, success: true }]);
      },
    });
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    expect((await workflow.submit()).status).toBe("rejected");
    const retried = await workflow.retry();
    expect(applyEdits).toHaveBeenCalledTimes(2);
    expect(retried.status).toBe("committed");
  });

  it("reverts a dirty draft without closing it", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setValue("status", "closed");
    const reverted = workflow.discardChanges();
    expect(reverted.status).toBe("draft");
    expect(reverted.dirty).toBe(false);
    expect(reverted.form?.controls.find((control) => control.name === "status")?.value).toBe("open");
  });

  it("returns a truthful no-op when there is no draft", async () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source });
    expect(workflow.validate().valid).toBe(false);
    expect(workflow.undo()).toBe(false);
    expect(workflow.redo()).toBe(false);
    expect(workflow.startSketch("point")).toMatchObject({ state: "unsupported" });
    expect((await workflow.submit()).transported).toBe(false);
  });
});

describe("HonuaFeatureEditorWorkflow — sketch composition", () => {
  it("reports the contract's default tool support, including the unsupported reason", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.begin("create");
    const tools = Object.fromEntries((workflow.snapshot().sketch?.tools ?? []).map((tool) => [tool.tool, tool]));
    expect(tools.polygon?.state).toBe("supported");
    expect(tools.rectangle).toMatchObject({ state: "unsupported" });
    expect(tools.rectangle?.reason).toMatch(/renderer support/i);
    expect(workflow.startSketch("rectangle").state).toBe("unsupported");
  });

  it("upgrades tool support from a sketch adapter while preserving the draft", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    completeCreateDraft(workflow);
    workflow.setGeometry("point", { type: "Point", coordinates: [3, 4] });

    workflow.configureSketchTools({ rectangle: "supported", circle: "supported" });
    expect(workflow.startSketch("rectangle").state).toBe("supported");
    const snapshot = workflow.snapshot();
    expect(snapshot.form?.controls.find((control) => control.name === "permit_no")?.value).toBe("P-9");
    expect(snapshot.sketch?.geometry).toEqual({ type: "Point", coordinates: [3, 4] });
  });

  it("exposes snapping state and keeps it off unless configured", () => {
    const { source } = makeSource();
    const off = createFeatureEditorWorkflow({ source });
    off.begin("create");
    expect(off.snapshot().sketch?.snapping).toEqual({ enabled: false, tolerance: 12 });

    const on = createFeatureEditorWorkflow({ source, snapping: { enabled: true, tolerance: 20 } });
    on.begin("create");
    expect(on.snapshot().sketch?.snapping).toEqual({ enabled: true, tolerance: 20 });
  });

  it("clears geometry through the undoable sketch path", () => {
    const { source } = makeSource();
    const workflow = createFeatureEditorWorkflow({ source, subtypes: SUBTYPES });
    workflow.setSelection(existing());
    workflow.begin("update");
    workflow.setGeometry("point", null);
    expect(workflow.snapshot().sketch?.geometry).toBeNull();
    workflow.undo();
    expect(workflow.snapshot().sketch?.geometry).toEqual({ type: "Point", coordinates: [1, 2] });
  });
});

describe("HonuaFeatureEditorWorkflow — metadata seams", () => {
  it("accepts explicit field metadata instead of the source schema", () => {
    const { source } = makeSource({ fields: [] });
    const workflow = createFeatureEditorWorkflow({
      source,
      metadata: { fields: [{ name: "label", type: "string", nullable: false, alias: "Label" }] },
    });
    workflow.begin("create");
    expect(workflow.snapshot().form?.controls.map((control) => control.name)).toEqual(["label"]);
    expect(workflow.snapshot().form?.controls[0]).toMatchObject({ label: "Label", required: true });
  });

  it("applies a domain supplied through metadata.domains", () => {
    const { source } = makeSource({ fields: [] });
    const workflow = createFeatureEditorWorkflow({
      source,
      metadata: {
        fields: [{ name: "grade", type: "string" }],
        domains: { grade: { type: "coded-value", codedValues: [{ name: "A", code: "a" }] } },
      },
    });
    workflow.begin("create");
    expect(workflow.snapshot().form?.controls[0]).toMatchObject({ kind: "select" });
  });

  it("renders an empty form for a source publishing no field metadata", () => {
    const { source } = makeSource({ fields: [] });
    const workflow = createFeatureEditorWorkflow({ source });
    const snapshot = workflow.begin("create");
    expect(snapshot.status).toBe("draft");
    expect(snapshot.form?.controls).toEqual([]);
  });
});
