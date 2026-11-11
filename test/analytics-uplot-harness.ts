// Shared µPlot adapter doubles. The real peer needs a canvas the unit runner does not provide.
import { createUplotAnalyticsAdapter } from "../src/analytics/adapters/uplot.js";
import type { UplotInstanceLike, UplotOptions, UplotSelectBox } from "../src/analytics/adapters/uplot.js";
import {
  UNBOUNDED,
  acceptScatterArtifact,
  analyticsArtifactIdentity,
  analyticsProvenance,
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
} from "../src/analytics/index.js";
import type { AnalyticsMeasure } from "../src/analytics/index.js";
import { createExplorationContext } from "../src/exploration/context.js";

const COUNT: AnalyticsMeasure = {
  field: "*",
  fn: "count",
  label: "Count",
  unit: "count",
  unitSystem: "count",
};
const ACCEPTED_AT = "2026-07-25T12:00:00.000Z";

export function scatter() {
  return acceptScatterArtifact({
    identity: analyticsArtifactIdentity({
      artifactId: "scatter",
      sourceId: "incidents",
      acceptedAt: ACCEPTED_AT,
    }),
    provenance: analyticsProvenance({
      computedBy: "server",
      bounds: UNBOUNDED,
    }),
    measure: COUNT,
    dimension: "height",
    yDimension: "weight",
    marks: [
      { key: "b", label: "B", x: 30, value: 40, targets: [2] },
      { key: "a", label: "A", x: 10, value: 20, targets: [1] },
    ],
  });
}

/**
 * A fake µPlot that records what the adapter handed it and exposes the hooks so
 * a test can fire brush / cursor / click events. The real peer needs a canvas
 * 2D context that jsdom does not provide; a real-render assertion belongs in a
 * packed browser test.
 */
export class FakeUplot implements UplotInstanceLike {
  public static instances: FakeUplot[] = [];

  public select: UplotSelectBox = { left: 0, top: 0, width: 0, height: 0 };
  public cursor: { idx?: number | null; left?: number; top?: number } = {};
  public destroyed = false;
  public setDataCalls: Array<{ data: unknown; resetScales?: boolean }> = [];
  public setSelectCalls: UplotSelectBox[] = [];
  public redrawCalls = 0;
  public bbox?: { left: number; top: number; width: number; height: number };
  public ctx?: {
    fillStyle: string;
    beginPath(): void;
    rect(x: number, y: number, width: number, height: number): void;
    moveTo(x: number, y: number): void;
    arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
    clip(): void;
    fill(): void;
    save(): void;
    restore(): void;
  };
  public readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public readonly over = {
    addEventListener: (type: string, listener: (event: unknown) => void): void => {
      const set = this.listeners.get(type) ?? new Set();
      set.add(listener);
      this.listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void): void => {
      this.listeners.get(type)?.delete(listener);
    },
  };

  public constructor(
    public readonly options: UplotOptions,
    public data: ReadonlyArray<ReadonlyArray<number | null>>,
    public readonly target?: unknown,
  ) {
    FakeUplot.instances.push(this);
  }

  public setData(data: ReadonlyArray<ReadonlyArray<number | null>>, resetScales?: boolean): void {
    this.data = data;
    this.setDataCalls.push({ data, resetScales });
  }

  public setSelect(box: UplotSelectBox): void {
    this.select = box;
    this.setSelectCalls.push(box);
  }

  /** Linear 1:1 pixel-to-value mapping so brush maths is assertable. */
  public posToVal(position: number): number {
    return position;
  }

  public valToPos(value: number): number {
    return value;
  }

  public destroy(): void {
    this.destroyed = true;
  }

  public redraw(): void {
    this.redrawCalls += 1;
  }

  public fireSelect(box: UplotSelectBox): void {
    this.select = box;
    for (const hook of this.options.hooks?.setSelect ?? []) hook(this);
  }

  public fireCursor(idx: number | null): void {
    this.cursor = { idx };
    for (const hook of this.options.hooks?.setCursor ?? []) hook(this);
  }

  public fireClick(): void {
    for (const listener of this.listeners.get("click") ?? []) listener({});
  }
}

export function fakeModule() {
  FakeUplot.instances = [];
  return FakeUplot as unknown as NonNullable<Parameters<typeof createUplotAnalyticsAdapter>[0]>["module"];
}

export function harness(artifact: Parameters<typeof createAnalyticsLinkedSession>[0]["artifact"]) {
  const ctx = createExplorationContext({
    datasetId: "incidents",
    sourceIds: ["incidents"],
  });
  const view = ctx.connectView({ id: "chart", role: "chart" });
  const registry = createAnalyticsAdapterRegistry({
    adapters: [createUplotAnalyticsAdapter({ module: fakeModule() })],
  });
  return {
    view,
    session: createAnalyticsLinkedSession({ view, artifact, registry }),
  };
}
