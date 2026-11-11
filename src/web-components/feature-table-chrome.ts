import type { HonuaApplicationDiagnostic } from "./application-context.js";
import type { HonuaFeatureTableSnapshot } from "./feature-table-engine.js";

export function revealedRowIndex<T>(snapshot: HonuaFeatureTableSnapshot<T>): number | undefined {
  const key = snapshot.focus?.rowKey;
  if (key === undefined) return undefined;
  return snapshot.rows.find((row) => row?.key === key)?.index;
}

export function scrollTopForRevealedRow(request: {
  readonly index: number | undefined;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly rowHeight: number;
  readonly viewportHeight: number;
  readonly overscan: number;
}): number {
  const windowTop = request.windowStart * request.rowHeight;
  if (request.index === undefined) return Math.max(0, windowTop + request.overscan * request.rowHeight);
  const centered = request.index * request.rowHeight - (request.viewportHeight - request.rowHeight) / 2;
  const maxScroll = Math.max(windowTop, request.windowEnd * request.rowHeight - request.viewportHeight);
  return Math.min(maxScroll, Math.max(windowTop, centered));
}

export function isApplicationSelectionTarget(
  value: unknown,
): value is { readonly sourceId: string; readonly id: string | number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "sourceId" in value &&
    typeof value.sourceId === "string" &&
    "id" in value &&
    (typeof value.id === "string" || typeof value.id === "number")
  );
}

export function tableStyles(): string {
  return `
    :host { direction: inherit; }
    :host([dir="rtl"]) { direction: rtl; }
    .table-panel {
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      overflow: hidden;
    }
    .table-panel__bar {
      align-items: center;
      background: var(--honua-ui-surface);
      display: flex;
      justify-content: space-between;
      padding-block: 8px;
      padding-inline: 10px;
    }
    .table-wrap { max-height: 300px; overflow: auto; }
    table { border-collapse: collapse; min-width: 100%; table-layout: fixed; }
    th, td {
      border-top: 1px solid var(--honua-ui-border);
      overflow: hidden;
      padding-block: 7px;
      padding-inline: 9px;
      text-align: start;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    th { background: var(--honua-ui-surface); color: var(--honua-ui-fg); font-weight: 650; }
    tr[aria-selected="true"] td { background: var(--honua-ui-accent); color: var(--honua-ui-accent-fg); }
    tbody tr[data-feature-id] { cursor: pointer; }
    tbody tr[data-feature-id]:focus { outline: 2px solid var(--honua-ui-accent); outline-offset: -2px; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .table-panel {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .table-panel__bar, th { background: Canvas; color: CanvasText; }
      th, td { border-top-color: CanvasText; }
      tr[aria-selected="true"] td { background: Highlight; color: HighlightText; }
      tbody tr[data-feature-id]:focus { outline-color: Highlight; }
    }
  `;
}

export function mapStatusStyles(): string {
  return `
    .map-status {
      align-items: center;
      background: var(--honua-ui-bg);
      border: 1px solid var(--honua-ui-border);
      border-radius: 8px;
      display: flex;
      direction: inherit;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: space-between;
      min-height: 42px;
      padding-block: 6px;
      padding-inline: 8px;
    }
    span {
      color: var(--honua-ui-muted);
      min-width: 0;
      text-align: start;
    }
    .map-status button { text-align: start; }
    @media (forced-colors: active), (prefers-contrast: more) {
      .map-status {
        background: Canvas;
        border-color: CanvasText;
        color: CanvasText;
      }
      .map-status span { color: CanvasText; }
      .map-status button {
        background: ButtonFace;
        border: 2px solid ButtonText;
        color: ButtonText;
        forced-color-adjust: none;
      }
      :host([data-status="unsupported"]) .map-status {
        border-color: GrayText;
        color: GrayText;
      }
      :host([data-status="unsupported"]) .map-status span { color: GrayText; }
      :host([data-status="error"]) .map-status {
        border-color: Mark;
        color: MarkText;
      }
      :host([data-status="error"]) .map-status span { color: MarkText; }
    }
    @media (max-width: 240px) {
      .map-status { align-items: flex-start; flex-direction: column; }
      .map-status button { inline-size: 100%; }
    }
  `;
}

export function applicationTargetsForRows<T>(
  snapshot: HonuaFeatureTableSnapshot<T>,
  selectionTargets: readonly unknown[],
): unknown[] {
  return snapshot.selection
    .map((key, index) => {
      const row = snapshot.rows.find((candidate) => candidate?.key === key);
      const target = row?.target ?? selectionTargets[index];
      if (!target) return undefined;
      return row && isApplicationSelectionTarget(target)
        ? { ...target, attributes: row.attributes, ...(row.geometry !== undefined ? { geometry: row.geometry } : {}) }
        : target;
    })
    .filter((entry) => entry !== undefined);
}

export function applicationDiagnosticsForTable<T>(
  existing: readonly HonuaApplicationDiagnostic[],
  snapshot: HonuaFeatureTableSnapshot<T>,
): HonuaApplicationDiagnostic[] {
  const componentId = "honua-feature-table";
  const tableDiagnostics: HonuaApplicationDiagnostic[] = [
    ...(snapshot.error
      ? [
          {
            code: "feature-table-query-failed",
            message:
              snapshot.error instanceof Error
                ? snapshot.error.message
                : (snapshot.message ?? "The table query failed."),
            severity: "error" as const,
            componentId,
            status: "failed" as const,
          },
        ]
      : []),
    ...snapshot.conflicts.map((conflict) => ({
      code: `feature-table-${conflict.code}`,
      message: conflict.message,
      severity: "warning" as const,
      componentId,
      status: "degraded" as const,
    })),
  ];
  return [...existing.filter((entry) => entry.componentId !== componentId), ...tableDiagnostics];
}
