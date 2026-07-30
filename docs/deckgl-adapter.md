# deck.gl binary adapter (experimental)

`@honua/sdk-js/deckgl` is a renderer-neutral boundary between Honua plan/source
identity and deck.gl binary layer data. It is an experimental slice of
[#388](https://github.com/honua-io/honua-sdk-js/issues/388), not the complete
GPU analytics workstream.

The adapter projects `scatterplot` (point), `feature-path` (line), and
`feature-polygon` (hole-free polygon) data from caller-owned typed arrays. It
does not convert to GeoJSON or create one object per feature. Geometry array
views are forwarded to deck.gl unchanged and `projection.metrics.copiedBytes`
is always zero. Default ceilings reject more than 1,000,000 rows/features, 32
attributes, 64 forwarded properties, or 256 MiB of unique backing allocations
before a deck.gl layer is constructed.

Every successful projection also exposes `projection.gpuContract`. This frozen
evidence records the supported layer kind, the optional peer constructor that
accepted it, feature/vertex counts, and `copiedBytes: 0`. The adapter validates
the constructed peer layer and its id before returning; a malformed peer result
fails with `HonuaDeckGlAdapterError` code `invalid-layer` instead of being
silently treated as a GPU projection. This contract describes the accepted
binary layer boundary only; it does not claim WebGPU availability or device
performance, which remain runtime/browser evidence work.

`feature-path` and `feature-polygon` requests address vertices through a
request-level `data.startIndices` boundary array (one boundary per feature
plus a trailing boundary — the same shape deck.gl's own `PathLayer` and
`SolidPolygonLayer` binary mode expect) rather than one row per vertex. The
adapter forces `_pathType: "open"` on `PathLayer` and `_normalize: false` on
`SolidPolygonLayer` so the peer does not re-normalize (and therefore re-copy)
the geometry it was just handed; both props are reserved and cannot be
overridden through `request.props`. `DeckGlPeers.PathLayer` and
`DeckGlPeers.SolidPolygonLayer` are optional — only required to `project()` the
layer kind that needs them — and report a structured `missing-peer` error when
absent.

The adapter reads foreign request, data, identity, attribute, and property
descriptors once into a bounded frozen snapshot. Typed-array byte length,
offset, component width, and backing allocation metrics come from JavaScript
intrinsics rather than overridable getters. Attribute offsets and strides must
be component-aligned, and `normalized`, when present, must be boolean.

## Direct GeoArrow Point/LineString/Polygon paths

The normative columnar contract can bind a non-null interleaved GeoArrow Point,
LineString, or Polygon batch with explicit `OGC:CRS84` longitude/latitude axis
evidence directly to a `scatterplot`, `feature-path`, or `feature-polygon`
request. Geometry, offsets, and feature-id arrays alias the batch's
transferable buffers; no GeoJSON feature or coordinate object is created. In
this excerpt, `renderBatch` is such a validated batch:

```ts doc-test=skip reason="partial excerpt requires an application-owned non-null OGC:CRS84 batch"
import {
  bindGeoArrowLineBatchToDeckGl,
  bindGeoArrowPointBatchToDeckGl,
  bindGeoArrowPolygonBatchToDeckGl,
  createDeckGlAdapter,
  loadDeckGlPeers,
} from "@honua/sdk-js/deckgl";

const binding = bindGeoArrowPointBatchToDeckGl({
  batch: renderBatch,
  layerId: "incidents",
  props: { radiusUnits: "meters" },
});
const adapter = createDeckGlAdapter({ peers: await loadDeckGlPeers() });
const projection = adapter.project(binding.request);

console.log(binding.metrics);
// { rows, positionBytes, copiedBytes: 0, geoJsonFeaturesMaterialized: 0 }
console.log(projection.metrics.copiedBytes); // 0

// LineString batches bind to a PathLayer request the same way; `metrics.vertices`
// reports the total addressed vertex count alongside `metrics.rows` (path count).
const routeBinding = bindGeoArrowLineBatchToDeckGl({ batch: routeBatch, layerId: "routes" });

// Polygon batches bind to a SolidPolygonLayer request. Contract v1 requires
// exactly one ring per polygon (no holes); holed or empty polygons need an
// explicit bounded gather/retriangulation and fail with `invalid-data`.
const parcelBinding = bindGeoArrowPolygonBatchToDeckGl({ batch: parcelBatch, layerId: "parcels" });
```

Contract v1 deliberately accepts only XY/XYZ, interleaved, non-null geometry in
explicit `OGC:CRS84` for these automatic paths, and — for polygons — exactly
one ring per feature. Separated coordinates, M dimensions, null rows, holes,
empty polygons, missing CRS evidence, and projected or latitude-first CRSs need
an explicit gather/filter/reprojection mapping; they fail with a structured
`invalid-data` diagnostic instead of silently copying, dropping rows, dropping
holes, swapping axes, or rendering nulls at `[0, 0]`. The general
`bindColumnarBatchToDeckGl()` seam remains available for callers that explicitly
provide their own bounded binary attributes, `startIndices` buffer, and
coordinate-system properties.

## Optional peer

deck.gl is not part of the root SDK dependency graph:

```sh
npm install @deck.gl/layers
```

Load the peer lazily or inject the constructor from an existing deck.gl install:

```ts doc-test=compile
import { createDeckGlAdapter, loadDeckGlPeers } from "@honua/sdk-js/deckgl";

const adapter = createDeckGlAdapter({ peers: await loadDeckGlPeers() });
```

Injecting peers is useful for import maps, custom builds, and tests. The lazy
loader never chooses a CDN and reports `HonuaDeckGlAdapterError` with code
`missing-peer` when the package or required export is unavailable.

## Binary projection and picking identity

```ts doc-test=skip reason="partial excerpt requires application host context"
const positions = new Float32Array([157.85, 21.3, 157.86, 21.31]);
const featureIds = new Uint32Array([301, 302]);

const projection = adapter.project({
  layer: "scatterplot",
  layerId: "incidents",
  data: {
    length: 2,
    attributes: {
      getPosition: { value: positions, size: 2 },
    },
  },
  identity: {
    sourceId: "incidents-live",
    planId: "plan:sha256:…",
    sourceVersion: "42",
    featureIds,
  },
  props: { radiusUnits: "meters" },
});

projection.selectionForPick(1);
// { sourceId, planId, sourceVersion, featureId: 302, rowIndex: 1 }
```

`featureIds` is copied once into a private bounded scalar array at projection
construction. Picks never reread caller-owned identity or row-count objects, so
later caller mutation cannot change selection identity. This identity copy is
separate from the binary payload; geometry and attribute buffers remain
zero-copy. A caller can map the pick result into exploration/selection state
without relying on unstable deck.gl object identity.

Mounting uses a small host contract so standalone Deck instances and MapLibre
overlay owners can retain control of their own layer collections:

```ts doc-test=skip reason="partial excerpt requires application host context"
const mounted = projection.mount(host); // host implements addLayer/removeLayer
mounted.dispose();
adapter.dispose(); // also disposes every still-owned mount
```

Successful removal is idempotent. If a host removal throws, the handle stays
owned and reports `dispose-failed`; calling `mounted.dispose()` or
`adapter.dispose()` again retries it. Mount registration happens before the
foreign `addLayer` callback, so synchronous adapter disposal rolls the newly
added layer back before `mount()` returns.

## Shared map state (MapLibre overlay mode)

`#561` adds a focused renderer-state seam so a deck.gl overlay can share
camera and selection with a MapLibre basemap it draws over, without either
side owning the other's core query semantics:

- `bindDeckGlViewportToMap(map, overlay)` — one-directional camera sync. Every
  MapLibre `"move"` event (pan/zoom/rotate/pitch) re-reads `map.getCenter()` /
  `getZoom()` / `getPitch()` / `getBearing()` and pushes a deck.gl `viewState`
  via `overlay.setProps({ viewState })`. `readMapCameraState(map)` reads the
  camera once without binding — useful to seed a standalone `Deck`'s
  `initialViewState`.
- `bindDeckGlPickToExploration(view)` returns a handler for a deck.gl
  `onClick`/`onHover` callback: call it with
  `projection.selectionForPick(info.index)` (or `undefined` when nothing is
  picked) to publish the pick into the same shared exploration selection slice
  MapLibre feature-state bindings use (`src/interactions/exploration-bindings.ts`).
  `selectedFeatureIdSet(selection, sourceId)` reads that shared slice back for
  one source, so an app can derive a GPU "selected" highlight attribute without
  any deck.gl-specific coupling in the exploration layer.
- `combineDeckGlDisposal(...handles)` composes mount handles, view-sync
  bindings, and any other `DeckGlDisposalHandle` into one idempotent lifecycle:
  `dispose()` tears every handle down in reverse-bind order and never touches
  a borrowed host beyond what each handle's own `dispose()` already does.

```ts doc-test=skip reason="partial excerpt requires an application-owned MapLibre map and deck.gl overlay"
import {
  bindDeckGlPickToExploration,
  bindDeckGlViewportToMap,
  combineDeckGlDisposal,
} from "@honua/sdk-js/deckgl";

const viewSync = bindDeckGlViewportToMap(map, overlay);
const onPick = bindDeckGlPickToExploration(explorationView);
overlay.setProps({
  onClick: (info) => onPick(info.index >= 0 ? projection.selectionForPick(info.index) : undefined),
});

const lifecycle = combineDeckGlDisposal(mounted, viewSync);
// ...later:
lifecycle.dispose();
```

Standalone mode (deck.gl owns its own viewport, no MapLibre map) simply does
not use `bindDeckGlViewportToMap` — nothing in `createDeckGlAdapter()` or
`DeckGlProjection` requires a map.

## Diagnostics and boundaries

`DECK_GL_CAPABILITIES` is the capability truth for this contract version.
Scatterplot, feature path, and feature polygon are `gpu-binary`; vector tile,
H3, Quadbin, heatmap, cluster, contour, and trips are explicitly
`not-implemented`. The projection diagnostic reports the chosen strategy,
input-array precision, fidelity, and absence of an implicit fallback.
Unsupported or malformed paths throw a typed error rather than materializing
feature objects or silently downgrading.

Remaining #388 work includes indexed and aggregate layer families (H3/Quadbin,
heatmap, cluster, contour, trips), realtime buffer patch/rebuild rules, WebGPU
boundaries, and the million-feature browser benchmark against
[#387](https://github.com/honua-io/honua-sdk-js/issues/387).
