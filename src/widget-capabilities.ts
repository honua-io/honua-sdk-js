/**
 * Pure helpers behind sketch snapping, histogram bins, form expressions,
 * multi-feature edits, and elevation samples.
 */

export interface SnapPoint {
  x: number;
  y: number;
}

export function snapVertex(pointer: SnapPoint, vertices: readonly SnapPoint[], enabled: boolean, tolerance = 1): SnapPoint {
  if (!enabled || vertices.length === 0) return { ...pointer };
  let nearest = vertices[0];
  let nearestDistance = distance(pointer, nearest);
  for (const vertex of vertices.slice(1)) {
    const candidate = distance(pointer, vertex);
    if (candidate < nearestDistance) {
      nearest = vertex;
      nearestDistance = candidate;
    }
  }
  return nearestDistance <= tolerance ? { x: nearest.x, y: nearest.y } : { ...pointer };
}

function distance(a: SnapPoint, b: SnapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface HistogramStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  average: number;
}

export interface HistogramBin {
  label: string;
  min: number;
  max: number;
  value: number;
}

export function histogramBins(
  values: readonly number[],
  stats: HistogramStats,
  classes: number,
  method: "equal-interval" | "quantile",
): HistogramBin[] {
  if (classes < 1) throw new Error("histogram classes must be at least 1");
  assertStats(values, stats);
  const breaks = method === "quantile" ? quantileEdges(values, classes) : equalIntervalEdges(stats.min, stats.max, classes);
  const bins: HistogramBin[] = [];
  for (let index = 0; index < breaks.length - 1; index += 1) {
    const min = breaks[index] ?? stats.min;
    const max = breaks[index + 1] ?? stats.max;
    const last = index === breaks.length - 2;
    const value = values.filter((item) => (last ? item >= min && item <= max : item >= min && item < max)).length;
    bins.push({ label: `${min}–${max}`, min, max, value });
  }
  return bins;
}

export function histogramRangeFilter(min: number, max: number): string {
  return `value >= ${min} AND value <= ${max}`;
}

function assertStats(values: readonly number[], stats: HistogramStats): void {
  const count = values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  const min = values.length === 0 ? Number.NaN : Math.min(...values);
  const max = values.length === 0 ? Number.NaN : Math.max(...values);
  const average = count === 0 ? Number.NaN : sum / count;
  if (stats.count !== count || stats.sum !== sum || stats.min !== min || stats.max !== max || stats.average !== average) {
    throw new Error("histogram statistics do not match the feature values");
  }
}

function equalIntervalEdges(min: number, max: number, classes: number): number[] {
  const width = classes === 0 ? 0 : (max - min) / classes;
  return Array.from({ length: classes + 1 }, (_, index) => min + width * index);
}

function quantileEdges(values: readonly number[], classes: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return [0, 0];
  const edges = [sorted[0] ?? 0];
  for (let index = 1; index < classes; index += 1) {
    const position = (index * (sorted.length - 1)) / classes;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    const weight = position - lower;
    const left = sorted[lower] ?? sorted[0] ?? 0;
    const right = sorted[upper] ?? left;
    edges.push(left + (right - left) * weight);
  }
  edges.push(sorted[sorted.length - 1] ?? edges[0] ?? 0);
  return edges;
}

export interface FormExpressionField {
  name: string;
  visibleExpression?: string;
  valueExpression?: string;
}

export interface FormExpressionResult {
  hidden: string[];
  values: Record<string, unknown>;
  errors: { field: string; message: string }[];
}

export function evaluateFormExpressions(
  fields: readonly FormExpressionField[],
  feature: { attributes?: Record<string, unknown> },
): FormExpressionResult {
  const hidden: string[] = [];
  const values: Record<string, unknown> = {};
  const errors: { field: string; message: string }[] = [];
  for (const field of fields) {
    if (field.visibleExpression) {
      const visible = evaluateExpression(field.visibleExpression, feature.attributes ?? {}, field.name, errors);
      if (visible === false) hidden.push(field.name);
    }
    if (field.valueExpression) {
      const value = evaluateExpression(field.valueExpression, feature.attributes ?? {}, field.name, errors);
      if (value !== undefined && !errors.some((error) => error.field === field.name && error.message.includes(field.valueExpression ?? ""))) {
        values[field.name] = value;
      }
    }
  }
  return { hidden, values, errors };
}

function evaluateExpression(
  expression: string,
  attributes: Record<string, unknown>,
  field: string,
  errors: { field: string; message: string }[],
): unknown {
  const call = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)\(/);
  if (call && call[1] !== "Number") {
    errors.push({ field, message: `unknown function ${call[1]} in ${expression}` });
    return undefined;
  }
  const equality = expression.match(/^\$feature\.([A-Za-z0-9_]+)\s*==\s*'([^']*)'$/);
  if (equality) return attributes[equality[1] ?? ""] === equality[2];
  const sum = expression.match(/^\$feature\.([A-Za-z0-9_]+)\s*\+\s*\$feature\.([A-Za-z0-9_]+)$/);
  if (sum) return Number(attributes[sum[1] ?? ""]) + Number(attributes[sum[2] ?? ""]);
  const reference = expression.match(/^\$feature\.([A-Za-z0-9_]+)$/);
  if (reference) return attributes[reference[1] ?? ""];
  errors.push({ field, message: `unsupported expression ${expression}` });
  return undefined;
}

export interface FeatureEdit {
  attributes?: Record<string, unknown>;
}

export interface ApplyEditsResult {
  error?: string;
  reason?: string;
}

export async function applyToFeatures(
  features: readonly FeatureEdit[],
  change: Record<string, unknown>,
  applyEdits: (edit: { update: FeatureEdit }) => Promise<ApplyEditsResult>,
): Promise<{ applied: FeatureEdit[]; rejected: { feature: FeatureEdit; reason: string }[] }> {
  const applied: FeatureEdit[] = [];
  const rejected: { feature: FeatureEdit; reason: string }[] = [];
  for (const feature of features) {
    const update = { attributes: { ...(feature.attributes ?? {}), ...change } };
    const result = await applyEdits({ update });
    if (result.error || result.reason) rejected.push({ feature, reason: result.reason ?? result.error ?? "rejected" });
    else applied.push(update);
  }
  return { applied, rejected };
}

export interface ElevationSample {
  position: [number, number];
  elevation: number;
}

export function sampleElevations(
  line: readonly [number, number][],
  terrain: { elevationAt: (longitude: number, latitude: number) => number } | undefined,
  spacing = 1,
): { samples: ElevationSample[]; error?: string } {
  if (!terrain) return { samples: [], error: "terrain-missing" };
  const densified = densify(line, spacing);
  return {
    samples: densified.map((position) => ({
      position,
      elevation: terrain.elevationAt(position[0], position[1]),
    })),
  };
}

function densify(line: readonly [number, number][], spacing: number): [number, number][] {
  if (line.length === 0) return [];
  const points: [number, number][] = [line[0] as [number, number]];
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1] as [number, number];
    const end = line[index] as [number, number];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const steps = Math.max(1, Math.ceil(length / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      points.push([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
    }
  }
  return points;
}
