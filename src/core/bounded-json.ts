/** Internal structural guard for byte-bounded JSON received across trust boundaries. */

export type BoundedJsonStructureViolation = "max-depth" | "max-nodes" | "non-json";

export function boundedJsonStructureViolation(
  value: unknown,
  maxDepth: number,
  maxNodes: number,
): BoundedJsonStructureViolation | undefined {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > maxNodes) return "max-nodes";
    if (current.depth > maxDepth) return "max-depth";
    if (current.value === null || typeof current.value === "string" || typeof current.value === "boolean") continue;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return "non-json";
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const entry of current.value) pending.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    if (isPlainObject(current.value)) {
      for (const entry of Object.values(current.value)) pending.push({ value: entry, depth: current.depth + 1 });
      continue;
    }
    return "non-json";
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
