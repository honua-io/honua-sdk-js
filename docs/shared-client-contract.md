# Shared Client Contract

Status: implemented in `src/contract/` (ticket `honua-sdk-js-23`).

The shared contract is the protocol-neutral vocabulary every Honua data
adapter speaks. It exists so cross-protocol code — exploration views,
visual builders, the server `SourceBinding`/`MapPackage` exporters, and
downstream WFS / WMS / OData adapter tickets — can be written once
against `Dataset` / `Source` / `Query` / `Result` / `MapBinding` rather
than re-litigating the surface in each ticket.

## Goals (and non-goals)

- **Goal:** one canonical name for "the dataset", "the source", "the
  capability", "the query", "the result", "the map binding", and "the
  exploration state" across `HonuaFeatureLayer`, `HonuaMapService`,
  `HonuaOgcFeatures`, and the upcoming WFS / WMS / OData adapters.
- **Goal:** wrap (do not replace) the existing runtime classes in
  `src/core/surfaces.ts`. Existing callers continue to work; adapter
  tickets opt in to the canonical surface.
- **Goal:** stable serialization shape that survives a round-trip with
  the server `SourceBinding` / `MapPackage` documents (see
  [`source-binding-alignment.md`](./source-binding-alignment.md)).
- **Non-goal:** a runtime rewrite. The contract is a typed surface plus
  three thin adapter functions (`geoServicesFeatureSource`,
  `geoServicesMapServiceSource`, `ogcFeaturesSource`).
- **Non-goal:** a query DSL. `Query.where` is still a SQL-92 / CQL2
  string; adapters translate to their wire format.

## Module layout

```
src/contract/
├── index.ts        # barrel — re-exports types and source factories
├── types.ts        # protocol, capability, source, dataset, query, result
└── source.ts       # createDataset + built-in adapters
```

Public entrypoint: `@honua/sdk-js/contract` (also re-exported from the
top-level `@honua/sdk-js` and `@honua/sdk-js/honua` barrels).

## Canonical nouns

| Type | What it is |
| --- | --- |
| `Protocol` | One of twelve identifiers — five GeoServices service types (`geoservices-feature-service`, `geoservices-map-service`, `geoservices-image-service`, `geoservices-geometry-service`, `geoservices-gp-service`), `ogc-features`, `wfs`, `wms`, `odata`, plus three MapLibre-native (`maplibre-vector`, `maplibre-raster`, `maplibre-geojson`). |
| `Capability` | A coarse-grained protocol capability (`query`, `queryAggregate`, `queryExtent`, `queryObjectIds`, `queryRelated`, `applyEdits`, `attachments`, `render`, `tiles`, `sql`, `stream`, `pbf`, `connect`, `image`, `geometry`, `geoprocess`). The canonical `Source` surface standardizes the query / edit / related / attachment / object-id subset today; `image` / `geometry` / `geoprocess` are negotiated for `Source.protocol()` escape hatches because their request shapes are too protocol-specific to belong on the unified envelope. |
| `Capabilities` | `ReadonlySet<Capability>`. Set membership = first-party protocol support, whether the caller consumes it through a canonical `Source` method or the typed protocol escape hatch. Under `strict` (default) a missing capability throws `HonuaCapabilityNotSupportedError`. Under `degraded` only call sites with a defined fallback proceed (today: OGC `queryAggregate` and `queryExtent`); every other missing capability still throws. |
| `SourceLocator` | Protocol-specific endpoint info (`url`, `serviceId`, `layerId`, `collectionId`, `typeName`, `entitySet`, `taskName`). Field-compatible with the server `SourceBinding.locator`. |
| `SourceDescriptor` | `{ id, protocol, locator, capabilities, schema?, attribution? }`. The serializable identity of one source. |
| `Source<T>` | Runtime handle. Methods: `query`, `queryAll`, `queryAggregate`, `queryExtent`, `stream`, `queryObjectIds`, `applyEdits`, `queryRelated`, `attachments` (namespace), `protocol` (typed escape hatch; `adapter` is the legacy alias). |
| `Dataset` | Logical grouping of sources sharing identity. Methods: `source(id)`, `sourceIds()`, `isCompatible()`, `supportsFeature()`. |
| `Query<T>` | `{ where?, spatialFilter?, outFields?, orderBy?, pagination?, aggregation?, returnGeometry?, outSr?, signal? }`. |
| `Result<T>` | `{ features, exceededTransferLimit, totalCount?, aggregateRows?, extent?, fields?, degraded? }`. |
| `EditEnvelope<T>` | `{ adds?, updates?, deletes?, rollbackOnFailure?, signal? }`. Each add / update is a `CanonicalFeature<T>` (attributes + optional geometry + optional id). |
| `EditResult` | `{ added, updated, deleted, degraded? }` — one `EditOutcome` per requested operation. |
| `RelatedQuery` / `RelatedResult<T>` | Canonical related-records request and response. Adapters that lack relationships (OGC, OData, ImageServer) throw rather than return empty groups. |
| `AttachmentApi` | Namespace returned by `Source.attachments`. Methods: `query`, `list`, `add`, `update`, `delete`. Adapters that do not advertise `attachments` throw `HonuaCapabilityNotSupportedError` from each method so the namespace property is always present and capability negotiation stays uniform. |
| `MapBinding` | `{ sourceId, layerIds, style?, minzoom?, maxzoom? }`. Maps onto `MapPackage.sourceBindings` + `MapPackage.mapSpec` server-side. The `@honua/sdk-js/runtime` module consumes a full `MapPackage` on the client — see [`maplibre-runtime.md`](./maplibre-runtime.md). |

## Capability negotiation

Two policies, declared at `createDataset({ capabilityPolicy })`:

- `strict` (default): `Source` operations whose required capability is
  missing throw `HonuaCapabilityNotSupportedError`. Callers can branch on
  `error.capability` and `error.protocol` to swap protocols, fall back, or
  surface the limitation to the user.
- `degraded`: `Source` operations attempt a client-side fallback when the
  server cannot serve the capability natively. The result envelope carries
  `degraded: DegradedReason[]` documenting what was approximated and why.

The capability matrix lives in
[`protocol-capability-matrix.md`](./protocol-capability-matrix.md). Callers
must pass the capability set they want enforced via
`SourceDescriptor.capabilities` — per-source overrides (e.g. downgrading
`queryAggregate` on a Feature Service whose metadata reports
`supportsStatistics: false`) are the caller's responsibility today.
Automatic metadata-driven downgrades inside the adapter constructors are
tracked as future work; when implemented, the adapter will read service
metadata and intersect the declared capability set with what the server
advertises.

The registry is intentionally broader than the current `Source` method list so
downstream adapter tickets can negotiate `render` / `tiles` / `sql` /
`queryObjectIds` / etc. without inventing a second capability vocabulary.

## Source factory

```ts
import { createDataset, type SourceDescriptor } from "@honua/sdk-js/contract";

const dataset = createDataset({
  id: "parcels",
  client,
  capabilityPolicy: "strict",
  sources: [
    {
      id: "parcels-fs",
      protocol: "geoservices-feature-service",
      locator: { url: "...", serviceId: "Parcels", layerId: 0 },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    },
  ] satisfies SourceDescriptor[],
});

const parcels = dataset.source("parcels-fs")!;
const result = await parcels.query({ where: "STATE = 'CA'", pagination: { limit: 100 } });
```

The built-in resolver handles `geoservices-feature-service`,
`geoservices-map-service`, `geoservices-image-service`,
`geoservices-geometry-service`, `geoservices-gp-service`, and
`ogc-features`. WFS / WMS / OData adapters register themselves through
`CreateDatasetOptions.resolveSource`.

The five GeoServices factories cover the surface published in
`honua-server/docs/gis/geoservices-rest-parity.md`:

- `geoServicesFeatureSource` — FeatureServer (query, edits, related,
  attachments, object ids, replica/calculate/validateSQL/append/bins/estimate
  via `protocol()`).
- `geoServicesMapServiceSource` — MapServer (read-only query family,
  related records; export/identify/find/legend/tile via `protocol()`).
- `geoServicesImageSource` — ImageServer (raster catalog query,
  exportImage / identify / tile / legend via `protocol()`).
- `geoServicesGeometryServiceSource` — Geometry Service (utility-only;
  query family throws, operations live behind `protocol()`).
- `geoServicesGPServiceSource` — GP Service (utility-only; submitJob /
  jobStatus / cancelJob / jobResult via `protocol()`).

`Source.queryAll()` and `Source.stream()` drain every page the server
returns — the built-in adapters override the core helpers' 100-page
default so a large `queryAll()` is not silently truncated. Callers who
want a hard cap should paginate with `Query.pagination` (`offset` skips
ahead; `limit` clips, and its meaning depends on the method):

- `query()` — `limit` is the single-page record count.
- `queryAll()` — `limit` is the total-row cap on the materialized result.
  The adapter sizes `pageSize` and `maxPages` from `limit` so the paging
  loop fetches at most `limit + 1` rows; the extra row lets the result
  stamp `exceededTransferLimit: true` when more records exist.
- `stream()` — `limit` is the per-batch page size (not a global cap).
  Each yielded `Result` carries up to `limit` features; callers that
  want a global cap must stop iterating explicitly.

## Compatibility gating

`Dataset.isCompatible()` calls `HonuaClient.checkCompatibility()` once and
caches the result. `Dataset.supportsFeature(feature)` proxies to
`HonuaClient.supportsFeature` for fine-grained checks. Both reuse the
existing compatibility-gate workflow — no new wire calls were introduced.

## Protocol escape hatch

`Source.protocol("geoservices-feature-service")` returns the underlying
`HonuaFeatureLayer` instance (or `undefined` for the wrong kind). The
accessor name is `protocol` because it surfaces protocol-specific
operations — raw `where`, raw `outFields`, GeoServices `calculate` /
`validateSQL` / replica / `queryBins` / `getEstimates` — that the
canonical `Source` surface intentionally does not expose. The
`adapter()` method is preserved as a legacy alias for callers written
against the original ticket-23 surface; it returns the same instance.
The `AdapterTypeMap` interface uses TypeScript declaration merging so
adapter tickets can plug in their own kind → instance type mapping
without touching this file.

```ts
declare module "@honua/sdk-js/contract" {
  interface AdapterTypeMap {
    "wfs": HonuaWfsLayer;
  }
}
```

The shipped map covers `geoservices-feature-service` →
`HonuaFeatureLayer`, `geoservices-map-service` → `HonuaMapService`,
`geoservices-map-layer` → `HonuaMapLayer`, `geoservices-image-service`
→ `HonuaImageService`, `geoservices-geometry-service` →
`HonuaGeometryService`, `geoservices-gp-service` →
`HonuaGeoprocessingService`, and `ogc-features` →
`HonuaOgcFeatureCollection`.

## What downstream tickets must consume

1. WFS, WMS, OData adapter tickets must implement `Source<T>` and
   register through `resolveSource`. They must declare their default
   capability set in `PROTOCOL_DEFAULT_CAPABILITIES` (this file owns
   that table — adapter PRs extend it).
2. Visual builder, exploration, and server-export tickets must consume
   `Dataset` / `Source` / `Query` / `Result` / `MapBinding` rather than
   the per-class request shapes (`QueryFeaturesRequest`, etc.). Per-class
   shapes are still available via `Source.adapter()` for legacy paths.
3. New error types must flow through `HonuaError` and `isHonuaError`.
   This ticket added `HonuaCapabilityNotSupportedError` and
   `HonuaExplorationContextError`.

## Test coverage

Conformance fixtures under `test/contract/` exercise the canonical
surface against mock adapters for each protocol. Adding a new protocol
adapter means adding a fixture there; the parametrized scenarios run
unchanged.
