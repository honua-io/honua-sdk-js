// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { sourceFeatureSelectionTarget } from "../../src/exploration/selection.js";
import type { SourceQualifiedFeatureSelectionTarget } from "../../src/exploration/types.js";
import {
  HonuaMapProvider,
  HonuaSelectionProvider,
  HonuaSelectionStore,
  HonuaSourceLayer,
  useHover,
  useMapHoverBinding,
  useMapSelectionBinding,
  useSelection,
} from "../../src/react/index.js";
import { FakeMap, fakeBridgeSource } from "./map-support.js";

afterEach(cleanup);

const target = (id: number): SourceQualifiedFeatureSelectionTarget =>
  sourceFeatureSelectionTarget("honua-parcels", id, {});

function SelectionPanel() {
  const { selected, select, toggle, clear } = useSelection();
  const { hovered } = useHover();
  return (
    <div>
      <span data-testid="selected">{selected.map((entry) => String(entry.id)).join(",")}</span>
      <span data-testid="hovered">{hovered ? String(hovered.id) : "none"}</span>
      <button type="button" data-testid="select-1" onClick={() => select(target(1))}>
        select 1
      </button>
      <button type="button" data-testid="toggle-2-additive" onClick={() => toggle(target(2), { additive: true })}>
        toggle 2
      </button>
      <button type="button" data-testid="clear" onClick={() => clear()}>
        clear
      </button>
    </div>
  );
}

describe("HonuaSelectionProvider + useSelection/useHover", () => {
  it("throws a descriptive error outside a provider", () => {
    function Naked() {
      useSelection();
      return null;
    }
    expect(() => render(<Naked />)).toThrow(/HonuaSelectionProvider/);
  });

  it("shares selection state across sibling non-map components", () => {
    function Mirror() {
      const { selected } = useSelection();
      return <span data-testid="mirror">{selected.length}</span>;
    }
    const view = render(
      <StrictMode>
        <HonuaSelectionProvider>
          <SelectionPanel />
          <Mirror />
        </HonuaSelectionProvider>
      </StrictMode>,
    );

    act(() => view.getByTestId("select-1").click());
    act(() => view.getByTestId("toggle-2-additive").click());
    expect(view.getByTestId("selected").textContent).toBe("1,2");
    expect(view.getByTestId("mirror").textContent).toBe("2");

    // Non-additive select replaces; toggling a selected id removes it.
    act(() => view.getByTestId("select-1").click());
    expect(view.getByTestId("selected").textContent).toBe("1");
    act(() => view.getByTestId("clear").click());
    expect(view.getByTestId("mirror").textContent).toBe("0");
  });

  it("notifies onSelectionChange after each change", () => {
    const changes: number[] = [];
    const view = render(
      <HonuaSelectionProvider onSelectionChange={(selected) => changes.push(selected.length)}>
        <SelectionPanel />
      </HonuaSelectionProvider>,
    );
    act(() => view.getByTestId("select-1").click());
    act(() => view.getByTestId("toggle-2-additive").click());
    expect(changes).toEqual([1, 2]);
  });
});

describe("useMapSelectionBinding / useMapHoverBinding", () => {
  function MapBindings(props: { map: FakeMap; multiSelect?: boolean }) {
    useMapSelectionBinding(props.map, {
      sourceId: "honua-parcels",
      layerIds: ["honua-parcels-point"],
      multiSelect: props.multiSelect,
    });
    useMapHoverBinding(props.map, { sourceId: "honua-parcels", layerIds: ["honua-parcels-point"] });
    return null;
  }

  it("routes map clicks into the shared store and mirrors feature-state", () => {
    const map = new FakeMap();
    const view = render(
      <StrictMode>
        <HonuaSelectionProvider>
          <MapBindings map={map} />
          <SelectionPanel />
        </HonuaSelectionProvider>
      </StrictMode>,
    );

    act(() => map.emit("click", "honua-parcels-point", { features: [{ id: 7 }] }));
    expect(view.getByTestId("selected").textContent).toBe("7");
    expect(map.getFeatureState({ source: "honua-parcels", id: 7 })).toEqual({ selected: true });

    // Click again toggles it off — state mirrored back to false.
    act(() => map.emit("click", "honua-parcels-point", { features: [{ id: 7 }] }));
    expect(view.getByTestId("selected").textContent).toBe("");
    expect(map.getFeatureState({ source: "honua-parcels", id: 7 })).toEqual({ selected: false });
  });

  it("mirrors sidebar-driven selection onto the map (non-map → map)", () => {
    const map = new FakeMap();
    const view = render(
      <HonuaSelectionProvider>
        <MapBindings map={map} />
        <SelectionPanel />
      </HonuaSelectionProvider>,
    );

    act(() => view.getByTestId("select-1").click());
    expect(map.getFeatureState({ source: "honua-parcels", id: 1 })).toEqual({ selected: true });

    act(() => view.getByTestId("clear").click());
    expect(map.getFeatureState({ source: "honua-parcels", id: 1 })).toEqual({ selected: false });
  });

  it("single-select map clicks replace the previous selection's feature-state", () => {
    const map = new FakeMap();
    const view = render(
      <HonuaSelectionProvider>
        <MapBindings map={map} />
        <SelectionPanel />
      </HonuaSelectionProvider>,
    );

    act(() => map.emit("click", "honua-parcels-point", { features: [{ id: 1 }] }));
    act(() => map.emit("click", "honua-parcels-point", { features: [{ id: 2 }] }));
    expect(view.getByTestId("selected").textContent).toBe("2");
    expect(map.getFeatureState({ source: "honua-parcels", id: 1 })).toEqual({ selected: false });
    expect(map.getFeatureState({ source: "honua-parcels", id: 2 })).toEqual({ selected: true });
  });

  it("publishes hover state and clears it on mouseleave", () => {
    const map = new FakeMap();
    const view = render(
      <HonuaSelectionProvider>
        <MapBindings map={map} />
        <SelectionPanel />
      </HonuaSelectionProvider>,
    );

    act(() => map.emit("mousemove", "honua-parcels-point", { features: [{ id: 3 }] }));
    expect(view.getByTestId("hovered").textContent).toBe("3");
    act(() => map.emit("mouseleave", "honua-parcels-point", {}));
    expect(view.getByTestId("hovered").textContent).toBe("none");
  });

  it("removes its listeners and mirrored feature-state on unmount", () => {
    const map = new FakeMap();
    const store = new HonuaSelectionStore();
    const view = render(
      <HonuaSelectionProvider store={store}>
        <MapBindings map={map} />
      </HonuaSelectionProvider>,
    );

    act(() => map.emit("click", "honua-parcels-point", { features: [{ id: 5 }] }));
    expect(map.getFeatureState({ source: "honua-parcels", id: 5 })).toEqual({ selected: true });

    view.unmount();
    expect(map.listenerCount()).toBe(0);
    expect(map.getFeatureState({ source: "honua-parcels", id: 5 })).toEqual({ selected: false });
    // The shared store itself still remembers the selection (state outlives the map binding).
    expect(store.getSnapshot().selected.map((entry) => entry.id)).toEqual([5]);
  });
});

describe("HonuaSourceLayer selection prop", () => {
  it("binds the mounted layers to the enclosing selection provider", async () => {
    const map = new FakeMap();
    const ctrl = fakeBridgeSource();

    const view = render(
      <StrictMode>
        <HonuaSelectionProvider>
          <HonuaMapProvider map={map}>
            <HonuaSourceLayer source={ctrl.source} selection hover />
          </HonuaMapProvider>
          <SelectionPanel />
        </HonuaSelectionProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(map.sources.size).toBe(1));
    act(() => map.emit("click", "honua-parcels-point", { features: [{ id: 9 }] }));
    expect(view.getByTestId("selected").textContent).toBe("9");
    expect(map.getFeatureState({ source: "honua-parcels", id: 9 })).toEqual({ selected: true });

    act(() => map.emit("mousemove", "honua-parcels-point", { features: [{ id: 9 }] }));
    expect(view.getByTestId("hovered").textContent).toBe("9");
  });
});
