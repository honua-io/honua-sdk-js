# Mixed-Source Composition

Status: implemented (`#22`). Composition rides on the existing
`@honua/sdk-js/contract` (`SourceDescriptor`, `Dataset`, `Capabilities`,
`Result.degraded[]`) and `@honua/sdk-js/runtime` (`loadMapPackage`)
surfaces; this guide collects the rules that make a heterogeneous
(multi-protocol) `MapPackage` rendered through one MapLibre map honest
about what it can and cannot do.

## Why composition, not a new vocabulary

Operators routinely need a parcels FeatureServer + a WMS basemap + a
STAC overlay + an OData operational layer in one runtime map. The 13
first-party adapters already work in isolation. What was missing was
the rule set that lets `createDataset({ sources: [...] })` accept a
heterogeneous list and `loadMapPackage` project it onto one MapLibre
map without per-protocol app glue, with two non-negotiables:

  - **weakest-capability honesty**: the composition supports a capability
    only when **every** participating source supports it; promising
    `applyEdits` because three of four sources advertise it is the
    worst possible failure mode (silent wrong result), worse than just
    refusing the call.
  - **per-source partial-failure**: one source erroring out — at bind,
    materialization, or query time — must not break the rest of the
    composition. The runtime emits `source-error` for the failed
    source, telemetry sees a `source-bind` span, and the remaining
    sources keep rendering and remain queryable.

The composition surface is intentionally *additive* — it does not
introduce a new abstraction layer beyond the existing `Source` /
`Dataset` / `Capabilities` / `Result.degraded[]` contract. If a feature
needs a new noun, that is a sign the composition surface is wrong, not
a sign to add a noun.

## Quick start

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createDataset,
  intersectCapabilities,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceDescriptor,
} from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js";
import { loadMapPackage } from "@honua/sdk-js/runtime";

const client = new HonuaClient({ baseUrl: "https://honua.example/api" });

const sources: SourceDescriptor[] = [
  {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://example/rest/services/Parcels/FeatureServer/0" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
  },
  {
    id: "imagery",
    protocol: "wms",
    locator: {
      url: "https://example/ogc/services/imagery/wms",
      serviceId: "imagery",
      typeName: "imagery:base",
    },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms,
  },
  {
    id: "permits",
    protocol: "odata",
    locator: { url: "https://example/odata", entitySet: "Permits" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
  },
  {
    id: "scenes",
    protocol: "stac",
    locator: { url: "https://example/stac" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.stac,
  },
];

// Cross-protocol negotiation: the WEAKEST capability set across the
// four sources. WMS contributes only render/tiles/query; STAC adds
// query/queryObjectIds/stream. So the composition's intersection is
// exactly { query }.
const dataset = createDataset({ id: "ops-board", client, sources });
const weakest = intersectCapabilities(dataset.sourceDescriptors);
console.log([...weakest]); // ["query"]
console.log(weakest.has("applyEdits")); // false — WMS and STAC lack it

// Bind to a MapLibre map through the existing runtime path:
const runtime = await loadMapPackage(mapPackage, map, { client });
```

## The weakest-capability rule

`intersectCapabilities` lives in `@honua/sdk-js/contract` and accepts
anything with a `capabilities` field — descriptors, live `Source`
instances, or any structural shape that exposes the set:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { intersectCapabilities } from "@honua/sdk-js/contract";

intersectCapabilities([
  { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"] },
  { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"] },
]);
// → Set { "query", "queryObjectIds", "applyEdits", "stream" }
```

### Worked example: refusing the silent wrong result

```ts doc-test=skip reason="partial excerpt requires application host context"
const fsAndWms = intersectCapabilities([
  { capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"] },
  { capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wms },
]);
fsAndWms.has("applyEdits"); // false — WMS lacks edits
```

A consumer that fans `applyEdits` across both sources without checking
the intersection would silently drop edits to WMS (since WMS would
throw `HonuaCapabilityNotSupportedError`) while edits to FeatureServer
succeeded — a partial-success without a signal. Always ask the
intersection first; route or refuse based on the answer. The companion
helper `unionCapabilities` exists for documentation-style "what *could*
this composition reach if every source were queried independently"
checks; never use it to gate a single fan-out call.

### Per-operation reasoning: partition first, intersect second

`intersectCapabilities` is intentionally *global* across the
participants you hand it. For a render+overlay stack where the
basemap is render-only and only the overlay carries query semantics,
partition first:

```ts doc-test=skip reason="partial excerpt requires application host context"
const featureSources = sources.filter(
  (s) => s.protocol === "ogc-features" || s.protocol === "odata",
);
const renderSources = sources.filter(
  (s) => s.protocol === "wms" || s.protocol === "wmts",
);

intersectCapabilities(featureSources).has("query"); // true
intersectCapabilities(renderSources).has("tiles"); // true
intersectCapabilities([...featureSources, ...renderSources]).size; // 0
```

The "smarter, per-operation per-source matrix" alternative is exactly
the abstraction layer this ticket explicitly does not add. Partitioning
in the consumer is one line; the cost of a new vocabulary layer would
be paid forever.

### Live `Source` vs. `SourceDescriptor`

Pass live `Source` instances when you need post-metadata-negotiation
accuracy — the OData adapter, for example, lazily fetches `$metadata`
on the first capability-gated method and intersects the descriptor's
declared `Capabilities` with the server's advertised flags. Live
sources reflect that intersection; descriptors carry only what the
caller declared. Pass descriptors when you need the cheap, synchronous
answer.

## Per-source partial failure

`Result.degraded[]` carries the canonical channel for "this source
served the call but with a fallback". Each entry now carries an
optional `sourceId` so a consumer fan-out can attribute the
degradation to the exact source that emitted it without parsing the
human-readable `reason`:

```ts doc-test=skip reason="partial excerpt requires application host context"
interface DegradedReason {
  capability: Capability;
  reason: string;
  protocol?: Protocol;
  sourceId?: SourceId; // ← attribution channel for #22 / #29
}
```

The OGC Features and OData adapters populate `sourceId` from
`descriptor.id`; consumers that fan a query out across multiple
sources see attribution out of the box. Other adapters that begin to
emit `degraded[]` should follow the same pattern.

### Bind-time failure: `loadMapPackage` `sourceErrorPolicy`

`loadMapPackage` accepts an additional option:

```ts doc-test=compile
interface LoadOptions {
  sourceErrorPolicy?: "tolerant" | "fail-fast"; // default: "tolerant"
}
```

| Policy        | Behaviour |
| ------------- | --------- |
| `"tolerant"`  | A per-source binding failure (resolver throws, `toHonuaSourceSpec` throws, eager materialization throws) does not abort the load. The failed source is dropped from the composed style along with any layer whose `source` references it; the runtime emits one `source-error` event per failed source after `source-ready` and before `package-loaded`; `HonuaRuntimeTelemetry.error` receives a `source-bind` span. Remaining sources continue to render. |
| `"fail-fast"` | Any per-source binding failure rejects the load with `HonuaMapPackageError({ stage: "source-bind" })`. The historical (single-source) behaviour. |

Configuration-level binding errors (unknown protocol, missing
`locator.url`, duplicate `sourceId`, deferred `workspace_artifact`)
raised by `projectSourceBindings` always fail-fast under either policy
— those are operator errors that must be fixed.

```ts doc-test=skip reason="partial excerpt requires application host context"
const runtime = await loadMapPackage(pkg, map, {
  client,
  // default tolerant — explicit for documentation:
  sourceErrorPolicy: "tolerant",
  telemetry: {
    error: (span) => {
      if (span.kind === "source-bind") {
        console.warn("source bind failed", span.detail, span.error);
      }
    },
  },
  onEvent: (event) => {
    if (event.type === "source-error") {
      console.warn("runtime source-error", event.sourceId, event.error);
    }
  },
});
```

### Query-time failure: `runtime.reportSourceError`

`HonuaMapRuntime` exposes a small shim for consumers that fan a query
out across the dataset and catch a per-source rejection:

```ts doc-test=skip reason="partial excerpt requires application host context"
runtime.reportSourceError("permits", error);
```

The shim emits the existing `source-error` event so listeners do not
have to subscribe to a parallel error channel and pipes the failure
through `HonuaRuntimeTelemetry.error` as a `source-bind` span. It is
idempotent and a no-op on a disposed runtime.

The composition layer intentionally does not ship a `queryAcross()`
operator — query fan-out is an operator-component (`#29`) concern.
What composition guarantees is that the primitives exist:
`dataset.sourceIds()` enumerates participants, each `Source.query()`
runs in isolation against its own protocol, `Result.degraded[]`
carries `sourceId` attribution, and `runtime.reportSourceError`
broadcasts per-source query rejections to listeners.

## Representative scenarios

### 1. GeoServices + OGC Features + WMS basemap + STAC overlay

A four-protocol composition mirroring the operator-board archetype.

```ts doc-test=skip reason="partial excerpt requires application host context"
const sources: SourceDescriptor[] = [
  /* parcels-fs (geoservices-feature-service)
   * permits-ogc (ogc-features)
   * basemap-wms (wms — render-only)
   * scenes-stac (stac)
   */
];

const dataset = createDataset({ id: "ops", client, sources });

// Composition-wide weakest set: query is the only universal capability.
const cap = intersectCapabilities(dataset.sourceDescriptors);
cap.has("query"); // true
cap.has("applyEdits"); // false — WMS/STAC lack edits
cap.has("tiles"); // false — FS/OGC/STAC lack tiles
```

Coverage: `test/contract/composition.test.ts` (per-source query in
isolation, weakest-set assertion) and
`test/honua-mixed-composition-runtime.test.ts` (full
`loadMapPackage` flow against mock fetch routes).

### 2. FeatureServer + OData operational layer

Both protocols expose `applyEdits`. The composition can fan edits to
both. When the OData service does not advertise `$batch` and the
caller asks for `rollbackOnFailure: true`, the OData adapter degrades
to per-call edits and emits a `DegradedReason` carrying
`sourceId: "<odata-source-id>"`. The FeatureServer edit on the same
batch is unaffected — the degradation is per-source, never
per-composition.

```ts doc-test=skip reason="partial excerpt requires application host context"
const odataEdits = await dataset.source("permits-odata")!.applyEdits({
  rollbackOnFailure: true,
  updates: [{ id: 1, attributes: { STATUS: "approved" } }],
});
const reason = odataEdits.degraded?.find((d) => d.sourceId === "permits-odata");
// reason.capability === "applyEdits", reason.protocol === "odata"
```

### 3. WMTS basemap + OGC Features overlay (render + query)

A render-only source paired with a feature source. The full
intersection is empty (render-only sources contribute nothing to
`query`). Partition before intersecting:

```ts doc-test=skip reason="partial excerpt requires application host context"
const renderable = intersectCapabilities([wmtsDescriptor]);
renderable.has("tiles"); // true
const queryable = intersectCapabilities([ogcDescriptor]);
queryable.has("query"); // true
```

The composed style still renders both: the WMTS source provides the
basemap, the OGC overlay provides the queryable layer.

### 4. Partial failure under `loadMapPackage`

A four-source mixed package where one source's binding throws (in the
test, an OGC Features descriptor whose URL does not include the
`/collections/<id>` segment, so `requireOgcLocator` throws at
materialization). Under the default tolerant policy the runtime:

  - drops the failing source from `composedStyle.sources`,
  - drops layers whose `source` references the failed source,
  - emits `{ type: "source-error", sourceId, error }` to all listeners,
  - emits a `source-bind` telemetry error span,
  - still emits `package-loaded` afterwards,
  - keeps every other source queryable through `runtime.dataset.source(id)`.

## Composition matrix

### First-party protocol combinations

Every pair-and-triple from the 13 first-party adapters is composable
through `createDataset` without any additional consumer wiring:

| Adapter family | Adapters |
| --- | --- |
| GeoServices | `geoservices-feature-service`, `geoservices-map-service`, `geoservices-image-service`, `geoservices-geometry-service`, `geoservices-gp-service` |
| OGC API | `ogc-features`, `ogc-tiles`, `ogc-maps` |
| STAC | `stac` |
| WFS / WMS / WMTS | `wfs`, `wms`, `wmts` |
| OData | `odata` |
| MapLibre-native | `maplibre-vector`, `maplibre-raster`, `maplibre-geojson` (rendered via the source bridge, not `Dataset`) |

### `resolveSource` — first-party with a custom adapter

Anything outside the first-party set goes through
`CreateDatasetOptions.resolveSource`. Custom adapters return a
`Source` that implements the canonical envelope; the composition
surface treats them identically to first-party sources for
`intersectCapabilities` and `loadMapPackage`. Examples: an internal
proprietary REST protocol; an experimental adapter under development;
a server flavor of an OGC API endpoint that needs a non-default
content negotiator.

### Render-only

WMS / WMTS / OGC Tiles / OGC Maps and the MapLibre-native sources are
*render-only*. They participate in the composition through the
composed MapLibre style but do not contribute to the canonical
`Source.query` family. `intersectCapabilities` reports that honestly
(WMS contributes only `render`/`tiles`/`query`; the others have no
`query`). For per-operation reasoning, partition before intersecting.

## Adapter author's checklist

When adding a new built-in adapter or an external `resolveSource`
implementation, the composition surface only requires that you:

1. Set the descriptor's `capabilities` to the honest declared set.
2. Honor `capabilityPolicy` (`"strict"` refuses missing capabilities;
   `"degraded"` allows client-side fallback paths).
3. Populate `DegradedReason.sourceId` from `descriptor.id` whenever
   you emit a `degraded` entry — fan-out consumers attribute through
   that field.
4. Make construction side-effect free (no HTTP at `new Adapter(...)`)
   so eager materialization in `loadMapPackage` stays cheap. Lazy
   metadata negotiation (the OData pattern) is the right model when
   you need server-side capability flags.

## Operational gotchas

- **Default behaviour change**: `loadMapPackage` now defaults to
  `sourceErrorPolicy: "tolerant"`. A single-source app whose only
  source fails sees no behavioural change — one-of-one failing means
  the map is empty either way — but the failure is non-silent
  (`source-error` event + telemetry). Pass `"fail-fast"` to restore
  the historical reject-on-any-bind-failure shape.
- **Layer pruning on partial failure**: a layer whose `source`
  references a failed source is dropped from the composed style so
  MapLibre does not throw on a missing source. The legend (`buildLegend`)
  iterates the live style and naturally drops orphan entries.
- **Capability honesty vs. ergonomics**: a 4-source mix containing one
  render-only adapter (WMS) reports no `query` capability across the
  whole composition (because WMS lacks the others). That is
  *intentional*; partition the participants for per-operation answers.
- **OData `$metadata` timing**: pass live `Source` instances to
  `intersectCapabilities` after first call so the negotiated flags
  (post-`$metadata`) flow through.
- **Mixed-source writes**: write coordination across protocols
  (`applyEdits` semantics for transactional mixed-source updates) is
  out of scope for `#22`. Single-source `applyEdits` continues to work
  normally; the contract guarantees per-source attribution on the
  resulting `degraded[]` entries so downstream coordinators can
  reason about partial outcomes.

## Related references

- `docs/shared-client-contract.md` — the canonical `Source` /
  `Dataset` / `Capabilities` vocabulary.
- `docs/protocol-capability-matrix.md` — per-protocol default
  capability sets.
- `docs/maplibre-runtime.md` — `loadMapPackage`,
  `HonuaRuntimeEvent`, telemetry surface.
- `docs/source-binding-alignment.md` — server-side `SourceBinding` to
  SDK descriptor projection.
- `test/contract/composition.test.ts` — composition contract suite.
- `test/honua-mixed-composition-runtime.test.ts` — 4-protocol E2E.
