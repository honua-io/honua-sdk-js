import { escapeAttribute as attr, escapeHtml } from "./element-utils.js";
import type { HonuaFilterBuilderDraft, HonuaFilterBuilderRow } from "./filter-builder.js";

const OPERATORS = {
  eq: "Equals",
  ne: "Differs from",
  lt: "Less than",
  lte: "At most",
  gt: "Greater than",
  gte: "At least",
  like: "Matches pattern",
  "is-null": "Is empty",
  "is-not-null": "Is not empty",
};

export const FILTER_BUILDER_CSS = `
:host { display:block; max-width:100%; min-width:0; font:inherit; }
form { display:grid; grid-template-columns:minmax(0,1fr); gap:1em; } fieldset { min-width:0; border:1px solid #9ba6b1; padding:0.75em; }
.row, .bounds { display:flex; flex-wrap:wrap; gap:0.5em; align-items:end; }
label { display:grid; gap:0.25em; min-width:0; max-width:100%; } input, select, button { font:inherit; min-height:44px; box-sizing:border-box; max-width:100%; }
input, select { min-width:0; width:14em; } input[type="checkbox"] { width:44px; margin:0; } .bounds input { width:7em; } button { padding:0.4em 0.8em; cursor:pointer; }
output, pre { white-space:pre-wrap; overflow-wrap:anywhere; min-width:0; margin:0; }
:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
`;

function options(entries: readonly { value: string; label: string }[], selected: string): string {
  return entries
    .map(
      ({ value, label }) =>
        `<option value="${attr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
}

function rowMarkup(row: HonuaFilterBuilderRow, index: number, draft: HonuaFilterBuilderDraft): string {
  const fieldOptions = options(
    draft.fields.map((field) => ({ value: field.name, label: field.label ?? field.name })),
    row.field,
  );
  const operatorOptions = options(
    Object.entries(OPERATORS).map(([value, label]) => ({ value, label })),
    row.operator,
  );
  return `<div class="row" data-row>
<label>Field ${index + 1}<select data-field>${fieldOptions}</select></label>
<label>Operator<select data-operator>${operatorOptions}</select></label>
<label>Value<input data-value value="${attr(row.value ?? "")}" aria-description="Use true or false for boolean fields, and a timestamp with timezone for date fields. Empty operators ignore this value."></label>
<button type="button" data-remove="${index}" aria-label="Remove filter ${index + 1}">Remove</button></div>`;
}

/** Internal markup shared by the browser element and its browser fixtures. */
export function filterBuilderMarkup(draft: HonuaFilterBuilderDraft, status: string, cql2: string): string {
  const bounds = ["West", "South", "East", "North"]
    .map(
      (label, index) =>
        `<label>${label}<input data-bound type="number" step="any" value="${draft.extent?.[index] ?? ""}"></label>`,
    )
    .join("");
  const timeOptions = options(
    [
      { value: "", label: "No time range" },
      ...draft.fields
        .filter((field) => field.type === "datetime")
        .map((field) => ({ value: field.name, label: field.label ?? field.name })),
    ],
    draft.time?.field ?? "",
  );
  return `<form part="root" aria-label="Filter rows">
<fieldset><legend>Attribute filters (all must match)</legend>${draft.rows.map((row, index) => rowMarkup(row, index, draft)).join("")}
<button type="button" data-add ${draft.rows.length >= 32 || !draft.fields.length ? "disabled" : ""}>Add filter</button></fieldset>
<fieldset><legend>Map extent</legend><label><input data-extent type="checkbox" ${draft.extent ? "checked" : ""}>Limit to WGS84 extent</label><div class="bounds">${bounds}</div></fieldset>
<fieldset><legend>Time range</legend><label>Date field<select data-time-field>${timeOptions}</select></label>
<label>Start (timestamp with timezone)<input data-start placeholder="2026-01-01T00:00:00Z" value="${attr(draft.time?.start ?? "")}"></label>
<label>End (timestamp with timezone)<input data-end placeholder="2026-02-01T00:00:00Z" value="${attr(draft.time?.end ?? "")}"></label></fieldset>
<button type="submit">Apply filters</button><output role="status" aria-live="polite">${escapeHtml(status)}</output>
<pre part="cql2" aria-label="Applied CQL2 filter">${escapeHtml(cql2 || "No attribute, extent or time filter applied.")}</pre></form>`;
}

/** Read edited native form controls while retaining host-owned schema and scope. */
export function readFilterBuilderDraft(root: ShadowRoot, draft: HonuaFilterBuilderDraft): HonuaFilterBuilderDraft {
  const value = (selector: string): string =>
    root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? "";
  const rows = [...root.querySelectorAll("[data-row]")].map((row) => ({
    field: row.querySelector<HTMLSelectElement>("[data-field]")!.value,
    operator: row.querySelector<HTMLSelectElement>("[data-operator]")!.value as HonuaFilterBuilderRow["operator"],
    value: row.querySelector<HTMLInputElement>("[data-value]")!.value,
  }));
  const extentEnabled = root.querySelector<HTMLInputElement>("[data-extent]")?.checked;
  const extent = extentEnabled
    ? ([...root.querySelectorAll<HTMLInputElement>("[data-bound]")].map((input) =>
        input.value.trim() ? Number(input.value) : Number.NaN,
      ) as [number, number, number, number])
    : undefined;
  const field = value("[data-time-field]");
  return {
    ...draft,
    rows,
    extent,
    time: field ? { field, start: value("[data-start]"), end: value("[data-end]") } : undefined,
  };
}
