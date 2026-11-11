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
  AnalyticsNumericRectangle,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsScatterArtifact,
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
  removeAttribute?(name: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  readonly dataset?: Record<string, string | undefined>;
  value?: string;
  textContent?: string | null;
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
   * Render brush controls for histogram, time-series, and scatter artifacts.
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
      ? `<tbody><tr><td colspan="${model.columns.length}">${escapeHtml(model.emptyMessage ?? "No buckets.")}</td></tr></tbody>`
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
 * Resolve the brushed mark-index range currently described by shared linked
 * state, so the controls reflect it instead of snapping back to full range.
 *
 * Returns the full range when nothing is brushed. A brush published by a peer
 * presentation (or by a chart adapter) lands here too, which is what keeps the
 * two surfaces agreeing.
 */
export function analyticsBrushIndices(
  artifact: AnalyticsArtifact,
  state: AnalyticsLinkedState = { selectedMarkKeys: [] },
): { readonly start: number; readonly end: number } | undefined {
  if (artifact.kind !== "histogram" && artifact.kind !== "time-series") return undefined;
  if (artifact.marks.length === 0) return undefined;
  const last = artifact.marks.length - 1;

  if (artifact.kind === "histogram" && state.range) {
    const { min, max } = state.range;
    const covered = artifact.marks
      .map((mark, index) => ({ mark, index }))
      .filter(({ mark }) => mark.min >= min && mark.max <= max);
    if (covered.length > 0) {
      return { start: covered[0].index, end: covered[covered.length - 1].index };
    }
  }

  if (artifact.kind === "time-series" && state.temporalWindow) {
    const from = Date.parse(state.temporalWindow.start);
    const to = Date.parse(state.temporalWindow.end);
    const covered = artifact.marks
      .map((mark, index) => ({ mark, index }))
      .filter(({ mark }) => Date.parse(mark.start) >= from && Date.parse(mark.end) <= to);
    if (covered.length > 0) {
      return { start: covered[0].index, end: covered[covered.length - 1].index };
    }
  }

  return { start: 0, end: last };
}

/** The active rectangle, or the mark extent when no rectangle is linked. */
function scatterBrushBounds(
  artifact: AnalyticsScatterArtifact,
  rectangle: AnalyticsNumericRectangle | undefined,
): AnalyticsNumericRectangle {
  if (rectangle) return rectangle;
  const xs = artifact.marks.map((mark) => mark.x);
  const ys = artifact.marks.map((mark) => mark.value);
  return {
    x: { min: Math.min(...xs), max: Math.max(...xs) },
    y: { min: Math.min(...ys), max: Math.max(...ys) },
  };
}

/**
 * Render numeric rectangle bounds for scatter artifacts, or two range
 * inputs rather than a drag surface: keyboard-operable, screen-reader
 * announced, and zero dependencies.
 *
 * The inputs are initialized from `state`, not from the artifact's extent, so
 * a rerender triggered by the brush the user just made (or by an inbound peer
 * brush) shows that range rather than resetting both handles.
 */
export function renderAnalyticsBrushHtml(
  artifact: AnalyticsArtifact,
  state: AnalyticsLinkedState = { selectedMarkKeys: [] },
  className = "honua-analytics",
): string {
  if (artifact.kind === "scatter") {
    if (artifact.marks.length === 0 || artifact.status === "error" || artifact.status === "unsupported") return "";
    const rectangle = scatterBrushBounds(artifact, state.rectangle);
    const axis = (key: "x" | "y", label: string): string =>
      `<fieldset><legend>${escapeHtml(label)}</legend>${(["min", "max"] as const)
        .map(
          (bound) =>
            `<label>${bound === "min" ? "Minimum" : "Maximum"} <input type="number" step="any" required data-rectangle="${key}-${bound}" value="${rectangle[key][bound]}"></label>`,
        )
        .join("")}</fieldset>`;
    return `<form class="${className}__rectangle">${axis("x", artifact.dimension)}${axis("y", artifact.yDimension)}<p role="status" data-brush-error></p><button type="submit">Apply rectangle</button><button type="button" data-clear-rectangle>Clear rectangle</button></form>`;
  }
  const indices = analyticsBrushIndices(artifact, state);
  if (!indices) return "";
  const last = artifact.marks.length - 1;
  return `<div class="${className}__brush" role="group" aria-label="Filter range">
<label class="${className}__brush-label">From <input type="range" class="${className}__brush-input" data-brush="start" min="0" max="${last}" step="1" value="${indices.start}"></label>
<label class="${className}__brush-label">To <input type="range" class="${className}__brush-input" data-brush="end" min="0" max="${last}" step="1" value="${indices.end}"></label>
</div>`;
}

function emitMarkHover(request: AnalyticsMountRequest, artifact: AnalyticsArtifact, key?: string): void {
  request.host.emit({
    kind: "hover",
    adapterId: ADAPTER_ID,
    artifactId: artifact.identity.artifactId,
    artifactSequence: artifact.identity.sequence,
    artifactSourceId: artifact.identity.sourceId,
    artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
    artifactKind: artifact.kind,
    ...(artifact.kind !== "aggregate" ? { artifactDimension: artifact.dimension } : {}),
    ...(artifact.kind === "scatter" ? { artifactYDimension: artifact.yDimension } : {}),
    ...(key ? { markKey: key } : {}),
  });
}

function bindMarkButtons(input: {
  target: RenderTarget;
  className: string;
  request: AnalyticsMountRequest;
  artifactOf: () => AnalyticsArtifact;
  emitMark: (key: string, replace: boolean) => void;
  teardown: Array<() => void>;
}): void {
  const { target, className, request, artifactOf, emitMark, teardown } = input;
  for (const button of Array.from(target.querySelectorAll(`.${className}__mark`))) {
    const key = button.getAttribute("data-mark");
    if (!key) continue;
    const onClick = (event: unknown): void => {
      const additive = Boolean(
        (event as { shiftKey?: boolean; metaKey?: boolean })?.shiftKey || (event as { metaKey?: boolean })?.metaKey,
      );
      emitMark(key, !additive);
    };
    const onEnter = (): void => emitMarkHover(request, artifactOf(), key);
    const onLeave = (): void => emitMarkHover(request, artifactOf());
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
}

function bindRectangleForm(input: {
  target: RenderTarget;
  className: string;
  request: AnalyticsMountRequest;
  artifactOf: () => AnalyticsArtifact;
  teardown: Array<() => void>;
}): void {
  const { target, className, request, artifactOf, teardown } = input;
  for (const form of Array.from(target.querySelectorAll(`.${className}__rectangle`))) {
    const onSubmit = (event: unknown): void => {
      (event as { preventDefault(): void }).preventDefault();
      const artifact = artifactOf();
      if (artifact.kind !== "scatter") return;
      const read = (key: string): number => {
        const input = Array.from(target.querySelectorAll(`[data-rectangle="${key}"]`))[0];
        const raw = input?.value?.trim();
        return raw ? Number(raw) : Number.NaN;
      };
      const rectangle = {
        x: { min: read("x-min"), max: read("x-max") },
        y: { min: read("y-min"), max: read("y-max") },
      };
      const valid = [rectangle.x, rectangle.y].every(
        (range) => Number.isFinite(range.min) && Number.isFinite(range.max) && range.min <= range.max,
      );
      const error = Array.from(target.querySelectorAll("[data-brush-error]"))[0];
      if (error) error.textContent = valid ? "" : "Enter finite ranges with each minimum at or below its maximum.";
      if (!valid) return;
      request.host.emit({
        kind: "rectangle-brush",
        adapterId: ADAPTER_ID,
        artifactId: artifact.identity.artifactId,
        artifactSequence: artifact.identity.sequence,
        artifactSourceId: artifact.identity.sourceId,
        artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
        artifactKind: artifact.kind,
        artifactDimension: artifact.dimension,
        artifactYDimension: artifact.yDimension,
        rectangle,
      });
    };
    form.addEventListener("submit", onSubmit);
    teardown.push(() => form.removeEventListener("submit", onSubmit));
  }
}

function bindRectangleClear(
  target: RenderTarget,
  request: AnalyticsMountRequest,
  artifactOf: () => AnalyticsArtifact,
  teardown: Array<() => void>,
): void {
  for (const button of Array.from(target.querySelectorAll("[data-clear-rectangle]"))) {
    const onClear = (): void => {
      const artifact = artifactOf();
      request.host.emit({
        kind: "clear",
        channel: "rectangle",
        adapterId: ADAPTER_ID,
        artifactId: artifact.identity.artifactId,
        artifactSequence: artifact.identity.sequence,
        artifactSourceId: artifact.identity.sourceId,
        artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
        artifactKind: artifact.kind,
        ...(artifact.kind === "scatter"
          ? { artifactDimension: artifact.dimension, artifactYDimension: artifact.yDimension }
          : {}),
      });
    };
    button.addEventListener("click", onClear);
    teardown.push(() => button.removeEventListener("click", onClear));
  }
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
    kinds: ["category", "histogram", "aggregate", "time-series", "scatter"],
    channels: ["mark-select", "hover", "range-brush", "rectangle-brush", "temporal-brush", "clear"],
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
          artifactSequence: artifact.identity.sequence,
          artifactSourceId: artifact.identity.sourceId,
          artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
          artifactKind: artifact.kind,
          ...(artifact.kind !== "aggregate" ? { artifactDimension: artifact.dimension } : {}),
          ...(artifact.kind === "scatter" ? { artifactYDimension: artifact.yDimension } : {}),
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
            artifactSequence: artifact.identity.sequence,
            artifactSourceId: artifact.identity.sourceId,
            artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
            artifactKind: artifact.kind,
            artifactDimension: artifact.dimension,
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
            artifactSequence: artifact.identity.sequence,
            artifactSourceId: artifact.identity.sourceId,
            artifactPlanFingerprint: artifact.identity.planFingerprint ?? "",
            artifactKind: artifact.kind,
            artifactDimension: artifact.dimension,
            window: { start: marks[0].start, end: marks[marks.length - 1].end },
          });
        }
      }

      function bindListeners(): void {
        bindMarkButtons({ target, className, request, artifactOf: () => artifact, emitMark, teardown });
        if (!brushing) return;
        bindRectangleForm({ target, className, request, artifactOf: () => artifact, teardown });
        bindRectangleClear(target, request, () => artifact, teardown);
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
          brushing ? renderAnalyticsBrushHtml(artifact, state, className) : ""
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
          const previous = state;
          state = next;
          if (artifact.kind !== "scatter") {
            render();
            return;
          }
          // Patch linked highlights without replacing a focused button or a brush draft.
          for (const button of Array.from(target.querySelectorAll("button[data-mark]"))) {
            const key = button.getAttribute("data-mark") ?? "";
            button.setAttribute("aria-pressed", String(state.selectedMarkKeys.includes(key)));
          }
          for (const row of Array.from(target.querySelectorAll("tr[data-mark]"))) {
            const key = row.getAttribute("data-mark") ?? "";
            row.setAttribute("aria-selected", String(state.selectedMarkKeys.includes(key)));
            if (state.hoveredMarkKey === key) row.setAttribute("data-hovered", "true");
            else row.removeAttribute?.("data-hovered");
          }
          if (JSON.stringify(previous.rectangle) !== JSON.stringify(state.rectangle)) {
            const bounds = scatterBrushBounds(artifact as AnalyticsScatterArtifact, state.rectangle);
            for (const input of Array.from(target.querySelectorAll("[data-rectangle]"))) {
              const [axis, bound] = (input.getAttribute("data-rectangle") ?? "").split("-");
              if ((axis === "x" || axis === "y") && (bound === "min" || bound === "max"))
                input.value = String(bounds[axis][bound]);
            }
          }
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
