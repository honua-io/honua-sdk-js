/**
 * The small accessible default presentation.
 *
 * This is deliberately *not* a chart engine. It renders the shared
 * {@link analyticsTableModel} as a real `<table>` whose value cells carry a
 * proportional bar, which means one DOM tree serves both the visual and the
 * assistive-technology reading. Rows are focusable buttons, so mark selection
 * works from the keyboard, and a native `<input type="range">` pair provides
 * brushing without a drag implementation.
 *
 * Honua ships this so a dashboard is never blocked on choosing a chart
 * library. Anything richer belongs in an adapter (see `docs/linked-analytics.md`).
 *
 * @experimental
 * @module
 */

import { analyticsTableModel } from "./accessible-table.js";
import type { AnalyticsTableModel } from "./accessible-table.js";
import { createDisposableHandle } from "./handle.js";
import { ANALYTICS_CONTRACT_VERSION, HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsArtifact,
  AnalyticsLinkedState,
  AnalyticsMountRequest,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsSupportDecision,
} from "./types.js";

const ADAPTER_ID = "honua.default-bars";

/** Minimal structural slice of the DOM surface the default presentation uses. */
interface RenderTarget {
  innerHTML: string;
  querySelectorAll(selectors: string): ArrayLike<RenderElement>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  ownerDocument?: unknown;
}

interface RenderElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  readonly dataset?: Record<string, string | undefined>;
  value?: string;
}

function asRenderTarget(value: unknown): RenderTarget {
  const candidate = value as RenderTarget | null | undefined;
  if (typeof candidate !== "object" || candidate === null || typeof candidate.querySelectorAll !== "function") {
    throw new HonuaAnalyticsError(
      "artifact-invalid",
      "The default analytics presentation requires an Element as request.target.",
      { adapterId: ADAPTER_ID },
    );
  }
  return candidate;
}

/** Options for {@link createDefaultAnalyticsPresentation}. */
export interface DefaultAnalyticsPresentationOptions {
  /**
   * Render brush controls for histogram and time-series artifacts.
   * @default true
   */
  readonly brushing?: boolean;
  /** CSS class applied to the root element. @default `"honua-analytics"` */
  readonly className?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render the accessible table model to HTML. Exported so a server-rendered or
 * web-component host can produce the identical markup without mounting.
 */
export function renderAnalyticsTableHtml(
  model: AnalyticsTableModel,
  state: AnalyticsLinkedState = { selectedMarkKeys: [] },
  options: DefaultAnalyticsPresentationOptions = {},
): string {
  const className = options.className ?? "honua-analytics";
  const selected = new Set(state.selectedMarkKeys);
  const statusBanner = model.statusMessage
    ? `<p class="${className}__status" data-status="${escapeHtml(model.status)}" role="status">${escapeHtml(
        model.statusMessage,
      )}</p>`
    : "";
  const rows = model.rows
    .map((row) => {
      const isSelected = selected.has(row.key);
      const isHovered = state.hoveredMarkKey === row.key;
      return `<tr data-mark="${escapeHtml(row.key)}"${isSelected ? ' aria-selected="true"' : ""}${
        isHovered ? ' data-hovered="true"' : ""
      }>
  <th scope="row"><button type="button" class="${className}__mark" data-mark="${escapeHtml(
    row.key,
  )}" aria-pressed="${isSelected ? "true" : "false"}">${escapeHtml(row.label)}</button></th>
  <td class="${className}__value"${row.isNull ? ' data-null="true"' : ""}><span class="${className}__bar" style="--honua-analytics-fraction:${row.fraction.toFixed(
    4,
  )}" aria-hidden="true"></span><span class="${className}__number">${escapeHtml(row.value)}</span></td>
  ${model.columns.length > 2 ? `<td class="${className}__extent">${escapeHtml(row.extent ?? "")}</td>` : ""}
</tr>`;
    })
    .join("\n");

  const headers = model.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("");
  const empty =
    model.rows.length === 0
      ? `<tbody><tr><td colspan="${model.columns.length}">No buckets.</td></tr></tbody>`
      : `<tbody>${rows}</tbody>`;
  const total = model.total
    ? `<tfoot><tr><th scope="row">Total</th><td>${escapeHtml(model.total)}</td>${model.columns.length > 2 ? "<td></td>" : ""}</tr></tfoot>`
    : "";
  const attribution = model.attribution.length
    ? `<p class="${className}__attribution">${model.attribution.map(escapeHtml).join(" · ")}</p>`
    : "";

  return `<figure class="${className}" data-artifact="${escapeHtml(model.artifactId)}">
<figcaption class="${className}__caption">${escapeHtml(model.caption)}</figcaption>
${statusBanner}
<table class="${className}__table">
<caption class="${className}__sr">${escapeHtml(model.description)}</caption>
<thead><tr>${headers}</tr></thead>
${empty}
${total}
</table>
<p class="${className}__provenance">${escapeHtml(model.provenanceMessage)}</p>
${attribution}
</figure>`;
}

/**
 * Render the brush controls for a histogram or time-series artifact. Two range
 * inputs rather than a drag surface: keyboard-operable, screen-reader
 * announced, and zero dependencies.
 */
export function renderAnalyticsBrushHtml(artifact: AnalyticsArtifact, className = "honua-analytics"): string {
  if (artifact.kind !== "histogram" && artifact.kind !== "time-series") return "";
  if (artifact.marks.length === 0) return "";
  const last = artifact.marks.length - 1;
  return `<div class="${className}__brush" role="group" aria-label="Filter range">
<label class="${className}__brush-label">From <input type="range" class="${className}__brush-input" data-brush="start" min="0" max="${last}" step="1" value="0"></label>
<label class="${className}__brush-label">To <input type="range" class="${className}__brush-input" data-brush="end" min="0" max="${last}" step="1" value="${last}"></label>
</div>`;
}

/**
 * Create the default presentation adapter.
 *
 * `mount()` requires a DOM element as `request.target`. It supports every
 * artifact kind and never rejects an artifact, so it is a valid last-resort
 * visual presentation as well as the recommended first one.
 */
export function createDefaultAnalyticsPresentation(
  options: DefaultAnalyticsPresentationOptions = {},
): AnalyticsPresentationAdapter {
  const className = options.className ?? "honua-analytics";
  const brushing = options.brushing ?? true;

  return {
    id: ADAPTER_ID,
    contractVersion: ANALYTICS_CONTRACT_VERSION,
    kinds: ["category", "histogram", "aggregate", "time-series"],
    channels: ["mark-select", "hover", "range-brush", "temporal-brush", "clear"],
    requiresDom: true,
    describeSupport(): AnalyticsSupportDecision {
      return { supported: true };
    },
    mount(request: AnalyticsMountRequest): AnalyticsPresentationHandle {
      const target = asRenderTarget(request.target);
      let artifact = request.artifact;
      let state = request.linkedState ?? { selectedMarkKeys: [] };
      let model = analyticsTableModel(artifact, request.locale);
      const teardown: Array<() => void> = [];

      function emitMark(key: string, replace: boolean): void {
        request.host.emit({
          kind: "mark-select",
          adapterId: ADAPTER_ID,
          artifactId: artifact.identity.artifactId,
          markKeys: [key],
          replace,
        });
      }

      function readBrush(): { start: number; end: number } | undefined {
        const inputs = Array.from(target.querySelectorAll(`.${className}__brush-input`));
        if (inputs.length !== 2) return undefined;
        const values = inputs.map((input) => Number.parseInt(input.value ?? "0", 10));
        const start = Math.min(values[0], values[1]);
        const end = Math.max(values[0], values[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
        return { start, end };
      }

      function emitBrush(): void {
        const indices = readBrush();
        if (!indices) return;
        if (artifact.kind === "histogram") {
          const marks = artifact.marks.slice(indices.start, indices.end + 1);
          if (marks.length === 0) return;
          request.host.emit({
            kind: "range-brush",
            adapterId: ADAPTER_ID,
            artifactId: artifact.identity.artifactId,
            range: {
              min: Math.min(...marks.map((mark) => mark.min)),
              max: Math.max(...marks.map((mark) => mark.max)),
            },
          });
          return;
        }
        if (artifact.kind === "time-series") {
          const marks = artifact.marks.slice(indices.start, indices.end + 1);
          if (marks.length === 0) return;
          request.host.emit({
            kind: "temporal-brush",
            adapterId: ADAPTER_ID,
            artifactId: artifact.identity.artifactId,
            window: { start: marks[0].start, end: marks[marks.length - 1].end },
          });
        }
      }

      function bindListeners(): void {
        for (const button of Array.from(target.querySelectorAll(`.${className}__mark`))) {
          const key = button.getAttribute("data-mark");
          if (!key) continue;
          const onClick = (event: unknown): void => {
            const additive = Boolean(
              (event as { shiftKey?: boolean; metaKey?: boolean })?.shiftKey ||
                (event as { metaKey?: boolean })?.metaKey,
            );
            emitMark(key, !additive);
          };
          const onEnter = (): void => {
            request.host.emit({
              kind: "hover",
              adapterId: ADAPTER_ID,
              artifactId: artifact.identity.artifactId,
              markKey: key,
            });
          };
          const onLeave = (): void => {
            request.host.emit({
              kind: "hover",
              adapterId: ADAPTER_ID,
              artifactId: artifact.identity.artifactId,
            });
          };
          button.addEventListener("click", onClick);
          button.addEventListener("mouseenter", onEnter);
          button.addEventListener("focus", onEnter);
          button.addEventListener("mouseleave", onLeave);
          button.addEventListener("blur", onLeave);
          teardown.push(() => {
            button.removeEventListener("click", onClick);
            button.removeEventListener("mouseenter", onEnter);
            button.removeEventListener("focus", onEnter);
            button.removeEventListener("mouseleave", onLeave);
            button.removeEventListener("blur", onLeave);
          });
        }

        if (!brushing) return;
        for (const input of Array.from(target.querySelectorAll(`.${className}__brush-input`))) {
          const onChange = (): void => emitBrush();
          input.addEventListener("change", onChange);
          teardown.push(() => input.removeEventListener("change", onChange));
        }
      }

      function releaseListeners(): void {
        while (teardown.length > 0) {
          const release = teardown.pop();
          release?.();
        }
      }

      function render(): void {
        releaseListeners();
        model = analyticsTableModel(artifact, request.locale);
        target.innerHTML = `${renderAnalyticsTableHtml(model, state, { className, brushing })}${
          brushing ? renderAnalyticsBrushHtml(artifact, className) : ""
        }`;
        bindListeners();
      }

      render();

      return createDisposableHandle({
        adapterId: ADAPTER_ID,
        artifact,
        describe: () => model.description,
        onUpdate(next) {
          artifact = next;
          render();
        },
        onLinkedState(next) {
          state = next;
          render();
        },
        onDispose() {
          releaseListeners();
          target.innerHTML = "";
        },
        extra: {
          get model(): AnalyticsTableModel {
            return model;
          },
        },
      });
    },
  };
}
