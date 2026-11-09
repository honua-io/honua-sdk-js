interface CsvCellOptions {
  readonly quoting?: "minimal" | "always";
  readonly formula?: "escape" | "preserve";
}

/** Encodes one CSV cell, neutralizing spreadsheet syntax in text by default. */
export function encodeCsvCell(value: string, options: CsvCellOptions = {}): string {
  const safe = options.formula !== "preserve" && /^[\t\r\n]|^\s*[=+\-@]/.test(value) ? `'${value}` : value;
  if (options.quoting !== "always" && !/[,"\r\n]/.test(safe)) return safe;
  return `"${safe.replaceAll('"', '""')}"`;
}
