/**
 * Two-way sync between analytics presentations and shared exploration state.
 *
 * The binding is the only place that knows how an analytics interaction maps
 * onto the shared `filters` / `selection` slices, so a click on a bar, a brush
 * on a histogram, and a brush on a time axis all reach the map and the table
 * through the same reducer the MapLibre and table bindings already use.
 *
 * Every commit is invertible. `apply()` captures the *previous values of only
 * the slices it touches* and returns an `undo()` that restores them — not a
 * whole-state snapshot restore, so a concurrent change published by a peer
 * view survives an undo of a chart interaction.
 *
 * @experimental
 * @module
 */

import { featureSelectionKey } from "../exploration/selection.js";
import type {
  ExplorationViewController,
  FeatureSelectionTarget,
  FilterClause,
  FilterOperator,
} from "../exploration/types.js";
import { analyticsMarkByKey, temporalWindowForMarks } from "./artifact.js";
import { EMPTY_ANALYTICS_LINKED_STATE, HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsArtifact,
  AnalyticsFilterClauseIds,
  AnalyticsFilterContribution,
  AnalyticsInteraction,
  AnalyticsLinkBindingOptions,
  AnalyticsLinkCommit,
  AnalyticsLinkedState,
  AnalyticsLinkedStateBinding,
  AnalyticsNumericRange,
  AnalyticsTemporalWindow,
} from "./types.js";

/** Derive the default clause ids for one artifact lineage. */
export function analyticsClauseIds(
  prefix: string,
  overrides?: Partial<AnalyticsFilterClauseIds>,
): AnalyticsFilterClauseIds {
  return {
    marks: overrides?.marks ?? `analytics:${prefix}:marks`,
    range: overrides?.range ?? `analytics:${prefix}:range`,
    temporal: overrides?.temporal ?? `analytics:${prefix}:temporal`,
  };
}

/**
 * Build the filter clause that expresses a set of selected marks.
 *
 * Returns `undefined` when the selection cannot be expressed as a filter — an
 * empty selection, an aggregate artifact (no dimension), or a selection that
 * only contains producer-supplied overflow buckets. The caller clears the
 * clause instead of writing a clause that would silently match everything.
 */
export function analyticsMarkFilterClause(
  artifact: AnalyticsArtifact,
  markKeys: readonly string[],
): FilterClause | undefined {
  if (markKeys.length === 0 || artifact.kind === "aggregate") return undefined;

  if (artifact.kind === "category") {
    const selected = artifact.marks.filter((mark) => markKeys.includes(mark.key) && mark.overflow !== true);
    if (selected.length === 0) return undefined;
    const values = selected.filter((mark) => mark.filterValue !== null).map((mark) => mark.filterValue);
    if (values.length === 0) {
      return { field: artifact.dimension, operator: "is-null", appliesTo: [artifact.identity.sourceId] };
    }
    // A mixed null + value selection cannot be expressed as one
    // protocol-neutral clause. The value clause is authoritative and the null
    // bucket is dropped, rather than silently widening the filter to
    // `is-null OR in (...)` in only the protocols that could express it.
    const operator: FilterOperator = values.length === 1 ? "=" : "in";
    return {
      field: artifact.dimension,
      operator,
      value: operator === "=" ? values[0] : values,
      appliesTo: [artifact.identity.sourceId],
    };
  }

  if (artifact.kind === "histogram") {
    const selected = artifact.marks.filter((mark) => markKeys.includes(mark.key));
    if (selected.length === 0) return undefined;
    const min = Math.min(...selected.map((mark) => mark.min));
    const max = Math.max(...selected.map((mark) => mark.max));
    return {
      field: artifact.dimension,
      operator: "between",
      value: [min, max],
      appliesTo: [artifact.identity.sourceId],
    };
  }

  const window = temporalWindowForMarks(artifact, markKeys);
  if (!window) return undefined;
  return {
    field: artifact.dimension,
    operator: "between",
    value: [window.start, window.end],
    appliesTo: [artifact.identity.sourceId],
  };
}

/** Build the clause for a brushed numeric range. */
export function analyticsRangeFilterClause(
  artifact: AnalyticsArtifact,
  range: AnalyticsNumericRange,
): FilterClause | undefined {
  if (artifact.kind === "aggregate") return undefined;
  return {
    field: artifact.dimension,
    operator: "between",
    value: [range.min, range.max],
    appliesTo: [artifact.identity.sourceId],
  };
}

/** Build the clause for a brushed temporal window. */
export function analyticsTemporalFilterClause(
  artifact: AnalyticsArtifact,
  window: AnalyticsTemporalWindow,
): FilterClause | undefined {
  if (artifact.kind !== "time-series") return undefined;
  return {
    field: artifact.dimension,
    operator: "between",
    value: [window.start, window.end],
    appliesTo: [artifact.identity.sourceId],
  };
}

/**
 * Project the shared exploration state back into the linked state a
 * presentation renders. Selected mark keys are recovered from the clause the
 * binding itself wrote, so a peer view that clears the clause visibly clears
 * the chart's highlight.
 */
export function selectAnalyticsLinkedState(
  artifact: AnalyticsArtifact,
  filters: Readonly<Record<string, FilterClause>>,
  clauseIds: AnalyticsFilterClauseIds,
  hoveredMarkKey?: string,
): AnalyticsLinkedState {
  // A time-series artifact expresses both clicks and brushes as a temporal
  // window, so its highlighted marks are derived from the temporal clause.
  const markClause = filters[artifact.kind === "time-series" ? clauseIds.temporal : clauseIds.marks];
  const rangeClause = filters[clauseIds.range];
  const temporalClause = filters[clauseIds.temporal];

  return {
    selectedMarkKeys: markClause ? marksMatchingClause(artifact, markClause) : [],
    ...(hoveredMarkKey ? { hoveredMarkKey } : {}),
    ...(rangeClause ? { range: rangeFromClause(rangeClause) } : {}),
    ...(temporalClause ? { temporalWindow: windowFromClause(temporalClause) } : {}),
  };
}

function rangeFromClause(clause: FilterClause): AnalyticsNumericRange | undefined {
  const value = clause.value;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [min, max] = value;
  if (typeof min !== "number" || typeof max !== "number") return undefined;
  return { min, max };
}

function windowFromClause(clause: FilterClause): AnalyticsTemporalWindow | undefined {
  const value = clause.value;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (typeof start !== "string" || typeof end !== "string") return undefined;
  return { start, end };
}

function marksMatchingClause(artifact: AnalyticsArtifact, clause: FilterClause): readonly string[] {
  if (artifact.kind === "aggregate") return [];
  if (clause.field !== artifact.dimension) return [];

  if (artifact.kind === "category") {
    if (clause.operator === "is-null") {
      return artifact.marks.filter((mark) => mark.filterValue === null).map((mark) => mark.key);
    }
    const wanted = clause.operator === "in" && Array.isArray(clause.value) ? clause.value : [clause.value];
    return artifact.marks.filter((mark) => wanted.includes(mark.filterValue)).map((mark) => mark.key);
  }

  if (artifact.kind === "histogram") {
    const range = rangeFromClause(clause);
    if (!range) return [];
    return artifact.marks.filter((mark) => mark.min >= range.min && mark.max <= range.max).map((mark) => mark.key);
  }

  const window = windowFromClause(clause);
  if (!window) return [];
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  return artifact.marks
    .filter((mark) => Date.parse(mark.start) >= start && Date.parse(mark.end) <= end)
    .map((mark) => mark.key);
}

/**
 * Bind an artifact's presentations to a shared exploration view.
 *
 * The returned binding is data-only: it holds the artifact by reference, never
 * copies marks, and owns no chart instance. Pass the same binding to every
 * presentation of one artifact so the default table, a category chart, and a
 * third-party time-series chart contribute to one clause set.
 */
export function bindAnalyticsToExploration(
  view: ExplorationViewController,
  artifact: AnalyticsArtifact,
  options: AnalyticsLinkBindingOptions = {},
): AnalyticsLinkedStateBinding {
  if (typeof view?.setFilter !== "function" || typeof view?.select !== "function") {
    throw new HonuaAnalyticsError(
      "artifact-invalid",
      "bindAnalyticsToExploration requires an ExplorationViewController.",
    );
  }

  const clauseIds = analyticsClauseIds(options.clausePrefix ?? artifact.identity.artifactId, options.clauseIds);
  const { publishSelection = true, replaceSelection = true, publishTemporalFilter = true } = options;

  let hoveredMarkKey: string | undefined;
  let disposed = false;
  const listeners = new Set<(state: AnalyticsLinkedState) => void>();

  function currentState(): AnalyticsLinkedState {
    return selectAnalyticsLinkedState(artifact, view.state.filters, clauseIds, hoveredMarkKey);
  }

  function notify(): void {
    const state = currentState();
    for (const listener of [...listeners]) listener(state);
  }

  const unsubscribe = view.subscribe(["filters", "selection"], () => {
    if (!disposed) notify();
  });

  /**
   * Write one clause and return the inverse operation. Capturing the previous
   * clause by value is what makes undo deterministic.
   */
  function writeClause(id: string, clause: FilterClause | undefined): () => void {
    const previous = view.state.filters[id];
    if (clause) view.setFilter(id, clause);
    else view.clearFilter(id);
    return () => {
      if (previous) view.setFilter(id, previous);
      else view.clearFilter(id);
    };
  }

  function writeSelection(targets: readonly FeatureSelectionTarget[] | undefined): () => void {
    const previous = [...view.state.selection];
    if (targets && targets.length > 0) view.select(targets, { replace: replaceSelection });
    else view.deselect();
    return () => {
      if (previous.length > 0) view.select(previous, { replace: true });
      else view.deselect();
    };
  }

  function commit(
    interaction: AnalyticsInteraction,
    inverses: ReadonlyArray<() => void>,
    touchedClauseIds: readonly string[],
    touchedSelection: boolean,
  ): AnalyticsLinkCommit {
    const linkedState = currentState();
    let undone = false;
    return {
      interaction,
      changed: inverses.length > 0,
      touchedClauseIds,
      touchedSelection,
      linkedState,
      undo(): void {
        if (undone) return;
        undone = true;
        // Reverse order so a selection restore cannot be re-clobbered by a
        // clause restore that also publishes selection.
        for (const inverse of [...inverses].reverse()) inverse();
        notify();
      },
    };
  }

  function targetsForMarks(markKeys: readonly string[]): readonly FeatureSelectionTarget[] {
    const targets: FeatureSelectionTarget[] = [];
    const seen = new Set<string>();
    for (const key of markKeys) {
      const mark = analyticsMarkByKey(artifact, key);
      for (const target of mark?.targets ?? []) {
        const dedupeKey = featureSelectionKey(target);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        targets.push(target);
      }
    }
    return targets;
  }

  function applyMarkSelect(interaction: Extract<AnalyticsInteraction, { kind: "mark-select" }>): AnalyticsLinkCommit {
    const replace = interaction.replace ?? true;
    const previousKeys = currentState().selectedMarkKeys;
    const nextKeys = replace ? interaction.markKeys : toggleKeys(previousKeys, interaction.markKeys);

    const inverses: Array<() => void> = [];
    const touched: string[] = [];

    // A time-series mark selection is a temporal window, so it is published on
    // the temporal clause rather than the generic mark clause. That keeps one
    // temporal contract for clicks and brushes.
    const clauseId = artifact.kind === "time-series" ? clauseIds.temporal : clauseIds.marks;
    inverses.push(writeClause(clauseId, analyticsMarkFilterClause(artifact, nextKeys)));
    touched.push(clauseId);

    let touchedSelection = false;
    if (publishSelection) {
      const targets = targetsForMarks(nextKeys);
      if (targets.length > 0 || (previousKeys.length > 0 && nextKeys.length === 0)) {
        inverses.push(writeSelection(targets));
        touchedSelection = true;
      }
    }
    return commit(interaction, inverses, touched, touchedSelection);
  }

  return {
    clauseIds,
    get linkedState(): AnalyticsLinkedState {
      return disposed ? EMPTY_ANALYTICS_LINKED_STATE : currentState();
    },
    apply(interaction: AnalyticsInteraction): AnalyticsLinkCommit {
      if (disposed) {
        throw new HonuaAnalyticsError("disposed", "This analytics link binding has been disposed.", {
          artifactId: artifact.identity.artifactId,
        });
      }

      switch (interaction.kind) {
        case "mark-select":
          return applyMarkSelect(interaction);

        case "range-brush": {
          const inverse = writeClause(clauseIds.range, analyticsRangeFilterClause(artifact, interaction.range));
          return commit(interaction, [inverse], [clauseIds.range], false);
        }

        case "temporal-brush": {
          if (!publishTemporalFilter) return commit(interaction, [], [], false);
          const inverse = writeClause(clauseIds.temporal, analyticsTemporalFilterClause(artifact, interaction.window));
          return commit(interaction, [inverse], [clauseIds.temporal], false);
        }

        case "hover": {
          // Hover is ephemeral cross-highlight state: it is shared with peer
          // presentations through this binding but never written into the
          // exploration reducer, so it cannot pollute a shareable snapshot.
          const previous = hoveredMarkKey;
          hoveredMarkKey = interaction.markKey;
          notify();
          const linkedState = currentState();
          let undone = false;
          return {
            interaction,
            changed: previous !== hoveredMarkKey,
            touchedClauseIds: [],
            touchedSelection: false,
            linkedState,
            undo(): void {
              if (undone) return;
              undone = true;
              hoveredMarkKey = previous;
              notify();
            },
          };
        }

        default: {
          const channel = interaction.channel;
          const inverses: Array<() => void> = [];
          const touched: string[] = [];
          if (!channel || channel === "marks") {
            inverses.push(writeClause(clauseIds.marks, undefined));
            touched.push(clauseIds.marks);
          }
          if (!channel || channel === "range") {
            inverses.push(writeClause(clauseIds.range, undefined));
            touched.push(clauseIds.range);
          }
          if (!channel || channel === "temporal") {
            inverses.push(writeClause(clauseIds.temporal, undefined));
            touched.push(clauseIds.temporal);
          }
          let touchedSelection = false;
          if ((!channel || channel === "marks") && publishSelection && view.state.selection.length > 0) {
            inverses.push(writeSelection(undefined));
            touchedSelection = true;
          }
          if (!channel || channel === "hover") {
            const previousHover = hoveredMarkKey;
            hoveredMarkKey = undefined;
            inverses.push(() => {
              hoveredMarkKey = previousHover;
            });
          }
          return commit(interaction, inverses, touched, touchedSelection);
        }
      }
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      unsubscribe();
    },
  };
}

function toggleKeys(current: readonly string[], toggled: readonly string[]): readonly string[] {
  const next = new Set(current);
  for (const key of toggled) {
    if (next.has(key)) next.delete(key);
    else next.add(key);
  }
  return [...next];
}

/**
 * Project the clauses a binding would write for a linked state, without
 * touching a controller. Useful for server-side rendering, snapshot tests, and
 * hosts that own their own state container.
 */
export function analyticsFilterContributions(
  artifact: AnalyticsArtifact,
  state: AnalyticsLinkedState,
  clauseIds: AnalyticsFilterClauseIds,
): readonly AnalyticsFilterContribution[] {
  const contributions: AnalyticsFilterContribution[] = [];
  const markClause = analyticsMarkFilterClause(artifact, state.selectedMarkKeys);
  if (markClause) {
    contributions.push({
      id: artifact.kind === "time-series" ? clauseIds.temporal : clauseIds.marks,
      clause: markClause,
    });
  }
  if (state.range) {
    const clause = analyticsRangeFilterClause(artifact, state.range);
    if (clause) contributions.push({ id: clauseIds.range, clause });
  }
  if (state.temporalWindow) {
    const clause = analyticsTemporalFilterClause(artifact, state.temporalWindow);
    if (clause) contributions.push({ id: clauseIds.temporal, clause });
  }
  return contributions;
}
