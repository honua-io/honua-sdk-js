/**
 * Bridges the esri-compat renderer shims to the first-class renderer objects
 * in `@honua/sdk-js/style` (issue #497 REQ-002). The compat classes stay
 * pure state holders; these helpers project their state through the same
 * WebMap symbol/renderer conversion path the WebMap converter uses, so the
 * SDK has exactly one class-breaks/unique-value implementation.
 *
 * Kept out of the compat classes themselves so consumers who never emit
 * renderer objects do not pay for the conversion pipeline.
 *
 * @module
 */

import type { ClassBreaksRenderer, UniqueValueRenderer } from "../style/renderers.js";
import { classBreaksRendererFromWebMap, uniqueValueRendererFromWebMap } from "../webmap/convert-renderer.js";
import type { WebMapSymbol } from "../webmap/types.js";
import type { WarningCollector } from "../webmap/warnings.js";
import { createWarningCollector } from "../webmap/warnings.js";
import type { ClassBreaksRendererCompat } from "./class-breaks-renderer.js";
import type { UniqueValueRendererCompat } from "./unique-value-renderer.js";

/** Result of projecting a compat renderer to a renderer object. @experimental */
export interface CompatRendererProjection<R> {
  /** The emitted renderer object, or `undefined` when nothing was convertible. */
  readonly renderer: R | undefined;
  /** Symbol/renderer conversion warnings collected during projection. */
  readonly warnings: WarningCollector["warnings"];
}

/**
 * Emit a first-class {@link ClassBreaksRenderer} from a
 * `ClassBreaksRendererCompat` shim. Compat `minValue`/`maxValue` map to the
 * WebMap `classMinValue`/`classMaxValue` fields and symbols convert through
 * the shared WebMap symbol pipeline.
 *
 * @experimental
 */
export function rendererObjectFromClassBreaksCompat(
  compat: ClassBreaksRendererCompat,
): CompatRendererProjection<ClassBreaksRenderer> {
  const warn = createWarningCollector();
  const renderer = classBreaksRendererFromWebMap(
    {
      type: "classBreaks",
      field: compat.field,
      minValue: compat.minValue,
      defaultSymbol: compat.defaultSymbol as WebMapSymbol | undefined,
      defaultLabel: compat.defaultLabel,
      classBreakInfos: compat.classBreakInfos.map((info) => ({
        classMinValue: info.minValue,
        classMaxValue: info.maxValue,
        label: info.label,
        symbol: info.symbol as WebMapSymbol | undefined,
      })),
    },
    warn,
  );
  return { renderer, warnings: warn.warnings };
}

/**
 * Emit a first-class {@link UniqueValueRenderer} from a
 * `UniqueValueRendererCompat` shim.
 *
 * @experimental
 */
export function rendererObjectFromUniqueValueCompat(
  compat: UniqueValueRendererCompat,
): CompatRendererProjection<UniqueValueRenderer> {
  const warn = createWarningCollector();
  const renderer = uniqueValueRendererFromWebMap(
    {
      type: "uniqueValue",
      field1: compat.field,
      field2: compat.field2,
      field3: compat.field3,
      defaultSymbol: compat.defaultSymbol as WebMapSymbol | undefined,
      defaultLabel: compat.defaultLabel,
      uniqueValueInfos: compat.uniqueValueInfos.map((info) => ({
        value: info.value as string,
        label: info.label,
        symbol: info.symbol as WebMapSymbol | undefined,
      })),
    },
    warn,
  );
  return { renderer, warnings: warn.warnings };
}
