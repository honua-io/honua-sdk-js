/**
 * Human-first output helpers for the `honua` CLI: fixed-width tables, key/value
 * detail blocks, and a thin `--json` escape hatch for machine consumers.
 *
 * Nothing here knows about the SDK; callers shape data into rows/records and
 * pick a renderer. This keeps formatting unit-testable without a live server.
 *
 * @packageDocumentation
 */

export type Cell = string | number | boolean | null | undefined;

export interface TableColumn {
  /** Key into each row record. */
  key: string;
  /** Column header (defaults to `key`). */
  header?: string;
  /** Right-align numeric columns. */
  align?: "left" | "right";
}

export interface RenderTableOptions {
  /** Printed above the table; omitted when falsy. */
  title?: string;
  /** Shown instead of a header+body when there are no rows. */
  emptyText?: string;
}

function cellToString(value: Cell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function displayWidth(text: string): number {
  // Strip ANSI escapes if any slipped through; CLI output is plain otherwise.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences
  return text.replace(/\[[0-9;]*m/g, "").length;
}

function pad(text: string, width: number, align: "left" | "right"): string {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  const fill = " ".repeat(gap);
  return align === "right" ? fill + text : text + fill;
}

/**
 * Render an array of records as an aligned text table.
 *
 * Columns are inferred from `columns`; each row is looked up by `column.key`.
 */
export function renderTable(
  rows: ReadonlyArray<Record<string, Cell>>,
  columns: ReadonlyArray<TableColumn>,
  options: RenderTableOptions = {},
): string {
  const lines: string[] = [];
  if (options.title) lines.push(options.title);

  if (rows.length === 0) {
    lines.push(options.emptyText ?? "(no results)");
    return lines.join("\n");
  }

  const headers = columns.map((c) => c.header ?? c.key);
  const widths = columns.map((c, i) => {
    const header = headers[i];
    const longestCell = rows.reduce((max, row) => {
      const w = displayWidth(cellToString(row[c.key]));
      return w > max ? w : max;
    }, 0);
    return Math.max(displayWidth(header), longestCell);
  });

  const headerRow = columns
    .map((c, i) => pad(headers[i], widths[i], c.align ?? "left"))
    .join("  ")
    .replace(/\s+$/, "");
  const sepRow = widths.map((w) => "-".repeat(w)).join("  ");
  lines.push(headerRow);
  lines.push(sepRow);

  for (const row of rows) {
    const cells = columns.map((c, i) => pad(cellToString(row[c.key]), widths[i], c.align ?? "left"));
    lines.push(cells.join("  ").replace(/\s+$/, ""));
  }

  return lines.join("\n");
}

/** Render a flat key/value record as an aligned two-column block. */
export function renderDetail(record: Record<string, Cell>, options: { title?: string } = {}): string {
  const lines: string[] = [];
  if (options.title) lines.push(options.title);
  const keys = Object.keys(record);
  const keyWidth = keys.reduce((max, k) => Math.max(max, k.length), 0);
  for (const key of keys) {
    lines.push(`${pad(`${key}:`, keyWidth + 1, "left")}  ${cellToString(record[key])}`);
  }
  return lines.join("\n");
}

/** Serialize a value as pretty JSON for `--json` output. */
export function renderJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Write a line to stdout. Isolated so tests can stub it. */
export function printLine(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`${text}\n`);
}
