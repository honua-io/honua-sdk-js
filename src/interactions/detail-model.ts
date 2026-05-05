/**
 * Framework-neutral popup/detail data preparation helpers.
 *
 * These helpers consume selection targets and query results from the existing
 * exploration surfaces. They do not own interaction state.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import {
  featureSelectionKey,
  isSourceQualifiedSelectionTarget,
  sourceFeatureSelectionTarget,
} from "../exploration/selection.js";
import type { FeatureSelectionTarget } from "../exploration/types.js";

export interface DetailFeatureLike {
  readonly id?: FeatureId;
  readonly sourceId?: SourceId;
  readonly sourceLayer?: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
}

export interface DetailFieldDefinition {
  readonly name: string;
  readonly label?: string;
  readonly visible?: boolean;
  readonly formatter?: (value: unknown, feature: DetailFeatureLike) => unknown;
}

export interface DetailModelOptions {
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly features?: ReadonlyArray<DetailFeatureLike>;
  readonly sourceId?: SourceId;
  readonly sourceLayer?: string;
  readonly objectIdField?: string;
  readonly titleField?: string;
  readonly fields?: ReadonlyArray<DetailFieldDefinition | string>;
  readonly includeHiddenFields?: boolean;
}

export type DetailSelectionStatus = "empty" | "ready" | "stale";

export interface DetailFieldModel {
  readonly name: string;
  readonly label: string;
  readonly value: unknown;
}

export interface DetailModel {
  readonly status: DetailSelectionStatus;
  readonly target?: FeatureSelectionTarget;
  readonly feature?: DetailFeatureLike;
  readonly title?: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly fields: ReadonlyArray<DetailFieldModel>;
  readonly geometry?: unknown;
}

/** Build one detail model per selected target. */
export function prepareSelectionDetailModels(options: DetailModelOptions): DetailModel[] {
  const selection = options.selection;
  if (selection.length === 0) return [emptyDetailModel()];

  const features = options.features ?? [];
  const bySelectionKey = new Map<string, DetailFeatureLike>();
  for (const feature of features) {
    const target = featureToSelectionTarget(feature, options);
    if (target) bySelectionKey.set(featureSelectionKey(target), feature);
  }

  return selection.map((target) => {
    const feature = bySelectionKey.get(featureSelectionKey(target));
    if (!feature) return staleDetailModel(target);
    return readyDetailModel(target, feature, options);
  });
}

/** Build the primary popup/detail model for the first selected target. */
export function preparePrimaryDetailModel(options: DetailModelOptions): DetailModel {
  return prepareSelectionDetailModels(options)[0] ?? emptyDetailModel();
}

function readyDetailModel(
  target: FeatureSelectionTarget,
  feature: DetailFeatureLike,
  options: DetailModelOptions,
): DetailModel {
  const attributes = featureAttributes(feature);
  return {
    status: "ready",
    target,
    feature,
    title: detailTitle(attributes, options.titleField, target),
    attributes,
    fields: detailFields(feature, attributes, options),
    geometry: feature.geometry,
  };
}

function emptyDetailModel(): DetailModel {
  return {
    status: "empty",
    attributes: {},
    fields: [],
  };
}

function staleDetailModel(target: FeatureSelectionTarget): DetailModel {
  return {
    status: "stale",
    target,
    attributes: {},
    fields: [],
  };
}

function featureToSelectionTarget(
  feature: DetailFeatureLike,
  options: Pick<DetailModelOptions, "objectIdField" | "sourceId" | "sourceLayer">,
): FeatureSelectionTarget | undefined {
  const id = featureId(feature, options.objectIdField);
  if (id === undefined) return undefined;
  const sourceId = feature.sourceId ?? options.sourceId;
  if (!sourceId) return id;
  return sourceFeatureSelectionTarget(sourceId, id, { sourceLayer: feature.sourceLayer ?? options.sourceLayer });
}

function featureId(feature: DetailFeatureLike, objectIdField: string | undefined): FeatureId | undefined {
  if (feature.id !== undefined) return feature.id;
  const attributes = featureAttributes(feature);
  const value =
    (objectIdField ? attributes[objectIdField] : undefined) ??
    attributes.OBJECTID ??
    attributes.objectid ??
    attributes.ObjectID ??
    attributes.id;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function featureAttributes(feature: DetailFeatureLike): Readonly<Record<string, unknown>> {
  return feature.attributes ?? feature.properties ?? {};
}

function detailTitle(
  attributes: Readonly<Record<string, unknown>>,
  titleField: string | undefined,
  target: FeatureSelectionTarget,
): string {
  const title = titleField ? attributes[titleField] : undefined;
  if (title !== undefined && title !== null && String(title).length > 0) return String(title);
  if (isSourceQualifiedSelectionTarget(target)) return `${target.sourceId} ${String(target.id)}`;
  return String(target);
}

function detailFields(
  feature: DetailFeatureLike,
  attributes: Readonly<Record<string, unknown>>,
  options: DetailModelOptions,
): DetailFieldModel[] {
  const definitions = options.fields ?? Object.keys(attributes);
  const out: DetailFieldModel[] = [];
  for (const definition of definitions) {
    const field = typeof definition === "string" ? { name: definition } : definition;
    if (field.visible === false && !options.includeHiddenFields) continue;
    out.push({
      name: field.name,
      label: field.label ?? field.name,
      value: field.formatter ? field.formatter(attributes[field.name], feature) : attributes[field.name],
    });
  }
  return out;
}
