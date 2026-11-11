import type { AnalyticsNumericRectangle } from "./types.js";

function axisIsOrdered(range: { readonly min: number; readonly max: number } | null | undefined): boolean {
  return range != null && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max;
}

/** True when both axes are present, finite, and each minimum is at or below its maximum. */
export function rectangleAxesAreOrdered(rectangle: AnalyticsNumericRectangle | undefined): boolean {
  return [rectangle?.x, rectangle?.y].every((range) => axisIsOrdered(range));
}
