/**
 * Host-facing edit workflow behind `<honua-feature-editor>` (issue #680).
 *
 * This is the composition layer: it owns a public contract
 * {@link EditSketchWorkflowModel} (which itself owns the edit session, undo /
 * redo, snapping, attachment staging, optimistic hooks, and the single
 * `applyEdits` call) and adds only what an operational editing UI needs on top
 * and the protocol layer deliberately does not model:
 *
 * - **Draft identity.** A draft is scoped to `source` + feature id + the
 *   concurrency token observed when it opened, so an unrelated realtime change
 *   can be recognised and ignored without disturbing the form
 *   ({@link HonuaFeatureEditorWorkflow.applyExternalChange}, REQ-005).
 * - **Subtype-aware pre-transport validation.** Subtype overrides change the
 *   valid choices per field. Rather than duplicating the contract validator,
 *   {@link HonuaFeatureEditorWorkflow.validate} builds a throwaway
 *   `createEditSession` over the *subtype-resolved* field list and runs the
 *   contract's own `validate()` against it, merging the result with the live
 *   model's session-level verdict. An invalid draft is rejected with
 *   `transported: false` — nothing reaches the wire.
 * - **An explicit conflict gate.** A version/etag/precondition failure (or a
 *   divergent external change) parks the draft in `"conflict"`; `submit()`
 *   refuses to retransport until {@link HonuaFeatureEditorWorkflow.resolveConflict}
 *   records a decision (REQ-004 / REQ-005).
 * - **Redacted state.** Snapshots and events describe staged attachments but
 *   never carry the payload — a `Blob` or a (possibly credential-bearing)
 *   string URL stays inside the edit session.
 *
 * No protocol adapter is imported and no status is ever optimistic about a
 * rejected edit: every non-`"succeeded"` submit result maps to
 * `"rejected"` / `"conflict"` / `"unsupported"` / `"cancelled"`, never
 * `"committed"`.
 *
 * @module
 */

import {
  type EditWorkflowConflictInfo,
  type EditWorkflowFailureKind,
  type EditWorkflowField,
  type EditWorkflowMetadataOptions,
  type EditWorkflowOperation,
  type EditWorkflowOptimisticHooks,
  type EditWorkflowSubmitResult,
  type EditWorkflowValidationError,
  type EditWorkflowValidationResult,
  createEditSession,
} from "../contract/edit-session.js";
import {
  type EditSketchTool,
  type EditSketchToolCapability,
  type EditSketchToolCapabilityInput,
  type EditSketchUndoSnapshot,
  type EditSketchWorkflowModel,
  createEditSketchWorkflow,
} from "../contract/edit-sketch.js";
import type { SnappingConfig } from "../contract/edit-snapping.js";
import type { CanonicalFeature, FeatureId, Source, SourceId } from "../contract/types.js";
import {
  type HonuaEditorAttachmentDraft,
  type HonuaEditorFormModel,
  type HonuaEditorOperation,
  type HonuaEditorOperationAvailability,
  type HonuaEditorOperationOverrides,
  type HonuaEditorSubtypeConfig,
  buildEditorFormModel,
  coerceEditorFieldValue,
  editorFieldsFromSchema,
  editorOperationAvailability,
  redactEditorAttachment,
  resolveActiveEditorSubtype,
  resolveEditorFields,
  resolveEditorOperations,
} from "./feature-editor-model.js";

/** Lifecycle state of the editor. Never `"committed"` for a rejected edit. */
export type HonuaFeatureEditorStatus =
  | "idle"
  | "draft"
  | "submitting"
  | "committed"
  | "rejected"
  | "conflict"
  | "cancelled"
  | "unsupported";

/** Identity a draft is scoped to until it is accepted. */
export interface HonuaFeatureEditorIdentity {
  readonly sourceId: SourceId;
  readonly featureId?: FeatureId;
  /** Concurrency token observed when the draft opened, when the source has one. */
  readonly version?: unknown;
  readonly versionField?: string;
}

/** A failure surfaced to the UI, normalized from the contract's own failure list. */
export interface HonuaFeatureEditorFailure {
  readonly kind: EditWorkflowFailureKind;
  readonly operation: EditWorkflowOperation;
  readonly code?: number;
  readonly description: string;
}

/** How a conflicting draft may be resolved. */
export type HonuaFeatureEditorConflictChoice = "keep-mine" | "discard-mine" | "reload";

/** An unresolved conflict. `submit()` refuses to transport while this is set. */
export interface HonuaFeatureEditorConflict {
  readonly reason: string;
  readonly versionField?: string;
  /** Token the draft carries. */
  readonly mine?: unknown;
  /** Token observed on the server / in the external change, when known. */
  readonly theirs?: unknown;
  readonly choices: readonly HonuaFeatureEditorConflictChoice[];
}

/** Geometry / sketch state, mirrored from the contract sketch workflow. */
export interface HonuaFeatureEditorSketchState {
  readonly status: "idle" | "sketching" | "ready" | "unsupported";
  readonly activeTool?: EditSketchTool;
  readonly tools: readonly EditSketchToolCapability[];
  readonly geometry: Record<string, unknown> | null | undefined;
  readonly snapping: Pick<SnappingConfig, "enabled" | "tolerance">;
}

/** Everything the editor UI renders. Carries no attachment payloads. */
export interface HonuaFeatureEditorSnapshot {
  readonly status: HonuaFeatureEditorStatus;
  readonly operation?: HonuaEditorOperation;
  readonly identity?: HonuaFeatureEditorIdentity;
  readonly operations: readonly HonuaEditorOperationAvailability[];
  readonly form?: HonuaEditorFormModel;
  readonly sketch?: HonuaFeatureEditorSketchState;
  readonly undo: EditSketchUndoSnapshot;
  readonly attachments: readonly HonuaEditorAttachmentDraft[];
  readonly attachmentsSupported: boolean;
  readonly failures: readonly HonuaFeatureEditorFailure[];
  readonly conflict?: HonuaFeatureEditorConflict;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly message: string;
  readonly committedFeatureId?: FeatureId;
}

/** Outcome of a `submit()` / `retry()`. `transported` is false for pre-flight rejections. */
export interface HonuaFeatureEditorCommit {
  readonly status: HonuaFeatureEditorStatus;
  readonly operation: HonuaEditorOperation;
  readonly transported: boolean;
  readonly committedFeatureId?: FeatureId;
  readonly failures: readonly HonuaFeatureEditorFailure[];
  readonly attachments: readonly HonuaEditorAttachmentDraft[];
  readonly snapshot: HonuaFeatureEditorSnapshot;
  /**
   * True when this submit no longer owned the workflow by the time the
   * transport settled — a newer draft had already been opened (or the draft was
   * cancelled and replaced). The workflow state was left entirely to the newer
   * draft, so `status` is reported as `"cancelled"` and `snapshot` describes the
   * *current* draft, not this one. The server outcome for the superseded edit is
   * in `failures` (empty means the service reported no failure), but the
   * workflow makes no claim about it.
   */
  readonly superseded?: boolean;
}

/** Result of reconciling one external (realtime) feature change. */
export type HonuaFeatureEditorExternalChangeOutcome = "ignored" | "reconciled" | "conflict";

export interface HonuaFeatureEditorOptions<T = Record<string, unknown>> {
  /** Editable source. Only the public `Source` contract is used. */
  readonly source: Source<T>;
  /**
   * Field / domain / primary-key / conflict metadata. Defaults to the source's
   * public schema, with coded-value and range domains projected across (see
   * `editorFieldsFromSchema`).
   */
  readonly metadata?: EditWorkflowMetadataOptions;
  /** Subtype configuration; drives per-subtype choices and overrides. */
  readonly subtypes?: HonuaEditorSubtypeConfig;
  /** Per-operation host denials (e.g. a service's `deleteEnabled: false`). Deny-only. */
  readonly operations?: HonuaEditorOperationOverrides;
  /** Sketch tool capabilities; a sketch adapter (e.g. terra-draw) supplies its own. */
  readonly sketchTools?: Partial<Record<EditSketchTool, EditSketchToolCapabilityInput>>;
  readonly snapping?: Partial<SnappingConfig>;
  readonly rollbackOnFailure?: boolean;
  /** Optimistic apply/rollback/commit hooks, passed straight to the edit session. */
  readonly optimistic?: EditWorkflowOptimisticHooks<T>;
}

type EditorListener = (snapshot: HonuaFeatureEditorSnapshot) => void;

const EMPTY_UNDO: EditSketchUndoSnapshot = { canUndo: false, canRedo: false, undoDepth: 0, redoDepth: 0 };

const CONFLICT_CHOICES: readonly HonuaFeatureEditorConflictChoice[] = ["keep-mine", "discard-mine", "reload"];

export class HonuaFeatureEditorWorkflow<T = Record<string, unknown>> {
  public readonly source: Source<T>;

  readonly #options: HonuaFeatureEditorOptions<T>;
  readonly #listeners = new Set<EditorListener>();
  readonly #schemaFields: readonly EditWorkflowField[];

  #sketchTools: Partial<Record<EditSketchTool, EditSketchToolCapabilityInput>> | undefined;
  #model: EditSketchWorkflowModel<T> | undefined;
  #selection: CanonicalFeature<T> | undefined;
  #operation: HonuaEditorOperation | undefined;
  #status: HonuaFeatureEditorStatus = "idle";
  #identity: HonuaFeatureEditorIdentity | undefined;
  #baseline: CanonicalFeature<T> | undefined;
  #failures: readonly HonuaFeatureEditorFailure[] = [];
  #attachments: readonly HonuaEditorAttachmentDraft[] = [];
  #conflict: HonuaFeatureEditorConflict | undefined;
  #message = "";
  #committedFeatureId: FeatureId | undefined;
  #abort: AbortController | undefined;
  /**
   * The model whose in-flight submit was cancelled. Identity, not a boolean:
   * `AbortSignal` is advisory — a transport may ignore it and settle anyway —
   * so a completion has to prove it still owns the workflow before touching
   * shared state.
   */
  #cancelledModel: EditSketchWorkflowModel<T> | undefined;

  public constructor(options: HonuaFeatureEditorOptions<T>) {
    this.source = options.source;
    this.#options = options;
    this.#sketchTools = options.sketchTools;
    this.#schemaFields = resolveSchemaFields(options);
    this.#message = "Pick an operation to start editing.";
  }

  // ── subscription ───────────────────────────────────────────────────────

  /** Subscribes to snapshot changes. Mirrors the kit's `{ remove() }` idiom. */
  public subscribe(listener: EditorListener): { remove(): void } {
    this.#listeners.add(listener);
    return {
      remove: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  // ── inspection ─────────────────────────────────────────────────────────

  /** The underlying contract sketch workflow, for a sketch adapter to bind to. */
  public sketchModel(): EditSketchWorkflowModel<T> | undefined {
    return this.#model;
  }

  /**
   * Subtype-resolved field metadata for the open draft, or — before one is
   * opened — for the recorded selection. Resolving against the selection
   * matters: a subtype's overrides can flip a field's editability, so using the
   * default subtype here would report the wrong `update` / `delete`
   * availability for the feature the host actually selected.
   */
  public fields(): readonly EditWorkflowField[] {
    return this.#fieldsFor(this.#values());
  }

  /** Truthful per-operation availability for the current source and selection. */
  public operations(): readonly HonuaEditorOperationAvailability[] {
    return this.#operationsFor(this.#values());
  }

  /**
   * Merged pre-transport validation: the contract validator run over the
   * subtype-resolved field list, unioned with the live session's own
   * session-level verdict (capability, identity, attachment support).
   */
  public validate(): EditWorkflowValidationResult {
    const model = this.#model;
    if (!model || !this.#operation) {
      return { valid: false, errors: [{ code: "required", message: "No edit draft is open." }] };
    }
    const sessionErrors = model.validate().errors;
    const derivedErrors = createEditSession<T>({
      source: this.source,
      kind: this.#operation,
      ...(this.#baseline ? { feature: this.#baseline } : {}),
      values: this.#values() as Partial<T>,
      metadata: { fields: this.fields() },
    }).validate().errors;
    const errors = dedupeValidationErrors([...sessionErrors, ...derivedErrors]);
    return { valid: errors.length === 0, errors };
  }

  /** Current UI state. Never contains an attachment payload. */
  public snapshot(): HonuaFeatureEditorSnapshot {
    const model = this.#model;
    const sketch = model?.snapshot().sketch;
    return {
      status: this.#status,
      ...(this.#operation ? { operation: this.#operation } : {}),
      ...(this.#identity ? { identity: this.#identity } : {}),
      operations: this.operations(),
      ...(model && this.#operation
        ? {
            form: buildEditorFormModel({
              operation: this.#operation,
              fields: this.fields(),
              values: this.#values(),
              validation: this.validate(),
              ...(this.#options.subtypes ? { subtypes: this.#options.subtypes } : {}),
            }),
          }
        : {}),
      ...(sketch
        ? {
            sketch: {
              status: sketch.status,
              ...(sketch.activeTool ? { activeTool: sketch.activeTool } : {}),
              tools: sketch.tools,
              geometry: sketch.geometry,
              snapping: { enabled: sketch.snapping.enabled, tolerance: sketch.snapping.tolerance },
            },
          }
        : {}),
      undo: model?.snapshot().undo ?? EMPTY_UNDO,
      attachments: this.#attachments,
      attachmentsSupported: this.source.capabilities.has("attachments"),
      failures: this.#failures,
      ...(this.#conflict ? { conflict: this.#conflict } : {}),
      dirty: model?.dirty() ?? false,
      busy: this.#status === "submitting",
      message: this.#message,
      ...(this.#committedFeatureId !== undefined ? { committedFeatureId: this.#committedFeatureId } : {}),
    };
  }

  // ── draft lifecycle ────────────────────────────────────────────────────

  /**
   * Records the host's current selection (table row, map click, search result)
   * so `update` / `delete` availability reflects it before a draft is opened.
   *
   * Ignored while a draft is open — an open draft owns its identity. A
   * *committed* draft is the one exception: it is finished, and the host's
   * re-read of the record it just wrote carries the only fresh concurrency
   * token there is. Refusing it would leave `selection()` on the pre-commit
   * feature, so the next `update` would reopen on a stale token the service has
   * to reject. Accepting it closes the finished draft without touching the
   * committed status or message — nothing about the commit is retracted.
   */
  public setSelection(feature: CanonicalFeature<T> | undefined): HonuaFeatureEditorSnapshot {
    if (this.#model && this.#status !== "committed") return this.snapshot();
    if (this.#model) {
      this.#model = undefined;
      this.#operation = undefined;
      this.#baseline = undefined;
      this.#attachments = [];
    }
    this.#selection = feature ? cloneFeature(feature) : undefined;
    this.#identity = this.#identityFor(feature);
    return this.#notify();
  }

  /** The host selection `update` / `delete` drafts open on. */
  public selection(): CanonicalFeature<T> | undefined {
    return this.#selection;
  }

  /**
   * Opens a draft, defaulting to the recorded selection. When the requested
   * operation is not truthfully available the draft is refused and the reason
   * recorded — never silently downgraded.
   */
  public begin(operation: HonuaEditorOperation, feature?: CanonicalFeature<T>): HonuaFeatureEditorSnapshot {
    const target = operation === "create" ? feature : (feature ?? this.#selection);
    this.#abort?.abort();
    // Any in-flight submit now belongs to a superseded draft, cancelled or not.
    this.#cancelledModel = undefined;
    this.#conflict = undefined;
    this.#failures = [];
    this.#attachments = [];
    this.#committedFeatureId = undefined;
    this.#identity = this.#identityFor(target);

    // Resolve availability against the feature this draft would open on, not
    // the standing selection — an explicit `feature` argument may carry a
    // different subtype, and subtypes can flip field editability.
    const availability = editorOperationAvailability(
      this.#operationsFor((target?.attributes ?? {}) as Record<string, unknown>),
      operation,
    );
    if (!availability.available) {
      this.#model = undefined;
      this.#operation = undefined;
      this.#status = isCapabilityGate(availability.code) ? "unsupported" : "rejected";
      this.#message = availability.reason ?? `${operation} is not available for this source.`;
      this.#failures = [
        {
          kind: isCapabilityGate(availability.code) ? "capability" : "validation",
          operation: "session",
          description: this.#message,
        },
      ];
      return this.#notify();
    }

    this.#operation = operation;
    this.#baseline = target ? cloneFeature(target) : undefined;
    this.#model = this.#createModel(operation, target);
    if (operation === "create") this.#seedCreateDefaults();
    this.#status = "draft";
    this.#message = draftMessage(operation);
    return this.#notify();
  }

  /** Discards the draft and aborts any in-flight submit. */
  public cancel(): HonuaFeatureEditorSnapshot {
    if (this.#status === "submitting") this.#cancelledModel = this.#model;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#model = undefined;
    this.#operation = undefined;
    this.#baseline = undefined;
    this.#conflict = undefined;
    this.#failures = [];
    this.#attachments = [];
    this.#status = "cancelled";
    this.#message = "Edit cancelled. Nothing was sent to the service.";
    return this.#notify();
  }

  /** Reverts the draft to the feature it opened on, keeping the draft open. */
  public discardChanges(): HonuaFeatureEditorSnapshot {
    this.#model?.discard();
    this.#attachments = [];
    this.#failures = [];
    this.#conflict = undefined;
    if (this.#model) this.#status = "draft";
    this.#message = "Draft reverted to the last known server values.";
    return this.#notify();
  }

  // ── attribute editing ──────────────────────────────────────────────────

  /**
   * Records raw control input for a field, coerced to the field's own type
   * (coded values resolve back to the domain code's type, so a numeric code
   * never reaches transport as a string).
   */
  public setValue(name: string, raw: string | boolean | null): HonuaFeatureEditorSnapshot {
    const model = this.#model;
    if (!model) return this.snapshot();
    const field = this.fields().find((entry) => entry.name === name) ?? { name };
    model.setValue(name, coerceEditorFieldValue(field, raw));
    this.#afterEdit();
    return this.#notify();
  }

  /** Records several already-typed attribute values at once. */
  public setValues(values: Readonly<Record<string, unknown>>): HonuaFeatureEditorSnapshot {
    const model = this.#model;
    if (!model) return this.snapshot();
    model.setValues(values as Partial<T>);
    this.#afterEdit();
    return this.#notify();
  }

  // ── geometry ───────────────────────────────────────────────────────────

  /** Arms a sketch tool. Unsupported tools report their reason rather than throwing. */
  public startSketch(tool: EditSketchTool): EditSketchToolCapability {
    const model = this.#model;
    if (!model) return { tool, state: "unsupported", reason: "No edit draft is open." };
    const capability = model.startSketch(tool);
    this.#message =
      capability.state === "supported"
        ? `Sketching a ${tool}. Enter coordinates or draw on the map.`
        : (capability.reason ?? `The ${tool} tool is not available.`);
    this.#notify();
    return capability;
  }

  /** Applies a geometry through the sketch workflow (undoable). */
  public setGeometry(tool: EditSketchTool, geometry: Record<string, unknown> | null): HonuaFeatureEditorSnapshot {
    const model = this.#model;
    if (!model) return this.snapshot();
    model.setSketchGeometry(tool, geometry);
    this.#afterEdit();
    return this.#notify();
  }

  public undo(): boolean {
    const undone = this.#model?.undo() ?? false;
    if (undone) {
      this.#afterEdit();
      this.#notify();
    }
    return undone;
  }

  public redo(): boolean {
    const redone = this.#model?.redo() ?? false;
    if (redone) {
      this.#afterEdit();
      this.#notify();
    }
    return redone;
  }

  // ── attachments ────────────────────────────────────────────────────────

  /**
   * Stages an attachment. The payload is handed straight to the edit session;
   * only redacted metadata enters the snapshot.
   */
  public stageAttachment(
    attachment: Blob | File | string,
    options: { name?: string; contentType?: string; parentId?: FeatureId } = {},
  ): HonuaFeatureEditorSnapshot {
    const model = this.#model;
    if (!model) return this.snapshot();
    model.stageAttachmentAdd(attachment, options);
    this.#syncAttachmentDrafts();
    this.#afterEdit();
    return this.#notify();
  }

  /** Stages an attachment deletion. */
  public stageAttachmentDelete(
    attachmentIds: readonly FeatureId[],
    options: { parentId?: FeatureId } = {},
  ): HonuaFeatureEditorSnapshot {
    const model = this.#model;
    if (!model) return this.snapshot();
    model.stageAttachmentDelete(attachmentIds, options);
    this.#syncAttachmentDrafts();
    this.#afterEdit();
    return this.#notify();
  }

  // ── sketch adapter seam ────────────────────────────────────────────────

  /**
   * Replaces the sketch tool capabilities (a sketch adapter such as terra-draw
   * calls this so `rectangle` / `circle` become truthfully supported). An open
   * draft is rebuilt in place, preserving values, geometry, and staged
   * attachments; undo history restarts because tool support is a new baseline.
   */
  public configureSketchTools(
    tools: Partial<Record<EditSketchTool, EditSketchToolCapabilityInput>>,
  ): HonuaFeatureEditorSnapshot {
    // Idempotent: re-declaring the same tool support must not rebuild an open
    // draft (a sketch adapter may re-announce it on every attach).
    if (JSON.stringify(this.#sketchTools ?? null) === JSON.stringify(tools)) return this.snapshot();
    this.#sketchTools = tools;
    const model = this.#model;
    // Never swap the model out from under an in-flight submit: that would make
    // the pending completion look superseded and silently drop its outcome.
    // The new tool support applies to the next draft instead.
    if (model && this.#operation && this.#status !== "submitting") {
      const snapshot = model.snapshot();
      this.#model = this.#createModel(this.#operation, snapshot.feature);
      for (const mutation of snapshot.attachments) restageAttachment(this.#model, mutation);
    }
    return this.#notify();
  }

  // ── submit ─────────────────────────────────────────────────────────────

  /**
   * Validates, then applies the draft through the contract edit session.
   *
   * Refuses to transport when the draft is invalid or an unresolved conflict is
   * parked (`transported: false`). Every non-success result maps to a
   * rejected / conflict / unsupported state — never `"committed"`.
   */
  public async submit(): Promise<HonuaFeatureEditorCommit> {
    const model = this.#model;
    const operation = this.#operation;
    if (!model || !operation) {
      return this.#preflightRejection("create", "No edit draft is open.", "validation");
    }
    if (this.#conflict) {
      return this.#preflightRejection(
        operation,
        "Resolve the conflicting change before submitting again.",
        "conflict",
        "conflict",
      );
    }
    const validation = this.validate();
    if (!validation.valid) {
      this.#status = validation.errors.some((error) => error.code === "unsupported") ? "unsupported" : "rejected";
      this.#failures = validation.errors.map((error) => ({
        kind: error.code === "unsupported" ? ("capability" as const) : ("validation" as const),
        operation: "session" as const,
        description: error.message,
      }));
      this.#message = "The draft was not sent: fix the highlighted problems first.";
      return this.#commit(operation, false);
    }

    this.#status = "submitting";
    this.#failures = [];
    this.#message = `Applying the ${operation}…`;
    this.#notify();

    const result = await model.submit();

    // An `AbortSignal` is advisory: a transport may settle a cancelled — or
    // superseded — submit anyway. Before touching shared state, prove this
    // completion still owns the workflow. Otherwise a slow first submit could
    // stamp its own outcome (and identity, baseline, and message) onto a draft
    // that was opened after it started.
    const cancelledThisSubmit = this.#cancelledModel === model;
    if (cancelledThisSubmit) this.#cancelledModel = undefined;
    if (this.#model !== model) {
      // `begin()` clears `#cancelledModel`, so reaching here with it still set
      // means the cancel was the last thing to touch the workflow.
      if (cancelledThisSubmit && this.#model === undefined) {
        this.#message = "Edit cancelled while it was being applied; treat the outcome as unknown.";
        this.#failures = result.failures.map(normalizeFailure);
        return this.#commit(operation, true);
      }
      return this.#supersededCommit(operation, model, result);
    }

    this.#failures = result.failures.map(normalizeFailure);
    this.#attachments = attachmentDraftsFromResult(model, result.attachmentResults);

    const conflictFailure = result.failures.find((failure) => failure.kind === "conflict");
    if (result.status === "succeeded") {
      this.#status = "committed";
      this.#committedFeatureId = result.committedFeatureId;
      this.#identity = this.#identityAfterCommit(result.committedFeatureId);
      this.#baseline = cloneFeature(model.snapshot().feature);
      this.#message = committedMessage(operation, result.committedFeatureId);
    } else if (conflictFailure || result.conflict) {
      const info = conflictFailure?.conflict ?? result.conflict;
      this.#status = "conflict";
      this.#conflict = conflictFrom(info, this.#identity, conflictFailure?.description);
      this.#message = "Someone else changed this feature. Choose how to resolve it.";
    } else if (result.status === "unsupported") {
      this.#status = "unsupported";
      this.#message = result.failures[0]?.description ?? "This source does not support the requested edit.";
    } else if (result.status === "partial") {
      this.#status = "rejected";
      this.#message = "The edit only partly applied. Review the failures before retrying.";
    } else {
      this.#status = "rejected";
      this.#message = result.failures[0]?.description ?? "The service rejected the edit.";
    }
    return this.#commit(operation, true);
  }

  /** Re-submits after a rejection (or after a resolved conflict). */
  public async retry(): Promise<HonuaFeatureEditorCommit> {
    if (this.#status === "submitting") {
      return this.#preflightRejection(this.#operation ?? "create", "An edit is already in flight.", "validation");
    }
    if (this.#status !== "conflict") this.#status = "draft";
    return this.submit();
  }

  // ── conflict resolution ────────────────────────────────────────────────

  /**
   * Records an explicit decision for a parked conflict.
   *
   * - `"keep-mine"` keeps the draft and, when the source's concurrency token
   *   is known, adopts the observed server token so the retry can pass the
   *   service's precondition (an explicit overwrite).
   * - `"discard-mine"` reverts the draft to the feature it opened on.
   * - `"reload"` closes the draft; the host is expected to reopen it on fresh
   *   server state.
   */
  public resolveConflict(choice: HonuaFeatureEditorConflictChoice): HonuaFeatureEditorSnapshot {
    const conflict = this.#conflict;
    if (!conflict) return this.snapshot();
    if (choice === "reload") {
      this.#conflict = undefined;
      this.#model = undefined;
      this.#operation = undefined;
      this.#baseline = undefined;
      this.#status = "idle";
      this.#message = "Reload the feature to continue editing the current server version.";
      return this.#notify();
    }
    if (choice === "discard-mine") {
      this.#conflict = undefined;
      this.#model?.discard();
      this.#status = this.#model ? "draft" : "idle";
      this.#message = "Your changes were discarded; the draft matches the last known server values.";
      this.#failures = [];
      return this.#notify();
    }
    this.#conflict = undefined;
    if (conflict.versionField !== undefined && conflict.theirs !== undefined) {
      this.#model?.setValue(conflict.versionField, conflict.theirs);
      if (this.#identity) this.#identity = { ...this.#identity, version: conflict.theirs };
    }
    this.#status = "draft";
    this.#failures = [];
    this.#message = "Keeping your changes. Submitting again will overwrite the other edit.";
    return this.#notify();
  }

  /**
   * Adopts the service's post-write concurrency token into a draft that stays
   * open on purpose — the partial outcome where the feature edit applied and
   * only an attachment was refused (issue #680).
   *
   * A protocol like GeoServices returns nothing but `objectId` and `success`
   * from `applyEdits`, so the new token exists only in the host's re-read of the
   * record. Feeding that back through {@link setValue} would read as a user
   * revision and clear the rejected status and the recorded failures — erasing
   * exactly the truth about what the service refused. This does not: status,
   * failures, and staged-attachment outcomes all survive, so {@link retry}
   * re-transports the same recovery against the version now on file instead of
   * the one the accepted write already consumed.
   *
   * The draft's own baseline is deliberately left alone: it is still the values
   * this draft opened on, and moving it could make an unrelated server-assigned
   * field look like a read-only edit the user made.
   *
   * Returns `false` — changing nothing — when no draft is open, when the record
   * is a different feature, or when the source publishes no concurrency token.
   */
  public adoptServerState(feature: CanonicalFeature<T>): boolean {
    const model = this.#model;
    const identity = this.#identity;
    if (!model || identity?.featureId === undefined) return false;
    if (feature.id === undefined || String(feature.id) !== String(identity.featureId)) return false;
    const field = identity.versionField;
    if (field === undefined) return false;
    const token = (feature.attributes as Record<string, unknown>)[field];
    if (token === undefined) return false;
    model.setValue(field, token);
    this.#identity = { ...identity, version: token };
    this.#notify();
    return true;
  }

  // ── realtime reconciliation ────────────────────────────────────────────

  /**
   * Reconciles one externally changed feature against the open draft (REQ-005).
   *
   * - A change to a different feature is `"ignored"`: no state changes and no
   *   listener runs, so selection, unsaved values, focus, and geometry survive
   *   unrelated realtime traffic untouched.
   * - A change to the drafted feature carrying the same concurrency token is
   *   `"reconciled"`: the baseline adopts the server values, and only fields the
   *   user has *not* touched adopt the new values.
   * - A change carrying a different token is a `"conflict"`: the draft is
   *   untouched and parked until {@link resolveConflict} records a decision.
   */
  public applyExternalChange(feature: CanonicalFeature<T>): HonuaFeatureEditorExternalChangeOutcome {
    const model = this.#model;
    const identity = this.#identity;
    if (!model || identity === undefined || identity.featureId === undefined) return "ignored";
    if (feature.id === undefined || String(feature.id) !== String(identity.featureId)) return "ignored";

    const conflictInfo = model.snapshot().metadata.conflict;
    const theirs = tokenOf(feature, conflictInfo);
    const mine = identity.version;
    if (theirs !== undefined && mine !== undefined && String(theirs) !== String(mine)) {
      this.#conflict = {
        reason: "The feature changed on the server while this draft was open.",
        ...(identity.versionField ? { versionField: identity.versionField } : {}),
        mine,
        theirs,
        choices: CONFLICT_CHOICES,
      };
      this.#status = "conflict";
      this.#message = "Someone else changed this feature. Choose how to resolve it.";
      this.#notify();
      return "conflict";
    }

    const baseline = this.#baseline;
    const current = model.snapshot().feature.attributes as Record<string, unknown>;
    const incoming = feature.attributes as Record<string, unknown>;
    const untouched: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(incoming)) {
      const previous = (baseline?.attributes as Record<string, unknown> | undefined)?.[name];
      if (sameScalar(current[name], previous)) untouched[name] = value;
    }
    this.#baseline = cloneFeature(feature);
    if (Object.keys(untouched).length > 0) model.setValues(untouched as Partial<T>);
    if (theirs !== undefined) this.#identity = { ...identity, version: theirs };
    this.#message = "Adopted the latest server values for fields you have not changed.";
    this.#notify();
    return "reconciled";
  }

  // ── internals ──────────────────────────────────────────────────────────

  #createModel(operation: HonuaEditorOperation, feature: CanonicalFeature<T> | undefined): EditSketchWorkflowModel<T> {
    this.#abort = new AbortController();
    return createEditSketchWorkflow<T>({
      source: this.source,
      kind: operation,
      ...(feature ? { feature: cloneFeature(feature) } : {}),
      metadata: {
        fields: this.#baseFields(),
        ...(this.#options.metadata?.primaryKey ? { primaryKey: this.#options.metadata.primaryKey } : {}),
        ...(this.#options.metadata?.relationships ? { relationships: this.#options.metadata.relationships } : {}),
        ...(this.#options.metadata?.conflict ? { conflict: this.#options.metadata.conflict } : {}),
      },
      ...(this.#sketchTools ? { sketchTools: this.#sketchTools } : {}),
      ...(this.#options.snapping ? { snapping: this.#options.snapping } : {}),
      ...(this.#options.rollbackOnFailure !== undefined ? { rollbackOnFailure: this.#options.rollbackOnFailure } : {}),
      ...(this.#options.optimistic ? { optimistic: this.#options.optimistic } : {}),
      signal: this.#abort.signal,
    });
  }

  /**
   * Field list the long-lived session validates against: subtype *domain* but
   * no per-subtype overrides, so the session never rejects a value the active
   * subtype allows. Subtype-specific rules are enforced by {@link validate}
   * over the resolved list before anything is transported.
   */
  #baseFields(): readonly EditWorkflowField[] {
    const subtypes = this.#options.subtypes;
    return resolveEditorFields(
      this.#schemaFields,
      subtypes ? { field: subtypes.field, subtypes: subtypes.subtypes } : undefined,
      {},
    );
  }

  #seedCreateDefaults(): void {
    const subtypes = this.#options.subtypes;
    if (!subtypes || subtypes.defaultCode === undefined) return;
    const active = resolveActiveEditorSubtype(subtypes, {});
    this.#model?.setValues({ [subtypes.field]: active?.code ?? subtypes.defaultCode } as Partial<T>);
  }

  /**
   * Attribute values subtype resolution runs against: the open draft's, or the
   * recorded selection's while no draft is open.
   */
  #values(): Readonly<Record<string, unknown>> {
    const model = this.#model;
    if (model) return model.snapshot().feature.attributes as Record<string, unknown>;
    return (this.#selection?.attributes ?? {}) as Record<string, unknown>;
  }

  #fieldsFor(values: Readonly<Record<string, unknown>>): readonly EditWorkflowField[] {
    return resolveEditorFields(this.#schemaFields, this.#options.subtypes, values);
  }

  #operationsFor(values: Readonly<Record<string, unknown>>): readonly HonuaEditorOperationAvailability[] {
    return resolveEditorOperations({
      capabilities: { applyEdits: this.source.capabilities.has("applyEdits") ? "supported" : "unsupported" },
      ...(capabilityDecisions(this.source) ? { decisions: capabilityDecisions(this.source) } : {}),
      hasFeatureIdentity: this.#identity?.featureId !== undefined,
      fields: this.#fieldsFor(values),
      ...(this.#options.operations ? { overrides: this.#options.operations } : {}),
    });
  }

  #identityFor(feature: CanonicalFeature<T> | undefined): HonuaFeatureEditorIdentity {
    const conflict = conflictInfoFor(this.source, this.#schemaFields, feature, this.#options.metadata);
    const token = feature ? tokenOf(feature, conflict) : undefined;
    return {
      sourceId: this.source.descriptor.id,
      ...(feature?.id !== undefined ? { featureId: feature.id } : {}),
      ...(token !== undefined ? { version: token } : {}),
      ...(conflictFieldName(conflict) ? { versionField: conflictFieldName(conflict) } : {}),
    };
  }

  #identityAfterCommit(committedFeatureId: FeatureId | undefined): HonuaFeatureEditorIdentity | undefined {
    const identity = this.#identity;
    if (!identity) return undefined;
    const model = this.#model;
    const conflict = model?.snapshot().metadata.conflict;
    const token = model && conflict ? tokenOf(model.snapshot().feature, conflict) : identity.version;
    return {
      ...identity,
      ...(committedFeatureId !== undefined ? { featureId: committedFeatureId } : {}),
      ...(token !== undefined ? { version: token } : {}),
    };
  }

  #afterEdit(): void {
    if (this.#status === "committed" || this.#status === "rejected" || this.#status === "cancelled") {
      this.#status = "draft";
      this.#failures = [];
      this.#message = draftMessage(this.#operation ?? "update");
    }
  }

  #syncAttachmentDrafts(): void {
    const model = this.#model;
    if (!model) return;
    this.#attachments = model
      .snapshot()
      .attachments.map((mutation, index) => redactEditorAttachment(mutation, index, "staged"));
  }

  #preflightRejection(
    operation: HonuaEditorOperation,
    description: string,
    kind: EditWorkflowFailureKind,
    status: HonuaFeatureEditorStatus = "rejected",
  ): HonuaFeatureEditorCommit {
    this.#status = status;
    this.#failures = [{ kind, operation: "session", description }];
    this.#message = description;
    this.#notify();
    return {
      status: this.#status,
      operation,
      transported: false,
      failures: this.#failures,
      attachments: this.#attachments,
      snapshot: this.snapshot(),
    };
  }

  /**
   * Result of a submit that no longer owns the workflow. Built entirely from
   * the caller's own locals — shared state belongs to the newer draft and is
   * deliberately left untouched, and no listener is notified.
   */
  #supersededCommit(
    operation: HonuaEditorOperation,
    model: EditSketchWorkflowModel<T>,
    result: EditWorkflowSubmitResult<T>,
  ): HonuaFeatureEditorCommit {
    return {
      status: "cancelled",
      operation,
      transported: true,
      superseded: true,
      failures: result.failures.map(normalizeFailure),
      attachments: attachmentDraftsFromResult(model, result.attachmentResults),
      snapshot: this.snapshot(),
    };
  }

  #commit(operation: HonuaEditorOperation, transported: boolean): HonuaFeatureEditorCommit {
    const snapshot = this.#notify();
    return {
      status: this.#status,
      operation,
      transported,
      ...(this.#committedFeatureId !== undefined && this.#status === "committed"
        ? { committedFeatureId: this.#committedFeatureId }
        : {}),
      failures: this.#failures,
      attachments: this.#attachments,
      snapshot,
    };
  }

  #notify(): HonuaFeatureEditorSnapshot {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) listener(snapshot);
    return snapshot;
  }
}

/** Creates a {@link HonuaFeatureEditorWorkflow}. */
export function createFeatureEditorWorkflow<T = Record<string, unknown>>(
  options: HonuaFeatureEditorOptions<T>,
): HonuaFeatureEditorWorkflow<T> {
  return new HonuaFeatureEditorWorkflow(options);
}

// ── module helpers ───────────────────────────────────────────────────────

function resolveSchemaFields<T>(options: HonuaFeatureEditorOptions<T>): readonly EditWorkflowField[] {
  const declared = options.metadata?.fields;
  const fields = declared ?? editorFieldsFromSchema(options.source.descriptor.schema?.fields);
  const domains = options.metadata?.domains;
  if (!domains) return fields;
  return fields.map((field) =>
    field.domain || !domains[field.name] ? field : { ...field, domain: domains[field.name] },
  );
}

function capabilityDecisions<T>(
  source: Source<T>,
): readonly { id: string; effective: string; reasons?: readonly string[] }[] | undefined {
  // The evaluated profile may live on the capability-aware source, on its
  // descriptor, or nowhere at all; only the coarse capability set is guaranteed.
  const carrier = source as {
    capabilityProfile?: { entries?: readonly unknown[] };
    descriptor?: { capabilityProfile?: { entries?: readonly unknown[] } };
  };
  const entries = (carrier.capabilityProfile ?? carrier.descriptor?.capabilityProfile)?.entries;
  if (!entries) return undefined;
  return entries as readonly { id: string; effective: string; reasons?: readonly string[] }[];
}

function isCapabilityGate(code: string | undefined): boolean {
  return (
    code === "capability-unsupported" ||
    code === "capability-unknown" ||
    code === "authorization-required" ||
    code === "authorization-denied" ||
    code === "policy-disabled" ||
    code === "peer-unavailable"
  );
}

function conflictInfoFor<T>(
  source: Source<T>,
  fields: readonly EditWorkflowField[],
  feature: CanonicalFeature<T> | undefined,
  metadata: EditWorkflowMetadataOptions | undefined,
): EditWorkflowConflictInfo {
  // Reuse the contract's own conflict inference rather than re-deriving which
  // field carries the concurrency token.
  const session = createEditSession<T>({
    source,
    kind: feature?.id === undefined ? "create" : "update",
    ...(feature ? { feature } : {}),
    metadata: { fields, ...(metadata?.conflict ? { conflict: metadata.conflict } : {}) },
  });
  return session.metadata().conflict;
}

function conflictFieldName(conflict: EditWorkflowConflictInfo): string | undefined {
  return conflict.versionField ?? conflict.etagField ?? conflict.updatedAtField;
}

function tokenOf<T>(feature: CanonicalFeature<T>, conflict: EditWorkflowConflictInfo): unknown {
  const attributes = feature.attributes as Record<string, unknown>;
  const field = conflictFieldName(conflict);
  return field ? attributes[field] : undefined;
}

function conflictFrom(
  info: EditWorkflowConflictInfo | undefined,
  identity: HonuaFeatureEditorIdentity | undefined,
  description: string | undefined,
): HonuaFeatureEditorConflict {
  const field = info ? conflictFieldName(info) : identity?.versionField;
  return {
    reason: info?.reason ?? description ?? "The service reported a version conflict.",
    ...(field ? { versionField: field } : {}),
    ...(identity?.version !== undefined ? { mine: identity.version } : {}),
    ...(info?.value !== undefined && String(info.value) !== String(identity?.version) ? { theirs: info.value } : {}),
    choices: CONFLICT_CHOICES,
  };
}

function normalizeFailure(failure: {
  kind: EditWorkflowFailureKind;
  operation: EditWorkflowOperation;
  code?: number;
  description: string;
}): HonuaFeatureEditorFailure {
  return {
    kind: failure.kind,
    operation: failure.operation,
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    description: failure.description,
  };
}

function attachmentDraftsFromResult<T>(
  model: EditSketchWorkflowModel<T>,
  results: readonly {
    operation: "add" | "update" | "delete";
    index: number;
    outcomes: readonly { success: boolean; error?: { code: number; description: string } }[];
  }[],
): readonly HonuaEditorAttachmentDraft[] {
  const staged = model.snapshot().attachments;
  return results.map((result) => {
    const mutation = staged[result.index] ?? { operation: result.operation };
    const failure = result.outcomes.find((outcome) => !outcome.success);
    if (!failure) return redactEditorAttachment(mutation, result.index, "applied");
    const skipped = failure.error?.code === 409 && failure.error.description.includes("skipped");
    return redactEditorAttachment(
      mutation,
      result.index,
      skipped ? "skipped" : "failed",
      failure.error?.description ?? "The attachment was rejected.",
    );
  });
}

function restageAttachment<T>(
  model: EditSketchWorkflowModel<T>,
  mutation: {
    operation: "add" | "update" | "delete";
    parentId?: FeatureId;
    attachment?: Blob | File | string;
    attachmentId?: FeatureId;
    attachmentIds?: readonly FeatureId[];
    name?: string;
    contentType?: string;
  },
): void {
  const options = {
    ...(mutation.parentId !== undefined ? { parentId: mutation.parentId } : {}),
    ...(mutation.name !== undefined ? { name: mutation.name } : {}),
    ...(mutation.contentType !== undefined ? { contentType: mutation.contentType } : {}),
  };
  if (mutation.operation === "add" && mutation.attachment !== undefined) {
    model.stageAttachmentAdd(mutation.attachment, options);
    return;
  }
  if (mutation.operation === "update" && mutation.attachment !== undefined && mutation.attachmentId !== undefined) {
    model.stageAttachmentUpdate(mutation.attachmentId, mutation.attachment, options);
    return;
  }
  if (mutation.operation === "delete" && mutation.attachmentIds) {
    model.stageAttachmentDelete(mutation.attachmentIds, options);
  }
}

function dedupeValidationErrors(
  errors: readonly EditWorkflowValidationError[],
): readonly EditWorkflowValidationError[] {
  const seen = new Set<string>();
  const out: EditWorkflowValidationError[] = [];
  for (const error of errors) {
    const key = `${error.code}|${error.fieldName ?? ""}|${error.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(error);
  }
  return out;
}

function draftMessage(operation: HonuaEditorOperation): string {
  if (operation === "create") return "New feature draft. Complete the required fields, then submit.";
  if (operation === "delete") return "Deleting this feature. Submit to confirm.";
  return "Editing the selected feature. Submit to apply your changes.";
}

function committedMessage(operation: HonuaEditorOperation, id: FeatureId | undefined): string {
  if (operation === "delete") return "Feature deleted.";
  const suffix = id === undefined ? "" : ` (id ${String(id)})`;
  return operation === "create" ? `Feature created${suffix}.` : `Feature updated${suffix}.`;
}

function cloneFeature<T>(feature: CanonicalFeature<T>): CanonicalFeature<T> {
  return {
    ...(feature.id !== undefined ? { id: feature.id } : {}),
    attributes: { ...(feature.attributes as Record<string, unknown>) } as T,
    ...(feature.geometry !== undefined ? { geometry: feature.geometry === null ? null : { ...feature.geometry } } : {}),
  };
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === undefined || right === undefined) return left === right;
  if (left === null || right === null) return left === right;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return String(left) === String(right);
}
