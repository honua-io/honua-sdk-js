import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WIDGET_SOURCE_SCHEMA_VERSION } from "../src/contract/index.js";
import type { WidgetSource } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import type {
  HonuaGeneratedAppFeatureInput,
  HonuaGeneratedAppManifest,
  HonuaGeneratedAppPackage,
  HonuaGeneratedAppRenderModel,
  HonuaGeneratedAppWidgetModel,
} from "../src/generated-app/index.js";
import {
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND,
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION,
  HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
  HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
  createGeneratedAppManifestArtifact,
  previewGeneratedApp,
  projectAppPackageToGeneratedAppManifest,
  projectBuildSpecToGeneratedAppManifest,
  projectMapPackageToGeneratedAppManifest,
} from "../src/generated-app/index.js";
import {
  HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT,
  HONUA_GENERATED_APP_MAX_WIDGETS,
} from "../src/generated-app/projection.js";
import type { HonuaMapPackage, MaplibreMap } from "../src/runtime/index.js";

interface MockCall {
  readonly method: string;
  readonly args: unknown[];
}

interface MockMap extends MaplibreMap {
  readonly _calls: MockCall[];
  readonly _state: Map<string, Record<string, unknown>>;
  _style: unknown;
}

const fixturesRoot = path.join(process.cwd(), "test/fixtures/generated-app");

function readFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, name), "utf8")) as T;
}

function makeClient(): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async () => new Response("not used in generated-app tests", { status: 200 }),
  });
}

function makeMockMap(): MockMap {
  const calls: MockCall[] = [];
  const state = new Map<string, Record<string, unknown>>();
  const key = (target: { source: string; id: string | number; sourceLayer?: string }): string =>
    `${target.source}:${target.sourceLayer ?? ""}:${target.id}`;

  return {
    _calls: calls,
    _state: state,
    _style: {},
    setStyle(style) {
      calls.push({ method: "setStyle", args: [style] });
      this._style = style;
    },
    getStyle() {
      return this._style;
    },
    setFilter(layerId, filter) {
      calls.push({ method: "setFilter", args: [layerId, filter] });
    },
    setFeatureState(target, patch) {
      const targetKey = key(target);
      state.set(targetKey, { ...(state.get(targetKey) ?? {}), ...patch });
    },
    getFeatureState(target) {
      return state.get(key(target)) ?? {};
    },
    removeFeatureState(target) {
      state.delete(key(target));
    },
    on() {
      return undefined;
    },
    off() {
      return undefined;
    },
    fitBounds(bounds, options) {
      calls.push({ method: "fitBounds", args: [bounds, options] });
    },
    removeLayer(id) {
      calls.push({ method: "removeLayer", args: [id] });
    },
    removeSource(id) {
      calls.push({ method: "removeSource", args: [id] });
    },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function widget<TKind extends HonuaGeneratedAppWidgetModel["kind"]>(
  model: HonuaGeneratedAppRenderModel,
  id: string,
  kind: TKind,
): Extract<HonuaGeneratedAppWidgetModel, { kind: TKind }> {
  const found = model.widgets.find((entry) => entry.id === id);
  expect(found).toMatchObject({ kind });
  return found as Extract<HonuaGeneratedAppWidgetModel, { kind: TKind }>;
}

function tableWidget(
  model: HonuaGeneratedAppRenderModel,
  id: string,
): Extract<HonuaGeneratedAppWidgetModel, { kind: "table" | "list" }> {
  const found = model.widgets.find((entry) => entry.id === id);
  expect(found?.kind === "table" || found?.kind === "list").toBe(true);
  return found as Extract<HonuaGeneratedAppWidgetModel, { kind: "table" | "list" }>;
}

function widgetResultBase() {
  return {
    schemaVersion: WIDGET_SOURCE_SCHEMA_VERSION,
    sourceId: "incidents",
    protocol: "geoservices-feature-service" as const,
    execution: "server" as const,
    serverPushdown: true,
    cache: {
      metadataCacheable: true,
      resultCacheable: true,
      cacheKey: "generated-app-widget-source-test",
      keyParts: ["generated-app-widget-source-test"],
      status: "computed" as const,
    },
  };
}

async function loadFixtureRuntime() {
  const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
  const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
  const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>("operations-dashboard-features.v1.json");
  const map = makeMockMap();
  const result = await previewGeneratedApp(
    { appPackage, mapPackage },
    {
      mapFactory: () => ({ map }),
      mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
      initialFeatures: features,
    },
  );
  if (result.status === "error") throw new Error(result.errors.map((error) => error.message).join("; "));
  return { ...result, map };
}

describe("@honua/sdk-js/generated-app", () => {
  it("exports a versioned manifest/profile and projects canonical package inputs", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");

    expect(packageJson.exports?.["./generated-app"]).toEqual({
      types: "./dist/src/generated-app/index.d.ts",
      default: "./dist/src/generated-app/index.js",
    });

    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    expect(manifest.format).toBe(HONUA_GENERATED_APP_MANIFEST_FORMAT_V1);
    expect(manifest.profile).toBe(HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1);
    expect(manifest.mapPackage?.mapPackageId).toBe("map-ops-dashboard-v1");

    const artifact = createGeneratedAppManifestArtifact(manifest);
    expect(artifact.artifactKind).toBe(HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND);
    expect(artifact.artifactVersion).toBe(HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION);

    const buildSpecManifest = projectBuildSpecToGeneratedAppManifest({
      id: "build-spec-ops",
      title: "BuildSpec Dashboard",
      sourceId: "incidents",
      bindings: {
        sourceId: "incidents",
        categoryField: "district",
        filterField: "district",
        layerId: "incident-points",
      },
    });
    expect(buildSpecManifest.layout.widgets.map((entry) => entry.kind)).toEqual([
      "map",
      "table",
      "count",
      "chart",
      "filter",
    ]);

    const mapManifest = projectMapPackageToGeneratedAppManifest(mapPackage, {
      appId: "map-derived-app",
      bindings: { categoryField: "district", filterField: "district" },
    });
    expect(mapManifest.data.sourceId).toBe("incidents");
    expect(mapManifest.mapPackageId).toBe("map-ops-dashboard-v1");
  });

  it("clamps generated manifest widget counts and preview limits during projection", () => {
    const widgets = Array.from({ length: HONUA_GENERATED_APP_MAX_WIDGETS + 10 }, (_, index) => ({
      id: `count-${index}`,
      kind: "count" as const,
      sourceId: "incidents",
    }));

    const manifest = projectBuildSpecToGeneratedAppManifest({
      id: "large-build-spec",
      sourceId: "incidents",
      widgets,
      data: { previewLimit: HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT * 10 },
    });

    expect(manifest.layout.widgets).toHaveLength(HONUA_GENERATED_APP_MAX_WIDGETS);
    expect(manifest.data.previewLimit).toBe(HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT);
  });

  it("loads and renders map, table, count, chart, and filter widgets from model-free fixtures", async () => {
    const { model, map } = await loadFixtureRuntime();

    expect(map._calls.some((call) => call.method === "setStyle")).toBe(true);
    expect(widget(model, "map", "map").legend).toHaveLength(1);
    expect(widget(model, "incident-count", "count").value).toBe(5);
    expect(tableWidget(model, "incident-table").rows.map((row) => row.id)).toEqual([1001, 1002, 1003, 1004, 1005]);
    expect(widget(model, "district-chart", "chart").buckets.map((bucket) => [bucket.value, bucket.count])).toEqual([
      ["Downtown", 2],
      ["Harbor", 2],
      ["Windward", 1],
    ]);
    expect(widget(model, "district-filter", "filter").options.map((option) => [option.value, option.count])).toEqual([
      ["Downtown", 2],
      ["Harbor", 2],
      ["Windward", 1],
    ]);
  });

  it("can consume widgetSource models for count, chart, and filter widgets", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>("operations-dashboard-features.v1.json");
    const requestedFields: string[] = [];
    const widgetSource: WidgetSource = {
      source: undefined as never,
      count: async (request) => {
        requestedFields.push("count");
        expect(request?.projection?.filters).toEqual({});
        return {
          ...widgetResultBase(),
          kind: "count",
          value: 42,
          label: "Incidents",
        };
      },
      categories: async (request) => {
        requestedFields.push(request.field);
        return {
          ...widgetResultBase(),
          kind: "categories",
          field: request.field,
          buckets: [
            { value: "Harbor", label: "Harbor", count: 30, percent: 30 / 42 },
            { value: "Downtown", label: "Downtown", count: 12, percent: 12 / 42 },
          ],
        };
      },
      formula: async () => {
        throw new Error("not used");
      },
      histogram: async () => {
        throw new Error("not used");
      },
      timeSeries: async () => {
        throw new Error("not used");
      },
      range: async () => {
        throw new Error("not used");
      },
      topValues: async () => {
        throw new Error("not used");
      },
    };

    const result = await previewGeneratedApp(
      { appPackage, mapPackage },
      {
        mapFactory: () => ({ map: makeMockMap() }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: features,
        widgetSource,
      },
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(widget(result.model, "incident-count", "count").value).toBe(42);
      expect(
        widget(result.model, "district-chart", "chart").buckets.map((bucket) => [bucket.value, bucket.count]),
      ).toEqual([
        ["Harbor", 30],
        ["Downtown", 12],
      ]);
      expect(
        widget(result.model, "district-filter", "filter").options.map((option) => [option.value, option.count]),
      ).toEqual([
        ["Downtown", 12],
        ["Harbor", 30],
        ["Windward", 0],
      ]);
      expect(requestedFields).toEqual(["count", "district", "district"]);
      result.runtime.dispose();
    }
  });

  it("can consume widgetSource histogram and time-series chart models", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>("operations-dashboard-features.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const analyticsManifest: HonuaGeneratedAppManifest = {
      ...manifest,
      layout: {
        ...manifest.layout,
        widgets: manifest.layout.widgets.flatMap((entry) =>
          entry.id === "district-chart"
            ? [
                { ...entry, id: "severity-histogram", chartKind: "histogram" as const, field: "severity", bins: 2 },
                {
                  ...entry,
                  id: "incident-series",
                  chartKind: "time-series" as const,
                  field: "reported_at",
                  interval: { unit: "hour" as const, timezone: "UTC" },
                },
              ]
            : [entry],
        ),
      },
    };
    const requested: string[] = [];
    const widgetSource: WidgetSource = {
      source: undefined as never,
      count: async () => ({ ...widgetResultBase(), kind: "count", value: 5, label: "Incidents" }),
      categories: async (request) => {
        requested.push(`categories:${request.field}`);
        return { ...widgetResultBase(), kind: "categories", field: request.field, buckets: [] };
      },
      histogram: async (request) => {
        requested.push(`histogram:${request.field}:${request.bins}`);
        return {
          ...widgetResultBase(),
          kind: "histogram",
          field: request.field,
          min: 0,
          max: 10,
          bins: [
            { id: "0", min: 0, max: 5, label: "0 - 5", count: 3, percent: 0.6 },
            { id: "1", min: 5, max: 10, label: "5 - 10", count: 2, percent: 0.4 },
          ],
        };
      },
      timeSeries: async (request) => {
        requested.push(
          `timeSeries:${request.field}:${request.interval && typeof request.interval === "object" ? request.interval.unit : request.interval}`,
        );
        return {
          ...widgetResultBase(),
          kind: "time-series",
          field: request.field,
          interval: { unit: "hour", step: 1, timezone: "UTC" },
          totalCount: 5,
          buckets: [
            {
              id: "2026-01-01T00:00:00.000Z",
              start: "2026-01-01T00:00:00.000Z",
              end: "2026-01-01T01:00:00.000Z",
              label: "2026-01-01T00:00Z",
              count: 5,
              percent: 1,
            },
          ],
        };
      },
      formula: async () => {
        throw new Error("not used");
      },
      range: async () => {
        throw new Error("not used");
      },
      topValues: async () => {
        throw new Error("not used");
      },
    };

    const result = await previewGeneratedApp(
      { manifest: analyticsManifest, mapPackage },
      {
        mapFactory: () => ({ map: makeMockMap() }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: features,
        widgetSource,
      },
    );

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(widget(result.model, "severity-histogram", "chart")).toMatchObject({
        chartKind: "histogram",
        field: "severity",
        histogramBins: [
          { id: "0", count: 3 },
          { id: "1", count: 2 },
        ],
      });
      expect(widget(result.model, "incident-series", "chart")).toMatchObject({
        chartKind: "time-series",
        field: "reported_at",
        interval: { unit: "hour", step: 1, timezone: "UTC" },
        timeSeriesBuckets: [{ id: "2026-01-01T00:00:00.000Z", count: 5 }],
      });
      expect(requested).toHaveLength(3);
      expect(requested).toEqual(
        expect.arrayContaining(["histogram:severity:2", "timeSeries:reported_at:hour", "categories:district"]),
      );
      result.runtime.dispose();
    }
  });

  it("requests every bound field needed by the default map-backed loader", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const sourceAttributes: Record<string, unknown> = {
      incident_id: "INC-1001",
      title: "Pump alarm",
      status: "Open",
      district: "Harbor",
      severity: 3,
    };
    const requestedOutFields: string[] = [];
    const requestedLimits: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://mock.honua.test",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        if (url.pathname !== "/rest/services/Incidents/FeatureServer/0/query") {
          return new Response("not found", { status: 404 });
        }

        const outFields = url.searchParams.get("outFields") ?? "";
        requestedOutFields.push(outFields);
        requestedLimits.push(url.searchParams.get("resultRecordCount") ?? "");
        const requestedFields = outFields === "*" ? Object.keys(sourceAttributes) : outFields.split(",");
        const attributes = Object.fromEntries(requestedFields.map((field) => [field, sourceAttributes[field]]));
        return new Response(JSON.stringify({ features: [{ attributes, geometry: null }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const sparseDisplayManifest: HonuaGeneratedAppManifest = {
      ...manifest,
      data: { ...manifest.data, previewLimit: HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT * 10 },
      initialState: { page: { limit: HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT * 10 } },
      bindings: {
        ...manifest.bindings,
        primaryKey: "incident_id",
        titleField: "title",
        subtitleField: "status",
        tableFields: ["title"],
        searchFields: ["district"],
      },
      layout: {
        ...manifest.layout,
        widgets: manifest.layout.widgets.map((entry) => {
          if (entry.kind === "table" || entry.kind === "list") {
            return {
              ...entry,
              fields: ["title"],
              primaryKey: "incident_id",
              titleField: "title",
              subtitleField: "status",
            };
          }
          if (entry.kind === "chart") return { ...entry, groupBy: "district" };
          if (entry.kind === "filter") {
            const { options: _options, ...filterWithoutOptions } = entry;
            return { ...filterWithoutOptions, field: "severity" };
          }
          return entry;
        }),
      },
    };

    const result = await previewGeneratedApp(
      { manifest: sparseDisplayManifest, mapPackage },
      {
        mapFactory: () => ({ map: makeMockMap() }),
        mapLoadOptions: { client, skipCompatibilityCheck: true, applyInitialView: false },
      },
    );

    expect(result.status).toBe("ready");
    expect(requestedOutFields[0]?.split(",")).toEqual(["incident_id", "title", "status", "district", "severity"]);
    expect(requestedLimits[0]).toBe(String(HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT));
    if (result.status === "ready") {
      expect(tableWidget(result.model, "incident-table").rows[0]).toMatchObject({
        id: "INC-1001",
        title: "Pump alarm",
        subtitle: "Open",
      });
      expect(
        widget(result.model, "district-chart", "chart").buckets.map((bucket) => [bucket.value, bucket.count]),
      ).toEqual([["Harbor", 1]]);
      expect(
        widget(result.model, "district-filter", "filter").options.map((option) => [option.value, option.count]),
      ).toEqual([[3, 1]]);
      result.runtime.dispose();
    }
  });

  it("bounds concurrent generated widget source requests", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>("operations-dashboard-features.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const concurrentManifest: HonuaGeneratedAppManifest = {
      ...manifest,
      layout: {
        ...manifest.layout,
        widgets: [
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `extra-count-${index}`,
            kind: "count" as const,
            sourceId: manifest.data.sourceId,
          })),
          ...manifest.layout.widgets,
        ],
      },
    };
    let active = 0;
    let peak = 0;
    const gate = async <T>(value: T): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    };
    const widgetSource: WidgetSource = {
      source: undefined as never,
      count: async () => gate({ ...widgetResultBase(), kind: "count", value: 1, label: "Incidents" }),
      categories: async (request) =>
        gate({ ...widgetResultBase(), kind: "categories", field: request.field, buckets: [] }),
      histogram: async (request) =>
        gate({ ...widgetResultBase(), kind: "histogram", field: request.field, min: 0, max: 0, bins: [] }),
      timeSeries: async (request) =>
        gate({
          ...widgetResultBase(),
          kind: "time-series",
          field: request.field,
          interval: { unit: "day", step: 1, timezone: "UTC" },
          totalCount: 0,
          buckets: [],
        }),
      formula: async () => {
        throw new Error("not used");
      },
      range: async () => {
        throw new Error("not used");
      },
      topValues: async () => {
        throw new Error("not used");
      },
    };

    const result = await previewGeneratedApp(
      { manifest: concurrentManifest, mapPackage },
      {
        mapFactory: () => ({ map: makeMockMap() }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: features,
        widgetSource,
      },
    );

    expect(result.status).toBe("ready");
    expect(peak).toBeLessThanOrEqual(4);
    if (result.status === "ready") result.runtime.dispose();
  });

  it("routes filter, chart, and table interactions through ExplorationContext", async () => {
    const { runtime, map } = await loadFixtureRuntime();
    const selections: unknown[] = [];
    runtime.context.subscribe("selection", (event) => selections.push(event.state.selection));

    let model = runtime.setFilter("district-filter", "Downtown");
    expect(widget(model, "incident-count", "count").value).toBe(2);
    expect(tableWidget(model, "incident-table").rows.map((row) => row.id)).toEqual([1002, 1003]);
    expect(runtime.context.state.filters["district-filter"]).toMatchObject({
      field: "district",
      value: "Downtown",
    });
    await flush();
    expect(map._calls.at(-1)?.args).toEqual(["incident-points", ["all", ["==", "district", "Downtown"]]]);

    model = runtime.selectChartBucket("district-chart", "Harbor");
    expect(widget(model, "incident-count", "count").value).toBe(2);
    expect(tableWidget(model, "incident-table").rows.map((row) => row.id)).toEqual([1001, 1005]);
    expect(runtime.context.state.filters["district-chart"]).toMatchObject({
      field: "district",
      value: "Harbor",
    });

    model = runtime.selectRecord("incident-table", 1005);
    expect(tableWidget(model, "incident-table").rows.find((row) => row.id === 1005)?.selected).toBe(true);
    await flush();
    expect(selections).toHaveLength(1);
    expect(map._state.get("incidents::1005")).toEqual({ selected: true });

    runtime.dispose();
  });

  it("uses table widget sourceId when selecting generated app records", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const tableSourceId = "inspection-records";
    const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>(
      "operations-dashboard-features.v1.json",
    ).map((feature) => ({ ...feature, sourceId: tableSourceId }));
    const multiSourceTableManifest: HonuaGeneratedAppManifest = {
      ...manifest,
      layout: {
        ...manifest.layout,
        widgets: manifest.layout.widgets.map((entry) =>
          entry.id === "incident-table" ? { ...entry, sourceId: tableSourceId } : entry,
        ),
      },
    };
    const result = await previewGeneratedApp(
      { manifest: multiSourceTableManifest, mapPackage },
      {
        mapFactory: () => ({ map: makeMockMap() }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: features,
      },
    );
    if (result.status === "error") throw new Error(result.errors.map((error) => error.message).join("; "));

    const model = result.runtime.selectRecord("incident-table", 1005);

    expect(result.runtime.context.state.selection).toEqual([{ sourceId: tableSourceId, id: 1005 }]);
    expect(tableWidget(model, "incident-table").rows.find((row) => row.id === 1005)).toMatchObject({
      sourceId: tableSourceId,
      selected: true,
    });
    result.runtime.dispose();
  });

  it("keeps unqualified generated app records selectable when a table declares sourceId", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const tableSourceId = "inspection-records";
    const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>(
      "operations-dashboard-features.v1.json",
    ).map((feature) => {
      const { sourceId: _sourceId, ...unqualified } = feature;
      return unqualified;
    });
    const multiSourceTableManifest: HonuaGeneratedAppManifest = {
      ...manifest,
      layout: {
        ...manifest.layout,
        widgets: manifest.layout.widgets.map((entry) =>
          entry.id === "incident-table" ? { ...entry, sourceId: tableSourceId } : entry,
        ),
      },
    };
    const result = await previewGeneratedApp(
      { manifest: multiSourceTableManifest, mapPackage },
      {
        mapFactory: () => ({ map: makeMockMap() }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: features,
      },
    );
    if (result.status === "error") throw new Error(result.errors.map((error) => error.message).join("; "));

    const model = result.runtime.selectRecord("incident-table", 1005);

    expect(result.runtime.context.state.selection).toEqual([{ sourceId: manifest.data.sourceId, id: 1005 }]);
    expect(tableWidget(model, "incident-table").rows.find((row) => row.id === 1005)).toMatchObject({
      sourceId: manifest.data.sourceId,
      selected: true,
    });
    result.runtime.dispose();
  });

  it("uses the manifest-level layerId fallback for map filter bindings", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const features = readFixture<ReadonlyArray<HonuaGeneratedAppFeatureInput>>("operations-dashboard-features.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const map = makeMockMap();
    const withoutWidgetLayerId: HonuaGeneratedAppManifest = {
      ...manifest,
      layout: {
        ...manifest.layout,
        widgets: manifest.layout.widgets.map((entry) => {
          if (entry.kind !== "map") return entry;
          const { layerId: _layerId, ...widgetWithoutLayerId } = entry;
          return widgetWithoutLayerId;
        }),
      },
    };

    const result = await previewGeneratedApp(
      { manifest: withoutWidgetLayerId, mapPackage },
      {
        mapFactory: () => ({ map }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: features,
      },
    );
    if (result.status === "error") throw new Error(result.errors.map((error) => error.message).join("; "));

    expect(widget(result.model, "map", "map").layerId).toBe("incident-points");
    result.runtime.setFilter("district-filter", "Downtown");
    await flush();

    expect(map._calls.filter((call) => call.method === "setFilter").at(-1)?.args).toEqual([
      "incident-points",
      ["all", ["==", "district", "Downtown"]],
    ]);
    result.runtime.dispose();
  });

  it("rejects a MapPackage whose id does not match the manifest contract", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const mismatchedMapPackage: HonuaMapPackage = {
      ...mapPackage,
      mapPackageId: "map-ops-dashboard-v2",
    };
    let mapFactoryCalled = false;

    const result = await previewGeneratedApp(
      { appPackage, mapPackage: mismatchedMapPackage },
      {
        mapFactory: () => {
          mapFactoryCalled = true;
          return { map: makeMockMap() };
        },
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        initialFeatures: [],
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errors[0]).toMatchObject({
        code: "map-package-mismatch",
        stage: "load",
        detail: {
          appId: "app-ops-dashboard-v1",
          expected: "map-ops-dashboard-v1",
          received: "map-ops-dashboard-v2",
        },
      });
    }
    expect(mapFactoryCalled).toBe(false);
  });

  it("disposes partially loaded map resources when initial feature refresh fails", async () => {
    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const map = makeMockMap();
    let disposedHostMap = false;

    const result = await previewGeneratedApp(
      { manifest, mapPackage },
      {
        mapFactory: () => ({
          map,
          dispose: () => {
            disposedHostMap = true;
          },
        }),
        mapLoadOptions: { client: makeClient(), skipCompatibilityCheck: true, applyInitialView: false },
        featureLoader: async () => {
          throw new Error("fixture loader failed");
        },
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errors[0]).toMatchObject({
        code: "data-load-failed",
        stage: "load",
      });
    }
    expect(disposedHostMap).toBe(true);
    expect(map._calls.some((call) => call.method === "removeLayer" && call.args[0] === "incident-points")).toBe(true);
  });

  it("restores generated app linked state snapshots", async () => {
    const { runtime } = await loadFixtureRuntime();
    const snapshot = runtime.snapshot();

    expect(widget(runtime.setFilter("district-filter", "Windward"), "incident-count", "count").value).toBe(1);
    const restored = runtime.restore(snapshot);

    expect(widget(restored, "incident-count", "count").value).toBe(5);
    expect(runtime.context.state.filters).toEqual({});
    runtime.dispose();
  });

  it("reports preview failures as structured diagnostics", async () => {
    const missingArtifact = await previewGeneratedApp(
      { appPackage: { id: "app-without-manifest", version: "1.0.0", assets: [] } },
      {},
    );
    expect(missingArtifact.status).toBe("error");
    if (missingArtifact.status === "error") {
      expect(missingArtifact.errors[0]).toMatchObject({
        code: "missing-manifest-artifact",
        stage: "projection",
      });
    }

    const appPackage = readFixture<HonuaGeneratedAppPackage>("operations-dashboard-app-package.v1.json");
    const mapPackage = readFixture<HonuaMapPackage>("operations-dashboard-map-package.v1.json");
    const manifest = projectAppPackageToGeneratedAppManifest(appPackage, { mapPackage });
    const withoutTable: HonuaGeneratedAppManifest = {
      ...manifest,
      layout: {
        ...manifest.layout,
        widgets: manifest.layout.widgets.filter((entry) => entry.kind !== "table" && entry.kind !== "list"),
      },
    };

    const missingTable = await previewGeneratedApp({ manifest: withoutTable, mapPackage }, {});
    expect(missingTable.status).toBe("error");
    if (missingTable.status === "error") {
      expect(missingTable.errors[0]).toMatchObject({
        code: "missing-widget",
        stage: "manifest",
      });
    }
  });
});
