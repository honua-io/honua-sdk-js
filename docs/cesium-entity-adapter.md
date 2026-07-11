# Experimental Cesium entity adapter

`@honua/sdk-js/scene-workspace` exposes an experimental accepted-plan workflow
for projecting a canonical `Source` query into a Cesium `EntityCollection`:

```ts
import { explainQuery } from "@honua/sdk-js/query-planner";
import { mountSourceToCesium } from "@honua/sdk-js/scene-workspace";

const plan = explainQuery({
  descriptor: source.descriptor,
  query: {
    pagination: { limit: 5_000 },
    returnGeometry: true,
    outSr: 4326,
  },
  sourceVersion,
  schemaVersion,
  authorizationScope,
});

const mounted = await mountSourceToCesium(viewer.entities, source, plan, {
  sourceVersion,
  schemaVersion,
  authorizationScope,
  time: { startField: "observed_at", endField: "expires_at" },
  verticalDatum: "ellipsoidal-wgs84",
});

await mounted.refresh();
mounted.dispose();
```

The core projection (`projectSourceToCesium`) does not import Cesium. Mounting
accepts either a minimal injected Cesium module or async loader; if neither is
provided, the optional `cesium` peer is imported lazily. Importing the
entrypoint in Node/SSR therefore does not initialize a browser or WebGL runtime.

## Supported slice

- One accepted, remote `query` step whose executable query exactly matches the
  canonical IR, with explicit geometry and a positive row limit no greater than
  `maxEntities` (10,000 by default).
- Explicit WGS84 output (`outSr: 4326`). Coordinates are never silently
  reinterpreted or reprojected.
- Point, single-part line, and single-ring polygon geometries in GeoJSON or
  common Esri shapes. Finite Z values require an explicit
  `verticalDatum: "ellipsoidal-wgs84"`; otherwise the feature is omitted with
  a stable fidelity diagnostic.
- Stable entity identity from `featureIdField` or the source primary key.
- Attributes are copied into deeply frozen JSON-like scalar, dense-array, and
  plain-object snapshots. Dates, class instances, sparse arrays, accessors, and
  other non-JSON values omit the feature with an unsupported-fidelity
  diagnostic rather than retaining mutable caller-owned objects.
- Optional offset-bearing ISO instants with at most millisecond precision, or
  integer Unix epoch-millisecond start/end attributes, mapped to Cesium
  availability intervals. Ambiguous local-time strings and precision-losing
  timestamps are omitted with a fidelity diagnostic.
- Serialized snapshot refresh, cancellation checks before renderer mutation,
  reentrant-disposal guards, rollback attempts, deterministic cleanup, and
  retryable failed disposal.
- Stable diagnostics for transfer-limited results, source degradation, missing
  identity, unsupported geometry, invalid time intervals, and snapshot rebuilds.

Unsupported features are omitted with `fidelity: "unsupported"`; they are not
rendered as plausible substitutes. Invalid plans, CRS, limits, and adapter
options fail before mounting.

## Deliberate non-goals for this slice

This is not completion of issue #395 and is not yet a beta Cesium adapter.
Terrain and imagery providers, glTF/models, point clouds and 3D Tiles continue
through the existing scene primitive adapter. Multi-part geometry and polygon
holes, vertical datum transforms, styling, clustering, streaming/tiled
execution, live deltas, camera/selection/filter synchronization, attribution
UI, asset authorization/caching, browser examples, and WebGL leak/performance
certification remain future work.

Refresh currently declares an `entity-snapshot` rebuild boundary. Stable IDs
are preserved across rebuilds, but this first slice does not claim fine-grained
property or sampled-position delta application.
