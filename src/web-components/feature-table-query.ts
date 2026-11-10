import type { FeatureId, SortSpec } from "../contract/types.js";
import { isSourceQualifiedSelectionTarget } from "../exploration/selection.js";
import type { FeatureSelectionTarget } from "../exploration/types.js";
import type { HonuaFeatureTableRowKey } from "./feature-table-engine.js";

/** Build the engine's row key. Shares the realtime key space (`sourceId:id`). */
export function featureTableRowKey(sourceId: string, id: FeatureId): HonuaFeatureTableRowKey {
  return `${sourceId}:${String(id)}`;
}

type ColumnList = readonly { readonly field: string; readonly visible: boolean }[];

export function tableProjection(
  columns: ColumnList,
  identityField: string | undefined,
  maxFields: number,
): readonly string[] | undefined {
  const fields = columns
    .filter((column) => column.visible)
    .slice(0, maxFields)
    .map((column) => column.field);
  if (fields.length === 0) return undefined;
  return identityField && !fields.includes(identityField) ? [...fields, identityField] : fields;
}

export function tableQueryOrder(sort: readonly SortSpec[], identityField: string | undefined): readonly SortSpec[] {
  if (!identityField || sort.some((entry) => entry.field === identityField)) return sort;
  return [...sort, { field: identityField, direction: "asc" }];
}

export function tableOrderedFields(columns: ColumnList, maxFields: number): readonly string[] {
  const visible = columns
    .filter((column) => column.visible)
    .slice(0, maxFields)
    .map((column) => column.field);
  return visible.length > 0 ? visible : columns.slice(0, maxFields).map((column) => column.field);
}

export function featureTableKeyForTarget(
  sourceId: string,
  target: FeatureSelectionTarget,
): HonuaFeatureTableRowKey | undefined {
  if (!isSourceQualifiedSelectionTarget(target)) return featureTableRowKey(sourceId, target);
  if (target.sourceId !== sourceId) return undefined;
  return featureTableRowKey(sourceId, target.id);
}
