/**
 * `@honua/sdk-js/style` — Honua style spec source parsers and validators.
 *
 * Translate `Source`/`SourceDescriptor` shapes to and from MapLibre-style
 * source specifications, and validate Honua style documents.
 *
 * @example
 * ```ts
 * import { createSources, validateHonuaStyle, parseOgcFeaturesUrl } from "@honua/sdk-js/style";
 *
 * const sources = createSources(dataset.sourceDescriptors);
 * const errors = validateHonuaStyle(myStyle);
 * if (errors.length) throw new Error(errors.map(e => e.message).join("\n"));
 *
 * const parsed = parseOgcFeaturesUrl("https://example.com/ogc/collections/parcels/items");
 * console.log(parsed.collectionId); // "parcels"
 * ```
 *
 * @packageDocumentation
 */
export {
  isHonuaSource,
  isFeatureServiceSource,
  isMapServiceSource,
  isOgcFeaturesSource,
  isWmsSource,
  isWmtsSource,
  parseOgcFeaturesUrl,
  validateHonuaStyle,
} from "./specification.js";
export type {
  HonuaSourceBase,
  HonuaFeatureServiceSourceSpecification,
  HonuaMapServiceSourceSpecification,
  HonuaOgcFeaturesSourceSpecification,
  HonuaWmsSourceSpecification,
  HonuaWmtsSourceSpecification,
  HonuaSourceSpecification,
  HonuaLayerSpecification,
  HonuaStyleSpecification,
  ParsedOgcFeaturesUrl,
  StyleValidationError,
} from "./specification.js";
export { createSources } from "./factory.js";
export type { ResolvedSource } from "./factory.js";
// Feature Service and Map Service URL parsers are exported from
// esri-compat/url.ts via the main index.ts barrel — no re-export needed here.
