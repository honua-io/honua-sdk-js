import { eq, get, interpolate, linear, rgba, switchCase, toNumber, typeOf } from "@honua/sdk-js/expr";
import type { ExpressionSpecification } from "maplibre-gl";

// Speed colorInfo from flight item 1b496d1b79fd4344ab548a1f2399c5fa.
// Captured with the chart metadata; see README for the source hash.
export const FLIGHT_SPEED_STOPS = [
  [20, [160, 0, 0]],
  [60, [223, 123, 123]],
  [100, [218, 230, 149]],
  [140, [71, 176, 223]],
  [180, [0, 143, 191]],
] as const;

export function flightSpeedColor(speedField: string): ExpressionSpecification {
  const speed = get(speedField);
  return switchCase(
    [
      eq(typeOf(speed), "number"),
      interpolate(
        linear(),
        toNumber(speed),
        ...FLIGHT_SPEED_STOPS.map(([stop, [r, g, b]]): [number, ReturnType<typeof rgba>] => [
          stop,
          rgba(r, g, b, 79 / 255),
        ]),
      ),
    ],
    rgba(170, 170, 170, 1),
  ).toJSON() as ExpressionSpecification;
}
