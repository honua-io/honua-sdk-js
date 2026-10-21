import type { HonuaStyleSpecification } from "../style/specification.js";
import { HonuaMapPackageError } from "./errors.js";
import type { HonuaStyleRefBody, HonuaStyleRefLayerBinding, HonuaStyleRefLayerOverride } from "./map-package.js";

const normalProperties = ["paint", "layout", "filter", "minzoom", "maxzoom", "metadata"] as const;
const allowedProperties = new Set<string>([...normalProperties, "visibility"]);
const crossTypeProperties = new Set<string>(["filter", "minzoom", "maxzoom", "visibility"]);

function invalid(message: string): never {
  throw new HonuaMapPackageError(message, { stage: "style-compose" });
}

/** Validate untrusted portable bindings before resolving or applying a shared style. */
export function readStyleLayerBindings(value: unknown): readonly HonuaStyleRefLayerBinding[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 256)
    invalid("Style layer bindings must contain between 1 and 256 mappings.");
  const targets = new Set<string>();
  for (const binding of value) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) invalid("Invalid style layer binding.");
    for (const key of ["styleLayerId", "targetLayerId", "layerType"] as const) {
      if (typeof binding[key] !== "string" || !binding[key].trim() || binding[key].length > 256)
        invalid(`Style layer binding requires a bounded ${key}.`);
    }
    if (targets.has(binding.targetLayerId))
      invalid("A style reference cannot map multiple overrides to one target layer.");
    targets.add(binding.targetLayerId);
    if (binding.properties !== undefined) {
      if (
        !Array.isArray(binding.properties) ||
        binding.properties.length === 0 ||
        binding.properties.length > allowedProperties.size ||
        new Set(binding.properties).size !== binding.properties.length ||
        binding.properties.some((property: unknown) => typeof property !== "string" || !allowedProperties.has(property))
      )
        invalid("Invalid shared style binding properties.");
    }
  }
  return value as HonuaStyleRefLayerBinding[];
}

/** Refuse stale map targets instead of silently dropping a shared style override. */
export function validateStyleBindingTargets(
  bindings: readonly HonuaStyleRefLayerBinding[],
  style: HonuaStyleSpecification,
): void {
  if (!style || !Array.isArray(style.layers)) invalid("A shared style binding requires a map render-layer list.");
  for (const binding of bindings) {
    const targets = style.layers.filter((layer) => layer && layer.id === binding.targetLayerId);
    if (targets.length !== 1) invalid(`Shared style target "${binding.targetLayerId}" is missing or ambiguous.`);
    if (
      targets[0].type !== binding.layerType &&
      (binding.properties ?? normalProperties).some((property) => !crossTypeProperties.has(property))
    )
      invalid(`Shared style target "${binding.targetLayerId}" has an incompatible render type.`);
  }
}

/** A custom resolver must also return exactly the explicitly bound target set. */
export function validateBoundStyleBody(bindings: readonly HonuaStyleRefLayerBinding[], body: HonuaStyleRefBody): void {
  const targets = new Set(bindings.map((binding) => binding.targetLayerId));
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== targets.size ||
    Object.keys(body).some((id) => !targets.has(id)) ||
    [...targets].some(
      (id) => !Object.hasOwn(body, id) || !body[id] || typeof body[id] !== "object" || Array.isArray(body[id]),
    )
  )
    invalid("Shared style resolution did not return the selected map layers.");
}

/** Select appearance properties without carrying source identity or ownership metadata. */
export function selectBoundStyleOverride(
  override: HonuaStyleRefLayerOverride,
  binding: HonuaStyleRefLayerBinding,
): HonuaStyleRefLayerOverride {
  const selected: HonuaStyleRefLayerOverride = {};
  for (const property of binding.properties ?? normalProperties) {
    if (property === "visibility") {
      if (override.layout?.visibility !== undefined)
        selected.layout = { ...selected.layout, visibility: override.layout.visibility };
    } else if (property === "metadata") {
      if (override.metadata !== undefined)
        selected.metadata = Object.fromEntries(
          Object.entries(override.metadata).filter(
            ([key]) => key !== "honua:compositionLayerId" && key !== "honua:compositionSourceId",
          ),
        );
    } else if (override[property] !== undefined) {
      Object.defineProperty(selected, property, {
        value: structuredClone(override[property]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return selected;
}
