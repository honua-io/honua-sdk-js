import { describe, expect, it, vi } from "vitest";

import {
  type AttachmentApi,
  type Capabilities,
  type EditEnvelope,
  type EditResult,
  type Protocol,
  type Query,
  type RelatedQuery,
  type Source,
  type SourceDescriptor,
  capabilities,
  createEditSketchWorkflow,
  createEditSession,
  normalizeEditWorkflowFailures,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";

type ParcelDraft = Record<string, unknown>;

const PARCEL_FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", nullable: false, editable: false },
  { name: "status", type: "esriFieldTypeString", nullable: false, editable: true, length: 12 },
  { name: "version", type: "esriFieldTypeInteger", nullable: false, editable: true },
] as const;

const STATUS_DOMAIN = {
  type: "coded-value" as const,
  codedValues: [
    { name: "Open", code: "open" },
    { name: "Closed", code: "closed" },
  ],
};

describe("contract / edit workflow session", () => {
  it("projects field metadata, domains, relationship support, attachments, and conflict hints", async () => {
    let observedRelated: RelatedQuery | undefined;
    const source = makeSource({
      capabilities: capabilities(["applyEdits", "attachments", "queryRelated"]),
      queryRelated: async (request) => {
        observedRelated = request;
        return { groups: [{ sourceId: request.sourceIds[0], features: [] }] };
      },
    });
    const session = createEditSession<ParcelDraft>({
      source,
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "open", version: 4 } },
      metadata: {
        domains: { status: STATUS_DOMAIN },
        relationships: [{ relationshipId: 2, name: "inspections", relatedSourceId: "inspections" }],
      },
    });

    expect(session.capabilities()).toEqual({
      applyEdits: "supported",
      attachments: "supported",
      relationships: "supported",
      conflicts: "supported",
    });
    expect(session.metadata().fields.find((field) => field.name === "status")?.domain).toBe(STATUS_DOMAIN);
    expect(session.metadata().relationships[0]).toMatchObject({ relationshipId: 2, name: "inspections" });
    expect(session.metadata().conflict).toMatchObject({ state: "supported", versionField: "version", value: 4 });

    await session.queryRelated(2);
    expect(observedRelated).toMatchObject({ relationshipId: 2, sourceIds: [10] });
  });

  it("validates required fields, coded domains, string length, and read-only fields before submitting", async () => {
    const applyEdits = vi.fn();
    const session = createEditSession<ParcelDraft>({
      source: makeSource({ applyEdits }),
      kind: "create",
      feature: { attributes: { OBJECTID: 1, status: "invalid-too-long", version: undefined } },
      metadata: { domains: { status: STATUS_DOMAIN } },
    });

    const result = await session.submit();

    expect(result.status).toBe("validation-failed");
    expect(result.validation.errors.map((error) => error.code)).toEqual(["read-only", "length", "domain", "required"]);
    expect(result.failures.every((failure) => failure.kind === "validation")).toBe(true);
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it("submits feature edits and staged attachment mutations in one workflow", async () => {
    let observedEnvelope: EditEnvelope<ParcelDraft> | undefined;
    let observedAttachmentParent: unknown;
    const source = makeSource({
      capabilities: capabilities(["applyEdits", "attachments"]),
      applyEdits: async (envelope) => {
        observedEnvelope = envelope;
        return { added: [{ id: 99, success: true }], updated: [], deleted: [] };
      },
      attachments: {
        ...unsupportedAttachments(),
        add: async (request) => {
          observedAttachmentParent = request.parentId;
          return { parentId: request.parentId, attachmentId: 7, success: true };
        },
      },
    });
    const commit = vi.fn();
    const rollback = vi.fn();
    const session = createEditSession<ParcelDraft>({
      source,
      kind: "create",
      feature: { attributes: { status: "open", version: 1 } },
      metadata: { domains: { status: STATUS_DOMAIN } },
      optimistic: { apply: vi.fn(), commit, rollback },
    }).stageAttachmentAdd("inspection.pdf", { name: "inspection.pdf", contentType: "application/pdf" });

    const result = await session.submit();

    expect(result.status).toBe("succeeded");
    expect(result.committedFeatureId).toBe(99);
    expect(observedEnvelope?.adds?.[0].attributes).toMatchObject({ status: "open" });
    expect(observedAttachmentParent).toBe(99);
    expect(result.attachmentResults[0].outcomes[0]).toEqual({ parentId: 99, attachmentId: 7, success: true });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back optimistic updates and surfaces conflict/version details on partial failure", async () => {
    const apply = vi.fn();
    const rollback = vi.fn();
    const source = makeSource({
      capabilities: capabilities(["applyEdits", "attachments"]),
      applyEdits: async () => ({
        added: [],
        updated: [
          {
            id: 10,
            success: false,
            error: { code: 409, description: "version conflict: expected 4" },
          },
        ],
        deleted: [],
      }),
    });
    const session = createEditSession<ParcelDraft>({
      source,
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "closed", version: 4 } },
      metadata: { domains: { status: STATUS_DOMAIN } },
      optimistic: { apply, rollback },
    });

    const result = await session.submit();

    expect(result.status).toBe("failed");
    expect(result.optimistic).toEqual({ applied: true, rolledBack: true });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(result.failures[0]).toMatchObject({
      kind: "conflict",
      operation: "update",
      id: 10,
      code: 409,
      conflict: { state: "supported", versionField: "version", value: 4 },
    });
  });

  it("keeps unsupported applyEdits and attachment states explicit and skips optimistic hooks", async () => {
    const optimisticApply = vi.fn();
    const source = makeSource({ capabilities: capabilities(["query"]) });
    const session = createEditSession<ParcelDraft>({
      source,
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "open", version: 1 } },
      optimistic: { apply: optimisticApply },
    }).stageAttachmentDelete([7]);

    expect(session.capabilities()).toMatchObject({
      applyEdits: "unsupported",
      attachments: "unsupported",
    });

    const result = await session.submit();

    expect(result.status).toBe("unsupported");
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((failure) => failure.kind === "capability")).toBe(true);
    expect(optimisticApply).not.toHaveBeenCalled();
  });

  it("tracks reusable sketch geometry, dirty state, undo, redo, and unsupported tools outside UI", () => {
    const workflow = createEditSketchWorkflow<ParcelDraft>({
      source: makeSource(),
      kind: "update",
      feature: {
        id: 10,
        attributes: { OBJECTID: 10, status: "open", version: 1 },
        geometry: { type: "point", x: 0, y: 0 },
      },
      metadata: { domains: { status: STATUS_DOMAIN } },
      sketchTools: {
        rectangle: { state: "supported" },
        circle: { state: "unsupported", reason: "renderer does not expose circle handles" },
      },
    });

    workflow.setSketchGeometry("rectangle", {
      type: "polygon",
      rings: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
    });
    workflow.setValue("status", "closed");

    expect(workflow.snapshot()).toMatchObject({
      dirty: true,
      sketch: { status: "ready", tool: "rectangle" },
      undo: { canUndo: true, canRedo: false, undoDepth: 2 },
    });
    expect(workflow.snapshot().feature.geometry).toMatchObject({ type: "polygon" });

    expect(workflow.undo()).toBe(true);
    expect(workflow.snapshot().feature.attributes.status).toBe("open");
    expect(workflow.snapshot().undo).toMatchObject({ canUndo: true, canRedo: true });

    expect(workflow.redo()).toBe(true);
    expect(workflow.snapshot().feature.attributes.status).toBe("closed");

    workflow.setSketchGeometry("circle", { type: "circle", x: 0, y: 0, radius: 10 });
    expect(workflow.snapshot().sketch).toMatchObject({ status: "unsupported", tool: "circle" });
    expect(workflow.snapshot().feature.geometry).toMatchObject({ type: "polygon" });

    workflow.discard();
    expect(workflow.snapshot()).toMatchObject({ dirty: false, undo: { canUndo: false, canRedo: false } });
    expect(workflow.snapshot().feature.geometry).toMatchObject({ type: "point", x: 0, y: 0 });
  });

  it("persists configured annotations only after successful sketch workflow commits", async () => {
    const persisted = vi.fn();
    const failing = createEditSketchWorkflow<ParcelDraft>({
      source: makeSource({
        applyEdits: async () => ({
          added: [],
          updated: [{ id: 10, success: false, error: { code: 409, description: "version conflict" } }],
          deleted: [],
        }),
      }),
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "closed", version: 1 } },
      metadata: { domains: { status: STATUS_DOMAIN } },
      annotationPersistence: { persist: persisted },
    });

    const failed = await failing.submit();
    expect(failed.status).toBe("failed");
    expect(persisted).not.toHaveBeenCalled();
    expect(failing.snapshot().annotations).toEqual({ state: "supported" });

    const successful = createEditSketchWorkflow<ParcelDraft>({
      source: makeSource(),
      kind: "update",
      feature: { id: 10, attributes: { OBJECTID: 10, status: "closed", version: 1 } },
      metadata: { domains: { status: STATUS_DOMAIN } },
      annotationPersistence: { persist: persisted },
    });
    successful.setSketchGeometry("point", { type: "point", x: 1, y: 2 });

    const result = await successful.submit();

    expect(result.status).toBe("succeeded");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(successful.snapshot()).toMatchObject({
      dirty: false,
      annotations: { state: "supported" },
    });
  });

  it("normalizes protocol edit failures across GeoServices, OGC Features, WFS, and OData", () => {
    const cases: Array<{ protocol: Protocol; editResult: EditResult; expectedKind: string; expectedCode?: number }> = [
      {
        protocol: "geoservices-feature-service",
        editResult: {
          added: [{ success: false, error: { code: 400, description: "missing required field" } }],
          updated: [],
          deleted: [],
        },
        expectedKind: "validation",
        expectedCode: 400,
      },
      {
        protocol: "ogc-features",
        editResult: {
          added: [],
          updated: [{ id: 7, success: false, error: { code: 409, description: "version conflict" } }],
          deleted: [],
        },
        expectedKind: "conflict",
        expectedCode: 409,
      },
      {
        protocol: "wfs",
        editResult: {
          added: [{ success: false }],
          updated: [],
          deleted: [],
        },
        expectedKind: "partial-failure",
      },
      {
        protocol: "odata",
        editResult: {
          added: [],
          updated: [{ id: 1, success: false, error: { code: 412, description: "ETag precondition failed" } }],
          deleted: [],
        },
        expectedKind: "conflict",
        expectedCode: 412,
      },
    ];

    for (const item of cases) {
      const failures = normalizeEditWorkflowFailures(item.editResult, {
        sourceId: `${item.protocol}-source`,
        protocol: item.protocol,
        conflict: { state: "supported", etagField: "etag", value: "v1" },
      });
      expect(failures[0]).toMatchObject({
        kind: item.expectedKind,
        protocol: item.protocol,
        sourceId: `${item.protocol}-source`,
      });
      if (item.expectedCode !== undefined) expect(failures[0].code).toBe(item.expectedCode);
    }
  });
});

function makeSource(
  options: {
    capabilities?: Capabilities;
    applyEdits?: Source<ParcelDraft>["applyEdits"];
    queryRelated?: Source<ParcelDraft>["queryRelated"];
    attachments?: Partial<AttachmentApi>;
  } = {},
): Source<ParcelDraft> {
  const descriptor: SourceDescriptor = {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
    capabilities: options.capabilities ?? capabilities(["query", "applyEdits", "attachments", "queryRelated"]),
    schema: { primaryKey: "OBJECTID", fields: PARCEL_FIELDS },
  };
  const caps = descriptor.capabilities;
  const attachments = { ...unsupportedAttachments(), ...(options.attachments ?? {}) };
  return {
    descriptor,
    capabilities: caps,
    async query(_request?: Query<ParcelDraft>) {
      return { features: [], exceededTransferLimit: false };
    },
    async queryAll(_request?: Query<ParcelDraft>) {
      return { features: [], exceededTransferLimit: false };
    },
    async queryAggregate() {
      return { features: [], exceededTransferLimit: false };
    },
    async queryExtent() {
      return { extent: null };
    },
    stream() {
      return emptyResultStream();
    },
    async queryObjectIds() {
      return [];
    },
    applyEdits:
      options.applyEdits ??
      (async () => ({
        added: [],
        updated: [{ id: 10, success: true }],
        deleted: [],
      })),
    queryRelated:
      options.queryRelated ??
      (async (request) => ({
        groups: request.sourceIds.map((sourceId) => ({ sourceId, features: [] })),
      })),
    attachments,
    protocol() {
      return undefined;
    },
    adapter() {
      return undefined;
    },
  };
}

async function* emptyResultStream(shouldYield = false) {
  if (shouldYield) {
    yield { features: [], exceededTransferLimit: false };
  }
}

function unsupportedAttachments(): AttachmentApi {
  const fail = () => {
    throw new HonuaCapabilityNotSupportedError("attachments", "geoservices-feature-service", "parcels");
  };
  return {
    query: fail,
    list: fail,
    add: fail,
    update: fail,
    delete: fail,
  };
}
