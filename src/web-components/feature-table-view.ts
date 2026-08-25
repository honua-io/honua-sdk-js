/**
 * Pure presentation layer for `<honua-feature-table>` (issue #681).
 *
 * Everything here is a string/value function over a
 * {@link HonuaFeatureTableViewModel}, so the WAI-ARIA grid contract and the
 * keyboard mapping are testable without mounting a custom element, and
 * `./elements.ts` keeps only wiring.
 *
 * The markup implements the WAI-ARIA `grid` pattern needed for the WCAG 2.2 AA
 * workflow (NFR-001): a single roving `tabindex`, `role="row"`/`role="gridcell"`
 * with 1-based `aria-rowindex`/`aria-colindex` so a virtualized window still
 * announces absolute positions, `aria-sort` per column header, `aria-rowcount`
 * of `-1` when the total is genuinely unknown, and a polite live region that
 * announces result truth and reconciliation conflicts.
 *
 * @module
 */

import type { SortSpec } from "../contract/types.js";
import {
  type HonuaFeatureTableConflict,
  type HonuaFeatureTableCount,
  type HonuaFeatureTableFocus,
  type HonuaFeatureTableFocusMove,
  type HonuaFeatureTableQueryEvidence,
  type HonuaFeatureTableResolvedColumn,
  type HonuaFeatureTableRow,
  type HonuaFeatureTableSnapshot,
  type HonuaFeatureTableState,
  type HonuaFeatureTableWindow,
  describeFeatureTableCount,
  featureTableAriaRowCount,
  featureTableAriaSort,
  formatFeatureTableCell,
} from "./feature-table-engine.js";
import type { HonuaComponentStatus, HonuaFeatureTableModel } from "./types.js";

/** One rendered row. `placeholder` rows sit inside the window but are not resident. */
export interface HonuaFeatureTableViewRow {
  readonly key: string;
  readonly sourceId: string;
  readonly featureId: string;
  /** 1-based absolute grid row index (header is row 1). */
  readonly ariaRowIndex: number;
  readonly selected: boolean;
  readonly cells: readonly string[];
  readonly placeholder: boolean;
}

/** One visible diagnostic describing where accepted query-plan work ran. */
export interface HonuaFeatureTableWorkBadge {
  readonly tier: "server" | "worker" | "client";
  readonly label: string;
  readonly detail: string;
}

export interface HonuaFeatureTableColumnControl {
  readonly field: string;
  readonly label: string;
  readonly visible: boolean;
}

/** Everything the renderer needs. Derived from an engine snapshot. */
export interface HonuaFeatureTableViewModel {
  readonly label: string;
  readonly state: HonuaFeatureTableState;
  readonly columns: readonly HonuaFeatureTableResolvedColumn[];
  readonly totalColumnCount: number;
  readonly columnWindow: HonuaFeatureTableWindow;
  readonly columnWidth: number;
  readonly columnControls: readonly HonuaFeatureTableColumnControl[];
  readonly rows: readonly HonuaFeatureTableViewRow[];
  readonly window: HonuaFeatureTableWindow;
  readonly ariaRowCount: number;
  readonly countLabel: string;
  readonly statusLabel: string;
  readonly sort: readonly SortSpec[];
  readonly focus?: HonuaFeatureTableFocus;
  readonly conflicts: readonly HonuaFeatureTableConflict[];
  /** Compact server/worker/client diagnostics projected from accepted-plan evidence. */
  readonly workBadges: readonly HonuaFeatureTableWorkBadge[];
  /** Row height in CSS pixels; drives the virtualization spacers. */
  readonly rowHeight: number;
  readonly busy: boolean;
  /**
   * The user unchecked every column. Distinct from a merely empty horizontal
   * window: the grid renders an explicit no-column state instead of a column
   * the controls report as hidden.
   */
  readonly columnsHidden: boolean;
  /** Announced in place of the grid when {@link columnsHidden} is set. */
  readonly columnsHiddenLabel?: string;
}

const EMPTY_RESOLVED_COLUMNS: readonly HonuaFeatureTableResolvedColumn[] = Object.freeze([]);

/** Caller-supplied labels and announcements for `<honua-feature-table>`. */
export interface HonuaFeatureTableMessages {
  readonly label?: string;
  readonly count?: (count: HonuaFeatureTableCount) => string;
  readonly status?: Partial<Readonly<Record<HonuaFeatureTableState, string>>>;
  readonly state?: (state: HonuaFeatureTableState, count: HonuaFeatureTableCount, message?: string) => string;
  /** Shown in place of the grid when every column has been hidden. */
  readonly columnsHidden?: string;
}

const COLUMNS_HIDDEN_LABEL = "No visible columns — choose at least one column to show.";

/** Human/screen-reader summary of the table's lifecycle state. */
export function describeFeatureTableState(
  state: HonuaFeatureTableState,
  count: HonuaFeatureTableCount,
  message: string | undefined,
  messages?: HonuaFeatureTableMessages,
): string {
  if (messages?.state) return messages.state(state, count, message);
  const countLabel = messages?.count?.(count) ?? describeFeatureTableCount(count);
  const statusLabel = messages?.status?.[state];
  if (statusLabel !== undefined) return statusLabel;
  switch (state) {
    case "idle":
      return "Not loaded";
    case "loading":
      return "Loading rows";
    case "ready":
      return countLabel;
    case "partial":
      return `Partial results — ${countLabel}`;
    case "stale":
      return `Stale results — ${message ?? countLabel}`;
    case "cancelled":
      return message ?? "The request was cancelled";
    case "unsupported":
      return message ?? "This table configuration is not supported by the source";
    default:
      return message ?? "The table query failed";
  }
}

/** Project an engine snapshot onto the renderer's view model. */
export function featureTableViewModel<T>(
  snapshot: HonuaFeatureTableSnapshot<T>,
  options: {
    readonly label?: string;
    readonly rowHeight?: number;
    readonly columnWidth?: number;
    readonly messages?: HonuaFeatureTableMessages;
  } = {},
): HonuaFeatureTableViewModel {
  // An empty `renderedColumns` has two unrelated causes. A horizontal window
  // that landed outside the visible set is a virtualization artifact, and
  // falling back to the first declared column keeps the grid readable. Every
  // column unchecked is a deliberate choice, and rendering column 0 anyway
  // contradicted the checkbox that reported it hidden -- the values stayed on
  // screen while `totalColumnCount` said zero. That case gets a real
  // no-column state instead.
  const columnsHidden = snapshot.columns.length > 0 && snapshot.visibleColumns.length === 0;
  const columns = columnsHidden
    ? EMPTY_RESOLVED_COLUMNS
    : snapshot.renderedColumns.length > 0
      ? snapshot.renderedColumns
      : snapshot.columns.slice(0, 1);
  const rows: HonuaFeatureTableViewRow[] = snapshot.rows.map((row, offset) =>
    row ? viewRow(row, columns, snapshot.selection) : placeholderRow(snapshot.window.startIndex + offset, columns),
  );
  return Object.freeze({
    label: options.label ?? options.messages?.label ?? "Features",
    state: snapshot.state,
    columns,
    totalColumnCount: snapshot.visibleColumns.length,
    columnWindow: snapshot.columnWindow,
    columnWidth: options.columnWidth ?? 160,
    columnControls: Object.freeze(
      snapshot.columns
        .slice(0, snapshot.budgets.maxFields)
        .map((column) => ({ field: column.field, label: column.label, visible: column.visible })),
    ),
    rows: Object.freeze(rows),
    window: snapshot.window,
    ariaRowCount: featureTableAriaRowCount(snapshot.count),
    countLabel: options.messages?.count?.(snapshot.count) ?? describeFeatureTableCount(snapshot.count),
    statusLabel: describeFeatureTableState(snapshot.state, snapshot.count, snapshot.message, options.messages),
    sort: snapshot.sort,
    ...(snapshot.focus ? { focus: snapshot.focus } : {}),
    conflicts: snapshot.conflicts,
    workBadges: featureTableWorkBadges(snapshot.evidence),
    rowHeight: options.rowHeight ?? 32,
    busy: snapshot.state === "loading",
    columnsHidden,
    ...(columnsHidden ? { columnsHiddenLabel: options.messages?.columnsHidden ?? COLUMNS_HIDDEN_LABEL } : {}),
  });
}

/**
 * Project the legacy single-page {@link HonuaFeatureTableModel} onto the same
 * view model, so a `<honua-feature-table>` with no bounded engine attached
 * still renders the full accessible grid. Result truth is derived
 * conservatively: a model that exceeded its transfer limit reports `partial`
 * with no total, never the returned row count dressed up as one.
 */
export function legacyFeatureTableViewModel<T>(
  model: HonuaFeatureTableModel<T>,
  options: {
    readonly label?: string;
    readonly rowHeight?: number;
    readonly selectedFeatureId?: string;
    readonly messages?: HonuaFeatureTableMessages;
  } = {},
): HonuaFeatureTableViewModel {
  const columns = resolveLegacyColumns(model.fields);
  const partial = model.exceededTransferLimit === true;
  const count: HonuaFeatureTableCount = partial
    ? { kind: "partial", loaded: model.rows.length, evidence: "loaded-rows" }
    : { kind: "known", value: model.totalCount, loaded: model.rows.length, evidence: "result-total-count" };
  const state: HonuaFeatureTableState = legacyState(model.status, partial);
  const rows = model.rows.map((row, index) =>
    Object.freeze({
      key: `${row.sourceId}:${String(row.id)}`,
      sourceId: row.sourceId,
      featureId: String(row.id),
      ariaRowIndex: index + 2,
      selected: options.selectedFeatureId !== undefined && options.selectedFeatureId === String(row.id),
      cells: Object.freeze(
        columns.map((column) => formatFeatureTableCell((row.attributes as Record<string, unknown>)[column.field])),
      ),
      placeholder: false,
    }),
  );
  return Object.freeze({
    label: options.label ?? options.messages?.label ?? "Features",
    state,
    columns,
    totalColumnCount: columns.length,
    columnWindow: Object.freeze({ startIndex: 0, endIndex: columns.length }),
    columnWidth: 160,
    columnControls: Object.freeze([]),
    rows: Object.freeze(rows),
    window: Object.freeze({ startIndex: 0, endIndex: rows.length }),
    ariaRowCount: featureTableAriaRowCount(count),
    countLabel: options.messages?.count?.(count) ?? describeFeatureTableCount(count),
    statusLabel: describeFeatureTableState(state, count, undefined, options.messages),
    sort: Object.freeze([]),
    conflicts: Object.freeze([]),
    workBadges: Object.freeze([]),
    rowHeight: options.rowHeight ?? 32,
    busy: model.status === "loading",
    // The legacy single-page model has no column controls, so there is no way
    // to hide every column from it.
    columnsHidden: false,
  });
}

/**
 * Collapse accepted-plan work into compact, accessible execution diagnostics.
 * The labels never infer pushdown: a tier appears only when the engine's
 * evidence names work that actually ran there.
 */
export function featureTableWorkBadges(
  evidence: HonuaFeatureTableQueryEvidence,
): readonly HonuaFeatureTableWorkBadge[] {
  const badges: HonuaFeatureTableWorkBadge[] = [];
  for (const tier of ["server", "worker", "client"] as const) {
    // Remote execution is a user-facing claim, so expose it only when an
    // accepted plan identifies itself. Without a plan the query still runs,
    // but the grid has no evidence to distinguish server pushdown from an
    // adapter fallback and must not guess.
    if (tier === "server" && evidence.planId === undefined) continue;
    const work = evidence.work.filter((item) => item.tier === tier);
    if (work.length === 0) continue;
    badges.push(
      Object.freeze({
        tier,
        label: `${tier[0]?.toUpperCase()}${tier.slice(1)} · ${work.length}`,
        detail: work.map((item) => `${item.concern}: ${item.detail}`).join("; "),
      }),
    );
  }
  return Object.freeze(badges);
}

function legacyState(status: HonuaComponentStatus, partial: boolean): HonuaFeatureTableState {
  if (status === "error") return "error";
  if (status === "unsupported") return "unsupported";
  if (status === "loading") return "loading";
  if (status === "idle") return "idle";
  return partial ? "partial" : "ready";
}

function resolveLegacyColumns(fields: readonly string[]): readonly HonuaFeatureTableResolvedColumn[] {
  return Object.freeze(
    fields.map((field) =>
      Object.freeze({ field, label: field, type: "unknown" as const, visible: true, sortable: false }),
    ),
  );
}

function viewRow<T>(
  row: HonuaFeatureTableRow<T>,
  columns: readonly HonuaFeatureTableResolvedColumn[],
  selection: readonly string[],
): HonuaFeatureTableViewRow {
  const attributes = row.attributes as Record<string, unknown>;
  return Object.freeze({
    key: row.key,
    sourceId: row.sourceId,
    featureId: String(row.id),
    ariaRowIndex: row.index + 2,
    selected: selection.includes(row.key),
    cells: Object.freeze(columns.map((column) => formatFeatureTableCell(attributes[column.field], column))),
    placeholder: false,
  });
}

function placeholderRow(index: number, columns: readonly HonuaFeatureTableResolvedColumn[]): HonuaFeatureTableViewRow {
  return Object.freeze({
    key: `placeholder:${index}`,
    sourceId: "",
    featureId: "",
    ariaRowIndex: index + 2,
    selected: false,
    cells: Object.freeze(columns.map(() => "")),
    placeholder: true,
  });
}

/**
 * Map a `KeyboardEvent.key` (plus modifiers) onto a grid navigation move.
 * Returns `undefined` for keys the grid must not swallow.
 */
export function featureTableFocusMoveForKey(
  key: string,
  modifiers: { readonly ctrl?: boolean; readonly meta?: boolean } = {},
): HonuaFeatureTableFocusMove | undefined {
  const jump = Boolean(modifiers.ctrl ?? modifiers.meta);
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Home":
      return jump ? "grid-start" : "row-start";
    case "End":
      return jump ? "grid-end" : "row-end";
    case "PageUp":
      return "page-up";
    case "PageDown":
      return "page-down";
    default:
      return undefined;
  }
}

/**
 * Render the accessible, virtualized grid.
 *
 * The window is positioned with two spacer rows sized in `rowHeight`
 * increments, so only the resident window exists in the DOM while the scroll
 * height still reflects the known total (REQ-002).
 */
export function featureTableGridHtml(model: HonuaFeatureTableViewModel): string {
  const columnCount = Math.max(1, model.totalColumnCount);
  const leadingColumns = model.columnWindow.startIndex * model.columnWidth;
  const trailingColumns = Math.max(0, model.totalColumnCount - model.columnWindow.endIndex) * model.columnWidth;
  const leading = model.window.startIndex * model.rowHeight;
  const knownRows = model.ariaRowCount > 0 ? model.ariaRowCount - 1 : model.window.endIndex;
  const trailing = Math.max(0, (knownRows - model.window.endIndex) * model.rowHeight);
  const focusedRow = model.focus?.rowKey;
  const focusedField = model.focus?.field;
  const hasFocus = model.rows.some((row) => row.key === focusedRow);

  return `
    <style>
      [data-leading] { height: ${leading}px; }
      [data-trailing] { height: ${trailing}px; }
      [data-column-leading] { min-width: ${leadingColumns}px; width: ${leadingColumns}px; }
      [data-column-trailing] { min-width: ${trailingColumns}px; width: ${trailingColumns}px; }
      [data-grid] { --honua-ft-column-width: ${model.columnWidth}px; }
    </style>
    <section class="table-panel" part="panel">
      <div class="table-panel__bar">
        <h2 id="honua-ft-label">${escapeHtml(model.label)}</h2>
        <span class="count" data-count>${escapeHtml(model.countLabel)}</span>
      </div>
      ${
        model.workBadges.length > 0
          ? `<ul class="work-badges" aria-label="Query execution" data-work-badges>${model.workBadges
              .map(
                (badge) =>
                  `<li data-work-tier="${badge.tier}" aria-label="${escapeAttribute(`${badge.label}: ${badge.detail}`)}" title="${escapeAttribute(badge.detail)}">${escapeHtml(badge.label)}</li>`,
              )
              .join("")}</ul>`
          : ""
      }
      ${
        model.columnControls.length > 0
          ? `<details class="column-controls" data-column-controls>
        <summary>Columns</summary>
        <fieldset>
          <legend class="visually-hidden">Visible columns</legend>
          ${model.columnControls
            .map(
              (column) =>
                `<label><input type="checkbox" data-column-field="${escapeAttribute(column.field)}" ${column.visible ? "checked" : ""}> ${escapeHtml(column.label)}</label>`,
            )
            .join("")}
        </fieldset>
      </details>`
          : ""
      }
      <p class="status" data-status role="status" aria-live="polite">${escapeHtml(statusText(model))}</p>
      <div class="table-wrap" data-scroller>
        <div class="spacer" data-leading></div>
        <table
          role="grid"
          aria-labelledby="honua-ft-label"
          aria-rowcount="${model.ariaRowCount}"
          aria-colcount="${columnCount}"
          aria-busy="${String(model.busy)}"
          data-grid
        >
          <thead>
            <tr role="row" aria-rowindex="1">
              ${leadingColumns > 0 && !model.columnsHidden ? '<th role="presentation" aria-hidden="true" data-column-leading></th>' : ""}
              ${
                model.columnsHidden
                  ? `<th role="columnheader" scope="col" aria-colindex="1" data-columns-hidden>${escapeHtml(
                      columnsHiddenText(model),
                    )}</th>`
                  : ""
              }
              ${model.columns
                .map(
                  (column, index) => `
              <th
                role="columnheader"
                scope="col"
                aria-colindex="${model.columnWindow.startIndex + index + 1}"
                aria-sort="${featureTableAriaSort(column.field, model.sort)}"
                data-field="${escapeAttribute(column.field)}"
              >
                ${
                  column.sortable
                    ? `<button type="button" data-sort-field="${escapeAttribute(column.field)}">${escapeHtml(
                        column.label,
                      )}</button>`
                    : escapeHtml(column.label)
                }
              </th>`,
                )
                .join("")}
              ${trailingColumns > 0 && !model.columnsHidden ? '<th role="presentation" aria-hidden="true" data-column-trailing></th>' : ""}
            </tr>
          </thead>
          <tbody>
            ${
              // Rows without columns have no cells to render, so a hidden-all
              // grid states why it is empty rather than emitting cell-less rows.
              model.columnsHidden
                ? `<tr role="row"><td role="gridcell" colspan="${columnCount}" class="empty">${escapeHtml(
                    columnsHiddenText(model),
                  )}</td></tr>`
                : model.rows.length === 0
                  ? `<tr role="row"><td role="gridcell" colspan="${columnCount}" class="empty">${escapeHtml(
                      model.statusLabel,
                    )}</td></tr>`
                  : model.rows
                      .map((row, rowOffset) => bodyRowHtml(row, rowOffset, model, focusedRow, focusedField, hasFocus))
                      .join("")
            }
          </tbody>
        </table>
        <div class="spacer" data-trailing></div>
      </div>
    </section>
  `;
}

function bodyRowHtml(
  row: HonuaFeatureTableViewRow,
  rowOffset: number,
  model: HonuaFeatureTableViewModel,
  focusedRow: string | undefined,
  focusedField: string | undefined,
  hasFocus: boolean,
): string {
  // Roving tabindex: exactly one cell in the grid is tabbable. When the focused
  // row scrolled out of the window, the first cell of the first row takes it so
  // the grid never becomes keyboard-unreachable.
  //
  // Rows carry `tabindex="-1"`: programmatically focusable (so a host app — or a
  // test — can reveal and focus a whole row, which the pre-grid markup allowed
  // via `tabindex="0"`) while staying out of the tab sequence, which the cells
  // own. Row-level Enter/Space still selects; see `#bindGrid`.
  const rovingRow = hasFocus ? row.key === focusedRow : rowOffset === 0;
  return `
            <tr
              role="row"
              tabindex="-1"
              aria-rowindex="${row.ariaRowIndex}"
              aria-selected="${String(row.selected)}"
              ${row.placeholder ? 'data-placeholder="true"' : `data-row-key="${escapeAttribute(row.key)}"`}
              ${row.placeholder ? "" : `data-source-id="${escapeAttribute(row.sourceId)}"`}
              ${row.placeholder ? "" : `data-feature-id="${escapeAttribute(row.featureId)}"`}
            >
              ${model.columnWindow.startIndex > 0 ? '<td role="presentation" aria-hidden="true" data-column-leading></td>' : ""}
              ${row.cells
                .map((cell, cellIndex) => {
                  const column = model.columns[cellIndex];
                  const field = column?.field ?? "";
                  const roving = rovingRow && (hasFocus ? field === focusedField : cellIndex === 0);
                  // `data-cell-key` is grid-unique. The kit restores focus after
                  // a re-render by matching the active element's first `data-`
                  // attribute alphabetically, and `data-field` alone matches the
                  // same column in *every* row — which silently dragged focus to
                  // row 1. This sorts before `data-field`, so focus returns to
                  // the exact cell that had it.
                  return `<td
                role="gridcell"
                aria-colindex="${model.columnWindow.startIndex + cellIndex + 1}"
                tabindex="${roving ? "0" : "-1"}"
                data-cell-key="${escapeAttribute(`${row.key}::${field}`)}"
                data-field="${escapeAttribute(field)}"
              >${escapeHtml(cell)}</td>`;
                })
                .join("")}
              ${model.columnWindow.endIndex < model.totalColumnCount ? '<td role="presentation" aria-hidden="true" data-column-trailing></td>' : ""}
            </tr>`;
}

function columnsHiddenText(model: HonuaFeatureTableViewModel): string {
  return model.columnsHiddenLabel ?? COLUMNS_HIDDEN_LABEL;
}

function statusText(model: HonuaFeatureTableViewModel): string {
  const base = model.columnsHidden ? `${model.statusLabel}. ${columnsHiddenText(model)}` : model.statusLabel;
  if (model.conflicts.length === 0) return base;
  return `${base}. ${model.conflicts.map((conflict) => conflict.message).join(" ")}`;
}

/** Grid styles layered on top of the kit's shared `tableStyles()`. */
export function featureTableGridStyles(): string {
  return `
    .table-panel { max-width: 100%; min-width: 0; }
    .table-panel__bar { gap: 8px; min-width: 0; }
    .table-panel__bar h2 { min-width: 0; overflow-wrap: anywhere; }
    .table-wrap { max-width: 100%; overflow-x: auto; overflow-y: auto; }
    .table-wrap table { min-width: 100%; width: max-content; }
    [role="columnheader"]:not([role="presentation"]), [role="gridcell"] { min-width: var(--honua-ft-column-width); }
    .table-panel__bar .count { color: var(--honua-ui-muted); font-variant-numeric: tabular-nums; }
    .work-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      list-style: none;
      margin: 0;
      padding-block: 0 4px;
      padding-inline: 10px;
    }
    .work-badges li {
      background: var(--honua-ui-surface);
      border: 1px solid var(--honua-ui-border);
      border-radius: 999px;
      color: var(--honua-ui-muted);
      font-size: 0.75rem;
      padding-block: 2px;
      padding-inline: 7px;
    }
    .column-controls { padding-block: 0 4px; padding-inline: 10px; }
    .column-controls fieldset { border: 0; display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 0; padding: 0; }
    .column-controls label { align-items: center; display: inline-flex; gap: 4px; }
    .visually-hidden { clip: rect(0 0 0 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
    .status {
      color: var(--honua-ui-muted);
      margin: 0;
      padding-block: 4px;
      padding-inline: 10px;
    }
    .status:empty { display: none; }
    .spacer { width: 1px; }
    [role="columnheader"] button {
      appearance: none;
      background: none;
      border: 0;
      color: inherit;
      cursor: pointer;
      font: inherit;
      font-weight: 650;
      padding: 0;
      text-align: start;
      width: 100%;
    }
    [role="columnheader"][aria-sort="ascending"] button::after { content: " \\2191"; }
    [role="columnheader"][aria-sort="descending"] button::after { content: " \\2193"; }
    [role="gridcell"]:focus-visible,
    [role="gridcell"]:focus {
      outline: 2px solid var(--honua-ui-accent);
      outline-offset: -2px;
    }
    [data-placeholder="true"] [role="gridcell"] { color: transparent; }
    [data-placeholder="true"] [role="gridcell"]::after {
      background: var(--honua-ui-border);
      border-radius: 3px;
      content: "";
      display: block;
      height: 8px;
      opacity: 0.6;
      width: 60%;
    }
    @media (max-width: 320px) {
      .table-wrap th,
      .table-wrap td {
        overflow-wrap: anywhere;
        text-overflow: clip;
        white-space: normal;
      }
    }
  `;
}

function escapeHtml(value: string): string {
  return value.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).split("'").join("&#39;");
}
