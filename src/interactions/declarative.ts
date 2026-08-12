/**
 * `@honua/sdk-js/interactions/declarative` — compiles a standard
 * `interactions[]` block (geospatial-mcp ADR-0030) onto this SDK's existing
 * imperative binding primitives.
 *
 * The standard constrains the *document*, not the dispatcher: "client
 * runtimes implement dispatch by compiling bindings onto whatever imperative
 * primitives they already have". That is exactly what this module does — it
 * owns no event plumbing of its own, only a compile table from the closed
 * (`on.event`, `do.verb`) vocabulary onto `createSelectionHandler`,
 * `createHoverHandler`, `bindTableSelectionToExploration`,
 * `bindFilterControlsToExploration`, and `subscribeExplorationSelector`.
 *
 * Three properties are load-bearing and asserted by the suite:
 *
 * 1. **Validate before binding.** `compileHonuaInteractions` runs the whole
 *    block through {@link validateHonuaInteractions} plus reference
 *    resolution against the components it was handed. A block with issues
 *    binds *nothing* — the standard rejects over-cap and malformed documents
 *    rather than truncating them.
 * 2. **Actions never emit events.** A verb-driven state change must not
 *    re-enter the dispatcher. Two mechanisms enforce it: every compiled
 *    handler is skipped while an action is in flight (`#dispatching`), and
 *    exploration-backed subscriptions run with the view controller's default
 *    `includeSelf: false`, so a change this compiler originated is never
 *    delivered back to this compiler. There is no cycle detection because
 *    there can be no cycle.
 * 3. **Unsupported pairs are named, never dropped.** When a binding's
 *    (`on.event`, `do.verb`) pair — or the component behind a ref — has no
 *    primitive to compile onto, it lands in
 *    {@link HonuaCompiledInteractions.unsupported} with the pair spelled out,
 *    so a host can surface a real "this runtime cannot honor that binding"
 *    message instead of silently rendering an inert app.
 *
 * @experimental The compiler surface tracks geospatial-mcp ADR-0030 while
 * that ADR is Proposed; the component-adapter shapes may gain fields.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type { HonuaExtent } from "../core/types.js";
import { sourceFeatureSelectionTarget } from "../exploration/selection.js";
import { subscribeExplorationSelector } from "../exploration/selectors.js";
import type {
  ExplorationViewController,
  FeatureSelectionTarget,
  FilterClause,
  FilterOperator,
  SourceQualifiedFeatureSelectionTarget,
  Unsubscribe,
} from "../exploration/types.js";
import { bindFilterControlsToExploration, bindTableSelectionToExploration } from "./exploration-bindings.js";
import { createHoverHandler, createSelectionHandler } from "./feature-state.js";
import type { InteractiveMap } from "./feature-state.js";

import {
  type HonuaInteraction,
  type HonuaInteractionEvent,
  type HonuaInteractionIssue,
  type HonuaInteractionRefKind,
  type HonuaInteractionVerb,
  parseHonuaInteractionRef,
  resolveHonuaInteractionArgs,
  validateHonuaInteractions,
} from "./declarative-contract.js";

export * from "./declarative-contract.js";

// ── Component adapters ────────────────────────────────────────

/**
 * A layer addressed as `layer:{id}`. `map` is what the
 * `featureSelect`/`featureHover` primitives bind to; the optional methods are
 * the layer-scoped action targets.
 */
export interface HonuaInteractionLayerComponent {
  /** MapLibre-style interactive map this layer renders on — the event source for `featureSelect`/`featureHover`. */
  readonly map?: InteractiveMap;
  /** Source id feature-state is written to. Defaults to the ref's id. */
  readonly sourceId?: SourceId;
  /** Rendered layer id clicks/hovers are observed on. Defaults to the ref's id. */
  readonly layerId?: string;
  /** Source layer, for vector-tile sources. */
  readonly sourceLayer?: string;
  /** Select multiple features rather than replacing on each click. @default false */
  readonly multiSelect?: boolean;
  /** `setVisibility` target. */
  setVisibility?(visible: boolean): void;
  /** `setFilter` target. When absent, `setFilter` falls back to the shared exploration filter keyed by this ref's id. */
  setFilter?(clause: FilterClause | undefined): void;
}

export interface HonuaInteractionViewport {
  readonly bbox?: readonly [number, number, number, number];
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
}

/** The `map` component. */
export interface HonuaInteractionMapComponent {
  /**
   * `setViewport` target. When absent, `setViewport` falls back to the
   * exploration view's `setExtent` for `bbox`-shaped arguments.
   */
  setViewport?(viewport: HonuaInteractionViewport): void;
}

/** A widget addressed as `widget:{id}`. */
export interface HonuaInteractionWidgetComponent {
  /** `runWidgetQuery` target. There is no exploration-level fallback for this verb. */
  runQuery?(request: Readonly<Record<string, unknown>>): void;
  /** `setFilter` target. When absent, falls back to the shared exploration filter keyed by this ref's id. */
  setFilter?(clause: FilterClause | undefined): void;
  /** `setVisibility` target. */
  setVisibility?(visible: boolean): void;
}

/**
 * A control addressed as `control:{id}`. A control's `change` event is read
 * off the shared exploration filter slice keyed by the control's id — that is
 * the same seam `bindFilterControlsToExploration` writes through, so a
 * filter bar wired with that primitive needs no extra adapter here.
 */
export interface HonuaInteractionControlComponent {
  /** `setVisibility` target. */
  setVisibility?(visible: boolean): void;
  /** `setFilter` target. When absent, falls back to the shared exploration filter keyed by this ref's id. */
  setFilter?(clause: FilterClause | undefined): void;
}

/**
 * The components an `interactions[]` block's refs resolve against. A ref that
 * resolves to no component is a validation failure (`unresolved-ref`), matching
 * the standard's "an implementation MUST reject a binding whose `ref` does not
 * resolve within the document".
 *
 * `control:` and `widget:` refs may be declared with an empty object when the
 * component needs no adapter — their events and their `setFilter` action both
 * run through the shared exploration view.
 */
export interface HonuaInteractionComponents {
  readonly map?: HonuaInteractionMapComponent;
  readonly layers?: Readonly<Record<string, HonuaInteractionLayerComponent>>;
  readonly widgets?: Readonly<Record<string, HonuaInteractionWidgetComponent>>;
  readonly controls?: Readonly<Record<string, HonuaInteractionControlComponent>>;
}

// ── Compilation result ────────────────────────────────────────

/** One binding this runtime cannot honor, with the pair named. */
export interface HonuaUnsupportedInteraction {
  readonly interactionId: string;
  readonly on: { readonly ref: string; readonly event: HonuaInteractionEvent };
  readonly do: { readonly ref: string; readonly verb: HonuaInteractionVerb };
  /** `"{event} -> {verb}"`, the pair as the standard spells it. */
  readonly pair: string;
  readonly reason: string;
}

/** One binding that compiled onto a primitive. */
export interface HonuaCompiledInteractionBinding {
  readonly interactionId: string;
  readonly on: { readonly ref: string; readonly event: HonuaInteractionEvent };
  readonly do: { readonly ref: string; readonly verb: HonuaInteractionVerb };
  readonly pair: string;
  /** Disposes just this binding. Idempotent. */
  dispose(): void;
}

export interface HonuaCompiledInteractions {
  /** True when the block validated and every non-disabled binding compiled. */
  readonly ok: boolean;
  /** Validation failures. When non-empty, nothing was bound. */
  readonly issues: ReadonlyArray<HonuaInteractionIssue>;
  readonly bindings: ReadonlyArray<HonuaCompiledInteractionBinding>;
  readonly unsupported: ReadonlyArray<HonuaUnsupportedInteraction>;
  /** Interaction ids skipped because `disabled: true`. */
  readonly disabled: ReadonlyArray<string>;
  /** Disposes every compiled binding. Idempotent. */
  dispose(): void;
}

export interface CompileHonuaInteractionsOptions {
  /**
   * The exploration view this compiler owns — every action verb writes
   * through it, and every exploration-backed event source subscribes on it.
   *
   * **Pass a view bound for the compiler alone** (`ctx.connectView({ id:
   * "interactions", role: "custom" })`), not a view a widget also dispatches
   * through. That is what makes "actions never emit events" structural rather
   * than best-effort: an `ExplorationViewController` delivers a bound view its
   * own notifications only under `includeSelf`, so a state change this
   * compiler originated is never routed back into this compiler, while a real
   * user gesture published by any *other* view is.
   */
  readonly view: ExplorationViewController;
  readonly components?: HonuaInteractionComponents;
  /** Per-(`on.ref`, `on.event`) fan-out cap. @default 8 */
  readonly fanOutCap?: number;
  /**
   * Observes each dispatched action. Called after the verb ran; never called
   * for a suppressed (action-originated) event, which is the whole point of
   * "actions never emit events".
   */
  readonly onDispatch?: (dispatch: HonuaInteractionDispatch) => void;
}

export interface HonuaInteractionDispatch {
  readonly interactionId: string;
  readonly event: HonuaInteractionEvent;
  readonly verb: HonuaInteractionVerb;
  readonly ref: string;
  /** Arguments after `$event.*` substitution. */
  readonly args: Readonly<Record<string, unknown>>;
}

// ── Compiler ──────────────────────────────────────────────────

const EMPTY_RESULT_BASE = { bindings: [] as HonuaCompiledInteractionBinding[], disabled: [] as string[] };

/**
 * Compiles an `interactions[]` block onto live components. Returns disposers;
 * never throws for a bad document — a malformed or over-cap block comes back
 * as `{ ok: false, issues }` with nothing bound.
 */
export function compileHonuaInteractions(
  interactions: unknown,
  options: CompileHonuaInteractionsOptions,
): HonuaCompiledInteractions {
  const validation = validateHonuaInteractions(interactions, {
    ...(options.fanOutCap !== undefined ? { fanOutCap: options.fanOutCap } : {}),
  });
  const components = options.components ?? {};
  const declared = Array.isArray(interactions) ? (interactions as ReadonlyArray<HonuaInteraction>) : [];

  const refIssues = validation.ok ? resolveReferenceIssues(declared, components) : [];
  const issues = [...validation.issues, ...refIssues];
  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      ...EMPTY_RESULT_BASE,
      unsupported: [],
      dispose: () => undefined,
    };
  }

  const compiler = new InteractionCompiler(options, components);
  for (const interaction of declared) compiler.compile(interaction);
  return compiler.result();
}

function resolveReferenceIssues(
  interactions: ReadonlyArray<HonuaInteraction>,
  components: HonuaInteractionComponents,
): ReadonlyArray<HonuaInteractionIssue> {
  const issues: HonuaInteractionIssue[] = [];
  interactions.forEach((interaction, index) => {
    for (const side of ["on", "do"] as const) {
      const ref = interaction[side].ref;
      if (resolveComponent(ref, components) !== undefined) continue;
      issues.push({
        code: "invalid-ref",
        interactionId: interaction.id,
        path: `interactions[${index}].${side}.ref`,
        message: `\`${ref}\` does not resolve to a declared component.`,
      });
    }
  });
  return issues;
}

type ResolvedComponent =
  | { readonly kind: "map"; readonly id: "map"; readonly component: HonuaInteractionMapComponent }
  | { readonly kind: "layer"; readonly id: string; readonly component: HonuaInteractionLayerComponent }
  | { readonly kind: "widget"; readonly id: string; readonly component: HonuaInteractionWidgetComponent }
  | { readonly kind: "control"; readonly id: string; readonly component: HonuaInteractionControlComponent };

function resolveComponent(ref: string, components: HonuaInteractionComponents): ResolvedComponent | undefined {
  const parsed = parseHonuaInteractionRef(ref);
  if (!parsed) return undefined;
  if (parsed.kind === "map") {
    return components.map ? { kind: "map", id: "map", component: components.map } : undefined;
  }
  const id = parsed.id as string;
  const table: Readonly<Record<Exclude<HonuaInteractionRefKind, "map">, Readonly<Record<string, object>> | undefined>> =
    {
      layer: components.layers,
      widget: components.widgets,
      control: components.controls,
    };
  const component = table[parsed.kind]?.[id];
  if (!component) return undefined;
  return { kind: parsed.kind, id, component } as ResolvedComponent;
}

class InteractionCompiler {
  readonly #view: ExplorationViewController;
  readonly #components: HonuaInteractionComponents;
  readonly #onDispatch: CompileHonuaInteractionsOptions["onDispatch"];
  readonly #bindings: HonuaCompiledInteractionBinding[] = [];
  readonly #unsupported: HonuaUnsupportedInteraction[] = [];
  readonly #disabled: string[] = [];
  /** Re-entrancy guard: an event delivered while an action runs is dropped (actions never emit events). */
  #dispatching = false;
  #disposed = false;

  public constructor(options: CompileHonuaInteractionsOptions, components: HonuaInteractionComponents) {
    this.#view = options.view;
    this.#components = components;
    this.#onDispatch = options.onDispatch;
  }

  public compile(interaction: HonuaInteraction): void {
    if (interaction.disabled === true) {
      this.#disabled.push(interaction.id);
      return;
    }
    const source = resolveComponent(interaction.on.ref, this.#components) as ResolvedComponent;
    const target = resolveComponent(interaction.do.ref, this.#components) as ResolvedComponent;

    const action = this.#compileAction(interaction, target);
    if (typeof action === "string") {
      this.#reject(interaction, action);
      return;
    }

    const dispose = this.#compileEvent(interaction, source, action);
    if (typeof dispose === "string") {
      this.#reject(interaction, dispose);
      return;
    }

    let released = false;
    this.#bindings.push({
      interactionId: interaction.id,
      on: { ref: interaction.on.ref, event: interaction.on.event },
      do: { ref: interaction.do.ref, verb: interaction.do.verb },
      pair: pairLabel(interaction),
      dispose: () => {
        if (released) return;
        released = true;
        dispose();
      },
    });
  }

  public result(): HonuaCompiledInteractions {
    const bindings = [...this.#bindings];
    return {
      ok: this.#unsupported.length === 0,
      issues: [],
      bindings,
      unsupported: [...this.#unsupported],
      disabled: [...this.#disabled],
      dispose: () => {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const binding of bindings) binding.dispose();
      },
    };
  }

  #reject(interaction: HonuaInteraction, reason: string): void {
    this.#unsupported.push({
      interactionId: interaction.id,
      on: { ref: interaction.on.ref, event: interaction.on.event },
      do: { ref: interaction.do.ref, verb: interaction.do.verb },
      pair: pairLabel(interaction),
      reason,
    });
  }

  // ── Event side ──────────────────────────────────────────────

  /** Returns a disposer, or a string reason the pair is unsupported. */
  #compileEvent(
    interaction: HonuaInteraction,
    source: ResolvedComponent,
    action: (payload: unknown) => void,
  ): (() => void) | string {
    const emit = (payload: unknown): void => {
      if (this.#disposed || this.#dispatching) return;
      this.#dispatching = true;
      try {
        action(payload);
      } finally {
        this.#dispatching = false;
      }
    };

    switch (interaction.on.event) {
      case "featureSelect": {
        if (source.kind !== "layer")
          return `\`featureSelect\` is a layer event; \`${interaction.on.ref}\` is not a layer.`;
        const map = source.component.map;
        if (!map) return `Layer "${source.id}" declares no \`map\`, so \`featureSelect\` has no primitive to bind to.`;
        const sourceId = source.component.sourceId ?? source.id;
        const handle = createSelectionHandler(map, {
          source: sourceId,
          layer: source.component.layerId ?? source.id,
          ...(source.component.sourceLayer ? { sourceLayer: source.component.sourceLayer } : {}),
          ...(source.component.multiSelect !== undefined ? { multiSelect: source.component.multiSelect } : {}),
          onSelectionTargetsChange: (targets) => emit(featureSelectPayload(sourceId, targets)),
        });
        return () => handle.remove();
      }
      case "featureHover": {
        if (source.kind !== "layer")
          return `\`featureHover\` is a layer event; \`${interaction.on.ref}\` is not a layer.`;
        const map = source.component.map;
        if (!map) return `Layer "${source.id}" declares no \`map\`, so \`featureHover\` has no primitive to bind to.`;
        const sourceId = source.component.sourceId ?? source.id;
        const handle = createHoverHandler(map, {
          source: sourceId,
          layer: source.component.layerId ?? source.id,
          ...(source.component.sourceLayer ? { sourceLayer: source.component.sourceLayer } : {}),
          onHoverTargetChange: (hovered) => emit(featureHoverPayload(sourceId, hovered)),
        });
        return () => handle.remove();
      }
      case "selection": {
        if (source.kind !== "widget")
          return `\`selection\` is a widget event; \`${interaction.on.ref}\` is not a widget.`;
        // Compiled onto the table/grid selection primitive: a widget publishes
        // and observes selection through the shared exploration slice.
        const unsubscribe = bindTableSelectionToExploration(this.#view).subscribe((selection) =>
          emit(selectionPayload(selection)),
        );
        return unsubscribe;
      }
      case "change": {
        if (source.kind !== "control")
          return `\`change\` is a control event; \`${interaction.on.ref}\` is not a control.`;
        // Compiled onto the filter-control primitive, keyed by the control's
        // own id — the same key `bindFilterControlsToExploration().setFilter`
        // writes, so a filter bar built on that primitive needs no adapter.
        const controlId = source.id;
        let previous = this.#view.state.filters[controlId];
        const unsubscribe = bindFilterControlsToExploration(this.#view).subscribe((filters) => {
          const clause = filters[controlId];
          if (clause === previous) return;
          previous = clause;
          emit(changePayload(controlId, clause, filters));
        });
        return unsubscribe;
      }
      case "viewportChange": {
        if (source.kind !== "map") return "`viewportChange` is a map event; only `map` publishes it.";
        // Compiled onto the shared extent slice — the slice
        // `bindMapExtentToExploration` publishes into.
        const unsubscribe: Unsubscribe = subscribeExplorationSelector(
          this.#view,
          "extent",
          (state) => state.extent,
          (extent) => emit(viewportPayload(extent)),
          { fireImmediately: false },
        );
        return unsubscribe;
      }
    }
  }

  // ── Action side ─────────────────────────────────────────────

  /** Returns an action, or a string reason the pair is unsupported. */
  #compileAction(interaction: HonuaInteraction, target: ResolvedComponent): ((payload: unknown) => void) | string {
    const verb = interaction.do.verb;
    const declaredArgs = interaction.do.args;
    const observe = (args: Readonly<Record<string, unknown>>): void => {
      this.#onDispatch?.({
        interactionId: interaction.id,
        event: interaction.on.event,
        verb,
        ref: interaction.do.ref,
        args,
      });
    };

    switch (verb) {
      case "setFilter": {
        const setFilter = componentSetFilter(target);
        const filterId = target.kind === "map" ? "map" : target.id;
        return (payload) => {
          const args = resolveHonuaInteractionArgs(declaredArgs, payload);
          const clause = filterClauseFromArgs(args);
          if (setFilter) setFilter(clause);
          else if (clause) this.#view.setFilter(filterId, clause);
          else this.#view.clearFilter(filterId);
          observe(args);
        };
      }
      case "setViewport": {
        if (target.kind !== "map") return "`setViewport` targets `map`; no other component accepts it.";
        const component = target.component;
        return (payload) => {
          const args = resolveHonuaInteractionArgs(declaredArgs, payload);
          const viewport = viewportFromArgs(args);
          if (component.setViewport) component.setViewport(viewport);
          else this.#view.setExtent(extentFromBbox(viewport.bbox));
          observe(args);
        };
      }
      case "selectFeature": {
        if (target.kind === "control") return "`selectFeature` has no control-side primitive.";
        const fallbackSourceId = target.kind === "layer" ? (target.component.sourceId ?? target.id) : target.id;
        const selection = bindTableSelectionToExploration(this.#view);
        return (payload) => {
          const args = resolveHonuaInteractionArgs(declaredArgs, payload);
          const featureId = args.featureId ?? args.id;
          if (featureId === undefined || featureId === null) {
            selection.clearSelection();
            observe(args);
            return;
          }
          const sourceId = typeof args.sourceId === "string" ? args.sourceId : fallbackSourceId;
          const target_ = sourceFeatureSelectionTarget(sourceId, featureId as FeatureId);
          selection.select([target_], { replace: args.replace !== false });
          observe(args);
        };
      }
      case "runWidgetQuery": {
        if (target.kind !== "widget") return "`runWidgetQuery` targets `widget:{id}`; no other component accepts it.";
        const runQuery = target.component.runQuery;
        if (!runQuery) {
          return `Widget "${target.id}" declares no \`runQuery\`, and there is no exploration-level fallback for \`runWidgetQuery\`.`;
        }
        return (payload) => {
          const args = resolveHonuaInteractionArgs(declaredArgs, payload);
          runQuery(args);
          observe(args);
        };
      }
      case "setVisibility": {
        if (target.kind === "map") return "`setVisibility` targets a layer, widget, or control, never `map`.";
        const setVisibility = target.component.setVisibility;
        if (!setVisibility) {
          return `${target.kind === "layer" ? "Layer" : target.kind === "widget" ? "Widget" : "Control"} "${target.id}" declares no \`setVisibility\`.`;
        }
        return (payload) => {
          const args = resolveHonuaInteractionArgs(declaredArgs, payload);
          setVisibility(args.visible !== false);
          observe(args);
        };
      }
    }
  }
}

// ── Payload builders ──────────────────────────────────────────

function featureSelectPayload(
  sourceId: SourceId,
  targets: ReadonlyArray<SourceQualifiedFeatureSelectionTarget>,
): Readonly<Record<string, unknown>> {
  const first = targets[0];
  return {
    sourceId: first?.sourceId ?? sourceId,
    ...(first ? { featureId: first.id } : {}),
    ...(first?.sourceLayer ? { sourceLayer: first.sourceLayer } : {}),
    targets,
    count: targets.length,
  };
}

function featureHoverPayload(
  sourceId: SourceId,
  hovered: SourceQualifiedFeatureSelectionTarget | undefined,
): Readonly<Record<string, unknown>> {
  return {
    sourceId: hovered?.sourceId ?? sourceId,
    ...(hovered ? { featureId: hovered.id } : {}),
    ...(hovered?.sourceLayer ? { sourceLayer: hovered.sourceLayer } : {}),
    ...(hovered ? { target: hovered } : {}),
    hovering: hovered !== undefined,
  };
}

function selectionPayload(selection: ReadonlyArray<FeatureSelectionTarget>): Readonly<Record<string, unknown>> {
  const first = selection[0];
  const qualified = typeof first === "object" && first !== null ? first : undefined;
  return {
    targets: selection,
    count: selection.length,
    ...(qualified ? { sourceId: qualified.sourceId, featureId: qualified.id } : {}),
    ...(qualified === undefined && first !== undefined ? { featureId: first } : {}),
  };
}

function changePayload(
  id: string,
  clause: FilterClause | undefined,
  filters: Readonly<Record<string, FilterClause>>,
): Readonly<Record<string, unknown>> {
  return {
    id,
    ...(clause ? { field: clause.field, operator: clause.operator, value: clause.value, clause } : {}),
    filters,
  };
}

function viewportPayload(extent: HonuaExtent | undefined): Readonly<Record<string, unknown>> {
  return {
    ...(extent ? { bbox: [extent.xmin, extent.ymin, extent.xmax, extent.ymax], extent } : {}),
  };
}

// ── Argument projection ───────────────────────────────────────

function componentSetFilter(target: ResolvedComponent): ((clause: FilterClause | undefined) => void) | undefined {
  if (target.kind === "map") return undefined;
  const setFilter = target.component.setFilter;
  return setFilter ? (clause) => setFilter(clause) : undefined;
}

const FILTER_OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "not-in",
  "between",
  "like",
  "is-null",
  "is-not-null",
]);

function filterClauseFromArgs(args: Readonly<Record<string, unknown>>): FilterClause | undefined {
  const declared = args.clause;
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    const clause = declared as Record<string, unknown>;
    if (typeof clause.field === "string") {
      return {
        field: clause.field,
        operator: FILTER_OPERATORS.has(clause.operator as string) ? (clause.operator as FilterOperator) : "=",
        value: clause.value,
        ...(Array.isArray(clause.appliesTo) ? { appliesTo: clause.appliesTo as ReadonlyArray<SourceId> } : {}),
      };
    }
  }
  if (typeof args.field !== "string") return undefined;
  // A `$event.*` path that resolved to nothing clears the filter rather than
  // installing an `= undefined` clause nothing can translate.
  if (args.value === undefined && !isValuelessOperator(args.operator)) return undefined;
  return {
    field: args.field,
    operator: FILTER_OPERATORS.has(args.operator as string) ? (args.operator as FilterOperator) : "=",
    value: args.value,
    ...(Array.isArray(args.appliesTo) ? { appliesTo: args.appliesTo as ReadonlyArray<SourceId> } : {}),
  };
}

function isValuelessOperator(operator: unknown): boolean {
  return operator === "is-null" || operator === "is-not-null";
}

function viewportFromArgs(args: Readonly<Record<string, unknown>>): HonuaInteractionViewport {
  const bbox = numberTuple(args.bbox, 4) as readonly [number, number, number, number] | undefined;
  const center = numberTuple(args.center, 2) as readonly [number, number] | undefined;
  return {
    ...(bbox ? { bbox } : {}),
    ...(center ? { center } : {}),
    ...(typeof args.zoom === "number" ? { zoom: args.zoom } : {}),
    ...(typeof args.pitch === "number" ? { pitch: args.pitch } : {}),
    ...(typeof args.bearing === "number" ? { bearing: args.bearing } : {}),
  };
}

function numberTuple(value: unknown, length: number): ReadonlyArray<number> | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? (value as ReadonlyArray<number>)
    : undefined;
}

function extentFromBbox(bbox: readonly [number, number, number, number] | undefined): HonuaExtent | undefined {
  return bbox ? { xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3] } : undefined;
}

function pairLabel(interaction: HonuaInteraction): string {
  return `${interaction.on.event} -> ${interaction.do.verb}`;
}
