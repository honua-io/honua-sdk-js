/** @internal Delete only enumerable properties whose value is undefined. */
export function removeUndefined<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key in record) if (record[key] === undefined) delete record[key];
  return value;
}
