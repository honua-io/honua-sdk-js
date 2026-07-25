/**
 * `<honua-feature-editor>` — the production-tier capability-aware editing and
 * sketch widget (issue #680, parent epic #678).
 *
 * The element is pure presentation over
 * {@link HonuaFeatureEditorWorkflow}: it renders the schema/domain/subtype
 * derived form, the geometry workflow, staged attachments, validation,
 * per-operation availability, failure and conflict state, and turns user input
 * back into workflow calls. It imports no protocol adapter, performs no
 * transport of its own, and never reports a rejected edit as a success.
 *
 * ## Wiring
 * ```ts
 * const workflow = createFeatureEditorWorkflow({ source, subtypes });
 * const editor = document.createElement("honua-feature-editor");
 * editor.workflow = workflow;          // element subscribes and renders
 * document.body.append(editor);
 * ```
 * Geometry may additionally be driven from the map through a sketch adapter
 * (`createTerraDrawEditorSketch` in `./feature-editor-sketch.js`) — the element
 * itself never needs the map.
 *
 * ## Accessibility (NFR-001)
 * The entire workflow is reachable without touching the map canvas:
 *
 * - operation, sketch-tool, undo/redo, conflict, and submit affordances are
 *   native `<button>`s in labelled `role="group"` toolbars, with `aria-pressed`
 *   for the active operation/tool and `aria-disabled` + a visible reason
 *   whenever an operation is unavailable;
 * - every field is a labelled native control with `aria-required`,
 *   `aria-invalid`, and `aria-describedby` pointing at its own error text;
 * - geometry can be entered, replaced, or cleared entirely from the keyboard
 *   through the GeoJSON geometry textarea plus **Apply geometry** / **Clear**;
 * - validation problems and service failures render in `role="alert"` regions,
 *   the workflow message in a `role="status" aria-live="polite"` region;
 * - `Escape` cancels the draft and `Ctrl`/`Cmd`+`Z` / `Shift`+`Ctrl`/`Cmd`+`Z`
 *   drive undo / redo from anywhere inside the panel;
 * - focus and text selection survive re-renders, so typing is never
 *   interrupted by an unrelated realtime change.
 *
 * @module
 */

import type { EditSketchTool } from "../contract/edit-sketch.js";
import type { CanonicalFeature } from "../contract/types.js";
import type { HonuaEditorFieldControl, HonuaEditorOperation } from "./feature-editor-model.js";
import type {
  HonuaFeatureEditorCommit,
  HonuaFeatureEditorConflictChoice,
  HonuaFeatureEditorSnapshot,
  HonuaFeatureEditorWorkflow,
} from "./feature-editor-workflow.js";

const globalDom = globalThis as typeof globalThis & {
  HTMLElement?: typeof HTMLElement;
  CustomEvent?: typeof CustomEvent;
  customElements?: CustomElementRegistry;
};

const HTMLElementBase: typeof HTMLElement = globalDom.HTMLElement ?? (class {} as unknown as typeof HTMLElement);

/** Detail of the `honua-feature-edit-change` event (redacted snapshot). */
export interface HonuaFeatureEditChangeDetail {
  readonly snapshot: HonuaFeatureEditorSnapshot;
}

/** Detail of the `honua-feature-edit-commit` event (submit outcome). */
export interface HonuaFeatureEditCommitDetail {
  readonly commit: HonuaFeatureEditorCommit;
}

const OPERATION_LABELS: Readonly<Record<HonuaEditorOperation, string>> = {
  create: "New",
  update: "Edit",
  delete: "Delete",
};

export class HonuaFeatureEditorElement<T = Record<string, unknown>> extends HTMLElementBase {
  public static get observedAttributes(): string[] {
    return ["label"];
  }

  #workflow: HonuaFeatureEditorWorkflow<T> | undefined;
  #subscription: { remove(): void } | undefined;
  #snapshot: HonuaFeatureEditorSnapshot | undefined;
  #connected = false;
  #geometryDraft: string | undefined;
  #geometryError: string | undefined;

  /** The workflow this editor renders. Setting it re-subscribes and re-renders. */
  public get workflow(): HonuaFeatureEditorWorkflow<T> | undefined {
    return this.#workflow;
  }

  public set workflow(workflow: HonuaFeatureEditorWorkflow<T> | undefined) {
    if (this.#workflow === workflow) return;
    this.#subscription?.remove();
    this.#subscription = undefined;
    this.#workflow = workflow;
    this.#geometryDraft = undefined;
    this.#geometryError = undefined;
    this.#snapshot = workflow?.snapshot();
    // Only hold a subscription while connected; `connectedCallback` re-takes it
    // so a detached-then-reinserted element resumes updating.
    if (this.#connected) this.#subscribe();
    this.render();
  }

  /** Takes the workflow subscription, unless one is already held. */
  #subscribe(): void {
    const workflow = this.#workflow;
    if (!workflow || this.#subscription) return;
    // State may have moved on while detached; re-read before listening.
    this.#snapshot = workflow.snapshot();
    this.#subscription = workflow.subscribe((snapshot) => {
      this.#snapshot = snapshot;
      this.#dispatch("honua-feature-edit-change", { snapshot });
      this.render();
    });
  }

  /** Equivalent to setting `.workflow`. */
  public connect(workflow: HonuaFeatureEditorWorkflow<T>): void {
    this.workflow = workflow;
  }

  /**
   * The feature `update` / `delete` drafts open on. Hosts assign this from
   * their own selection state (table row, map click, search result); it is
   * forwarded to the workflow so per-operation availability reflects it
   * immediately. The element never reads the map.
   */
  public get selectedFeature(): CanonicalFeature<T> | undefined {
    return this.#workflow?.selection();
  }

  public set selectedFeature(feature: CanonicalFeature<T> | undefined) {
    this.#workflow?.setSelection(feature);
  }

  /** The last snapshot rendered. */
  public get snapshot(): HonuaFeatureEditorSnapshot | undefined {
    return this.#snapshot;
  }

  public attributeChangedCallback(): void {
    this.render();
  }

  public connectedCallback(): void {
    this.#connected = true;
    if (!this.shadowRoot && typeof this.attachShadow === "function") this.attachShadow({ mode: "open" });
    this.#subscribe();
    this.render();
  }

  public disconnectedCallback(): void {
    this.#connected = false;
    this.#subscription?.remove();
    this.#subscription = undefined;
  }

  // ── rendering ──────────────────────────────────────────────────────────

  protected render(): void {
    const root = this.shadowRoot;
    if (!root || !this.#connected) return;
    const focus = captureFocus(root);
    root.innerHTML = this.#html();
    this.#bind(root);
    restoreFocus(root, focus);
  }

  #html(): string {
    const label = this.#attr("label") ?? "Feature editor";
    const snapshot = this.#snapshot;
    if (!snapshot) {
      return `
        <style>${editorStyles()}</style>
        <section class="panel" part="panel" role="region" aria-label="${escapeAttribute(label)}">
          <div class="bar"><h2>${escapeHtml(label)}</h2></div>
          <p class="empty" role="status">No edit workflow is attached. Set <code>.workflow</code> to an editable source's workflow.</p>
        </section>
      `;
    }
    return `
      <style>${editorStyles()}</style>
      <section class="panel" part="panel" role="region" aria-label="${escapeAttribute(label)}">
        <div class="bar">
          <h2>${escapeHtml(label)}</h2>
          <span class="state" data-state>${escapeHtml(snapshot.status)}${snapshot.dirty ? " • unsaved" : ""}</span>
        </div>
        ${this.#operationsHtml(snapshot, label)}
        ${this.#conflictHtml(snapshot)}
        ${this.#formHtml(snapshot)}
        ${this.#geometryHtml(snapshot, label)}
        ${this.#attachmentsHtml(snapshot)}
        ${this.#problemsHtml(snapshot)}
        <p class="status" part="status" role="status" aria-live="polite" data-status>${escapeHtml(snapshot.message)}</p>
        ${this.#actionsHtml(snapshot)}
      </section>
    `;
  }

  #operationsHtml(snapshot: HonuaFeatureEditorSnapshot, label: string): string {
    const buttons = snapshot.operations
      .map((availability) => {
        const active = snapshot.operation === availability.operation && snapshot.status !== "idle";
        const disabled = availability.available ? "" : ' disabled aria-disabled="true"';
        const title = availability.reason ? ` title="${escapeAttribute(availability.reason)}"` : "";
        return `<button type="button" part="operation" data-operation="${availability.operation}" aria-pressed="${String(active)}"${disabled}${title}>${escapeHtml(OPERATION_LABELS[availability.operation])}</button>`;
      })
      .join("");
    const blocked = snapshot.operations.filter((availability) => !availability.available && availability.reason);
    const reasons =
      blocked.length === 0
        ? ""
        : `<ul class="reasons" data-operation-reasons>${blocked
            .map(
              (availability) =>
                `<li data-operation-reason="${availability.operation}" data-code="${escapeAttribute(availability.code ?? "")}">${escapeHtml(`${OPERATION_LABELS[availability.operation]}: ${availability.reason}`)}</li>`,
            )
            .join("")}</ul>`;
    return `
      <div class="segmented" role="group" aria-label="${escapeAttribute(`${label} operations`)}">${buttons}</div>
      ${reasons}
    `;
  }

  #conflictHtml(snapshot: HonuaFeatureEditorSnapshot): string {
    const conflict = snapshot.conflict;
    if (!conflict) return "";
    const detail =
      conflict.versionField && (conflict.mine !== undefined || conflict.theirs !== undefined)
        ? `<p class="muted" data-conflict-detail>${escapeHtml(
            `${conflict.versionField}: yours ${describeToken(conflict.mine)}, theirs ${describeToken(conflict.theirs)}`,
          )}</p>`
        : "";
    const choices = conflict.choices
      .map(
        (choice) =>
          `<button type="button" part="conflict" data-conflict="${choice}">${escapeHtml(CONFLICT_LABELS[choice])}</button>`,
      )
      .join("");
    return `
      <div class="conflict" part="conflict-panel" role="group" aria-label="Resolve conflicting change" data-conflict-panel>
        <p role="alert" data-conflict-reason>${escapeHtml(conflict.reason)}</p>
        ${detail}
        <div class="actions">${choices}</div>
      </div>
    `;
  }

  #formHtml(snapshot: HonuaFeatureEditorSnapshot): string {
    const form = snapshot.form;
    if (!form) return "";
    if (form.controls.length === 0) {
      return `<p class="empty" role="status">This source publishes no editable field metadata.</p>`;
    }
    return `
      <fieldset class="fields" part="fields">
        <legend>${escapeHtml(form.subtype?.name ? `Attributes — ${form.subtype.name}` : "Attributes")}</legend>
        ${form.controls.map((control) => this.#controlHtml(control)).join("")}
      </fieldset>
    `;
  }

  #controlHtml(control: HonuaEditorFieldControl): string {
    const id = `honua-field-${cssSafe(control.name)}`;
    const errorId = `${id}-error`;
    const invalid = control.errors.length > 0;
    const described = invalid ? ` aria-describedby="${errorId}"` : "";
    const common =
      `id="${id}" data-field="${escapeAttribute(control.name)}"` +
      `${control.required ? ' aria-required="true" required' : ""}` +
      `${invalid ? ' aria-invalid="true"' : ""}` +
      `${control.readOnly ? " disabled" : ""}${described}`;
    const value = stringValue(control.value);
    let field: string;
    if (control.kind === "select") {
      const options = [
        control.required && value === "" ? '<option value="">Select…</option>' : "",
        ...(control.choices ?? []).map(
          (choice) =>
            `<option value="${escapeAttribute(choice.value)}"${choice.value === value ? " selected" : ""}>${escapeHtml(choice.label)}</option>`,
        ),
        ...(control.required ? [] : ['<option value="">(none)</option>']),
      ].join("");
      field = `<select ${common}>${options}</select>`;
    } else if (control.kind === "checkbox") {
      field = `<input type="checkbox" ${common}${value === "true" ? " checked" : ""} />`;
    } else if (control.kind === "textarea") {
      field = `<textarea ${common}${control.maxLength ? ` maxlength="${control.maxLength}"` : ""} rows="3">${escapeHtml(value)}</textarea>`;
    } else {
      const type = control.kind === "number" ? "number" : control.kind === "text" ? "text" : control.kind;
      const bounds =
        control.kind === "number"
          ? `${control.min !== undefined ? ` min="${control.min}"` : ""}${control.max !== undefined ? ` max="${control.max}"` : ""}`
          : "";
      field = `<input type="${type}" ${common} value="${escapeAttribute(value)}"${control.maxLength ? ` maxlength="${control.maxLength}"` : ""}${bounds} />`;
    }
    const hints = [
      control.readOnly ? "read-only" : "",
      control.required ? "required" : control.nullable ? "" : "not nullable",
      control.subtypeField ? "subtype" : "",
    ].filter(Boolean);
    return `
      <div class="field" part="field">
        <label for="${id}">${escapeHtml(control.label)}${control.required ? '<span aria-hidden="true"> *</span>' : ""}</label>
        ${field}
        ${hints.length > 0 ? `<p class="hint">${escapeHtml(hints.join(" • "))}</p>` : ""}
        ${invalid ? `<p class="error" id="${errorId}" data-error-for="${escapeAttribute(control.name)}">${escapeHtml(control.errors.join(" "))}</p>` : ""}
      </div>
    `;
  }

  #geometryHtml(snapshot: HonuaFeatureEditorSnapshot, label: string): string {
    const sketch = snapshot.sketch;
    if (!sketch) return "";
    const tools = sketch.tools
      .map((capability) => {
        const disabled = capability.state === "supported" ? "" : ' disabled aria-disabled="true"';
        const title = capability.reason ? ` title="${escapeAttribute(capability.reason)}"` : "";
        return `<button type="button" part="sketch-tool" data-sketch-tool="${capability.tool}" aria-pressed="${String(sketch.activeTool === capability.tool)}"${disabled}${title}>${escapeHtml(toolLabel(capability.tool))}</button>`;
      })
      .join("");
    const text = this.#geometryDraft ?? (sketch.geometry ? JSON.stringify(sketch.geometry) : "");
    return `
      <fieldset class="geometry" part="geometry">
        <legend>Geometry</legend>
        <div class="segmented" role="group" aria-label="${escapeAttribute(`${label} sketch tools`)}">${tools}</div>
        <label for="honua-geometry-json">Geometry (GeoJSON)</label>
        <textarea id="honua-geometry-json" data-geometry-json rows="3" spellcheck="false" placeholder='{"type":"Point","coordinates":[0,0]}'>${escapeHtml(text)}</textarea>
        <div class="actions">
          <button type="button" data-action="apply-geometry">Apply geometry</button>
          <button type="button" data-action="clear-geometry"${sketch.geometry ? "" : " disabled"}>Clear geometry</button>
        </div>
        <p class="hint" data-geometry-state>${escapeHtml(geometryStateText(sketch))}</p>
        ${this.#geometryError ? `<p class="error" role="alert" data-geometry-error>${escapeHtml(this.#geometryError)}</p>` : ""}
      </fieldset>
    `;
  }

  #attachmentsHtml(snapshot: HonuaFeatureEditorSnapshot): string {
    if (!snapshot.form) return "";
    if (!snapshot.attachmentsSupported) {
      return `
        <fieldset class="attachments" part="attachments">
          <legend>Attachments</legend>
          <p class="empty" role="status" data-attachments-unsupported>This source does not support attachments.</p>
        </fieldset>
      `;
    }
    const staged =
      snapshot.attachments.length === 0
        ? '<p class="hint">No attachments staged.</p>'
        : `<ul class="staged" role="list">${snapshot.attachments
            .map(
              (draft) =>
                `<li role="listitem" data-attachment-index="${draft.index}" data-attachment-status="${draft.status}">${escapeHtml(
                  `${draft.name} — ${draft.status}${draft.error ? `: ${draft.error}` : ""}`,
                )}</li>`,
            )
            .join("")}</ul>`;
    return `
      <fieldset class="attachments" part="attachments">
        <legend>Attachments</legend>
        <label for="honua-attachment-file">Add an attachment</label>
        <input type="file" id="honua-attachment-file" data-attachment-input />
        ${staged}
      </fieldset>
    `;
  }

  #problemsHtml(snapshot: HonuaFeatureEditorSnapshot): string {
    const formErrors = snapshot.form?.formErrors ?? [];
    const fieldErrorCount = (snapshot.form?.controls ?? []).filter((control) => control.errors.length > 0).length;
    const validation =
      formErrors.length === 0 && fieldErrorCount === 0
        ? ""
        : `<div class="problems" role="alert" data-validation>
            <p>${escapeHtml(
              fieldErrorCount > 0
                ? `${fieldErrorCount} field${fieldErrorCount === 1 ? "" : "s"} need attention before this edit can be sent.`
                : "This draft cannot be sent yet.",
            )}</p>
            ${formErrors.length > 0 ? `<ul>${formErrors.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>` : ""}
          </div>`;
    const failures =
      snapshot.failures.length === 0
        ? ""
        : `<ul class="problems" role="alert" data-failures>${snapshot.failures
            .map(
              (failure) =>
                `<li data-failure-kind="${failure.kind}">${escapeHtml(`${failure.kind}: ${failure.description}`)}</li>`,
            )
            .join("")}</ul>`;
    return `${validation}${failures}`;
  }

  #actionsHtml(snapshot: HonuaFeatureEditorSnapshot): string {
    const hasDraft = snapshot.form !== undefined;
    const blockedByConflict = snapshot.conflict !== undefined;
    const submitDisabled = !hasDraft || snapshot.busy || blockedByConflict || snapshot.form?.valid === false;
    return `
      <div class="actions" role="group" aria-label="Edit actions">
        <button type="button" part="submit" data-action="submit"${submitDisabled ? " disabled" : ""}>${escapeHtml(
          snapshot.operation === "delete" ? "Delete feature" : "Submit",
        )}</button>
        <button type="button" data-action="retry"${snapshot.status === "rejected" && !snapshot.busy ? "" : " disabled"}>Retry</button>
        <button type="button" data-action="undo"${snapshot.undo.canUndo ? "" : " disabled"}>Undo</button>
        <button type="button" data-action="redo"${snapshot.undo.canRedo ? "" : " disabled"}>Redo</button>
        <button type="button" data-action="discard"${hasDraft && snapshot.dirty ? "" : " disabled"}>Revert</button>
        <button type="button" data-action="cancel"${hasDraft && !snapshot.busy ? "" : " disabled"}>Cancel</button>
      </div>
    `;
  }

  // ── event binding ──────────────────────────────────────────────────────

  #bind(root: ShadowRoot): void {
    const workflow = this.#workflow;
    if (!workflow) return;

    root.querySelectorAll<HTMLButtonElement>("button[data-operation]").forEach((button) => {
      button.addEventListener("click", () => {
        const operation = button.dataset.operation as HonuaEditorOperation | undefined;
        if (operation) this.#dispatchOperation(operation);
      });
    });

    root.querySelectorAll<HTMLButtonElement>("button[data-conflict]").forEach((button) => {
      button.addEventListener("click", () => {
        const choice = button.dataset.conflict as HonuaFeatureEditorConflictChoice | undefined;
        if (choice) workflow.resolveConflict(choice);
      });
    });

    root.querySelectorAll<HTMLButtonElement>("button[data-sketch-tool]").forEach((button) => {
      button.addEventListener("click", () => {
        const tool = button.dataset.sketchTool as EditSketchTool | undefined;
        if (tool) workflow.startSketch(tool);
      });
    });

    root.querySelectorAll<HTMLElement>("[data-field]").forEach((input) => {
      const name = input.dataset.field;
      if (!name) return;
      input.addEventListener("change", () => {
        workflow.setValue(name, controlValue(input));
      });
    });

    root.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        void this.#runAction(button.dataset.action ?? "");
      });
    });

    root.querySelector<HTMLInputElement>("[data-attachment-input]")?.addEventListener("change", (event) => {
      const input = event.currentTarget as HTMLInputElement | null;
      const file = input?.files?.[0];
      if (file) workflow.stageAttachment(file, { name: file.name, contentType: file.type || undefined });
      if (input) input.value = "";
    });

    const geometry = root.querySelector<HTMLTextAreaElement>("[data-geometry-json]");
    geometry?.addEventListener("input", () => {
      this.#geometryDraft = geometry.value;
    });

    root.addEventListener("keydown", (event) => {
      const keyboard = event as KeyboardEvent;
      if (keyboard.key === "Escape") {
        workflow.cancel();
        return;
      }
      if ((keyboard.ctrlKey || keyboard.metaKey) && keyboard.key.toLowerCase() === "z") {
        keyboard.preventDefault();
        if (keyboard.shiftKey) workflow.redo();
        else workflow.undo();
      }
    });
  }

  #dispatchOperation(operation: HonuaEditorOperation): void {
    const workflow = this.#workflow;
    if (!workflow) return;
    this.#geometryDraft = undefined;
    this.#geometryError = undefined;
    // `update` / `delete` open on the workflow's recorded selection, which the
    // host feeds through `.selectedFeature` — the element never reaches into
    // the map itself.
    workflow.begin(operation);
  }

  async #runAction(action: string): Promise<void> {
    const workflow = this.#workflow;
    if (!workflow) return;
    if (action === "submit" || action === "retry") {
      const commit = action === "retry" ? await workflow.retry() : await workflow.submit();
      this.#dispatch("honua-feature-edit-commit", { commit });
      return;
    }
    if (action === "undo") {
      workflow.undo();
      this.#geometryDraft = undefined;
      return;
    }
    if (action === "redo") {
      workflow.redo();
      this.#geometryDraft = undefined;
      return;
    }
    if (action === "discard") {
      workflow.discardChanges();
      this.#geometryDraft = undefined;
      return;
    }
    if (action === "cancel") {
      workflow.cancel();
      this.#geometryDraft = undefined;
      return;
    }
    if (action === "clear-geometry") {
      this.#geometryDraft = undefined;
      this.#geometryError = undefined;
      workflow.setGeometry(this.#activeTool(), null);
      return;
    }
    if (action === "apply-geometry") this.#applyGeometryFromText();
  }

  #applyGeometryFromText(): void {
    const workflow = this.#workflow;
    if (!workflow) return;
    const text = (this.#geometryDraft ?? "").trim();
    if (text === "") {
      this.#geometryError = "Enter a GeoJSON geometry, or use Clear geometry.";
      this.render();
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#geometryError = "That is not valid JSON.";
      this.render();
      return;
    }
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
      this.#geometryError = 'A geometry needs a "type" (for example {"type":"Point","coordinates":[0,0]}).';
      this.render();
      return;
    }
    this.#geometryError = undefined;
    this.#geometryDraft = undefined;
    workflow.setGeometry(this.#activeTool(parsed as Record<string, unknown>), parsed as Record<string, unknown>);
  }

  #activeTool(geometry?: Record<string, unknown>): EditSketchTool {
    const snapshot = this.#snapshot;
    const active = snapshot?.sketch?.activeTool;
    if (active) return active;
    const type = typeof geometry?.type === "string" ? (geometry.type as string).toLowerCase() : "";
    if (type.includes("polygon")) return "polygon";
    if (type.includes("line")) return "line";
    if (type.includes("point")) return "point";
    const supported = snapshot?.sketch?.tools.find((capability) => capability.state === "supported");
    return supported?.tool ?? "point";
  }

  #dispatch(name: string, detail: unknown): void {
    if (!globalDom.CustomEvent || typeof this.dispatchEvent !== "function") return;
    this.dispatchEvent(new globalDom.CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  #attr(name: string): string | null {
    return typeof this.getAttribute === "function" ? this.getAttribute(name) : null;
  }
}

/** Registers `<honua-feature-editor>`; skipped when the tag is already defined. */
export function defineHonuaFeatureEditor(registry = globalDom.customElements): void {
  if (!registry) return;
  if (!registry.get("honua-feature-editor")) {
    registry.define("honua-feature-editor", HonuaFeatureEditorElement);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

const CONFLICT_LABELS: Readonly<Record<HonuaFeatureEditorConflictChoice, string>> = {
  "keep-mine": "Keep my changes",
  "discard-mine": "Discard my changes",
  reload: "Reload the feature",
};

function toolLabel(tool: EditSketchTool): string {
  return tool.charAt(0).toUpperCase() + tool.slice(1);
}

function geometryStateText(sketch: NonNullable<HonuaFeatureEditorSnapshot["sketch"]>): string {
  const snapping = sketch.snapping.enabled ? `snapping on (${sketch.snapping.tolerance}px)` : "snapping off";
  if (sketch.status === "sketching") return `Sketching with ${sketch.activeTool ?? "a tool"} — ${snapping}`;
  if (sketch.geometry === null) return `Geometry cleared — ${snapping}`;
  if (sketch.geometry === undefined) return `No geometry yet — ${snapping}`;
  return `Geometry ready — ${snapping}`;
}

function describeToken(token: unknown): string {
  if (token === undefined) return "unknown";
  if (token === null) return "none";
  return String(token);
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function controlValue(input: HTMLElement): string | boolean | null {
  const candidate = input as unknown as { type?: string; checked?: boolean; value?: string };
  if (candidate.type === "checkbox") return candidate.checked === true;
  return candidate.value ?? null;
}

interface FocusMemento {
  readonly id: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
}

function captureFocus(root: ShadowRoot): FocusMemento | undefined {
  const active = root.activeElement as
    | (Element & { id?: string; selectionStart?: number; selectionEnd?: number })
    | null;
  if (!active?.id) return undefined;
  return {
    id: active.id,
    ...(typeof active.selectionStart === "number" ? { selectionStart: active.selectionStart } : {}),
    ...(typeof active.selectionEnd === "number" ? { selectionEnd: active.selectionEnd } : {}),
  };
}

function restoreFocus(root: ShadowRoot, memento: FocusMemento | undefined): void {
  if (!memento) return;
  const next = root.querySelector<HTMLElement & { setSelectionRange?(start: number, end: number): void }>(
    `#${cssEscape(memento.id)}`,
  );
  if (!next || typeof next.focus !== "function") return;
  next.focus();
  if (memento.selectionStart !== undefined && typeof next.setSelectionRange === "function") {
    try {
      next.setSelectionRange(memento.selectionStart, memento.selectionEnd ?? memento.selectionStart);
    } catch {
      // Controls without a text selection model (checkbox, select) throw here.
    }
  }
}

/** Field names become element ids; keep them selector-safe without a regex backtrack. */
function cssSafe(value: string): string {
  let out = "";
  for (const char of value) {
    out += /[A-Za-z0-9_-]/.test(char) ? char : "_";
  }
  return out;
}

function cssEscape(value: string): string {
  return cssSafe(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

/** Structural styles, themable through the shared `--honua-ui-*` properties. */
function editorStyles(): string {
  return `
    :host {
      --honua-ui-bg: #ffffff;
      --honua-ui-fg: #172033;
      --honua-ui-muted: #667085;
      --honua-ui-border: #d0d5dd;
      --honua-ui-accent: #1d4ed8;
      --honua-ui-accent-fg: #ffffff;
      --honua-ui-danger: #b42318;
      box-sizing: border-box;
      color: var(--honua-ui-fg);
      display: block;
      font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    *, *::before, *::after { box-sizing: inherit; }
    .panel {
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      display: grid;
      gap: 10px;
      min-width: 240px;
      padding: 12px;
    }
    .bar { align-items: center; display: flex; gap: 8px; justify-content: space-between; }
    h2 { font-size: 14px; margin: 0; }
    .state { color: var(--honua-ui-muted); font-size: 12px; }
    button {
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-height: 32px;
      padding: 0 10px;
    }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button[aria-pressed="true"] {
      background: var(--honua-ui-accent);
      border-color: var(--honua-ui-accent);
      color: var(--honua-ui-accent-fg);
    }
    .segmented { display: flex; flex-wrap: wrap; gap: 6px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; }
    fieldset {
      border: 1px solid var(--honua-ui-border);
      border-radius: 6px;
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 8px 10px 10px;
    }
    legend { color: var(--honua-ui-muted); font-size: 12px; padding: 0 4px; }
    label { display: block; font-size: 12px; font-weight: 600; }
    input, select, textarea {
      border: 1px solid var(--honua-ui-border);
      border-radius: 6px;
      color: inherit;
      font: inherit;
      min-height: 32px;
      padding: 4px 8px;
      width: 100%;
    }
    input[type="checkbox"] { min-height: 0; width: auto; }
    textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
    [aria-invalid="true"] { border-color: var(--honua-ui-danger); }
    .field { display: grid; gap: 4px; }
    .hint { color: var(--honua-ui-muted); font-size: 12px; margin: 0; }
    .empty { color: var(--honua-ui-muted); margin: 0; }
    .error { color: var(--honua-ui-danger); font-size: 12px; margin: 0; }
    .status { margin: 0; }
    .reasons, .staged { display: grid; gap: 4px; font-size: 12px; list-style: none; margin: 0; padding: 0; }
    .reasons li { color: var(--honua-ui-muted); }
    .problems {
      background: rgba(180, 35, 24, 0.06);
      border: 1px solid var(--honua-ui-danger);
      border-radius: 6px;
      color: var(--honua-ui-danger);
      display: grid;
      gap: 4px;
      list-style: none;
      margin: 0;
      padding: 8px 10px;
    }
    .problems p, .problems ul { margin: 0; }
    .conflict {
      border: 1px solid var(--honua-ui-danger);
      border-radius: 6px;
      display: grid;
      gap: 6px;
      padding: 8px 10px;
    }
    .conflict p { margin: 0; }
  `;
}
