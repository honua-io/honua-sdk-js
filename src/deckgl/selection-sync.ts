/**
 * Shared selection state between deck.gl picking results and the Honua
 * exploration view — the same linked selection slice the MapLibre
 * feature-state bindings use (`src/interactions/exploration-bindings.ts`),
 * so an app can mix a MapLibre-driven basemap and a deck.gl overlay or
 * standalone renderer against one shared selection without deck.gl-specific
 * coupling in the exploration layer.
 *
 * @experimental
 * @module
 */

import { isSourceQualifiedSelectionTarget, sourceFeatureSelectionTarget } from "../exploration/selection.js";
import type {
  ExplorationViewController,
  FeatureSelectionTarget,
  SourceQualifiedFeatureSelectionTarget,
} from "../exploration/types.js";
import { HonuaDeckGlAdapterError } from "./types.js";
import type { DeckGlPickedSelection } from "./types.js";

export interface DeckGlSelectionExplorationBindingOptions {
  /** Replace the exploration selection with the picked feature. @default true */
  readonly replace?: boolean;
}

/**
 * Convert a `DeckGlProjection.selectionForPick(...)` result into a
 * source-qualified exploration selection target. `bigint` feature ids (for
 * example from a 64-bit id column) are stringified, since `FeatureId` is
 * `number | string`.
 */
export function deckGlPickedSelectionTarget(pick: DeckGlPickedSelection): SourceQualifiedFeatureSelectionTarget {
  return sourceFeatureSelectionTarget(
    pick.sourceId,
    typeof pick.featureId === "bigint" ? pick.featureId.toString() : pick.featureId,
  );
}

/**
 * Bind deck.gl picking results to the shared exploration selection slice.
 * Call the returned handler from a deck.gl `onClick`/`onHover` callback with
 * `projection.selectionForPick(info.index)` when `info.index >= 0`, or with
 * `undefined` when nothing is under the pointer (deck.gl's `info.index ===
 * -1`) to clear the selection.
 */
export function bindDeckGlPickToExploration(
  view: ExplorationViewController,
  options: DeckGlSelectionExplorationBindingOptions = {},
): (pick: DeckGlPickedSelection | undefined) => void {
  if (
    typeof view !== "object" ||
    view === null ||
    typeof view.select !== "function" ||
    typeof view.deselect !== "function"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "bindDeckGlPickToExploration requires an ExplorationViewController.",
    );
  }
  const { replace = true } = options;
  return (pick: DeckGlPickedSelection | undefined): void => {
    if (pick === undefined) {
      if (replace) view.deselect();
      return;
    }
    view.select([deckGlPickedSelectionTarget(pick)], { replace });
  };
}

/**
 * Read the exploration selection state's feature ids for one source, so an
 * app can derive a GPU "selected" highlight attribute (a boolean/byte mask
 * keyed by row) matching a rendered batch's `featureIds`, without any
 * deck.gl-specific coupling in the exploration layer.
 */
export function selectedFeatureIdSet(
  selection: ReadonlyArray<FeatureSelectionTarget>,
  sourceId: string,
): ReadonlySet<string | number> {
  const ids = new Set<string | number>();
  for (const target of selection) {
    if (isSourceQualifiedSelectionTarget(target) && target.sourceId === sourceId) ids.add(target.id);
  }
  return ids;
}
