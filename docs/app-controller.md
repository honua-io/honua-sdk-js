# HonuaController Application API

`HonuaController` is the renderer-neutral application API for common map app
flows. It composes existing `HonuaMapRuntime`, generated-app runtime, and
`ExplorationContext` primitives instead of owning a separate state engine.

```ts
import { createHonuaController } from "@honua/sdk-js/app-controller";
import { loadMapPackage } from "@honua/sdk-js/runtime";

const runtime = await loadMapPackage(mapPackage, map, {
  client,
  skipCompatibilityCheck: true,
});

const controller = createHonuaController({
  runtime,
  layerGroups: {
    operations: ["incident-points", "unit-lines"],
  },
  legendItemLayers: {
    "incidents-0": ["incident-points"],
  },
});

controller.onSelectionChange((event) => {
  renderInspector(event.selection);
});

controller.onIdle((event) => {
  persistSessionState(event.snapshot);
});

controller.fitBounds([-159, 19, -155, 22], { padding: 32 });
controller.selectFeature("incidents", 1001);
controller.setVisibility({
  hide: [{ kind: "layer-group", id: "operations" }],
  show: [{ kind: "legend-item", id: "incidents-0" }],
});

controller.addOverlay({
  id: "dispatch-point",
  kind: "point",
  coordinate: [-157.85, 21.31],
  properties: { status: "active" },
});

controller.addAnnotation({
  id: "dispatch-note",
  kind: "note",
  coordinate: [-157.85, 21.31],
  text: "Temporary session note",
});
```

Snapshots carry exploration state, viewport, visibility, overlays, and
annotations:

```ts
const snapshot = controller.snapshot();
controller.restore(snapshot);
controller.dispose();
```

After `dispose()`, controller operations throw `HonuaControllerError` with
`code: "disposed"` so application teardown can be handled predictably.
