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

## Layer and Source CRUD

`HonuaController` exposes Mapbox-style source and layer operations at the
application boundary. When the controller wraps `HonuaMapRuntime`, these
methods delegate to the runtime's MapLibre adapter; custom adapters can provide
the same methods without exposing a renderer directly.

```ts
const controller = createHonuaController({
  runtime,
  layerSourcePersistence: {
    async save(payload) {
      await saveDraftMap({
        packageId: payload.mapPackage?.mapPackageId,
        style: payload.style,
        mutations: payload.mutations,
        ifMatch: payload.concurrencyToken,
      });
      return { version: "map-version-42" };
    },
    async discard(payload) {
      await discardDraftMap(payload.mapPackage?.mapPackageId);
    },
  },
});

controller.addSource("dispatch", {
  type: "geojson",
  data: { type: "FeatureCollection", features: [] },
});

controller.addLayer(
  {
    id: "dispatch-points",
    type: "circle",
    source: "dispatch",
    paint: { "circle-color": "#00a884", "circle-radius": 6 },
    metadata: { editable: true },
  },
  { beforeId: "incident-points" },
);

controller.setLayerPaint("dispatch-points", { "circle-color": "#006f5f" });
controller.moveLayer("dispatch-points", { position: "top" });
controller.setLayerVisibility("dispatch-points", false);

await controller.saveLayerSourceChanges({ concurrencyToken: "etag-from-server" });
```

The source shape follows MapLibre source entries for native `geojson`,
`vector`, `raster`, `raster-dem`, and protocol-backed sources. Honua custom
sources such as `honua-feature-service`, `honua-map-service`,
`honua-ogc-features`, `honua-wms`, and `honua-wmts` can also be passed through
when the runtime has the corresponding adapter support. Query-tile and hosted
MapPackage bindings should be materialized as runtime source specifications
before calling `addSource`.

Layer operations mirror the Felt-style app workflow: create a source, add one
or more styled layers, update paint/layout/filter/metadata, move the layer in
the render stack, toggle visibility, refresh the backing source, and remove the
layer or source. Invalid mutations fail before the pending mutation list is
updated; runtime-backed controllers surface `HonuaRuntimeDiagnosticError`
diagnostics from the MapLibre style checks.

Runtime-only mutations are ephemeral. `saveLayerSourceChanges()` and
`discardLayerSourceChanges()` call optional hooks with a traceable payload:
pending mutations, current composed style, current MapPackage, and optional
version or concurrency tokens. When no hook is configured, the controller still
tracks and clears local pending mutation state, but it does not write to a
server or restore a previous renderer style.

Snapshots carry exploration state, viewport, visibility, overlays, and
annotations:

```ts
const snapshot = controller.snapshot();
controller.restore(snapshot);
controller.dispose();
```

After `dispose()`, controller operations throw `HonuaControllerError` with
`code: "disposed"` so application teardown can be handled predictably.
