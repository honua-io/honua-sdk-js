export const normalizeFuel = (value: unknown) =>
  String(value || "other")
    .toLowerCase()
    .replaceAll(" ", "");

/** Apply the same category normalization to grouped server rows and individual plants. */
export function mergeFuelCounts(rows: readonly Record<string, unknown>[], fuelField: string) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const fuel = normalizeFuel(row[fuelField]);
    const count = Number(row.plant_count);
    if (!Number.isInteger(count) || count < 0) throw new Error("Invalid server count");
    counts.set(fuel, (counts.get(fuel) ?? 0) + count);
  }
  return [...counts].map(([fuel, count]) => ({ fuel, count }));
}
