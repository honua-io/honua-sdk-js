# deck.gl binary adapter (experimental)

`@honua/sdk-js/deckgl` is a renderer-neutral boundary between Honua plan/source
identity and deck.gl binary layer data. It is an experimental first slice of
[#388](https://github.com/honua-io/honua-sdk-js/issues/388), not the complete
GPU analytics workstream.

The adapter currently projects scatterplot data from caller-owned typed arrays.
It does not convert to GeoJSON or create one object per feature. Array views are
forwarded to deck.gl unchanged and `projection.metrics.copiedBytes` is always
zero. Default ceilings reject more than 1,000,000 rows, 32 attributes, or 256
MiB of unique backing allocations before a deck.gl layer is constructed.

## Optional peer

deck.gl is not part of the root SDK dependency graph:

```sh
npm install @deck.gl/layers
```

Load the peer lazily or inject the constructor from an existing deck.gl install:

```ts
import { createDeckGlAdapter, loadDeckGlPeers } from "@honua/sdk-js/deckgl";

const adapter = createDeckGlAdapter({ peers: await loadDeckGlPeers() });
```

Injecting peers is useful for import maps, custom builds, and tests. The lazy
loader never chooses a CDN and reports `HonuaDeckGlAdapterError` with code
`missing-peer` when the package or required export is unavailable.

## Binary projection and picking identity

```ts
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

`featureIds` stays columnar and is only read for a picked row. A caller can map
that result into its exploration/selection state without relying on unstable
deck.gl object identity.

Mounting uses a small host contract so standalone Deck instances and MapLibre
overlay owners can retain control of their own layer collections:

```ts
const mounted = projection.mount(host); // host implements addLayer/removeLayer
mounted.dispose();
adapter.dispose(); // also disposes every still-owned mount; idempotent
```

## Diagnostics and boundaries

`DECK_GL_CAPABILITIES` is the capability truth for this contract version.
Scatterplot is `gpu-binary`; feature path/polygon, vector tile, H3, Quadbin,
heatmap, cluster, contour, and trips are explicitly `not-implemented`. The
projection diagnostic reports the chosen strategy, input-array precision,
fidelity, and absence of an implicit fallback. Unsupported or malformed paths
throw a typed error rather than materializing feature objects or silently
downgrading.

Remaining #388 work includes normative Arrow/GeoArrow mappings after the
columnar data-plane contract lands, indexed and aggregate layer families,
realtime buffer patch/rebuild rules, direct MapLibre overlay and standalone Deck
hosts, WebGPU boundaries, and the million-feature browser benchmark against
[#387](https://github.com/honua-io/honua-sdk-js/issues/387).
