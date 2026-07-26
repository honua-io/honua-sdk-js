// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  UPLOT_ANALYTICS_ADAPTER_ID,
  createUplotAnalyticsAdapter,
  loadUplot,
  projectAnalyticsArtifactToUplot,
} from "../src/analytics/adapters/uplot.js";
import type { UplotInstanceLike, UplotOptions, UplotSelectBox } from "../src/analytics/adapters/uplot.js";
import {
  UNBOUNDED,
  acceptCategoryArtifact,
  acceptHistogramArtifact,
  acceptTimeSeriesArtifact,
  analyticsArtifactIdentity,
  analyticsProvenance,
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
  unsupportedAnalyticsArtifact,
} from "../src/analytics/index.js";
import type { AnalyticsMeasure } from "../src/analytics/index.js";
import { createExplorationContext } from "../src/exploration/context.js";

const COUNT: AnalyticsMeasure = { field: "*", fn: "count", label: "Count", unit: "count", unitSystem: "count" };
const ACCEPTED_AT = "2026-07-25T12:00:00.000Z";

function timeSeries(sequence = 0, values: readonly number[] = [2, 4, 1]) {
  return acceptTimeSeriesArtifact({
    identity: analyticsArtifactIdentity({
      artifactId: "incidents-by-day",
      sourceId: "incidents",
      planFingerprint: "sha256:abc",
      sequence,
      acceptedAt: ACCEPTED_AT,
    }),
    provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
    measure: COUNT,
    title: "Incidents by day",
    dimension: "reported_at",
    interval: { unit: "day", step: 1 },
    marks: values.map((value, index) => ({
      key: `d${index + 1}`,
      label: `Jul ${index + 1}`,
      value,
      start: `2026-07-0${index + 1}T00:00:00.000Z`,
      end: `2026-07-0${index + 2}T00:00:00.000Z`,
    })),
  });
}

function histogram() {
  return acceptHistogramArtifact({
    identity: analyticsArtifactIdentity({
      artifactId: "severity",
      sourceId: "incidents",
      acceptedAt: ACCEPTED_AT,
    }),
    provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
    measure: COUNT,
    dimension: "severity",
    bins: 2,
    marks: [
      { key: "b0", label: "0–10", value: 5, min: 0, max: 10, boundary: "inclusive-exclusive", bucket: 0 },
      { key: "b1", label: "10–20", value: null, min: 10, max: 20, boundary: "inclusive-exclusive", bucket: 1 },
    ],
  });
}

function category() {
  return acceptCategoryArtifact({
    identity: analyticsArtifactIdentity({ artifactId: "status", sourceId: "incidents", acceptedAt: ACCEPTED_AT }),
    provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
    measure: COUNT,
    dimension: "status",
    marks: [{ key: "s:OPEN", label: "Open", value: 1, filterValue: "OPEN" }],
  });
}

/**
 * A fake µPlot that records what the adapter handed it and exposes the hooks so
 * a test can fire brush / cursor / click events. The real peer needs a canvas
 * 2D context that jsdom does not provide; a real-render assertion belongs in a
 * packed browser test.
 */
class FakeUplot implements UplotInstanceLike {
  public static instances: FakeUplot[] = [];

  public select: UplotSelectBox = { left: 0, top: 0, width: 0, height: 0 };
  public cursor: { idx?: number | null } = {};
  public destroyed = false;
  public setDataCalls: Array<{ data: unknown; resetScales?: boolean }> = [];
  public setSelectCalls: UplotSelectBox[] = [];
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

function fakeModule() {
  FakeUplot.instances = [];
  return FakeUplot as unknown as NonNullable<Parameters<typeof createUplotAnalyticsAdapter>[0]>["module"];
}

function harness(artifact: Parameters<typeof createAnalyticsLinkedSession>[0]["artifact"]) {
  const ctx = createExplorationContext({ datasetId: "incidents", sourceIds: ["incidents"] });
  const view = ctx.connectView({ id: "chart", role: "chart" });
  const registry = createAnalyticsAdapterRegistry({
    adapters: [createUplotAnalyticsAdapter({ module: fakeModule() })],
  });
  return { view, session: createAnalyticsLinkedSession({ view, artifact, registry }) };
}

describe("projectAnalyticsArtifactToUplot", () => {
  it("projects a time-series onto epoch seconds with stable mark keys", () => {
    const projection = projectAnalyticsArtifactToUplot(timeSeries());
    expect(projection.xUnit).toBe("epoch-seconds");
    expect(projection.data[0]).toEqual([
      Date.parse("2026-07-01T00:00:00.000Z") / 1000,
      Date.parse("2026-07-02T00:00:00.000Z") / 1000,
      Date.parse("2026-07-03T00:00:00.000Z") / 1000,
    ]);
    expect(projection.data[1]).toEqual([2, 4, 1]);
    expect(projection.markKeys).toEqual(["d1", "d2", "d3"]);
    expect(projection.options.scales?.x).toEqual({ time: true });
    expect(projection.options.title).toBe("Incidents by day");
    expect(projection.options.series[1]).toMatchObject({ label: "Count" });
  });

  it("projects a histogram onto bin midpoints and keeps nulls as gaps", () => {
    const projection = projectAnalyticsArtifactToUplot(histogram());
    expect(projection.xUnit).toBe("bucket-midpoint");
    expect(projection.data[0]).toEqual([5, 15]);
    // A null measure must stay null so µPlot draws a gap, never a false zero.
    expect(projection.data[1]).toEqual([5, null]);
    expect(projection.options.scales?.x).toEqual({ time: false });
  });

  it("accepts option overrides but never lets a caller replace the hooks", () => {
    const projection = projectAnalyticsArtifactToUplot(timeSeries(), {
      width: 800,
      optionOverrides: { width: 1024, hooks: { setSelect: [] }, legend: { show: false } },
    });
    expect(projection.options.width).toBe(1024);
    expect(projection.options.legend).toEqual({ show: false });
    expect(projection.options.hooks).toBeUndefined();
  });
});

describe("uPlot adapter: support decisions", () => {
  const adapter = createUplotAnalyticsAdapter({ module: fakeModule() });

  it("declines categorical artifacts so the registry can fall back honestly", () => {
    expect(adapter.describeSupport(category())).toEqual({
      supported: false,
      reason: "kind-not-supported",
      message:
        'The µPlot adapter renders numeric and temporal axes; "category" artifacts need a categorical presentation.',
    });
  });

  it("declines unsupported and error artifacts", () => {
    const unsupported = unsupportedAnalyticsArtifact({
      identity: analyticsArtifactIdentity({ artifactId: "a", sourceId: "s", acceptedAt: ACCEPTED_AT }),
      kind: "time-series",
      measure: COUNT,
      message: "not supported",
    });
    expect(adapter.describeSupport(unsupported)).toMatchObject({ supported: false, reason: "artifact-invalid" });
  });

  it("accepts time-series and histogram artifacts", () => {
    expect(adapter.describeSupport(timeSeries()).supported).toBe(true);
    expect(adapter.describeSupport(histogram()).supported).toBe(true);
  });

  it("declares itself as an optional-peer DOM adapter on the current contract", () => {
    expect(adapter).toMatchObject({
      id: UPLOT_ANALYTICS_ADAPTER_ID,
      library: "uPlot",
      requiresDom: true,
      kinds: ["time-series", "histogram"],
    });
  });
});

describe("uPlot adapter: optional peer loading", () => {
  it("loads the peer through an injectable importer", async () => {
    const importModule = vi.fn(async () => FakeUplot);
    const loaded = await loadUplot({ importModule });
    expect(importModule).toHaveBeenCalledWith("uplot");
    expect(loaded).toBe(FakeUplot);
  });

  it("unwraps a default export", async () => {
    const loaded = await loadUplot({ importModule: async () => ({ default: FakeUplot }) });
    expect(loaded).toBe(FakeUplot);
  });

  it("reports an actionable typed error when the peer is missing", async () => {
    const cause = new Error("Cannot find module 'uplot'");
    await expect(
      loadUplot({
        importModule: async () => {
          throw cause;
        },
      }),
    ).rejects.toMatchObject({
      name: "HonuaAnalyticsError",
      code: "missing-peer",
      cause,
      detail: { package: "uplot" },
    });
  });

  it("rejects a module that is not a constructor", async () => {
    await expect(loadUplot({ importModule: async () => ({ notUplot: true }) })).rejects.toMatchObject({
      code: "missing-peer",
    });
  });

  it("only touches the peer at mount time", async () => {
    const importModule = vi.fn(async () => FakeUplot);
    const adapter = createUplotAnalyticsAdapter({ importModule });
    adapter.describeSupport(timeSeries());
    expect(importModule).not.toHaveBeenCalled();

    const handle = await adapter.mount({
      artifact: timeSeries(),
      host: { emit: () => {} },
      target: document.createElement("div"),
    });
    expect(importModule).toHaveBeenCalledOnce();
    handle.dispose();
  });
});

describe("uPlot adapter: linked interactions", () => {
  it("turns a µPlot brush into a temporal filter on shared state", async () => {
    const { session, view } = harness(timeSeries());
    const presentation = await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances.at(-1)!;

    const start = Date.parse("2026-07-01T00:00:00.000Z") / 1000;
    const end = Date.parse("2026-07-03T00:00:00.000Z") / 1000;
    chart.fireSelect({ left: start, top: 0, width: end - start, height: 10 });

    expect(view.state.filters[session.binding.clauseIds.temporal]).toEqual({
      field: "reported_at",
      operator: "between",
      value: ["2026-07-01T00:00:00.000Z", "2026-07-03T00:00:00.000Z"],
      appliesTo: ["incidents"],
    });
    expect(session.linkedState.selectedMarkKeys).toEqual(["d1", "d2"]);

    // …and the same brush can be undone deterministically.
    session.undo();
    expect(view.state.filters[session.binding.clauseIds.temporal]).toBeUndefined();
    expect(presentation.handle.disposed).toBe(false);
    session.dispose();
  });

  it("turns a µPlot brush on a histogram into a numeric range filter", async () => {
    const { session, view } = harness(histogram());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances.at(-1)!;

    chart.fireSelect({ left: 2, top: 0, width: 16, height: 10 });
    expect(view.state.filters[session.binding.clauseIds.range]).toEqual({
      field: "severity",
      operator: "between",
      value: [2, 18],
      appliesTo: ["incidents"],
    });
    session.dispose();
  });

  it("ignores a zero-width brush", async () => {
    const { session, view } = harness(timeSeries());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances.at(-1)!;
    chart.fireSelect({ left: 10, top: 0, width: 0, height: 10 });
    expect(view.state.filters[session.binding.clauseIds.temporal]).toBeUndefined();
    session.dispose();
  });

  it("turns a click on the plot area into a mark selection", async () => {
    const { session, view } = harness(timeSeries());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances.at(-1)!;

    chart.cursor = { idx: 1 };
    chart.fireClick();

    expect(view.state.filters[session.binding.clauseIds.temporal]).toMatchObject({
      value: ["2026-07-02T00:00:00.000Z", "2026-07-03T00:00:00.000Z"],
    });
    session.dispose();
  });

  it("emits deduplicated hover without touching the exploration reducer", async () => {
    const emitted: string[] = [];
    const adapter = createUplotAnalyticsAdapter({ module: fakeModule() });
    const handle = await adapter.mount({
      artifact: timeSeries(),
      host: {
        emit: (interaction) => {
          if (interaction.kind === "hover") emitted.push(interaction.markKey ?? "<none>");
        },
      },
      target: document.createElement("div"),
    });
    const chart = FakeUplot.instances.at(-1)!;

    chart.fireCursor(0);
    chart.fireCursor(0);
    chart.fireCursor(2);
    chart.fireCursor(null);

    expect(emitted).toEqual(["d1", "d3", "<none>"]);
    handle.dispose();
  });

  it("paints inbound shared state back onto the chart selection", async () => {
    const { session } = harness(timeSeries());
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances.at(-1)!;

    session.apply({
      kind: "temporal-brush",
      adapterId: "peer",
      artifactId: "incidents-by-day",
      window: { start: "2026-07-02T00:00:00.000Z", end: "2026-07-03T00:00:00.000Z" },
    });

    const painted = chart.setSelectCalls.at(-1)!;
    expect(painted.left).toBe(Date.parse("2026-07-02T00:00:00.000Z") / 1000);
    expect(painted.width).toBe(86_400);

    session.apply({ kind: "clear", adapterId: "peer", artifactId: "incidents-by-day" });
    expect(chart.setSelectCalls.at(-1)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
    session.dispose();
  });
});

describe("uPlot adapter: update disposition and disposal", () => {
  it("patches the live instance on a newer sequence instead of rebuilding", async () => {
    const { session } = harness(timeSeries(1, [2, 4, 1]));
    await session.present({ target: document.createElement("div") });
    expect(FakeUplot.instances).toHaveLength(1);
    const chart = FakeUplot.instances[0];

    session.accept(timeSeries(2, [9, 9, 9]));

    expect(FakeUplot.instances).toHaveLength(1);
    expect(chart.destroyed).toBe(false);
    // resetScales === false keeps the user's zoom and focus through a delta.
    expect(chart.setDataCalls.at(-1)).toMatchObject({ resetScales: false });
    expect(chart.data[1]).toEqual([9, 9, 9]);
    session.dispose();
  });

  it("rebuilds the peer instance when the plan changes", async () => {
    const { session } = harness(timeSeries(1));
    await session.present({ target: document.createElement("div") });
    const first = FakeUplot.instances[0];

    session.accept(
      acceptTimeSeriesArtifact({
        identity: analyticsArtifactIdentity({
          artifactId: "incidents-by-day",
          sourceId: "incidents",
          planFingerprint: "sha256:changed",
          sequence: 2,
          acceptedAt: ACCEPTED_AT,
        }),
        provenance: analyticsProvenance({ computedBy: "server", bounds: UNBOUNDED }),
        measure: COUNT,
        dimension: "reported_at",
        interval: { unit: "day", step: 1 },
        marks: [
          { key: "d1", label: "Jul 1", value: 7, start: "2026-07-01T00:00:00.000Z", end: "2026-07-02T00:00:00.000Z" },
        ],
      }),
    );

    expect(first.destroyed).toBe(true);
    expect(FakeUplot.instances).toHaveLength(2);
    session.dispose();
  });

  it("ignores a late delta without touching the peer", async () => {
    const { session } = harness(timeSeries(5, [9, 9, 9]));
    await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];

    session.accept(timeSeries(4, [1, 1, 1]));
    expect(chart.setDataCalls).toHaveLength(0);
    expect(chart.data[1]).toEqual([9, 9, 9]);
    session.dispose();
  });

  it("destroys the instance and releases the click listener on dispose", async () => {
    const { session } = harness(timeSeries());
    const presentation = await session.present({ target: document.createElement("div") });
    const chart = FakeUplot.instances[0];
    expect(chart.listeners.get("click")?.size).toBe(1);

    presentation.handle.dispose();

    expect(chart.destroyed).toBe(true);
    expect(chart.listeners.get("click")?.size).toBe(0);
    expect(presentation.handle.disposed).toBe(true);
    // A late event from a detached peer cannot reach shared state.
    chart.fireSelect({ left: 0, top: 0, width: 10, height: 10 });
    session.dispose();
  });

  it("is idempotent on repeated dispose", async () => {
    const { session } = harness(histogram());
    const presentation = await session.present({ target: document.createElement("div") });
    presentation.handle.dispose();
    expect(() => presentation.handle.dispose()).not.toThrow();
    session.dispose();
  });

  it("refuses to mount an unsupported kind", async () => {
    const adapter = createUplotAnalyticsAdapter({ module: fakeModule() });
    await expect(
      adapter.mount({ artifact: category(), host: { emit: () => {} }, target: document.createElement("div") }),
    ).rejects.toMatchObject({ code: "adapter-unsupported" });
  });

  it("warns and tears down rather than misrendering a kind change", async () => {
    const warnings: string[] = [];
    const adapter = createUplotAnalyticsAdapter({ module: fakeModule() });
    const handle = await adapter.mount({
      artifact: timeSeries(1),
      host: { emit: () => {}, reportWarning: (message) => warnings.push(message) },
      target: document.createElement("div"),
    });
    const chart = FakeUplot.instances[0];

    handle.update(category());

    expect(warnings[0]).toMatch(/stopped updating/);
    expect(chart.destroyed).toBe(true);
    handle.dispose();
  });
});

describe("uPlot adapter: core bundle hygiene", () => {
  const root = path.resolve(process.cwd(), "src", "analytics");

  it("keeps the analytics barrel free of every adapter", () => {
    const barrel = fs.readFileSync(path.join(root, "index.ts"), "utf8");
    // Prose may name the adapter subpath; module graph edges may not.
    const statements = barrel.replace(/\/\*\*[\s\S]*?\*\//g, "");
    expect(statements).not.toMatch(/\.\/adapters\//);
    expect(statements).not.toMatch(/uplot/i);
  });

  it("never statically imports the optional chart peer", () => {
    const files = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => fs.readFileSync(path.join(entry.parentPath ?? root, entry.name), "utf8"))
      .join("\n");

    // A static `import ... from "uplot"` would drag the peer into the graph.
    expect(files).not.toMatch(/from\s+["']uplot["']/);
    // Only the variable-specifier dynamic import is allowed.
    expect(files).toMatch(/import\(specifier\)/);
  });
});
