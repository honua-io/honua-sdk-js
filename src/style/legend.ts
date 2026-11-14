import type { RendererLegendItem } from "./renderers.js";
import type { HonuaLayerSpecification } from "./specification.js";

export interface StyleLegendLayer {
  readonly layerId: string;
  readonly label: string;
  /** Full symbol definition, including opacity, filters, sprites and expressions. */
  readonly layer: HonuaLayerSpecification;
  readonly items: readonly RendererLegendItem[];
  /** Complex symbols require an application renderer; never replaced by a guessed color. */
  readonly unresolvedReason?: string;
}

export interface StyleLegendOptions {
  /** Caller-selected visible layer IDs. Hidden style layers are always omitted. */
  readonly layerIds?: readonly string[];
  readonly zoom?: number;
}

/** Derive color classes from a style file without a server legend request. */
export function legendFromStyle(
  style: { readonly layers: readonly HonuaLayerSpecification[] },
  options: StyleLegendOptions = {},
): readonly StyleLegendLayer[] {
  if (options.zoom !== undefined && !Number.isFinite(options.zoom)) {
    throw new RangeError("Legend zoom must be finite.");
  }
  return style.layers
    .filter((layer) => isVisible(layer, options))
    .map((layer) => {
      const color = layer.paint?.[`${layer.type}-color`];
      const items = colorItems(color);
      return {
        layerId: layer.id,
        label: typeof layer.metadata?.title === "string" ? layer.metadata.title : layer.id,
        layer: structuredClone(layer),
        items: items ?? [],
        ...(items
          ? {}
          : {
              unresolvedReason:
                "No static, match or step color legend; render the layer symbol or supply a custom legend.",
            }),
      };
    });
}

function isVisible(layer: HonuaLayerSpecification, options: StyleLegendOptions): boolean {
  if (layer.layout?.visibility === "none") return false;
  if (options.layerIds && !options.layerIds.includes(layer.id)) return false;
  const zoom = options.zoom;
  return zoom === undefined || (zoom >= (layer.minzoom ?? 0) && zoom < (layer.maxzoom ?? Number.POSITIVE_INFINITY));
}

function colorItems(color: unknown): RendererLegendItem[] | undefined {
  if (typeof color === "string") return [{ kind: "default", label: "All features", color }];
  if (!Array.isArray(color)) return undefined;
  if (color[0] === "match") return matchItems(color);
  if (color[0] === "step") return stepItems(color);
  return undefined;
}

function matchItems(expression: unknown[]): RendererLegendItem[] | undefined {
  if (expression.length < 5 || expression.length % 2 !== 1) return undefined;
  const items: RendererLegendItem[] = [];
  for (let index = 2; index < expression.length - 1; index += 2) {
    const values = Array.isArray(expression[index]) ? (expression[index] as unknown[]) : [expression[index]];
    const color = expression[index + 1];
    if (typeof color !== "string" || !values.every((value) => typeof value === "string" || typeof value === "number"))
      return undefined;
    for (const value of values as (string | number)[]) {
      items.push({ kind: "unique-value", label: String(value), color, value });
    }
  }
  const fallback = expression.at(-1);
  if (typeof fallback !== "string") return undefined;
  return [...items, { kind: "default", label: "Other", color: fallback }];
}

function stepItems(expression: unknown[]): RendererLegendItem[] | undefined {
  if (expression.length < 5 || expression.length % 2 !== 1) return undefined;
  const colors = [expression[2]];
  const thresholds: number[] = [];
  for (let index = 3; index < expression.length; index += 2) {
    const threshold = expression[index];
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) return undefined;
    if (thresholds.length && threshold <= thresholds[thresholds.length - 1]) return undefined;
    thresholds.push(threshold);
    colors.push(expression[index + 1]);
  }
  if (!colors.every((color) => typeof color === "string")) return undefined;
  return (colors as string[]).map((color, index) => {
    const minValue = thresholds[index - 1];
    const maxValue = thresholds[index];
    return {
      kind: "class-break",
      label:
        minValue === undefined
          ? `< ${maxValue}`
          : maxValue === undefined
            ? `≥ ${minValue}`
            : `${minValue} ≤ value < ${maxValue}`,
      color,
      ...(minValue === undefined ? {} : { minValue }),
      ...(maxValue === undefined ? {} : { maxValue }),
    };
  });
}
