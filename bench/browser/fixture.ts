/**
 * Deterministic binary point fixtures shared by every deck.gl browser
 * benchmark page (10k baseline, 100k/1M scale tiers, lifecycle/leak, and
 * capability harnesses). Every value is derived from `index` alone — never
 * `Math.random()` — so the same `rows` count produces byte-identical typed
 * arrays across runs, browsers, and CI/local environments.
 */

export const DEFAULT_CENTER_LONGITUDE = -157.8583;
export const DEFAULT_CENTER_LATITUDE = 21.3069;
/** Row placed exactly at the map center so a fixed-radius pick always resolves it. */
export const DEFAULT_INTERACTION_TARGET_INDEX = 4_949;
export const DEFAULT_FEATURE_ID_BASE = 100_000;

export interface BinaryPointFixture {
  readonly positions: Float32Array;
  readonly radii: Float32Array;
  readonly colors: Uint8Array;
  readonly featureIds: Uint32Array;
}

export interface BuildBinaryPointFixtureOptions {
  readonly centerLongitude?: number;
  readonly centerLatitude?: number;
  readonly interactionTargetIndex?: number;
  readonly featureIdBase?: number;
}

/**
 * A grid of 100-wide rows fanned out from the map center, with one
 * distinguishable "interaction target" row placed exactly at the center for
 * picking. `rows` must be greater than `interactionTargetIndex` for the
 * target row to exist (every scale tier this repo defines satisfies that).
 */
export function buildBinaryPointFixture(
  rows: number,
  options: BuildBinaryPointFixtureOptions = {},
): BinaryPointFixture {
  const centerLongitude = options.centerLongitude ?? DEFAULT_CENTER_LONGITUDE;
  const centerLatitude = options.centerLatitude ?? DEFAULT_CENTER_LATITUDE;
  const interactionTargetIndex = options.interactionTargetIndex ?? DEFAULT_INTERACTION_TARGET_INDEX;
  const featureIdBase = options.featureIdBase ?? DEFAULT_FEATURE_ID_BASE;
  if (!Number.isSafeInteger(rows) || rows <= interactionTargetIndex) {
    throw new Error(`buildBinaryPointFixture requires rows > interactionTargetIndex (${interactionTargetIndex})`);
  }
  const positions = new Float32Array(rows * 2);
  const radii = new Float32Array(rows);
  const colors = new Uint8Array(rows * 4);
  const featureIds = new Uint32Array(rows);
  for (let index = 0; index < rows; index += 1) {
    const column = index % 100;
    const row = Math.floor(index / 100);
    const isInteractionTarget = index === interactionTargetIndex;
    positions[index * 2] = isInteractionTarget ? centerLongitude : centerLongitude + 0.05 + (column - 49.5) * 0.0005;
    positions[index * 2 + 1] = isInteractionTarget ? centerLatitude : centerLatitude + (row - 49.5) * 0.0005;
    radii[index] = isInteractionTarget ? 220 : 70;
    colors.set(isInteractionTarget ? [255, 218, 92, 255] : [52, 195, 181, 210], index * 4);
    featureIds[index] = featureIdBase + index;
  }
  return { positions, radii, colors, featureIds };
}

export function webGlRendererString(canvas: HTMLCanvasElement): string {
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!gl) return "unavailable";
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  if (!extension) return String(gl.getParameter(gl.RENDERER));
  return String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL));
}
