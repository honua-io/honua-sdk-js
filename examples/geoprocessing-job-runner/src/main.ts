import "./styles.css";

import { BUFFER_INPUTS, INPUT_POINT, PROCESS_ID, RESULT_GEOMETRY_SHA256 } from "./fixtures.js";
import { BufferJobWalkthrough } from "./model.js";
import type { BufferFeature, PolygonGeometry, WalkthroughSnapshot } from "./types.js";

declare global {
  interface Window {
    __HONUA_GEOPROCESSING_JOB_RUNNER__?: {
      readonly ready: boolean;
      snapshot(): WalkthroughSnapshot;
      replay(): Promise<void>;
      cancel(): Promise<void>;
    };
  }
}

const walkthrough = new BufferJobWalkthrough({ baseUrl: window.location.origin });

walkthrough.subscribe(render);
getElement<HTMLButtonElement>("#primary-action").addEventListener("click", () => void walkthrough.primaryAction());

window.__HONUA_GEOPROCESSING_JOB_RUNNER__ = {
  ready: true,
  snapshot: () => walkthrough.snapshot(),
  replay: () => walkthrough.run(),
  cancel: () => walkthrough.cancel(),
};

void walkthrough.run();

function render(snapshot: WalkthroughSnapshot): void {
  const status = snapshot.status === "submitting" ? "Submitting" : titleCase(snapshot.status);
  setText("#job-state", status);
  getElement<HTMLElement>("#job-state").dataset.status = snapshot.status;
  setText("#timeline-count", `${snapshot.timeline.length} / 4`);
  setText(
    "#result-state",
    snapshot.result ? "Rendered and verified" : snapshot.error ? "Not rendered" : "Waiting for result",
  );
  setText("#result-digest", snapshot.resultDigest ?? RESULT_GEOMETRY_SHA256);
  setText("#error-message", snapshot.error ?? "No request or job errors");
  getElement<HTMLElement>("#error-message").hidden = !snapshot.error;

  const button = getElement<HTMLButtonElement>("#primary-action");
  button.disabled =
    snapshot.status === "submitting" ||
    (snapshot.busy && snapshot.status !== "accepted" && snapshot.status !== "running");
  button.textContent =
    snapshot.status === "accepted" || snapshot.status === "running"
      ? "Cancel job"
      : snapshot.status === "idle"
        ? "Run buffer job"
        : snapshot.status === "dismissed" || snapshot.status === "failed"
          ? "Restart buffer job"
          : "Replay buffer job";

  const timeline = getElement<HTMLOListElement>("#status-timeline");
  timeline.innerHTML = snapshot.timeline.length
    ? snapshot.timeline
        .map((entry) => `<li data-status="${entry.status}"><span>${entry.label}</span><p>${entry.detail}</p></li>`)
        .join("")
    : '<li class="pending"><span>Ready</span><p>The fixture submits automatically on load.</p></li>';

  renderMap(snapshot.result);
}

function renderMap(feature: BufferFeature | undefined): void {
  const polygon = getElement<SVGPathElement>("#buffer-polygon");
  polygon.setAttribute("d", feature ? polygonPath(feature.geometry) : "");
  polygon.dataset.rendered = feature ? "true" : "false";
  polygon.setAttribute("aria-hidden", feature ? "false" : "true");
  const input = project(INPUT_POINT.projectedX, INPUT_POINT.projectedY);
  const halo = getElement<SVGCircleElement>("#input-point");
  halo.setAttribute("cx", String(input.x));
  halo.setAttribute("cy", String(input.y));
  const core = getElement<SVGCircleElement>("#input-core");
  core.setAttribute("cx", String(input.x));
  core.setAttribute("cy", String(input.y));
}

function polygonPath(geometry: PolygonGeometry): string {
  const ring = geometry.coordinates[0] ?? [];
  return `${ring
    .map(([x, y], index) => {
      const point = project(x, y);
      return `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    })
    .join(" ")} Z`;
}

function project(x: number, y: number): { x: number; y: number } {
  const bounds = { xmin: -17_573_650, xmax: -17_571_650, ymin: 2_427_450, ymax: 2_429_050 };
  return {
    x: 80 + ((x - bounds.xmin) / (bounds.xmax - bounds.xmin)) * 840,
    y: 590 - ((y - bounds.ymin) / (bounds.ymax - bounds.ymin)) * 520,
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function setText(selector: string, value: string): void {
  getElement<HTMLElement>(selector).textContent = value;
}

setText("#process-id", PROCESS_ID);
setText("#input-wkb", BUFFER_INPUTS.wkb);
