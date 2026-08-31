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
| `mountSourceToCesium` / `projectSourceToCesium` / `mountCesiumScene` | Has real-Cesium evidence since `#1050`, which also cleared two of the three named blockers — `refresh()` now diffs instead of rebuilding, and `mountCesiumScene` owns both mounts behind one `dispose()`. Held back for the remaining one: there is no symbology surface, and adding it means new required shapes — see [Tier decision](./cesium-entity-adapter.md#tier-decision-issue-1050). |

The split is enumerated symbol by symbol under `packageLifecycle.surfaceTiers`
in [`config/support-manifest.v1.json`](../config/support-manifest.v1.json) and
projected into [`config/public-surface.json`](../config/public-surface.json). An
export that no tier classifies fails `npm run support:check`, so a new symbol
cannot inherit beta from the directory it lands in.

Evidence backing the promotion — all release-gated, listed in the generated
[surface tiers table](./standalone-capability-matrix.md#surface-tiers):

- Workspace and state-sync fixtures: [`test/scene-workspace.test.ts`](../test/scene-workspace.test.ts),
  [`test/scene-state-sync.test.ts`](../test/scene-state-sync.test.ts).
- Cesium adapter fixtures, including the hardened model-layer contract:
  [`test/cesium-scene-adapter.test.ts`](../test/cesium-scene-adapter.test.ts).
- Bounded mount lifecycle — transactional apply, idempotent release, and
  fail-closed limits: [`test/cesium-scene-mount.test.ts`](../test/cesium-scene-mount.test.ts).
- CRS, vertical-datum, and fidelity diagnostics:
  [`test/scene-primitive-spatial-diagnostics.test.ts`](../test/scene-primitive-spatial-diagnostics.test.ts).
- Real-Cesium browser matrix and bounded teardown budgets, described in
  [Real-Cesium browser evidence and teardown budgets](#real-cesium-browser-evidence-and-teardown-budgets):
  [`test/playwright/cesium-scene-adapter-fixtures.spec.mjs`](../test/playwright/cesium-scene-adapter-fixtures.spec.mjs).
- Bundle isolation — core and 2D consumers never load Cesium, and the
  `@honua/app-platform` split re-exports the scene surface:
  [`scripts/verify-split-packages.mjs`](../scripts/verify-split-packages.mjs),
  budgeted in [`bundle-budgets.json`](../bundle-budgets.json).

Promotion adds no required dependency: `cesium` stays an optional peer that the
adapter imports lazily, and no core or 2D bundle ceiling moved.

The browser matrix (`#928`) now crosses camera, quantized-mesh terrain, every
declared imagery protocol, 3D-Tiles tilesets including a `.pnts` point cloud and
the server styling sidecar, and a glTF/GLB model against real Cesium objects,
plus the fail-closed rows for an undeclared imagery protocol and an
unmaterialized model format. Its teardown budgets are measured, its final-canvas
GC floor is documented as a floor rather than asserted away, and its DOM-listener
budget is proven by an injected per-cycle leak.

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

The synchronizer is a transport and never touches a renderer. The two bindings
that do are shipped: `createMapLibreStateSyncPort()` and
`createCesiumStateSyncPort()`.

```ts doc-test=skip reason="ports wrap application-owned renderer instances"
import {
  createCesiumStateSyncPort,
  createMapLibreStateSyncPort,
  createSceneStateSynchronizer,
} from "@honua/app-platform/scene-workspace";

const identity = { sourceId: "live-incidents", planId: "incident-command" };

const mapPort = createMapLibreStateSyncPort(map, {
  id: "map-2d",
  identity,
  // Without a temporal field the port declares `time` outbound-unsupported
  // rather than accepting shared time it cannot apply.
  timeField: "observed_at",
});
const globePort = createCesiumStateSyncPort(viewer, {
  id: "globe-3d",
  identity,
  entityIdForTarget: (target) => `incident-${target.id}`,
  targetForEntityId: (entityId) => ({ sourceId: "live-incidents", id: Number(entityId.slice(9)) }),
});

const sharedState = createSceneStateSynchronizer({
  applicationId: "incident-command",
  ports: [mapPort, globePort],
});
```

Both renderers stay duck-typed: nothing in `src/scene-workspace/` statically
imports either package, and CesiumJS is reached only through a lazy dynamic
import performed on the first apply that needs a Cesium constructor.

### What each port actually drives

| Slice | 2D map | Cesium viewer |
| --- | --- | --- |
| `camera` | `jumpTo` centre/zoom/bearing/pitch/roll through the documented correspondence | `Camera.setView` destination + orientation |
| `selection` | `setFeatureState` on the addressed source | `viewer.selectedEntity` (one focused entity) |
| `filters` | `setFilter`, composed on top of the style's own filter | entity visibility evaluated against entity properties |
| `time` | an epoch-millisecond window on the configured field | `viewer.clock`, through the same clock plan the scene adapter applies |
| `detail` | `setFeatureState` under a separate key | refused: the globe's single focus channel belongs to `selection` |
| `attribution` | shared identifiers for the host to render | shared identifiers; provider credit display is untouched |
| `realtime` | status only | status only |

Each port computes its own `mappings` from what the live renderer can actually
do, so a fidelity claim is never just a string table: a map without a
feature-state API declares `selection` outbound-`unsupported`, a viewer without
a clock declares `time` outbound-`unsupported`, and the synchronizer reports
`unsupported-target` instead of pretending the state landed.

The same rule applies *within* a slice the renderer mostly supports. The 2D
filter language has no expression for `like`, and none for a comparison,
membership or range clause whose published value has the wrong shape, while the
globe evaluates all of them against entity properties. So the 2D `filters`
mapping is `equivalent` rather than `exact`, and a clause addressed at a layer's
source that compiles to nothing is reported as `filters-clause-not-expressible`
naming the clause, operator and field, instead of vanishing from the composed
filter. `compileMapLibreFilterSet()` is the compiler that returns that report
alongside the filter; `compileMapLibreFilters()` is the same call with the
report discarded. A clause whose `appliesTo` excludes the layer's source was
never addressed there and is not reported.

The globe's `time` slice goes through `sceneTimelineToCesiumClockPlan()` and
`applyCesiumClockPlan()` rather than writing the clock itself, so shared time and
adapter-applied time have exactly one set of semantics: the extent is written
before the instant, `speed` becomes the clock multiplier, uninterpretable fields
are named rather than dropped, and a viewer that declares
`clockOwnership: "host"` is left alone (reported as `time-clock-host-owned`)
instead of being fought for transport. `port.dispose()` restores the clock it
displaced.

### The 2D/3D camera correspondence

The renderer-neutral `SceneCameraState` is a globe pose. A 2D map has no camera
height — it has a zoom, which is a statement about ground resolution:

```text
groundResolution(zoom, lat) = C · cos(lat) / (tileSize · 2^zoom)   [m/px]
centreDistance(px)          = 0.5 · viewportHeight / tan(fov / 2)
cameraHeight(m)             = groundResolution · centreDistance(px) · cos(pitch2D)
```

`mapLibreZoomToCameraHeight()` / `mapLibreCameraHeightToZoom()` are that
relationship, and `mapLibreViewToSceneCamera()` / `sceneCameraToMapLibreView()`
are the whole-pose conversions built on it. The correspondence is neither
latitude- nor viewport-independent, and the live port reads the viewport from
the map it is bound to rather than assuming one. Pitch flips convention across
the boundary (`pitch2D = 0` is nadir, which is `pitch = -90` on the globe);
bearing and heading share the compass convention.

Poses a Web Mercator plane cannot hold are clamped and reported, never silently
applied. `sceneCameraToMapLibreView()` returns `degradations` typed by
`SceneCameraDegradationCode` — `camera-latitude-clamped`,
`camera-zoom-clamped`, `camera-pitch-clamped`, `camera-roll-dropped` — and
`fidelity: "exact"` only when nothing was clamped. The live port surfaces the
same records through `port.degradations` and the `onDegraded` callback, each
carrying the requested and applied values.

### Loop closure and convergence

An adapter must publish a strictly increasing local `sequence`. When it emits a
native event caused by applying revision 42, it sets `causeRevision: 42`; the
synchronizer suppresses that echo. Untagged equivalent values and stale local
sequences are also suppressed. Camera and time events are coalesced over one
frame by default while the final state is retained. Delivery to each port is
serialized, failed applies produce diagnostics without poisoning later work,
and detach, abort, and disposal cancel pending work and remove listeners.

The shipped ports close that loop with two rules:

1. **Applied-signature matching.** After applying a delivery the port reads the
   renderer back and records a quantized signature of what it actually holds
   (about 1 cm horizontally, nine significant digits of height, 1/10000 of a
   degree of orientation). The next renderer event whose signature matches is
   published once with `causeRevision`, which the synchronizer records as
   `loop-suppressed`. The acknowledgement is published rather than swallowed so
   loop closure stays observable.
2. **Lossy sides do not write back.** A renderer that clamped what it was given
   applies its best effort, records a degradation, and leaves the shared value
   alone — writing the clamped pose back would drag every other view down to the
   least capable renderer's limits and is the one shape that can oscillate. Both
   the read-back and the delivered value count as echoes, so a change converges
   in one round trip even when the destination renderer applies further
   constraints of its own.

Disposal is owned: `port.dispose()` releases every renderer listener, clears the
feature state it wrote, restores the layer filters it composed, and restores the
entity visibility it changed. The synchronizer's own `dispose()` reaches the
same release through the `AbortSignal` it passes to `subscribe`.

### Attribution and the two slice vocabularies

`sceneAttributionId()` reduces free-form credit text to the identifier charset
the `attribution` slice enforces (`"County orthophotography"` →
`county-orthophotography`), and `sceneAttributionValue()` builds a sorted,
de-duplicated slice value from live provider credits and primitive attribution.
Text that cannot be reduced is dropped rather than guessed at; the safe-id rule
is a boundary to satisfy, not to relax. On the Cesium side, primitive
`attribution` now reaches terrain providers, tilesets, and models as well as
imagery.

`SCENE_STATE_SYNC_SLICES` (7) and `SCENE_WORKSPACE_SLICES` (13) are different
sizes because they answer different questions, and
`SCENE_STATE_SYNC_SLICE_WORKSPACE_CROSSWALK` names the relationship. The wire
vocabulary is what two renderers must agree on; the store vocabulary is what one
workspace notifies its own subscribers about. `time` (wire) is `timeline`
(store) — the only rename. `attribution` maps to `null`: it is derived from what
each renderer credits rather than stored as workspace state. The workspace-only
members (`all`, `scene`, `layers`, `primitives`, `diagnostics`, `evidence`,
`history`) are single-application concerns with nothing to synchronize.

The runnable [shared renderer state fixture](./examples/shared-renderer-state/)
drives real MapLibre and Cesium canvases through these ports and asserts
destination-renderer state — `map.getCenter()`, `map.getZoom()`,
`map.getFilter()`, `map.getFeatureState()`, `viewer.camera.positionCartographic`,
`viewer.selectedEntity`, `viewer.entities.getById(...).show`, `viewer.clock` —
rather than a dictionary the fixture kept for itself. Renderer packages remain
optional peers: the scene-workspace entrypoint has no static MapLibre or Cesium
import.

## Scene Primitives

Scene primitives describe 3D intent without naming a renderer package:

- `camera`: serializable view state separate from source data state.
- `ground` and `elevation-source`: terrain/ground metadata, cache policy,
  attribution, and tile protocol. Every terrain protocol — `terrain-rgb`,
  `raster-dem`, `quantized-mesh`, `image-service`, `i3s`, and `custom` — requires
  a renderable endpoint and in-range tile/zoom/exaggeration values; a missing or
  malformed endpoint fails closed rather than reaching a provider factory. See
  [Terrain diagnostics](#terrain-diagnostics). This is renderer-neutral
  vocabulary, not a claim that every adapter materializes every protocol.
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
an optional `crs`, `verticalDatum`, and `precision`. Every primitive accepts an
optional `cache` and `sourceVersion`. All of them are descriptive plan data and
all of them round-trip through workspace serialization. See
[Spatial reference and fidelity](#spatial-reference-and-fidelity) and
[Precision, cache, and source version](#precision-cache-and-source-version).

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

### Precision, cache, and source version

Placing a binding correctly is not the same as resolving it at the detail the
author claimed. Elevation-source, imagery-layer, and model-layer primitives can
declare a `precision` descriptor, and every primitive can declare `cache`
freshness and a `sourceVersion`. None of it changes what the SDK does to the
data — nothing is resampled, revalidated, or version-negotiated — but all of it
now reaches the diagnostic stream instead of sitting inert in the plan.

```ts doc-test=skip reason="field shape excerpt, not a standalone program"
precision: {
  horizontalMeters?: number;   // finest horizontal detail the binding resolves
  verticalMeters?: number;     // finest height detail the binding resolves
  coordinateFrame?: "geocentric" | "local";
  coordinateStorage?: "float32" | "float64";
}
```

The two magnitudes are **claims**. The other two fields, the declared DEM
`encoding`, and a renderer's own `SceneSpatialCapabilities.precision` floor are
**limits**. A claim is compared against the coarsest limit that applies to its
axis, because a binding resolves no finer than its bluntest instrument.

| Limit | Quantum | Derived from |
| --- | --- | --- |
| `dem-encoding` | 0.1 m (`mapbox`), 1/256 m (`terrarium`) | The published decode formulas. Mapbox Terrain-RGB is `-10000 + (R * 65536 + G * 256 + B) * 0.1`, so 0.1 m is the smallest height step it can express; Terrarium is `(R * 256 + G + B / 256) - 32768`. Applies to `terrain-rgb` and `raster-dem` sources that declare one of those encodings. |
| `geocentric-float32-coordinates` | 0.5 m | A float32 carries a 24-bit significand, so adjacent representable values near the WGS84 semi-major axis are `2 ** (floor(log2 6378137) - 23)` = 0.5 m apart. This is why 3D assets are published in a local frame anchored by a relative-to-centre origin rather than in raw ECEF. |
| `renderer-floor` | Adapter-declared | `SceneRuntimeCapabilities.spatial.precision`. |

| Code | Status | Fidelity | Raised when |
| --- | --- | --- | --- |
| `scene-primitive-precision-exact` | `supported` | `exact` | The claim is at or above the coarsest limit on that axis; the binding is carried as authored. |
| `scene-primitive-precision-equivalent` | `degraded` | `equivalent` | The claim is finer than the coarsest limit; the binding is carried at that coarser quantum. `context` names the axis, the claim, the limit, and its source. |
| `scene-primitive-cache-stale` | `degraded` | — | `cache.status` is `stale`. The scene draws material the plan already knew was out of date. |
| `scene-primitive-cache-bypass` | `supported` | — | `cache.status` is `bypass`. Every request for the material reaches the origin. |
| `scene-primitive-asset-metadata-invalid` | `degraded` | — | A `precision`, `cache`, or `sourceVersion` value could not be read. `context.invalidFields` names them, dotted from the primitive root. |

Four properties hold by construction, and each is a deliberate choice:

- **Silent on half a comparison.** A claim with no declared limit, a limit with
  no claim, an encoding whose quantum the plan does not publish (`custom`, or
  none declared), and a renderer that declares no floor all produce nothing. An
  undeclared `encoding` is never assumed to be the renderer's default, and an
  omitted renderer floor is not read as an unbounded one.
- **No `unsupported` precision fidelity exists.** A binding whose detail exceeds
  a limit still renders, only coarser than authored — which is exactly what
  `equivalent` means. Minting an `unsupported` precision finding would name a
  state that cannot occur, so the vocabulary stops at two, the same way the
  vertical-datum axis stops at one.
- **Neither shipped adapter declares a precision floor.** Cesium encodes
  positions relative to a centre before they reach the GPU, and MapLibre samples
  whatever the DEM encodes; neither imposes a documented sample-spacing limit
  above the binding's own encoding. A number invented for the table would be
  worse than silence, so `RENDERER_WGS84_SPATIAL_CAPABILITIES` omits `precision`
  and a custom adapter declares its own.
- **Descriptive metadata degrades; it never fails closed.** Precision, cache
  state, and source version describe the material behind a binding, and none of
  them can put it in the wrong place, so an unreadable one reports `degraded`
  and the scene still renders. Staying silent is not the alternative: a
  `cache.staus` typo dropped in silence would read as `ready`, so both records
  are validated as closed records and every unknown own key is named.

`sourceVersion` is opaque — a service version, dataset edition, or content
digest, spelled however the publisher spells it. It is never parsed or compared;
it is copied onto the `context` of every diagnostic the primitive raises, so a
finding can be traced back to the material it was computed from.

Cache metadata is reported, not acted on. The SDK does not own the cache: it
never revalidates, refetches, or evicts, and `ready` and `unknown` are both
silent because neither says anything the developer can act on.

**Authorization is deliberately not carried here.** The epic that introduced
this metadata asked scene assets to carry attribution, cache, source-version,
and *authorization* metadata. The first three are on `ScenePrimitiveBase`; the
fourth is refused. A scene primitive that reached workspace serialization
holding a credential or a signed URL would persist it into every snapshot,
history entry, and shared plan, so credential-bearing URIs fail closed
(`scene-primitive-imagery-credentials-forbidden`,
`scene-primitive-model-credentials-forbidden`) with the same fallback in both
cases: *resolve authorization at the host boundary*. The host attaches
credentials to the request — through a fetch interceptor, a signing proxy, or a
Cesium `Resource` it owns — and the plan stays shareable. This is a standing
decision, not an unfinished field.

```ts doc-test=compile
import {
  CESIUM_SCENE_CAPABILITIES,
  diagnoseScenePrimitives,
  type SceneRuntimePrimitive,
} from "@honua/sdk-js/scene-workspace";

const primitives: SceneRuntimePrimitive[] = [
  {
    kind: "model-layer",
    id: "site-model",
    uri: "https://models.example.test/tileset.json",
    format: "3d-tiles",
    sourceVersion: "dem-2026.2",
    cache: { status: "stale", scope: "tiles" },
    // Survey-grade source coordinates rendered through float32 geocentric storage.
    precision: { horizontalMeters: 0.01, coordinateFrame: "geocentric", coordinateStorage: "float32" },
  },
];

for (const diagnostic of diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES)) {
  // scene-primitive-precision-equivalent / degraded / equivalent, then
  // scene-primitive-cache-stale — both carrying context.sourceVersion.
  console.log(diagnostic.code, diagnostic.fidelity, diagnostic.context?.sourceVersion);
}
```

### Terrain diagnostics

Renderer capability validation runs before endpoint validation. The Cesium
adapter advertises and materializes only `quantized-mesh`; it never passes
Terrain-RGB, raster DEM, ImageServer, or custom bindings to
`CesiumTerrainProvider.fromUrl`. MapLibre continues to materialize
`terrain-rgb` and `raster-dem` through its `raster-dem` source path. The other
protocol values remain portable descriptive primitive vocabulary for future or
host-provided adapters.

| Renderer | Materialized terrain protocols | Descriptive-only protocols |
| --- | --- | --- |
| Cesium | `quantized-mesh` | `terrain-rgb`, `raster-dem`, `image-service`, `i3s`, `custom` |
| MapLibre | `terrain-rgb`, `raster-dem` | `quantized-mesh`, `image-service`, `i3s`, `custom` |

For protocols a renderer accepts, endpoint and range validation happens before
the provider/source is constructed. Applying one primitive directly with
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
and 3D Tiles primitive adapter.

It is proven against real Cesium in the same browser lane as the primitive
adapter (`#1050`): entities materialize from a live `Source` and an accepted
plan onto a real `Viewer`, Cesium's own availability decides which of them are
drawn at a given clock instant, polygon interior rings reach the GPU, the entity
ceiling fails closed, and disposal returns the collection to baseline inside the
primitive lane's measured teardown ceilings.

`refresh()` is a diff rather than a rebuild. It runs the mount-diff discipline
the beta primitive path runs on: identity is the projected entity id qualified by
geometry kind, configuration is an order-independent per-facet fingerprint, and a
feature that cannot be fingerprinted is treated as changed. A feature whose row
did not change keeps the **same live `Entity`**, a changed feature keeps it too
and has only the changed facets written onto it, and departures are released last
so a mid-refresh failure cannot leave a hole. The consequence a host can rely on
is that `viewer.selectedEntity`, a tracked entity, and an entity reference the
application holds all survive a refresh — asserted by object identity against a
real `Viewer`.

`mountCesiumScene` is the single owner over both halves: it delegates to the
primitive mount and to each entity mount, bounds the number of sources, and
releases everything behind one idempotent, retryable `dispose()` — entity mounts
first, in reverse acquisition order, then the primitive plan.
`mountScenePrimitivesToCesium` is unchanged and still owns primitives alone.

The slice stays `experimental` regardless, and the reason is recorded rather than
implied: with the refresh diff and the single owner landed, the one remaining
blocker is that there is no symbology surface, and adding it means new required
shapes rather than purely additive ones. See
[Tier decision](./cesium-entity-adapter.md#tier-decision-issue-1050).

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

### Real-Cesium browser evidence and teardown budgets

Everything above is also proven against the real `cesium` package in a real
Chromium page, not only against the unit suite's `vi.mock("cesium")` seam. The
lane lives in `test/playwright/cesium-scene-adapter-fixtures.spec.mjs` and runs
inside the repository's normal browser smoke job:

```bash
npm run build
npm run test:playwright:cesium-scene
```

The fixture mounts one accepted plan through the public
`createCesiumSceneAdapter` surface onto a live `Viewer` and covers every
primitive kind the adapter materializes, plus both non-`supported` outcomes:

| Binding | Kind | Expected outcome |
| --- | --- | --- |
| `fixture-camera` | `camera` | camera driven to the plan's viewpoint |
| `fixture-terrain` | `elevation-source` (`quantized-mesh`) | real `CesiumTerrainProvider`, exaggeration applied |
| `fixture-imagery` | `imagery-layer` (`url-template`) | real `UrlTemplateImageryProvider`, opacity applied |
| `fixture-imagery-mercator` | `imagery-layer` declaring `EPSG:3857` | renders, and reports `scene-primitive-crs-equivalent` at `equivalent` fidelity |
| `fixture-tileset` | `model-layer` (`3d-tiles`) | real `Cesium3DTileset` with loaded content, placed by the primitive's `position` |
| `fixture-model` | `model-layer` (`glb`) | real `Model`, ready, placed and scaled |
| `fixture-i3s` | `model-layer` (`i3s`) | fails closed with `scene-primitive-model-format-not-materialized`; never reaches a Cesium factory |

A second case widens the imagery axis to **every protocol
`CESIUM_SCENE_CAPABILITIES` declares**, mounted together on one viewer. Each row
asserts the provider the adapter routed it to — resolved by `instanceof` against
the live runtime's constructors, since Cesium ships minified — and the request
that provider then put on the wire, which is the only place the adapter's
per-protocol URL and parameter shaping is observable:

| Binding | Protocol | Cesium provider | What the wire shows |
| --- | --- | --- | --- |
| `protocol-url-template` | `url-template` | `UrlTemplateImageryProvider` | `{z}/{x}/{y}` tile requests |
| `protocol-wms` | `wms` | `WebMapServiceImageryProvider` | `GetMap` with the primitive's `layer`, `format`, `styles`, and — from `parameters` — `version=1.3.0`, which makes it a `crs=CRS:84` request rather than an `srs` one |
| `protocol-wmts` | `wmts` | `WebMapTileServiceImageryProvider` | KVP `GetTile` with `layer`, `style`, `tilematrixset`, `format` |
| `protocol-single-tile` | `single-tile` | `SingleTileImageryProvider` | one image request, no tile pyramid |
| `protocol-arcgis-map-server` | `arcgis-imagery` (`…/MapServer`) | `ArcGisMapServerImageryProvider` | the `?f=json` service description, then `/export?f=image&layers=show:0&bboxSR=4326` |
| `protocol-arcgis-image-server` | `arcgis-imagery` (`…/ImageServer`) | `UrlTemplateImageryProvider` | the adapter's own `/exportImage?f=image&…&bboxSR=3857&imageSR=3857` template |
| `protocol-unsupported` | `tms` | none | fails closed with `scene-primitive-unsupported`; issues no request |

`arcgis-imagery` appears twice because the adapter forks on the endpoint type,
and a single row would leave half of that fork unproven. The row set is checked
against `CESIUM_SCENE_CAPABILITIES.imagery.protocols` itself rather than against
a copy of it, so a protocol added to the surface without evidence fails the lane
instead of quietly staying uncovered. Each row also declares a distinct
`opacity`, which doubles as a check that layer *n* really is row *n*.

A third case covers the **3D-Tiles content variants**, where what distinguishes
the rows is what the server put in the tileset rather than anything in the
primitive's shape:

- A `.pnts` **point cloud** loads through Cesium's point-cloud content pipeline
  (not a glTF that happens to draw points), the primitive's `pointCloudShading`
  becomes a real `PointCloudShading` on the live tileset with every validated
  field intact, and the points reach the GPU — all 400 in the fixture grid are
  selected for rendering, and the tileset is picked out of a real pick pass.
- A tileset advertising the server's **styling sidecar**
  (`extras.honua_style`, honua-server#1206) has its `style.json` discovered,
  fetched, and applied without the caller asking for it. The applied object is a
  real `Cesium3DTileStyle` carrying both sidecar blocks verbatim, and its colour
  expression is executed by Cesium's own engine rather than merely assigned.
- A tileset that advertises nothing fetches nothing and stays unstyled. That
  silent no-op is half the same contract and would otherwise be invisible.

The styled row binds its tileset by **absolute** URL. The sidecar `uri` is
relative to the `tileset.json` URL and is resolved with `new URL(uri, tilesetUrl)`,
so a bare root-relative tileset URI is not a parseable base and the adapter falls
back to fetching the raw `uri` against the document. Server-issued tileset URLs
are absolute, so that is what the fixture binds.

Every asset — the glTF/GLB, both glTF-content 3D-Tiles tilesets, the `.pnts`
point cloud, the styling sidecar, the quantized-mesh terrain tiles, the imagery
tiles, and the ArcGIS MapServer service description — is generated in-process by
`test/playwright/cesium-scene-fixture-assets.mjs` and served from loopback. The
spec aborts and fails on any off-origin request, so the lane has no network
dependency at all.

The plan is mounted and torn down repeatedly on fresh viewers, and the teardown
of each cycle is measured against fixed budgets:

- Adapter-owned handles are released **before** the viewer is destroyed: the
  scene's primitive collection and imagery collection return to their baseline,
  `terrainProvider` is cleared, and `verticalExaggeration` returns to `1`.
- The viewer reports `isDestroyed()`, its canvas leaves the DOM, and no
  `requestAnimationFrame` callback is left pending.
- DOM event listener retention is bounded as a total across the run. CesiumJS
  binds a fixed handful of listeners to the widget's own elements and drops them
  with the element rather than through `removeEventListener`, which is legitimate
  because those elements are proven collectible; a listener that accumulates
  across cycles is not. The bound is a run total rather than a per-cycle equality
  because asynchronous teardown moves listeners between cycles without leaking
  any.
- Wall-clock ceilings guard against a teardown path that starts blocking rather
  than against runner jitter; the spec records the measured actuals next to the
  ceilings it asserts.
- Every destroyed `Viewer` object graph must become collectible under forced GC,
  bounded by the final-canvas GC floor below.
- CesiumJS pools its `TaskProcessor` web workers globally and deliberately does
  not terminate them on viewer destroy, so the worker budget is non-growth after
  the first cycle rather than zero.

#### The final-canvas GC floor

Chromium keeps the most recently used WebGL canvas — and the drawing buffer
behind it — reachable independently of the page's own references. Nothing the
page does displaces it: dropping every reference does not, and creating a
throwaway context afterwards does not either, which was measured rather than
assumed. So **zero retained canvases is not a property this lane can honestly
assert**, and asserting it anyway would only teach the next reader to relax the
budget the first time it flaked.

What the lane asserts instead is that this is a floor and not a slope:

- at most one canvas survives forced collection, however many cycles ran;
- the survivor is always the *final* cycle's — nothing outlives a non-final
  cycle;
- the same bound holds for live WebGL contexts;
- and the retained count does not scale with the cycle count.

A real retention bug is a slope: it pins one canvas per cycle, so it reports one
per cycle where the floor reports at most one in total. The spec keeps the cycle
count above `floor + 1` and asserts that relationship rather than trusting it, so
the two can never be confused.

#### Proving the listener budget with an injected leak

DOM-listener retention is bounded as a run total rather than as a per-cycle
equality, because asynchronous teardown moves a listener across a cycle boundary
without leaking it (`#1055`). A weaker assertion is only an improvement if it
still fails on the thing it exists to catch, so the lane proves that rather than
arguing it: one case runs the same predicate twice over the same matrix — once
on a clean run, where it must hold, and once with a genuine per-cycle listener
leak injected into the fixture, where it must fail. The injection is a fixture
flag that defaults to off and is switched on only by that case, so nothing in the
committed lane leaks by default.

A further case in the same lane covers application time and realtime deltas
against a live `Viewer`: it mounts a plan with the clock bound, advances
application time, and asserts that `viewer.clock` moved, that a probe entity's
Cesium availability changed answer because of it, and that every layer handle —
and the live `Cesium3DTileset` behind one of them — survived by object identity
with no rebuild boundary crossed. It then drives one configuration delta and
asserts that exactly the changed binding was rebuilt, that the change reached the
renderer (`ImageryLayer.alpha`), and that the unchanged binding was carried
forward untouched. Its teardown is asserted against the same measured ceilings.

Two further cases in the same lane cover the experimental accepted-plan entity
path (`#1050`). One connects to a loopback feature service with `createHonua()`,
accepts a plan with `explainQuery`, mounts it with `mountSourceToCesium`, and
asserts that every projected feature became a real `Cesium.Entity` whose
position, polygon hierarchy, availability, and properties are real Cesium
objects; that Cesium's availability decides what is picked out of a real GPU
pick pass at two clock instants; that a refresh against a changed source
preserves a byte-identical feature's `Entity` **by object identity** — together
with the `viewer.selectedEntity` set on it — while moving the changed one and
releasing the departed one; and that disposal returns the collection to
baseline without accumulating entities, viewers, canvases, or listeners across
cycles. The other runs an entity mount and a primitive mount on one viewer and
asserts that each disposal releases exactly its own resources, that an
over-ceiling mount fails closed without disturbing either, and that the same two
halves under one `mountCesiumScene` owner are released by a single `dispose()`.
Their budgets are the ones measured here, stated as run totals rather than
per-cycle equalities.

Console errors and unhandled rejections fail the lane, matching the sample
console-teardown gate.

## Cesium scene mount lifecycle

`applyCesiumScenePrimitives()` is a one-shot projection: it returns the layer
handles it created and forgets them. Applying twice constructs a second set of
providers, tilesets, and models, and the caller must remember every handle from
the first call or leak it.

`mountScenePrimitivesToCesium()` is the lifecycle-owning entry point. It applies
the plan and returns one handle that owns every renderer resource the adapter
created for as long as that plan is live. Applications hold the mount, not the
handles.

```ts doc-test=compile
import {
  type CesiumSceneRuntimeTarget,
  type SceneRuntimePrimitive,
  mountScenePrimitivesToCesium,
} from "@honua/sdk-js/scene-workspace";

declare const target: CesiumSceneRuntimeTarget;
declare const acceptedPlan: readonly SceneRuntimePrimitive[];
declare const revisedPlan: readonly SceneRuntimePrimitive[];
declare const unmounted: AbortSignal;

const mount = await mountScenePrimitivesToCesium(target, acceptedPlan, {
  signal: unmounted,
  maxLayers: 32,
});

// Revise the plan through the same mount: unchanged primitives are reused,
// primitives that left the plan are disposed.
const revision = await mount.apply(revisedPlan);
console.log(revision.created, revision.reused, revision.disposed);

// One call releases everything the mount owns.
mount.dispose();
```

Four properties define the lifecycle.

**Bounded.** A mount owns at most `maxLayers` layer handles
(`DEFAULT_SCENE_MOUNT_LAYER_LIMIT`, 64, by default). The ceiling counts the
elevation-source, imagery-layer, and model-layer primitives in the plan — the
kinds that each pin one adapter-owned renderer resource — and is enforced before
the Cesium peer is loaded. An over-budget plan is refused with a
`HonuaCesiumSceneMountError` (`layer-limit-exceeded`) and the currently mounted
plan is left exactly as it was, so the ceiling is an admission gate rather than a
post-hoc count.

**Diffed.** Identity is the primitive's kind and id together; configuration is a
stable fingerprint of the whole primitive. A revision reuses each primitive whose
identity *and* fingerprint are unchanged — its Cesium object is never
reconstructed, so visibility and opacity the host applied to the handle survive
the revision — and disposes exactly the handles whose primitive left the plan or
changed. A primitive that cannot be fingerprinted deterministically is treated as
changed and rebuilt, never assumed unchanged. An unchanged `camera` primitive is
not re-applied either, so a revision that does not move the view does not yank a
camera the user has navigated.

**Cancellation-safe.** The mount accepts an `AbortSignal`, and `dispose()` fires
its own. Aborting before materialization loads nothing. Aborting during
materialization unwinds through the adapter's transactional rollback: everything
already attached is removed and destroyed, and the terrain provider and vertical
exaggeration are restored. The Cesium asset factories take no `AbortSignal`, so a
load already in flight cannot be stopped at the peer — what the mount guarantees
instead is that the resource it resolves to is destroyed and *never attached*,
rather than landing in a scene the host has abandoned. Aborting a single
`apply()` leaves the previously applied plan mounted and the mount usable.

**Provably released.** `dispose()` releases every handle the mount owns, in
reverse construction order, exactly once, and is idempotent. If a handle refuses
to release, the failures are aggregated and thrown, the mount stays in
`disposing`, and a later `dispose()` retries only what is still owned. The same
retention applies to a handle that refused to release during a revision: the
revision still lands, `scene-mount-disposal-incomplete` is reported, and the
retained handle stays the mount's responsibility.

Rollback is unchanged from the one-shot path: a failure mid-application restores
the scene's pre-application terrain, imagery, and primitives, so a failed
revision leaves the previously applied plan intact and a subsequent `dispose()`
releases exactly that plan.

Diagnostics stay plan-scoped. Every application re-diagnoses the whole plan
against `CESIUM_SCENE_CAPABILITIES`, so a reused primitive still reports its
current model-layer, terrain, and spatial-reference findings even though nothing
was rebuilt for it. The mount adds one `scene-mount-applied` diagnostic per
application whose `context` carries the revision number and the created, reused,
and disposed ids. The two layers answer different questions: plan findings say
whether a binding *can* render where its author meant it, and mount findings say
what the renderer currently owns.

`applyCesiumScenePrimitives()` keeps working unchanged for callers that do not
need a lifecycle; it is the same engine with no diff, no ceiling, and no
ownership.

## Application time, realtime deltas, and rebuild boundaries

The workspace `timeline` slice is canonical application time, and the Cesium
adapter binds it to a live `Clock`. The `realtime` slice travels with the
application that carried it, so a revision driven by a live feed can be read
against the feed state it arrived under.

### Who owns the clock

Time binding is **opt-in on the target**. A `CesiumSceneRuntimeTarget` gains two
optional fields:

```ts doc-test=compile
import {
  type CesiumSceneRuntimeTarget,
  type SceneRuntimePrimitive,
  type SceneWorkspaceState,
  mountScenePrimitivesToCesium,
} from "@honua/sdk-js/scene-workspace";

declare const viewer: {
  camera: CesiumSceneRuntimeTarget["camera"];
  scene: CesiumSceneRuntimeTarget["scene"];
  clock: CesiumSceneRuntimeTarget["clock"];
};
declare const plan: readonly SceneRuntimePrimitive[];
declare const state: SceneWorkspaceState;

// Opting in: the adapter drives `viewer.clock` from `state.timeline`.
const target: CesiumSceneRuntimeTarget = {
  camera: viewer.camera,
  scene: viewer.scene,
  clock: viewer.clock,
};
const mount = await mountScenePrimitivesToCesium(target, plan, { state });

// Advancing time is a revision with the same plan and a moved timeline.
const advanced = await mount.apply(plan, {
  state: { ...state, timeline: { ...state.timeline, currentTime: "2026-03-01T12:00:00Z" } },
});
console.log(advanced.created, advanced.rebuildBoundaries);
```

Three rules define ownership, and each one reports itself:

- **No `clock` on the target** — the adapter never reads or writes a clock.
  A timeline that declares a time is reported as `scene-time-clock-unbound`
  (`degraded`), never silently dropped.
- **`clock` present** (the default `clockOwnership: "adapter"`) — the adapter
  writes `Clock.currentTime` from `timeline.currentTime`, `Clock.startTime` /
  `Clock.stopTime` from `timeline.startTime` / `timeline.endTime` when both
  parse and are ordered, `Clock.shouldAnimate` from `timeline.playing`, and
  `Clock.multiplier` from `timeline.speed`. Only declared fields are written.
- **`clockOwnership: "host"`** — the adapter stands down and writes nothing.
  Declare this when Cesium's own Animation/Timeline widgets or a host simulation
  loop own the clock. The refusal is reported as `scene-time-host-owned`
  (`supported`), so standing down is distinguishable from a missing binding.

Time participates in the adapter's transactional rollback: a failed application
restores the clock alongside the terrain provider and vertical exaggeration.

`defaultSceneStateSyncMappings("cesium").time` already advertised this binding as
`exact` under the code `cesium-clock`; it is now backed by a writer.

### Driving a globe from the temporal playback controller

`createTemporalPlayback()` (`@honua/sdk-js/map`) is the renderer-neutral
play/pause/scrub controller behind `<honua-time-slider>`. It now has a Cesium
sink, so one controller instance can hold a MapLibre filter binding, a
data-to-map bridge `where` clause, a slider view, and a globe at once:

```ts doc-test=compile
import { createTemporalPlayback } from "@honua/sdk-js/map";
import { type CesiumSceneRuntimeTarget, bindTemporalPlaybackToCesium } from "@honua/sdk-js/scene-workspace";

declare const target: CesiumSceneRuntimeTarget;

const playback = createTemporalPlayback({
  extent: ["2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z"],
  windowMs: 60 * 60 * 1000,
  apply: () => undefined,
});

const binding = await bindTemporalPlaybackToCesium(target, playback);
playback.play();
// ...
binding.dispose(); // restores the clock exactly as it was at bind time
playback.dispose();
```

`scene-workspace` never imports `/map`: it declares the structural slice it needs
(`CesiumTemporalPlayback`), the same posture `<honua-time-slider>` takes, so
neither entrypoint gains the other's closure.

Two mappings are worth stating plainly:

- A playback **window** is an interval and a Cesium clock is an **instant**, so
  the mapping is `equivalent`, not exact. The binding writes the window's start
  by default — matching the slider's `aria-valuenow`, `scrub()`, and `progress`
  semantics — and `instant: "window-end"` binds the leading edge instead.
- By default the binding sets `shouldAnimate = false` for as long as it is live:
  the controller is the transport and the SDK is the only writer of
  `currentTime`. `transport: "mirror"` instead follows `playback.playing` and
  scales `Clock.multiplier` by `playback.speed`, so Cesium interpolates between
  the controller's frames and the controller re-anchors it on every tick.

Entity availability needs no extra wiring: Cesium evaluates
`TimeIntervalCollection` availability against `Clock.currentTime`, so a temporal
entity honours the bound application time as soon as the clock does.

### Rebuild boundaries

Every revision through a mount reports what it had to cross. `apply()` returns
`rebuildBoundaries`, one entry per binding, and the mount exposes the most recent
list as `mount.rebuildBoundaries`:

| Boundary | Meaning |
| --- | --- |
| `none` | Applied in place; the renderer resource was reused untouched. |
| `primitive-identity` | The binding was not previously mounted; its resource was constructed. |
| `primitive-configuration` | The configuration fingerprint changed; the resource was rebuilt. |
| `plan-membership` | The binding left the plan; its resource was released. |
| `unfingerprintable` | The primitive could not be fingerprinted deterministically, so it was rebuilt conservatively. |

Each crossing that is **not** `none` also emits a `scene-mount-rebuild-boundary`
diagnostic naming the primitive, its kind, and the boundary in
`context.rebuildBoundary`. The initial application reports no boundaries — with
no previously mounted plan there is nothing to have crossed, and
`scene-mount-applied` already lists what was created.

The load-bearing consequence: **advancing application time crosses no boundary.**
Time lives in the workspace state, never in the plan, so it is outside the
fingerprint the diff runs on. Re-applying the same plan with a moved timeline
reuses every handle by identity and mutates only the clock. A realtime *data*
delta is the other case — it revises a binding's configuration, so exactly that
binding is rebuilt (`primitive-configuration`) while the rest are carried
forward. Both properties are asserted against a real `Viewer`, by object
identity, in `test/playwright/cesium-scene-adapter-fixtures.spec.mjs`.

### Time and delta diagnostic codes

| Code | Severity / status | Meaning |
| --- | --- | --- |
| `scene-time-applied` | info / supported | Application time was written to the bound clock. `context.rebuildBoundary` is `none`. |
| `scene-time-host-owned` | info / supported | The target declares `clockOwnership: "host"`; the adapter reported the time without writing it. |
| `scene-time-clock-unbound` | warning / degraded | The timeline declares a time but no clock is bound to the target. |
| `scene-time-invalid` | warning / degraded | Declared timeline fields could not be interpreted; `context.rejected` names them. |
| `scene-time-runtime-unavailable` | warning / degraded | The loaded `cesium` peer exposes no usable `JulianDate`. |
| `scene-mount-rebuild-boundary` | info / supported | A revision could not update a binding in place; `context.rebuildBoundary` names the crossing. |

### What stays snapshot-only

- **Feature/entity data.** The primitive adapter binds terrain, imagery,
  tilesets, and models. Per-feature deltas remain the experimental entity slice's
  concern, and that slice is still an unconditional remove-then-re-add reported
  honestly as `rebuildBoundary: "entity-snapshot"`. That is now measured rather
  than asserted: the browser lane refreshes a mount against a source where one
  feature is byte-identical and observes that its `Entity` is replaced anyway —
  see [Experimental Cesium entity adapter](./cesium-entity-adapter.md).
- **Sub-primitive updates.** There is no partial mutation of a materialized
  binding: any configuration change rebuilds that binding. Opacity and visibility
  are the exception, because the layer handle owns them directly
  (`setVisible` / `setOpacity`) and neither goes through the plan.
- **Playback history.** The controller keeps only the current window by
  construction; the SDK caches no past windows and pre-fetches nothing.

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
