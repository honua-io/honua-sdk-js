// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { Query } from "../../src/contract/types.js";
import type { MountSourceOptions, MountedSourceDiagnostics } from "../../src/map/data-to-map-bridge.js";
import { HonuaMapProvider, HonuaSourceLayer, useHonuaMap, useMountedSource } from "../../src/react/index.js";
import { classBreaksRenderer, uniqueValueRenderer } from "../../src/style/index.js";
import type { Renderer } from "../../src/style/renderers.js";
import { type BridgeAttrs, FakeMap, fakeBridgeSource } from "./map-support.js";

afterEach(cleanup);

const DEFAULT_LAYER_IDS = [
  "honua-parcels-point",
  "honua-parcels-line",
  "honua-parcels-polygon",
  "honua-parcels-polygon-outline",
];

function Harness(props: {
  map: FakeMap;
  source: ReturnType<typeof fakeBridgeSource>["source"];
  query?: Readonly<Omit<Query<BridgeAttrs>, "signal">>;
  paint?: MountSourceOptions<BridgeAttrs>["paint"];
  onDiagnostics?: (diagnostics: MountedSourceDiagnostics) => void;
  onError?: (error: unknown) => void;
  hover?: boolean;
}) {
  const { diagnostics } = useMountedSource(props.map, props.source, {
    query: props.query,
    paint: props.paint,
    hover: props.hover,
    onDiagnostics: props.onDiagnostics,
    onError: props.onError,
  });
  return <span data-testid="strategy">{diagnostics?.strategy ?? "pending"}</span>;
}

describe("useMountedSource", () => {
  it("mounts the source and layer matrix and reports diagnostics", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();
    const seen: MountedSourceDiagnostics[] = [];

    const view = render(<Harness map={map} source={ctrl.source} onDiagnostics={(d) => seen.push(d)} />);

    await waitFor(() => expect(view.getByTestId("strategy").textContent).toBe("geojson"));
    expect([...map.sources.keys()]).toEqual(["honua-parcels"]);
    expect([...map.layers.keys()]).toEqual(DEFAULT_LAYER_IDS);
    expect(seen.at(-1)?.featureCount).toBe(2);
  });

  it("disposes every mounted MapLibre resource on unmount", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();

    const view = render(<Harness map={map} source={ctrl.source} hover />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    expect(map.listenerCount()).toBeGreaterThan(0);

    view.unmount();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.listenerCount()).toBe(0);
  });

  it("is StrictMode-safe: double-mount leaks no sources, layers, or listeners", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();

    const view = render(
      <StrictMode>
        <Harness map={map} source={ctrl.source} hover />
      </StrictMode>,
    );

    await waitFor(() => expect(view.getByTestId("strategy").textContent).toBe("geojson"));
    // Let the aborted first mount (and any trailing microtasks) fully settle.
    await waitFor(() => {
      expect(map.sources.size).toBe(1);
      expect([...map.layers.keys()]).toEqual(DEFAULT_LAYER_IDS);
    });

    // Exactly one hover listener pair per interactive layer — the StrictMode
    // ghost mount left nothing behind.
    const expectedListenerKeys = 2 * 3; // mousemove+mouseleave on point/line/polygon
    expect(map.listenerCount()).toBe(expectedListenerKeys);

    view.unmount();
    expect(map.sources.size).toBe(0);
    expect(map.layers.size).toBe(0);
    expect(map.listenerCount()).toBe(0);
    expect(map.featureStates.size).toBe(0);
  });

  it("applies query prop changes through setFilter without tearing down", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();

    const view = render(<Harness map={map} source={ctrl.source} query={{ where: "1=1" }} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    const addCallsAfterMount = map.calls.filter((call) => call.startsWith("addSource")).length;

    view.rerender(<Harness map={map} source={ctrl.source} query={{ where: "STATUS = 'OPEN'" }} />);

    const handle = map.sources.get("honua-parcels");
    await waitFor(() => expect(handle?.setDataCalls.length).toBe(1));
    // No structural churn: same source object, no additional addSource.
    expect(map.calls.filter((call) => call.startsWith("addSource")).length).toBe(addCallsAfterMount);
    expect(ctrl.requests.at(-1)?.where).toBe("STATUS = 'OPEN'");
  });

  it("applies paint prop changes in place via setPaintProperty", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();

    const view = render(
      <Harness map={map} source={ctrl.source} paint={{ point: { "circle-color": "#ff0000" } }} />,
    );
    await waitFor(() => expect(map.sources.size).toBe(1));
    const addSourceCount = map.calls.filter((call) => call.startsWith("addSource")).length;

    view.rerender(<Harness map={map} source={ctrl.source} paint={{ point: { "circle-color": "#00ff00" } }} />);

    await waitFor(() =>
      expect(map.paintCalls).toContainEqual({
        layerId: "honua-parcels-point",
        name: "circle-color",
        value: "#00ff00",
      }),
    );
    expect(map.calls.filter((call) => call.startsWith("addSource")).length).toBe(addSourceCount);

    // Removing the override restores the bridge default for that key.
    view.rerender(<Harness map={map} source={ctrl.source} />);
    await waitFor(() => {
      const last = map.paintCalls.filter((call) => call.name === "circle-color").at(-1);
      expect(last?.value).not.toBe("#00ff00");
      expect(last?.value).toBeDefined();
    });
  });

  it("remounts structurally when the host lacks paint property setters", async () => {
    const map = new FakeMap();
    (map as unknown as Record<string, unknown>).setPaintProperty = undefined;
    (map as unknown as Record<string, unknown>).setLayoutProperty = undefined;
    const ctrl = fakeBridgeSource();

    const view = render(<Harness map={map} source={ctrl.source} />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    const initialAddCount = map.calls.filter((call) => call.startsWith("addSource")).length;

    view.rerender(<Harness map={map} source={ctrl.source} paint={{ point: { "circle-color": "#00ff00" } }} />);

    await waitFor(() =>
      expect(map.calls.filter((call) => call.startsWith("addSource")).length).toBe(initialAddCount + 1),
    );
    // Still exactly one live copy of everything after the remount.
    expect(map.sources.size).toBe(1);
    expect([...map.layers.keys()]).toEqual(DEFAULT_LAYER_IDS);
  });

  it("diffs first-class renderer objects through setRenderer without teardown", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();
    const priority = uniqueValueRenderer({
      field: "priority",
      values: [{ value: "high", color: "#b91c1c" }],
      defaultColor: "#334155",
    });
    const magnitude = classBreaksRenderer({
      field: "magnitude",
      breaks: [{ min: 0, max: 3, color: "#fed976" }],
      defaultColor: "#cccccc",
    });

    function RendererHarness({ renderer }: { renderer: Renderer }) {
      useMountedSource(map, ctrl.source, { renderer });
      return <span data-testid="mounted" />;
    }

    const view = render(
      <StrictMode>
        <RendererHarness renderer={priority} />
      </StrictMode>,
    );
    await waitFor(() => expect(map.sources.size).toBe(1));
    const pointBefore = map.layers.get("honua-parcels-point") as { paint: Record<string, unknown> };
    expect(JSON.stringify(pointBefore.paint["circle-color"])).toContain("priority");
    const addLayerCount = map.calls.filter((call) => call.startsWith("addLayer")).length;
    const removeLayerCount = map.calls.filter((call) => call.startsWith("removeLayer")).length;

    view.rerender(
      <StrictMode>
        <RendererHarness renderer={magnitude} />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(
        map.paintCalls.some((call) => call.layerId === "honua-parcels-point" && call.name === "circle-color"),
      ).toBe(true),
    );
    // Same layer structure: setRenderer diffed paint in place — no
    // teardown/re-add beyond the initial (StrictMode) mount cycle.
    expect(map.calls.filter((call) => call.startsWith("addLayer")).length).toBe(addLayerCount);
    expect(map.calls.filter((call) => call.startsWith("removeLayer")).length).toBe(removeLayerCount);
    const pointAfter = map.layers.get("honua-parcels-point") as { paint: Record<string, unknown> };
    expect(JSON.stringify(pointAfter.paint["circle-color"])).toContain("magnitude");
  });

  it("uses the latest popup render and factory props without remounting", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();
    const openedHtml: string[] = [];
    const makeFactory = (tag: string) => () => {
      const handle = {
        setLngLat: () => handle,
        setDOMContent: () => handle,
        setHTML: (html: string) => {
          openedHtml.push(`${tag}:${html}`);
          return handle;
        },
        addTo: () => handle,
        remove: () => {},
      };
      return handle;
    };

    function PopupHarness({ label, tag }: { label: string; tag: string }) {
      // `factory` and `render` are fresh closures on every render — the hook
      // must deliver the *latest* ones to the bridge without a remount.
      useMountedSource(map, ctrl.source, {
        popup: { factory: makeFactory(tag), render: () => `<b>${label}</b>` },
      });
      return null;
    }

    const click = { lngLat: { lng: -158, lat: 21.3 }, features: [{ id: 1, properties: { OBJECTID: 1 } }] };
    const view = render(<PopupHarness label="first" tag="a" />);
    await waitFor(() => expect(map.sources.size).toBe(1));
    const addSourceCount = map.calls.filter((call) => call.startsWith("addSource")).length;

    act(() => map.emit("click", "honua-parcels-point", click));
    expect(openedHtml).toEqual(["a:<b>first</b>"]);

    view.rerender(<PopupHarness label="second" tag="b" />);
    act(() => map.emit("click", "honua-parcels-point", click));
    expect(openedHtml).toEqual(["a:<b>first</b>", "b:<b>second</b>"]);
    // Callback identity changes never remount the layer set.
    expect(map.calls.filter((call) => call.startsWith("addSource")).length).toBe(addSourceCount);
  });

  it("surfaces mount failures through onError and the error state", async () => {
    const map = new FakeMap();
    const failing = fakeBridgeSource();
    (failing.source as unknown as Record<string, unknown>).queryAll = async () => {
      throw new Error("query exploded");
    };
    const errors: unknown[] = [];

    function ErrorHarness() {
      const { error } = useMountedSource(map, failing.source, { onError: (e) => errors.push(e) });
      return <span data-testid="error">{error instanceof Error ? error.message : "none"}</span>;
    }

    const view = render(<ErrorHarness />);
    await waitFor(() => expect(view.getByTestId("error").textContent).toBe("query exploded"));
    expect(errors).toHaveLength(1);
    expect(map.sources.size).toBe(0);
  });
});

describe("HonuaSourceLayer + external map interop", () => {
  it("resolves the map from HonuaMapProvider (react-maplibre interop shape)", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();
    const seen: MountedSourceDiagnostics[] = [];

    render(
      <StrictMode>
        <HonuaMapProvider map={map}>
          <HonuaSourceLayer
            source={ctrl.source}
            renderer={{ paint: { point: { "circle-color": "#38bdf8" } } }}
            onDiagnostics={(d) => seen.push(d)}
          />
        </HonuaMapProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(map.sources.size).toBe(1));
    expect(seen.at(-1)?.strategy).toBe("geojson");
    const pointLayer = map.layers.get("honua-parcels-point") as { paint?: Record<string, unknown> };
    expect(pointLayer?.paint?.["circle-color"]).toBe("#38bdf8");
  });

  it("waits while the provider map is null and mounts when it arrives", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();

    function Probe() {
      const resolved = useHonuaMap();
      return <span data-testid="has-map">{resolved ? "yes" : "no"}</span>;
    }

    const view = render(
      <HonuaMapProvider map={null}>
        <Probe />
        <HonuaSourceLayer source={ctrl.source} />
      </HonuaMapProvider>,
    );
    expect(view.getByTestId("has-map").textContent).toBe("no");
    expect(map.sources.size).toBe(0);

    view.rerender(
      <HonuaMapProvider map={map}>
        <Probe />
        <HonuaSourceLayer source={ctrl.source} />
      </HonuaMapProvider>,
    );
    expect(view.getByTestId("has-map").textContent).toBe("yes");
    await waitFor(() => expect(map.sources.size).toBe(1));
  });

  it("prefers an explicit map prop over the context map", async () => {
    const contextMap = new FakeMap();
    const explicitMap = new FakeMap();
    const ctrl = fakeBridgeSource();

    render(
      <HonuaMapProvider map={contextMap}>
        <HonuaSourceLayer source={ctrl.source} map={explicitMap} />
      </HonuaMapProvider>,
    );

    await waitFor(() => expect(explicitMap.sources.size).toBe(1));
    expect(contextMap.sources.size).toBe(0);
  });
});
