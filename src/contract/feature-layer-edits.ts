import type { ApplyEditsRequest, HonuaFeature } from "../core/types.js";
import type { CanonicalFeature, EditEnvelope, FeatureId } from "./types.js";

type FeatureLayerEdits = Pick<
  ApplyEditsRequest,
  "adds" | "updates" | "deletes" | "useGlobalIds" | "rollbackOnFailure" | "signal"
>;

/** Translate a canonical edit envelope into feature-layer applyEdits buckets. */
export function toApplyEditsRequest<T>(envelope: EditEnvelope<T>, objectIdField?: string): FeatureLayerEdits {
  const out: FeatureLayerEdits = editBuckets(envelope, objectIdField);
  if (envelope.rollbackOnFailure !== undefined) out.rollbackOnFailure = envelope.rollbackOnFailure;
  if (envelope.signal) out.signal = envelope.signal;
  return out;
}

function editBuckets<T>(envelope: EditEnvelope<T>, objectIdField: string | undefined): FeatureLayerEdits {
  const globalMode = envelope.useGlobalIds === true;
  const out: FeatureLayerEdits = globalMode ? { useGlobalIds: true } : {};
  if (envelope.adds && envelope.adds.length > 0) {
    out.adds = envelope.adds.map((feature) => canonicalToHonuaFeature(feature, objectIdField));
  }
  if (envelope.updates && envelope.updates.length > 0) {
    // With useGlobalIds the update's row identity is its global ID; never copy
    // `id` into the object-ID attribute there.
    out.updates = envelope.updates.map((feature) =>
      canonicalToHonuaFeature(globalMode ? { ...feature, id: undefined } : feature, objectIdField),
    );
  }
  if (envelope.deletes && envelope.deletes.length > 0) {
    out.deletes = globalMode ? envelope.deletes.map(String) : canonicalDeleteIds(envelope.deletes);
  }
  return out;
}

function canonicalDeleteIds(ids: readonly FeatureId[]): number[] | string {
  const numericIds: number[] = [];
  let allNumeric = true;
  for (const id of ids) {
    if (typeof id === "number" && !Number.isSafeInteger(id)) {
      throw new Error("Delete object IDs must be safe integers or exact decimal strings.");
    }
    const parsed = Number(id);
    if (Number.isSafeInteger(parsed)) {
      numericIds.push(parsed);
    } else {
      allNumeric = false;
    }
  }
  return allNumeric ? numericIds : ids.map(String).join(",");
}

function canonicalToHonuaFeature<T>(feature: CanonicalFeature<T>, objectIdField = "OBJECTID"): HonuaFeature {
  const attributes = { ...(feature.attributes as Record<string, unknown>) };
  if (feature.id !== undefined && feature.id !== null && attributes[objectIdField] === undefined) {
    attributes[objectIdField] = feature.id;
  }
  // The transport places the global ID: gRPC sends Feature.global_id; REST refuses it.
  const out: HonuaFeature = { attributes, ...(feature.globalId === undefined ? {} : { globalId: feature.globalId }) };
  if (feature.geometry !== undefined) {
    out.geometry = feature.geometry;
  }
  return out;
}
