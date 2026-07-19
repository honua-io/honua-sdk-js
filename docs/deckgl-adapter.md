# deck.gl binary adapter (experimental)

`@honua/sdk-js/deckgl` is a renderer-neutral boundary between Honua plan/source
identity and deck.gl binary layer data. It is an experimental first slice of
[#388](https://github.com/honua-io/honua-sdk-js/issues/388), not the complete
GPU analytics workstream.

The adapter currently projects scatterplot data from caller-owned typed arrays.
It does not convert to GeoJSON or create one object per feature. Array views are
forwarded to deck.gl unchanged and `projection.metrics.copiedBytes` is always
zero. Default ceilings reject more than 1,000,000 rows, 32 attributes, 64
forwarded properties, or 256 MiB of unique backing allocations before a deck.gl
layer is constructed.

The adapter reads foreign request, data, identity, attribute, and property
descriptors once into a bounded frozen snapshot. Typed-array byte length,
offset, component width, and backing allocation metrics come from JavaScript
intrinsics rather than overridable getters. Attribute offsets and strides must
be component-aligned, and `normalized`, when present, must be boolean.

## Direct GeoArrow Point path

The normative columnar contract can bind a non-null interleaved GeoArrow Point
batch with explicit `OGC:CRS84` longitude/latitude axis evidence directly to a
scatterplot request. Position and feature-id arrays alias the batch's
transferable buffers; no GeoJSON feature or coordinate object is created. In
this excerpt, `renderBatch` is such a validated batch:

```ts doc-test=skip reason="partial excerpt requires an application-owned non-null OGC:CRS84 batch"
import {
  bindGeoArrowPointBatchToDeckGl,
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
```

Contract v1 deliberately accepts only XY/XYZ, interleaved, non-null Point
batches in explicit `OGC:CRS84` for this automatic path. Separated coordinates,
M dimensions, null rows, missing CRS evidence, and projected or latitude-first
CRSs need an explicit gather/filter/reprojection mapping; they fail with a
structured `invalid-data` diagnostic instead of silently copying, dropping
rows, swapping axes, or rendering nulls at `[0, 0]`. The general
`bindColumnarBatchToDeckGl()` seam remains available for callers that explicitly
provide their own bounded binary attributes and coordinate-system properties.

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

## Diagnostics and boundaries

`DECK_GL_CAPABILITIES` is the capability truth for this contract version.
Scatterplot is `gpu-binary`; feature path/polygon, vector tile, H3, Quadbin,
heatmap, cluster, contour, and trips are explicitly `not-implemented`. The
projection diagnostic reports the chosen strategy, input-array precision,
fidelity, and absence of an implicit fallback. Unsupported or malformed paths
throw a typed error rather than materializing feature objects or silently
downgrading.

Remaining #388 work includes additional GeoArrow geometry/layer mappings,
indexed and aggregate layer families,
realtime buffer patch/rebuild rules, direct MapLibre overlay and standalone Deck
hosts, WebGPU boundaries, and the million-feature browser benchmark against
[#387](https://github.com/honua-io/honua-sdk-js/issues/387).
