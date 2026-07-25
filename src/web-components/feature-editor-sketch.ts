/**
 * The app-platform sketch default for `<honua-feature-editor>` (issue #680,
 * REQ-002): a terra-draw-backed geometry adapter that stays bound across the
 * editor's draft lifecycle.
 *
 * The SDK already ships the renderer-neutral sketch/snapping seam
 * (`bindTerraDrawSketch`, `createTerraDrawSketch`, `createTerraDrawSnapping`,
 * `terraDrawSketchToolCapabilities` on `@honua/sdk-js/runtime`). What
 * app-platform adds here is *lifecycle composition*: a
 * {@link HonuaFeatureEditorWorkflow} builds a fresh contract sketch workflow
 * every time a draft opens, so a one-shot binding would silently stop driving
 * the editor after the first submit. {@link bindEditorSketch} watches the
 * workflow and re-binds terra-draw to each new draft's model, and reports
 * terra-draw's true tool support (which upgrades `rectangle` / `circle` from
 * the contract's renderer-support-required defaults) into the workflow so the
 * editor's tool buttons are truthful.
 *
 * terra-draw itself stays an optional peer: {@link bindEditorSketch} takes a
 * duck-typed instance the app already constructed, and only
 * {@link createTerraDrawEditorSketch} — the one-call default — pulls the peer
 * in, through the runtime module's own lazy `import()`.
 *
 * @module
 */

import type { EditSketchTool, EditSketchToolCapability, EditSketchWorkflowModel } from "../contract/edit-sketch.js";
import type { SnapIndex, SnappingConfig } from "../contract/edit-snapping.js";
import {
  type BindTerraDrawSketchOptions,
  type CreateTerraDrawSnappingOptions,
  type TerraDrawSketchHandle,
  type TerraDrawSketchInstance,
  bindTerraDrawSketch,
  createTerraDrawSketch,
  terraDrawSketchToolCapabilities,
} from "../runtime/terra-draw-sketch.js";
import type { HonuaFeatureEditorWorkflow } from "./feature-editor-workflow.js";

/**
 * The geometry seam `<honua-feature-editor>` composes with. Every method is a
 * no-op-with-a-reason while no draft is open, so a host never has to branch on
 * the editor's lifecycle.
 */
export interface HonuaEditorSketchAdapter {
  /** Arms a drawing tool in both the sketch backend and the workflow. */
  setTool(tool: EditSketchTool): EditSketchToolCapability;
  /** Switches the backend to reshape/select mode for updating existing geometry. */
  select(): void;
  /** Leaves any drawing or select mode. */
  cancel(): void;
  /** Undo through the workflow, then re-sync the backend. */
  undo(): boolean;
  /** Redo through the workflow, then re-sync the backend. */
  redo(): boolean;
  /** Pushes the workflow's current geometry back into the backend. */
  syncFromModel(): boolean;
  /**
   * Resolves once the adapter has finished (re)binding to the workflow's
   * current draft. Deterministic hook for hosts and tests after `begin()`.
   */
  ready(): Promise<void>;
  /** Detaches from the workflow and the sketch backend. */
  remove(): void;
}

/** Options shared by both adapter factories. */
export interface HonuaEditorSketchOptions<T = Record<string, unknown>>
  extends Pick<
    BindTerraDrawSketchOptions<T>,
    "transformGeometry" | "restoreGeometry" | "featureFilter" | "toolForMode" | "onFinish" | "onDelete"
  > {
  /** Editor workflow whose drafts drive (and are driven by) the sketch backend. */
  readonly workflow: HonuaFeatureEditorWorkflow<T>;
  /**
   * terra-draw modes actually registered on the instance. Defaults to every
   * canonical drawing mode; used to report truthful tool support.
   */
  readonly modes?: readonly string[];
}

/**
 * Binds an already-constructed terra-draw instance to an editor workflow, and
 * keeps it bound as drafts open and close.
 *
 * Also reports terra-draw's real tool support into the workflow, so the
 * editor's `rectangle` / `circle` buttons become enabled instead of showing
 * the contract's "requires renderer support" reason.
 */
export function bindEditorSketch<T = Record<string, unknown>>(
  draw: TerraDrawSketchInstance,
  options: HonuaEditorSketchOptions<T>,
): HonuaEditorSketchAdapter {
  return createAdapter(options, () => draw);
}

/** Options for the one-call terra-draw default. */
export interface CreateTerraDrawEditorSketchOptions<T = Record<string, unknown>> extends HonuaEditorSketchOptions<T> {
  /**
   * Wire SDK snapping into the terra-draw modes that expose a custom snapping
   * hook (linestring / polygon). Snapping is configured when the instance is
   * constructed, so it persists across draft re-binds.
   */
  readonly snapping?: { readonly index: SnapIndex; readonly config?: Partial<SnappingConfig> };
}

/**
 * The app-platform terra-draw default: constructs terra-draw for a MapLibre
 * map (pulling the optional `terra-draw` peers lazily through the runtime
 * module), wires SDK snapping, and binds it to the editor workflow for the
 * lifetime of the adapter.
 *
 * @example
 * ```ts
 * const workflow = createFeatureEditorWorkflow({ source });
 * const sketch = await createTerraDrawEditorSketch(map, { workflow });
 * editor.workflow = workflow;   // <honua-feature-editor>
 * ```
 */
export async function createTerraDrawEditorSketch<T = Record<string, unknown>>(
  map: unknown,
  options: CreateTerraDrawEditorSketchOptions<T>,
): Promise<HonuaEditorSketchAdapter & { stop(): void }> {
  const { workflow } = options;
  workflow.configureSketchTools(terraDrawSketchToolCapabilities(options.modes));
  const model = workflow.sketchModel() ?? bootstrapModel(workflow);
  const snapping: CreateTerraDrawSnappingOptions<T> | undefined = options.snapping
    ? {
        index: options.snapping.index,
        model,
        ...(options.snapping.config ? { config: options.snapping.config } : {}),
      }
    : undefined;
  const controller = await createTerraDrawSketch<T>(map, {
    model,
    ...bindPassThrough(options),
    ...(snapping ? { snapping } : {}),
  });
  // The controller's own binding covers whichever model existed at
  // construction; the adapter owns every binding from here on.
  controller.remove();
  const adapter = createAdapter(options, () => controller.draw);
  return {
    ...adapter,
    setTool: (tool) => adapter.setTool(tool),
    select: () => adapter.select(),
    cancel: () => adapter.cancel(),
    undo: () => adapter.undo(),
    redo: () => adapter.redo(),
    syncFromModel: () => adapter.syncFromModel(),
    ready: () => adapter.ready(),
    remove: () => adapter.remove(),
    stop() {
      adapter.remove();
      controller.stop();
    },
  };
}

// ── shared adapter ───────────────────────────────────────────────────────

function createAdapter<T>(
  options: HonuaEditorSketchOptions<T>,
  drawOf: () => TerraDrawSketchInstance,
): HonuaEditorSketchAdapter {
  const { workflow } = options;
  // Report terra-draw's real tool support so the editor's rectangle / circle
  // buttons stop showing the contract's "requires renderer support" reason.
  workflow.configureSketchTools(terraDrawSketchToolCapabilities(options.modes));
  let handle: TerraDrawSketchHandle | undefined;
  let bound: EditSketchWorkflowModel<T> | undefined;
  let pending = Promise.resolve();
  let removed = false;

  const rebind = (): void => {
    if (removed) return;
    const model = workflow.sketchModel();
    if (model === bound) return;
    handle?.remove();
    handle = undefined;
    bound = model;
    if (!model) return;
    handle = bindTerraDrawSketch<T>(drawOf(), { model, ...bindPassThrough(options) });
  };

  const schedule = (): void => {
    pending = pending.then(() => {
      rebind();
    });
  };

  const subscription = workflow.subscribe(schedule);
  rebind();

  return {
    setTool(tool) {
      if (handle) return handle.setTool(tool);
      return workflow.startSketch(tool);
    },
    select() {
      handle?.select();
    },
    cancel() {
      handle?.cancel();
    },
    undo() {
      return handle ? handle.undo() : workflow.undo();
    },
    redo() {
      return handle ? handle.redo() : workflow.redo();
    },
    syncFromModel() {
      return handle?.syncFromModel() ?? false;
    },
    ready() {
      return pending;
    },
    remove() {
      removed = true;
      subscription.remove();
      handle?.remove();
      handle = undefined;
      bound = undefined;
    },
  };
}

function bindPassThrough<T>(options: HonuaEditorSketchOptions<T>): Omit<BindTerraDrawSketchOptions<T>, "model"> {
  return {
    ...(options.transformGeometry ? { transformGeometry: options.transformGeometry } : {}),
    ...(options.restoreGeometry ? { restoreGeometry: options.restoreGeometry } : {}),
    ...(options.featureFilter ? { featureFilter: options.featureFilter } : {}),
    ...(options.toolForMode ? { toolForMode: options.toolForMode } : {}),
    ...(options.onFinish ? { onFinish: options.onFinish } : {}),
    ...(options.onDelete ? { onDelete: options.onDelete } : {}),
  };
}

/**
 * terra-draw needs a model at construction time, but an editor may have no
 * draft open yet. Opening a throwaway create draft yields a real contract
 * sketch workflow to construct against; the adapter re-binds to whatever draft
 * the host opens next.
 */
function bootstrapModel<T>(workflow: HonuaFeatureEditorWorkflow<T>): EditSketchWorkflowModel<T> {
  workflow.begin("create");
  const model = workflow.sketchModel();
  if (!model) {
    throw new Error(
      "createTerraDrawEditorSketch: the editor workflow could not open a draft to bind terra-draw against " +
        "(the source does not support editing). Bind a sketch adapter only to an editable source.",
    );
  }
  return model;
}
