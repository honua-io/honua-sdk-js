import type { CanonicalFeature, FeatureId, Protocol, Source, SourceId } from "./types.js";
import {
  type CreateEditSessionOptions,
  type EditAttachmentMutation,
  type EditWorkflowKind,
  type EditWorkflowMetadata,
  type EditWorkflowSession,
  type EditWorkflowSnapshot,
  type EditWorkflowSubmitResult,
  type EditWorkflowValidationResult,
  createEditSession,
} from "./edit-session.js";

export type EditSketchTool = "point" | "line" | "polygon" | "rectangle" | "circle" | "buffer";
export type EditSketchCapabilityState = "supported" | "unsupported";
export type EditSketchStatus = "idle" | "sketching" | "ready" | "unsupported";
export type EditAnnotationPersistenceState = "not-configured" | "supported" | "failed";

export interface EditSketchToolCapability {
  tool: EditSketchTool;
  state: EditSketchCapabilityState;
  reason?: string;
}

export type EditSketchToolCapabilityInput =
  | EditSketchCapabilityState
  | {
      state: EditSketchCapabilityState;
      reason?: string;
    };

export interface EditSketchWorkflowOptions<T = Record<string, unknown>>
  extends Omit<CreateEditSessionOptions<T>, "optimistic"> {
  sketchTools?: Partial<Record<EditSketchTool, EditSketchToolCapabilityInput>>;
  optimistic?: CreateEditSessionOptions<T>["optimistic"];
  annotationPersistence?: EditAnnotationPersistenceHook<T>;
}

export interface EditAnnotationPersistenceHook<T = Record<string, unknown>> {
  persist(snapshot: EditWorkflowSnapshot<T>, result: EditWorkflowSubmitResult<T>): void | Promise<void>;
}

export interface EditAnnotationPersistenceSnapshot {
  state: EditAnnotationPersistenceState;
  reason?: string;
}

export interface EditSketchUndoSnapshot {
  canUndo: boolean;
  canRedo: boolean;
  undoDepth: number;
  redoDepth: number;
}

export interface EditSketchWorkflowSnapshot<T = Record<string, unknown>> {
  sourceId: SourceId;
  protocol: Protocol;
  kind: EditWorkflowKind;
  feature: CanonicalFeature<T>;
  attachments: readonly EditAttachmentMutation[];
  metadata: EditWorkflowMetadata;
  sketch: {
    status: EditSketchStatus;
    activeTool?: EditSketchTool;
    tool?: EditSketchTool;
    tools: readonly EditSketchToolCapability[];
    geometry: Record<string, unknown> | null | undefined;
  };
  dirty: boolean;
  validation: EditWorkflowValidationResult;
  undo: EditSketchUndoSnapshot;
  annotations: EditAnnotationPersistenceSnapshot;
}

type RestorableSnapshot<T> = Pick<EditWorkflowSnapshot<T>, "kind" | "feature" | "attachments">;

const EDIT_SKETCH_TOOLS: readonly EditSketchTool[] = ["point", "line", "polygon", "rectangle", "circle", "buffer"];

const DEFAULT_SKETCH_TOOL_CAPABILITIES: Readonly<Record<EditSketchTool, EditSketchToolCapability>> = {
  point: { tool: "point", state: "supported" },
  line: { tool: "line", state: "supported" },
  polygon: { tool: "polygon", state: "supported" },
  rectangle: { tool: "rectangle", state: "unsupported", reason: "rectangle sketch requires renderer support" },
  circle: { tool: "circle", state: "unsupported", reason: "circle sketch requires renderer support" },
  buffer: { tool: "buffer", state: "unsupported", reason: "buffer sketch requires geometry service support" },
};

export class EditSketchWorkflowModel<T = Record<string, unknown>> {
  public readonly source: Source<T>;
  public readonly kind: EditWorkflowKind;
  readonly #options: EditSketchWorkflowOptions<T>;
  #session: EditWorkflowSession<T>;
  #base: EditWorkflowSnapshot<T>;
  #undo: RestorableSnapshot<T>[] = [];
  #redo: RestorableSnapshot<T>[] = [];
  #activeTool: EditSketchTool | undefined;
  #lastTool: EditSketchTool | undefined;
  #annotationState: EditAnnotationPersistenceSnapshot;

  public constructor(options: EditSketchWorkflowOptions<T>) {
    this.source = options.source;
    this.kind = options.kind ?? (options.feature?.id === undefined ? "create" : "update");
    this.#options = options;
    this.#session = createEditSession(options);
    this.#base = this.#session.snapshot();
    this.#annotationState = options.annotationPersistence ? { state: "supported" } : { state: "not-configured" };
  }

  public snapshot(): EditSketchWorkflowSnapshot<T> {
    const snapshot = this.#session.snapshot();
    const validation = this.#session.validate();
    return {
      sourceId: snapshot.sourceId,
      protocol: snapshot.protocol,
      kind: snapshot.kind,
      feature: snapshot.feature,
      attachments: snapshot.attachments,
      metadata: snapshot.metadata,
      sketch: {
        status: this.sketchStatus(),
        ...(this.#activeTool ? { activeTool: this.#activeTool } : {}),
        ...(this.#lastTool ? { tool: this.#lastTool } : {}),
        tools: this.tools(),
        geometry: snapshot.feature.geometry,
      },
      dirty: this.dirty(),
      validation,
      undo: this.undoState(),
      annotations: this.#annotationState,
    };
  }

  public tools(): readonly EditSketchToolCapability[] {
    return EDIT_SKETCH_TOOLS.map((tool) => this.toolCapability(tool));
  }

  public toolCapability(tool: EditSketchTool): EditSketchToolCapability {
    const configured = this.#options.sketchTools?.[tool];
    if (configured === undefined) return { ...DEFAULT_SKETCH_TOOL_CAPABILITIES[tool] };
    if (typeof configured === "string") return { tool, state: configured };
    return { tool, state: configured.state, ...(configured.reason ? { reason: configured.reason } : {}) };
  }

  public startSketch(tool: EditSketchTool): EditSketchToolCapability {
    const capability = this.toolCapability(tool);
    this.#activeTool = capability.state === "supported" ? tool : undefined;
    this.#lastTool = tool;
    return capability;
  }

  public setSketchGeometry(tool: EditSketchTool, geometry: Record<string, unknown> | null): this {
    const capability = this.startSketch(tool);
    if (capability.state === "unsupported") return this;
    this.recordUndo();
    this.#session.setGeometry(geometry);
    this.#activeTool = undefined;
    return this;
  }

  public setValue(fieldName: string, value: unknown): this {
    this.recordUndo();
    this.#session.setValue(fieldName, value);
    return this;
  }

  public setValues(values: Partial<T>): this {
    this.recordUndo();
    this.#session.setValues(values);
    return this;
  }

  public setId(id: FeatureId): this {
    this.recordUndo();
    this.#session.setId(id);
    return this;
  }

  public stageAttachmentAdd(
    attachment: Blob | File | string,
    options: { parentId?: FeatureId; name?: string; contentType?: string } = {},
  ): this {
    this.recordUndo();
    this.#session.stageAttachmentAdd(attachment, options);
    return this;
  }

  public stageAttachmentUpdate(
    attachmentId: FeatureId,
    attachment: Blob | File | string,
    options: { parentId?: FeatureId; name?: string; contentType?: string } = {},
  ): this {
    this.recordUndo();
    this.#session.stageAttachmentUpdate(attachmentId, attachment, options);
    return this;
  }

  public stageAttachmentDelete(attachmentIds: readonly FeatureId[], options: { parentId?: FeatureId } = {}): this {
    this.recordUndo();
    this.#session.stageAttachmentDelete(attachmentIds, options);
    return this;
  }

  public undo(): boolean {
    const previous = this.#undo.pop();
    if (!previous) return false;
    this.#redo.push(restorableSnapshot(this.#session.snapshot()));
    this.restore(previous);
    return true;
  }

  public redo(): boolean {
    const next = this.#redo.pop();
    if (!next) return false;
    this.#undo.push(restorableSnapshot(this.#session.snapshot()));
    this.restore(next);
    return true;
  }

  public discard(): void {
    this.restore(restorableSnapshot(this.#base));
    this.#undo = [];
    this.#redo = [];
    this.#activeTool = undefined;
    this.#lastTool = undefined;
  }

  public dirty(): boolean {
    return !sameRestorable(restorableSnapshot(this.#base), restorableSnapshot(this.#session.snapshot()));
  }

  public validate(): EditWorkflowValidationResult {
    return this.#session.validate();
  }

  public async submit(overrides: Partial<T> = {}): Promise<EditWorkflowSubmitResult<T>> {
    const result = await this.#session.submit(overrides);
    if (result.status === "succeeded" && this.#options.annotationPersistence) {
      try {
        await this.#options.annotationPersistence.persist(result.snapshot, result);
        this.#annotationState = { state: "supported" };
      } catch (err) {
        this.#annotationState = { state: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
    if (result.status === "succeeded") {
      this.#base = this.#session.snapshot();
      this.#undo = [];
      this.#redo = [];
    }
    return result;
  }

  private undoState(): EditSketchUndoSnapshot {
    return {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      undoDepth: this.#undo.length,
      redoDepth: this.#redo.length,
    };
  }

  private sketchStatus(): EditSketchStatus {
    if (this.#activeTool) return "sketching";
    if (this.#lastTool && this.toolCapability(this.#lastTool).state === "unsupported") return "unsupported";
    return this.#session.snapshot().feature.geometry === undefined ? "idle" : "ready";
  }

  private recordUndo(): void {
    this.#undo.push(restorableSnapshot(this.#session.snapshot()));
    this.#redo = [];
  }

  private restore(snapshot: RestorableSnapshot<T>): void {
    this.#session = createEditSession<T>({
      source: this.source,
      kind: snapshot.kind,
      feature: cloneFeature(snapshot.feature),
      metadata: metadataOptionsFromSnapshot(this.#session.snapshot().metadata),
      rollbackOnFailure: this.#options.rollbackOnFailure,
      signal: this.#options.signal,
      optimistic: this.#options.optimistic,
    });
    for (const mutation of snapshot.attachments) stageAttachment(this.#session, mutation);
  }
}

export function createEditSketchWorkflow<T = Record<string, unknown>>(
  options: EditSketchWorkflowOptions<T>,
): EditSketchWorkflowModel<T> {
  return new EditSketchWorkflowModel(options);
}

function restorableSnapshot<T>(snapshot: EditWorkflowSnapshot<T>): RestorableSnapshot<T> {
  return {
    kind: snapshot.kind,
    feature: cloneFeature(snapshot.feature),
    attachments: snapshot.attachments.map(cloneAttachmentMutation),
  };
}

function metadataOptionsFromSnapshot(metadata: EditWorkflowMetadata): CreateEditSessionOptions["metadata"] {
  return {
    fields: metadata.fields,
    relationships: metadata.relationships,
    primaryKey: metadata.primaryKey,
    conflict: metadata.conflict,
  };
}

function stageAttachment<T>(session: EditWorkflowSession<T>, mutation: EditAttachmentMutation): void {
  if (mutation.operation === "add") {
    session.stageAttachmentAdd(mutation.attachment, {
      parentId: mutation.parentId,
      name: mutation.name,
      contentType: mutation.contentType,
    });
  } else if (mutation.operation === "update") {
    session.stageAttachmentUpdate(mutation.attachmentId, mutation.attachment, {
      parentId: mutation.parentId,
      name: mutation.name,
      contentType: mutation.contentType,
    });
  } else {
    session.stageAttachmentDelete(mutation.attachmentIds, { parentId: mutation.parentId });
  }
}

function cloneFeature<T>(feature: CanonicalFeature<T>): CanonicalFeature<T> {
  return {
    ...(feature.id !== undefined ? { id: feature.id } : {}),
    attributes: { ...(feature.attributes as Record<string, unknown>) } as T,
    ...(feature.geometry !== undefined ? { geometry: feature.geometry === null ? null : { ...feature.geometry } } : {}),
  };
}

function cloneAttachmentMutation(mutation: EditAttachmentMutation): EditAttachmentMutation {
  if (mutation.operation === "delete") return { ...mutation, attachmentIds: [...mutation.attachmentIds] };
  return { ...mutation };
}

function sameRestorable<T>(left: RestorableSnapshot<T>, right: RestorableSnapshot<T>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
