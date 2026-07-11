# Scene Workspace Interop

`@honua/sdk-js/scene-workspace` is a renderer-neutral coordination layer for
apps that combine a 3D scene, 2D map, table, detail panel, timeline, evidence
tray, and realtime status. It does not import Cesium, MapLibre, or a UI
framework. Renderers translate their native events into typed workspace intents
and subscribe to narrow slices or selectors.

## Sample Pattern

```ts
import {
  createMapLibreSceneAdapter,
  createSceneWorkspace,
  diagnoseScenePrimitives,
  sceneWorkspaceIntentFromAdapterEvent,
  selectSceneEvidenceForFeature,
  selectScenePrimitivesByKind,
  selectSceneVisibleLayers,
} from "@honua/sdk-js/scene-workspace";
import { sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";

const workspace = createSceneWorkspace({
  sceneId: "incident-command",
  title: "Incident Command Scene",
  layers: {
    buildings: { id: "buildings", sourceId: "buildings", title: "Buildings", visible: true, kind: "scene" },
    incidents: { id: "incidents", sourceId: "incidents", title: "Incidents", visible: true, kind: "feature" },
  },
  primitives: {
    terrain: {
      kind: "elevation-source",
      id: "terrain",
      sourceId: "terrain-dem",
      protocol: "terrain-rgb",
      tiles: ["/terrain/{z}/{y}/{x}.png"],
      encoding: "mapbox",
      tileSize: 512,
      exaggeration: 1.25,
      cache: { status: "ready", scope: "tiles", ttlMs: 86400000 },
    },
    buildings: {
      kind: "extrusion",
      id: "buildings",
      sourceId: "buildings",
      height: ["get", "height_m"],
      base: 0,
    },
  },
});

const unsubscribeScene = workspace.subscribe("camera", ({ state }) => {
  cesiumAdapter.flyTo(state.camera);
});

const unsubscribeLayers = workspace.subscribe("layers", ({ state }) => {
  mapAdapter.setVisibleLayers(selectSceneVisibleLayers(state));
});

const unsubscribeSelection = workspace.subscribe("selection", ({ state }) => {
  tableAdapter.highlight(state.selection);
  detailAdapter.renderEvidence(selectSceneEvidenceForFeature(state, "INC-7"));
});

cesiumAdapter.onCameraChange((camera) => {
  workspace.dispatch(sceneWorkspaceIntentFromAdapterEvent({ type: "camera-change", camera }, "scene"));
});

mapAdapter.onFeatureClick((sourceId, id) => {
  workspace.dispatch({
    kind: "set-selection",
    source: "map",
    selection: [sourceFeatureSelectionTarget(sourceId, id)],
  });
});

realtimeAdapter.onStatus((realtime) => {
  workspace.dispatch({ kind: "set-realtime", source: "realtime", realtime });
});
```

The important property is that no adapter calls another adapter directly. The
scene publishes camera or selection state, the map publishes selected features,
the table and detail panel observe the same source-qualified selection, and the
timeline/realtime layer shares status through the same state model.

## Scene Primitives

Scene primitives describe 3D intent without naming a renderer package:

- `camera`: serializable view state separate from source data state.
- `ground` and `elevation-source`: terrain/ground metadata, cache policy,
  attribution, and tile protocol.
- `extrusion`: a source-bound height/base/color definition that MapLibre can
  render as `fill-extrusion`.
- `model-layer`: glTF, 3D Tiles, I3S, or custom model binding for a 3D adapter.
- `scene-layer-metadata`: SceneServer/mesh/point-cloud metadata preserved when a
  renderer cannot draw it directly.

Use MapLibre 2.5D when the experience is a pitched map with raster-dem terrain,
hillshade, and source-bound building or asset extrusions. Use a Cesium or custom
3D adapter when the workflow needs globe navigation, glTF/3D Tiles/I3S model
layers, point clouds, precise ground clamping, or scene-layer symbology.

Adapters declare `SceneRuntimeCapabilities` and can run
`diagnoseScenePrimitives()` before applying state:

```ts
const adapter = createMapLibreSceneAdapter();
const diagnostics = diagnoseScenePrimitives(
  selectScenePrimitivesByKind(workspace.state, "elevation-source"),
  adapter.capabilities,
);

workspace.dispatch(
  sceneWorkspaceIntentFromAdapterEvent({ type: "primitive-diagnostics", diagnostics }, "scene"),
);
```

Diagnostics use `supported`, `degraded`, and `unsupported` states. Degraded
means the app can continue with an explicit fallback, such as rendering a
SceneServer layer as metadata while the MapLibre map keeps terrain and
extrusions active. Unsupported means the primitive should be routed to another
adapter or retained in migration diagnostics rather than silently dropped.

## Cesium entity queries

The experimental accepted-plan `Source` to Cesium entity lifecycle is
documented in [Experimental Cesium entity adapter](./cesium-entity-adapter.md).
It is a bounded feature/entity slice alongside the existing terrain, model,
and 3D Tiles primitive adapter; it is not yet the production adapter described
by issue `#395`.

## Demo Fit

The incident operations dashboard can use this workspace when the map expands
from 2D incident points into a 3D command scene. The same source-qualified
selection targets keep a clicked building, table row, evidence packet, and
detail panel aligned. Realtime transport remains separate; it only publishes
status or deltas that the workspace can expose to renderers.

The Palantir-style operations sample can layer the scene workspace beside the
app workspace from issue `#71`: the app workspace owns cross-app metadata,
jobs, source cache, and reviewable MCP/AI drafts; the scene workspace owns
renderer-neutral 3D view state and scene-specific evidence.

## Boundaries

- Renderer adapters own Cesium/MapLibre/OpenLayers objects.
- The workspace owns serializable scene state and source-qualified selection.
- Cloud Honua queries, realtime subscriptions, and job runs stay in the SDK
  client/app workspace and feed scene intents at the protocol edge.
- Snapshot and restore are value-detached so saved state can be persisted
  without retaining renderer-owned objects.
