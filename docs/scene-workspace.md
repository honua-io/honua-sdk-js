# Scene Workspace Interop

`@honua/app-platform/scene-workspace` is a renderer-neutral coordination layer for
apps that combine a 3D scene, 2D map, table, detail panel, timeline, evidence
tray, and realtime status. It does not import Cesium, MapLibre, or a UI
framework. Renderers translate their native events into typed workspace intents
and subscribe to narrow slices or selectors.

The former `@honua/sdk-js/scene-workspace` subpath is a deprecated 0.1.x
forwarder. New applications should install `@honua/app-platform` plus only the
optional renderer peers they use.

## Support status: beta

**Beta** (issue [#931](https://github.com/honua-io/honua-sdk-js/issues/931)).
The renderer-neutral workspace state, the scene primitive contract, and the
Cesium primitive adapter keep their shape through `@honua/app-platform` 0.1.x:
no export is renamed or removed, and primitive kinds, diagnostic codes, and
renderer capability flags grow additively only. Breaking one of those is a
called-out change in a minor release, never a silent edit.

What may still change inside beta:

- Additive union members — a new primitive kind or diagnostic code can require a
  new arm in an exhaustive `switch`.
- The `cesium` optional-peer floor may rise within 0.1.x.
- Server-authored 3D style types (`Honua3DStyleSpec` and friends) track the
  Honua Server styling contract and may gain fields.

**Still experimental, and deliberately not promoted by proximity:**

| Surface | Why it is held back |
| --- | --- |
| Honua Server scene discovery (`listScenes`, `getScene`, `sceneToRuntimePrimitives`, …) | Server-attached; outside the open-endpoint evidence behind beta. |
| `SceneView` and the elevation/analysis widgets | Execute against Honua Server analysis endpoints. |
| `mountSourceToCesium` / `projectSourceToCesium` | Bounded entity slice, not the production adapter of `#395` — see [Experimental Cesium entity adapter](./cesium-entity-adapter.md). |

The split is enumerated symbol by symbol under `packageLifecycle.surfaceTiers`
in [`config/support-manifest.v1.json`](../config/support-manifest.v1.json) and
projected into [`config/public-surface.json`](../config/public-surface.json). An
export that no tier classifies fails `npm run support:check`, so a new symbol
cannot inherit beta from the directory it lands in.

Evidence backing the promotion — all release-gated, listed in the generated
[surface tiers table](./standalone-capability-matrix.md#surface-tiers):

- Workspace and state-sync fixtures: [`test/scene-workspace.test.ts`](../test/scene-workspace.test.ts),
  [`test/scene-state-sync.test.ts`](../test/scene-state-sync.test.ts).
- Cesium adapter fixtures, including model-layer contract and mount/disposal
  behavior: [`test/cesium-scene-adapter.test.ts`](../test/cesium-scene-adapter.test.ts).
- CRS, vertical-datum, and fidelity diagnostics:
  [`test/scene-primitive-spatial-diagnostics.test.ts`](../test/scene-primitive-spatial-diagnostics.test.ts).
- Bundle isolation — core and 2D consumers never load Cesium, and the
  `@honua/app-platform` split re-exports the scene surface:
  [`scripts/verify-split-packages.mjs`](../scripts/verify-split-packages.mjs),
  budgeted in [`bundle-budgets.json`](../bundle-budgets.json).

Promotion adds no required dependency: `cesium` stays an optional peer that the
adapter imports lazily, and no core or 2D bundle ceiling moved.

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
  attribution, and tile protocol. Every terrain protocol — `terrain-rgb`,
  `raster-dem`, `quantized-mesh`, `image-service`, `i3s`, and `custom` — requires
  a renderable endpoint and in-range tile/zoom/exaggeration values; a missing or
  malformed endpoint fails closed rather than reaching a provider factory. See
  [Terrain diagnostics](#terrain-diagnostics).
- `imagery-layer`: URL-template, WMS, WMTS, single-tile, or ArcGIS imagery with
  explicit service configuration, opacity, attribution, and cache metadata.
  ArcGIS MapServer endpoints use Cesium's native MapServer provider; ImageServer
  endpoints use its `exportImage` operation through a bounded URL template.
  Service parameters override case-insensitive query keys already present in the
  endpoint: URL-template and single-tile bindings append them to the URL, WMS
  forwards them as request parameters, and WMTS forwards them as dimensions.
  WMS and WMTS accept explicit `layer`, `style`, and `format` fields (plus
  `tileMatrixSetId` for WMTS); other provider kinds reject those service fields
  instead of silently ignoring them. Custom subdomains require a `{s}` URL
  placeholder. ArcGIS MapServer rejects `minimumLevel`, which Cesium does not
  expose as a constructor option, while ImageServer URL templates support it.
  ArcGIS imagery URLs must identify a MapServer or ImageServer service. When a
  later layer reuses an ID, its predecessor is removed before replacement.
  Cesium-owned WMS/WMTS operation keys are removed from endpoint URLs, and WMTS
  dimensions that alias provider fields fail closed instead of creating
  case-insensitive KVP conflicts. ImageServer parameters cannot override the
  adapter-owned export format, projection, viewport, or response type.
  Single-tile bindings reject tile-level bounds because the provider represents
  one untiled image and cannot honor minimum or maximum tile levels.
  Provider URLs may be relative, HTTP, or HTTPS; malformed URLs and bindings
  containing userinfo, signed-URL query keys, or credential-like parameters fail
  closed before workspace serialization or provider creation.
- `extrusion`: a source-bound height/base/color definition that MapLibre can
  render as `fill-extrusion`.
- `model-layer`: glTF, 3D Tiles, I3S, or custom model binding for a 3D adapter,
  optionally placed by `position` (lon/lat/height), `rotation` (heading/pitch/roll
  in degrees), and `scale`. Tiled point clouds ride the `3d-tiles` format and
  accept bounded `pointCloudShading` (attenuation, maximum attenuation,
  geometric-error scale, and eye-dome lighting strength/radius), validated as a
  closed record so a misspelled key fails closed instead of silently falling
  back to renderer defaults. Asset URIs obey
  the same credential-free rule as imagery: relative, HTTP, or HTTPS only, with
  userinfo, signed-URL query keys, and credential-like fragment parameters
  rejected before workspace serialization or renderer materialization. Placement
  outside the globe's coordinate ranges, non-finite rotation, non-positive scale,
  and out-of-range shading fail closed rather than producing a silently wrong
  model matrix. See [Model-layer diagnostics](#model-layer-diagnostics).
- `scene-layer-metadata`: SceneServer/mesh/point-cloud metadata preserved when a
  renderer cannot draw it directly.

Elevation-source, imagery-layer, and model-layer primitives additionally accept
an optional `crs` and `verticalDatum`. Both are descriptive plan data and both
round-trip through workspace serialization. See
[Spatial reference and fidelity](#spatial-reference-and-fidelity).

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

### Spatial reference and fidelity

A primitive that renders is not automatically a primitive that renders *in the
right place*. Elevation-source, imagery-layer, and model-layer primitives can
declare the horizontal CRS and vertical datum they were authored against, and
the adapter classifies that declaration against the renderer before a viewer
exists:

| Fidelity | Meaning |
| --- | --- |
| `exact` | The renderer addresses the world in this CRS. Nothing is resampled. |
| `equivalent` | The renderer honors the binding through its own documented reprojection or tiling scheme. Footprints land correctly; samples are resampled. |
| `unsupported` | The renderer cannot honor it. This SDK never reinterprets coordinates or transforms heights, so the binding fails closed. |

This is the same `exact` / `equivalent` / `unsupported` vocabulary the
[shared state synchronizer](#shared-maplibre-and-cesium-state) applies to slice
mappings, and it appears on the diagnostic as an explicit `fidelity` field.

Both shipped adapters declare `RENDERER_WGS84_SPATIAL_CAPABILITIES`: geographic
WGS84 (`EPSG:4326`, `OGC:CRS84`) is exact, the Web Mercator family
(`EPSG:3857` and its `EPSG:900913` / `ESRI:102100` aliases) is equivalent
because both engines reproject it onto a WGS84 globe themselves, and heights are
only honored against the ellipsoidal datum (`EPSG:4979`, spelled
`ellipsoidal-wgs84` on the [Cesium entity path](./cesium-entity-adapter.md)).
A custom adapter declares its own `SceneRuntimeCapabilities.spatial` record;
classification always follows the record, never a hard-coded globe.

Identifiers are normalized before comparison, so `EPSG:3857`, `epsg:3857`,
`3857`, `urn:ogc:def:crs:EPSG::3857`, and
`http://www.opengis.net/def/crs/EPSG/0/3857` are one CRS. An identifier that
cannot be resolved at all is treated as unsupported rather than assumed
compatible.

| Code | Status | Fidelity | Raised when |
| --- | --- | --- | --- |
| `scene-primitive-crs-exact` | `supported` | `exact` | The declared `crs` is one the renderer addresses natively. |
| `scene-primitive-crs-equivalent` | `degraded` | `equivalent` | The renderer reprojects the declared `crs` itself. |
| `scene-primitive-crs-unsupported` | `unsupported` | `unsupported` | The declared `crs` is unresolvable or outside the renderer's record. |
| `scene-primitive-vertical-datum-unsupported` | `unsupported` | `unsupported` | The declared `verticalDatum` is not one the renderer can interpret as scene heights. |

A vertical datum has only two honest states against a renderer that performs no
height transform, so the code vocabulary reuses the entity path's
`vertical-datum-unsupported` spelling rather than inventing a second one: a
datum the renderer can interpret is silent, and one it cannot fails closed.
The horizontal axis reports all three fidelities because `equivalent` is a real
state there — the renderer genuinely does reproject Web Mercator itself.

Only `EPSG:4979` and its `ellipsoidal-wgs84` spelling name the WGS84 ellipsoid
as a *vertical* reference. `EPSG:4326` and `OGC:CRS84` are two-dimensional, so
they classify as an unhonorable vertical datum even though they are exact
horizontal ones; write `EPSG:4979` when the heights really are ellipsoidal.

Three properties hold by construction:

- **Pure.** Classification loads no renderer peer, so a migration analysis can
  run before a viewer exists.
- **Silent when nothing is known.** A primitive that declares neither field
  diagnoses exactly as it did before this contract existed, and so does any
  primitive measured against a renderer that declares no `spatial` record.
  Absence of metadata is never read as agreement.
- **Fail-closed when something is known but unhonorable.** Nothing is reprojected
  or transformed to make a declaration fit, and no fidelity is inferred from an
  identifier the normalizer could not resolve.

This example imports through the deprecated `@honua/sdk-js/scene-workspace`
forwarder so it stays compile-checked in this repository; the identical symbols
are exported from `@honua/app-platform/scene-workspace`.

```ts doc-test=compile
import {
  CESIUM_SCENE_CAPABILITIES,
  diagnoseScenePrimitives,
  type SceneRuntimePrimitive,
} from "@honua/sdk-js/scene-workspace";

const primitives: SceneRuntimePrimitive[] = [
  {
    kind: "elevation-source",
    id: "site-terrain",
    sourceId: "site-terrain",
    protocol: "quantized-mesh",
    url: "https://terrain.example.test/tiles",
    crs: "EPSG:4326",
    verticalDatum: "EPSG:5703", // NAVD88 orthometric heights
  },
];

for (const diagnostic of diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES)) {
  // scene-primitive-vertical-datum-unsupported / unsupported:
  // Cesium heights are ellipsoidal, so this binding never reaches the globe.
  console.log(diagnostic.code, diagnostic.fidelity, diagnostic.status);
}
```

### Terrain diagnostics

Endpoint and range validation runs for every terrain protocol, not just
`terrain-rgb`. `CesiumTerrainProvider.fromUrl` and MapLibre's `raster-dem`
source both fail opaquely on an absent or malformed endpoint, so the check
happens before either is constructed. Applying one primitive directly with
`applyCesiumTerrain()` throws, because the caller asked for exactly that
binding; a batch apply through `applyCesiumScenePrimitives()` or
`applyMapLibreScenePrimitives()` skips the offending primitive and keeps its
diagnostic so the rest of the plan still lands. In every case the live scene's
terrain provider and vertical exaggeration are left as they were — an
unsupported elevation source no longer moves the exaggeration of a terrain it
never loaded.

| Code | Raised when |
| --- | --- |
| `scene-primitive-terrain-source-missing-url` | Neither `url` nor a non-blank `tiles` entry is present. |
| `scene-primitive-terrain-source-url-invalid` | A declared `url` or `tiles` entry is malformed or uses a scheme other than relative/HTTP/HTTPS. `context.invalidFields` names the offenders. |
| `scene-primitive-terrain-range-invalid` | `tileSize`, `exaggeration`, or the zoom range is non-finite, non-positive, out of `0..24`, or inverted. |

### Model-layer diagnostics

A model layer is validated before any renderer peer loads, so an unrenderable
binding never reaches a Cesium factory. Every code below is `error` severity and
`unsupported` status; `applyCesiumScenePrimitives()` skips the primitive and
reports the diagnostic instead of attaching anything.

| Code | Raised when |
| --- | --- |
| `scene-primitive-model-source-missing-uri` | `uri` is absent or blank. |
| `scene-primitive-model-source-uri-invalid` | `uri` is malformed or uses a scheme other than relative/HTTP/HTTPS. |
| `scene-primitive-model-credentials-forbidden` | `uri` carries userinfo or a credential-like query/fragment key. |
| `scene-primitive-model-placement-invalid` | `position`, `rotation`, or `scale` is non-finite, out of range, or non-positive. `context.invalidFields` names the offenders. |
| `scene-primitive-model-point-cloud-shading-invalid` | `pointCloudShading` is set on a non-tiled format, is not a plain data record, or carries an unknown key, a non-boolean toggle, or a non-positive magnitude. `context.invalidFields` names the offenders. |
| `scene-primitive-model-format-not-materialized` | The renderer engine can consume the format but this adapter does not attach it. |
| `scene-primitive-unsupported` | The renderer engine cannot consume the format at all. |

The last two are deliberately distinct. `SceneRuntimeCapabilities.modelLayer`
carries both `formats` (what the engine can consume) and an optional
`materializedFormats` (what the adapter actually attaches). Cesium declares
`i3s` in `formats` because CesiumJS can consume I3S, but omits it from
`materializedFormats` because this adapter does not wire it — so an I3S binding
fails closed with `scene-primitive-model-format-not-materialized` and its
`context.materializedFormats`, instead of reporting `supported` and then
rendering nothing.

## Cesium entity queries

The experimental accepted-plan `Source` to Cesium entity lifecycle is
documented in [Experimental Cesium entity adapter](./cesium-entity-adapter.md).
It is a bounded feature/entity slice alongside the existing terrain, model,
and 3D Tiles primitive adapter; it is not yet the production adapter described
by issue `#395`.

### Cesium layer disposal

Cesium layer handles returned by the primitive adapter own the resources they
materialize. Calling `remove()` is idempotent, and control calls made after
removal are no-ops rather than mutations of a destroyed object.

Tilesets and models are removed through Cesium's primitive collection and then
destroyed exactly once behind an `isDestroyed()` check, so a collection
configured with `destroyPrimitives = false` cannot leak them. Terrain handles
clear the active provider and call its optional `destroy()` method; replacing
terrain destroys the displaced provider immediately, while removing a stale
handle never disturbs the newer provider. Imagery handles control visibility and
opacity, remove their Cesium imagery layer, and destroy an owned provider at
most once.

`setOpacity` is present only where the adapter owns an alpha channel: imagery
layers (`ImageryLayer.alpha`) and glTF/GLB models (`Model.color` alpha). A
`Cesium3DTileset` has no tileset-wide alpha — tileset translucency is a
`Cesium3DTileStyle` concern owned by the server styling contract — so tileset
handles omit `setOpacity` rather than clobbering an applied style. Callers must
feature-detect it.

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
