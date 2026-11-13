import type { Query } from "../contract/types.js";

function filterFieldNames(node: unknown, names: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const child of node) filterFieldNames(child, names);
  else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (record.kind === "property" && typeof record.name === "string") names.add(record.name);
    for (const value of Object.values(record)) filterFieldNames(value, names);
  }
  return names;
}

/** Every field a query names: outputs, filters, sort keys, groups, metrics and the temporal field. */
export function referencedFields(query: Query<unknown>): Set<string> {
  const names = filterFieldNames(query.filter, new Set(query.outFields ?? []));
  for (const sort of query.orderBy ?? []) names.add(sort.field);
  for (const field of query.aggregation?.groupBy ?? []) names.add(field);
  for (const metric of query.aggregation?.metrics ?? []) if (metric.field !== "*") names.add(metric.field);
  if (query.temporalFilter?.field) names.add(query.temporalFilter.field);
  return names;
}
