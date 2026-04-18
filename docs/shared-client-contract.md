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
| `Protocol` | One of nine identifiers (`geoservices-feature-service`, `geoservices-map-service`, `ogc-features`, `wfs`, `wms`, `odata`, `maplibre-vector`, `maplibre-raster`, `maplibre-geojson`). |
| `Capability` | A coarse-grained operation a `Source` may expose (`query`, `queryAggregate`, `queryExtent`, `queryObjectIds`, `queryRelated`, `applyEdits`, `attachments`, `render`, `tiles`, `sql`, `stream`, `pbf`, `connect`). |
| `Capabilities` | `ReadonlySet<Capability>`. Set membership = first-party support; missing capabilities either fail in `strict` policy or fall back to client-side strategies in `degraded` policy. |
| `SourceLocator` | Protocol-specific endpoint info (`url`, `serviceId`, `layerId`, `collectionId`, `typeName`, `entitySet`). Field-compatible with the server `SourceBinding.locator`. |
| `SourceDescriptor` | `{ id, protocol, locator, capabilities, schema?, attribution? }`. The serializable identity of one source. |
| `Source<T>` | Runtime handle. Methods: `query`, `queryAll`, `queryAggregate`, `queryExtent`, `stream`, `adapter`. |
| `Dataset` | Logical grouping of sources sharing identity. Methods: `source(id)`, `sourceIds()`, `isCompatible()`, `supportsFeature()`. |
| `Query<T>` | `{ where?, spatialFilter?, outFields?, orderBy?, pagination?, aggregation?, returnGeometry?, outSr?, signal? }`. |
| `Result<T>` | `{ features, exceededTransferLimit, nextCursor?, totalCount?, aggregateRows?, extent?, fields?, degraded? }`. |
| `MapBinding` | `{ sourceId, layerIds, style?, minzoom?, maxzoom? }`. Maps onto `MapPackage.sourceBindings` + `MapPackage.mapSpec` server-side. |

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
[`protocol-capability-matrix.md`](./protocol-capability-matrix.md). Adapter
constructors apply per-source overrides (e.g. a Feature Service whose
metadata reports `supportsStatistics: false` drops `queryAggregate`).

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
`geoservices-map-service`, and `ogc-features`. WFS / WMS / OData adapters
register themselves through `CreateDatasetOptions.resolveSource`.

## Compatibility gating

`Dataset.isCompatible()` calls `HonuaClient.checkCompatibility()` once and
caches the result. `Dataset.supportsFeature(feature)` proxies to
`HonuaClient.supportsFeature` for fine-grained checks. Both reuse the
existing compatibility-gate workflow — no new wire calls were introduced.

## Adapter escape hatch

`Source.adapter("geoservices-feature-service")` returns the underlying
`HonuaFeatureLayer` instance (or `undefined` for the wrong kind). The
`AdapterTypeMap` interface uses TypeScript declaration merging so adapter
tickets can plug in their own kind → instance type mapping without
touching this file.

```ts
declare module "@honua/sdk-js/contract" {
  interface AdapterTypeMap {
    "wfs": HonuaWfsLayer;
  }
}
```

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
