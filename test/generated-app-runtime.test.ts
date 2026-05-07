import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
