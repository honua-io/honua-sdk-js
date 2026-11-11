import type { AnalyticsNumericRectangle } from "./types.js";

/** True when both axes are finite and each minimum is at or below its maximum. */
export function rectangleAxesAreOrdered(rectangle: AnalyticsNumericRectangle | undefined): boolean {
  return [rectangle?.x, rectangle?.y].every(
    (range) =>
      range !== undefined && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max,
  );
}
