# Scene Workspace Interop

`@honua/app-platform/scene-workspace` is a renderer-neutral coordination layer for
apps that combine a 3D scene, 2D map, table, detail panel, timeline, evidence
tray, and realtime status. It does not import Cesium, MapLibre, or a UI
framework. Renderers translate their native events into typed workspace intents
and subscribe to narrow slices or selectors.

The former `@honua/sdk-js/scene-workspace` subpath is a deprecated 0.1.x
forwarder. New applications should install `@honua/app-platform` plus only the
optional renderer peers they use.

## Sample Pattern

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createMapLibreSceneAdapter,
  createSceneWorkspace,
  diagnoseScenePrimitives,
  sceneWorkspaceIntentFromAdapterEvent,
  selectSceneEvidenceForFeature,
  selectScenePrimitivesByKind,
  selectSceneVisibleLayers,
} from "@honua/app-platform/scene-workspace";
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
    orthophoto: {
      kind: "imagery-layer",
      id: "orthophoto",
      sourceId: "orthophoto",
      protocol: "url-template",
      url: "/imagery/{z}/{x}/{y}.jpg",
      opacity: 0.85,
      attribution: "County orthophotography",
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

## Shared MapLibre and Cesium state

`createSceneStateSynchronizer()` owns a bounded, renderer-neutral lifecycle for
applications that show MapLibre and Cesium together or let a user switch
between them. Ports publish versioned envelopes for `camera`, `selection`,
`filters`, `time`, `detail`, credential-free `attribution`, and `realtime`.
Every accepted envelope carries a monotonic revision, canonical timestamps,
source/schema/plan identity, renderer origin, and an explicit
`exact`/`equivalent`/`unsupported` mapping result.

```ts doc-test=skip reason="ports wrap application-owned renderer instances"
import {
  createSceneStateSynchronizer,
  defaultSceneStateSyncMappings,
} from "@honua/app-platform/scene-workspace";

const sharedState = createSceneStateSynchronizer({
  applicationId: "incident-command",
  ports: [
    {
      id: "map-2d",
      renderer: "maplibre",
      mappings: defaultSceneStateSyncMappings("maplibre"),
      subscribe: (publish, signal) => mapStatePort.subscribe(publish, signal),
      apply: (delivery, signal) => mapStatePort.apply(delivery, signal),
    },
    {
      id: "globe-3d",
      renderer: "cesium",
      mappings: defaultSceneStateSyncMappings("cesium"),
      subscribe: (publish, signal) => globeStatePort.subscribe(publish, signal),
      apply: (delivery, signal) => globeStatePort.apply(delivery, signal),
    },
  ],
});
```

An adapter must publish a strictly increasing local `sequence`. When it emits a
native event caused by applying revision 42, it sets `causeRevision: 42`; the
synchronizer suppresses that echo. Untagged equivalent values and stale local
sequences are also suppressed. Camera and time events are coalesced over one
frame by default while the final state is retained. Delivery to each port is
serialized, failed applies produce diagnostics without poisoning later work,
and detach, abort, and disposal cancel pending work and remove listeners.

MapLibre camera and application time mappings are deliberately `equivalent`:
its center/zoom/pitch cannot preserve a Cesium globe horizon or roll, and it has
no native clock. Selection, protocol-neutral filters, source-qualified detail,
attribution identifiers, and realtime freshness map exactly by default. Apps
must narrow a port's mappings to `unsupported` when their adapter cannot honor
a slice; the synchronizer diagnoses that boundary instead of silently dropping
state.

The runnable [shared renderer state fixture](./examples/shared-renderer-state/)
uses real MapLibre and Cesium canvases and proves bidirectional camera,
selection, filter, and time flow plus loop suppression and cleanup. Renderer
packages remain optional peers: the scene-workspace entrypoint has no static
MapLibre or Cesium import.

## Scene Primitives

Scene primitives describe 3D intent without naming a renderer package:

- `camera`: serializable view state separate from source data state.
- `ground` and `elevation-source`: terrain/ground metadata, cache policy,
  attribution, and tile protocol.
- `imagery-layer`: URL-template, WMS, WMTS, single-tile, or ArcGIS imagery with
  explicit service configuration, opacity, attribution, and cache metadata.
  ArcGIS MapServer endpoints use Cesium's native MapServer provider; ImageServer
  endpoints use its `exportImage` operation through a bounded URL template.
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

```ts doc-test=skip reason="partial excerpt requires application host context"
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

### Cesium layer disposal

Cesium layer handles returned by the primitive adapter own the resources they
materialize. Calling `remove()` is idempotent. Tilesets and models are removed
through Cesium's primitive collection; terrain handles clear the active
provider and call its optional `destroy()` method. Replacing terrain destroys
the displaced provider immediately, while removing a stale handle never
disturbs the newer provider. Imagery handles control visibility and opacity,
remove their Cesium imagery layer, and destroy an owned provider at most once.
The application owns the Cesium `Viewer`/`Scene` itself and must dispose that
target separately.

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
- Each synchronizer is application-instance scoped. It does not coordinate
  browser tabs, persist state, or own renderer objects.
