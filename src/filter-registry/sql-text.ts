const FIELD_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** A SQL identifier, or `undefined` when the name is not safe to interpolate. */
export function sqlIdentifier(field: string): string | undefined {
  return FIELD_IDENTIFIER.test(field) ? field : undefined;
}

/** Quote a scalar the way filter clauses and bounded locate predicates do. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}
