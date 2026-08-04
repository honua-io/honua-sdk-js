# Experimental Cesium entity adapter

`@honua/sdk-js/scene-workspace` exposes an experimental accepted-plan workflow
for projecting a canonical `Source` query into a Cesium `EntityCollection`:

```ts doc-test=compile
import type { Source } from "@honua/sdk-js/contract";
import { explainQuery } from "@honua/sdk-js/query-planner";
import { type CesiumEntityCollectionTarget, mountSourceToCesium } from "@honua/sdk-js/scene-workspace";

declare const source: Source<Record<string, unknown>>;
/** A live Cesium `viewer.entities` satisfies this structurally. */
declare const entities: CesiumEntityCollectionTarget;

const plan = explainQuery({
  descriptor: source.descriptor,
  query: { pagination: { limit: 5_000 }, returnGeometry: true, outSr: 4326 },
});

const mounted = await mountSourceToCesium(entities, source, plan, {
  featureIdField: "unit_id",
  verticalDatum: "ellipsoidal-wgs84",
  time: { startField: "observed_at", endField: "expires_at" },
});

// Re-executes the same accepted plan and rebuilds the whole snapshot; stable
// entity ids survive, the `Entity` objects behind them do not.
const refreshed = await mounted.refresh();
if (refreshed.state === "degraded") {
  for (const diagnostic of mounted.diagnostics) console.warn(diagnostic.code, diagnostic.message);
}

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
- Point, single-part line, and polygon geometries with validated interior
  rings in GeoJSON or common Esri shapes. Polygon holes are represented by
  Cesium `PolygonHierarchy` children. Finite Z values require an explicit
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
- A single-timestamp mapping (`time: { instantField: "observed_at" }`) projects
  one source instant as a zero-duration availability interval rather than
  inventing a playback duration. The same validation and
  `time-interval-invalid` diagnostic apply.
- Serialized snapshot refresh, cancellation checks before renderer mutation,
  reentrant-disposal guards, rollback attempts, deterministic cleanup, and
  retryable failed disposal.
- Stable diagnostics for transfer-limited results, source degradation, missing
  identity, unsupported geometry, invalid time intervals, and snapshot rebuilds.

Unsupported features are omitted with `fidelity: "unsupported"`; they are not
rendered as plausible substitutes. Invalid plans, CRS, limits, and adapter
options fail before mounting.

## Real-Cesium evidence

Until issue [#1050](https://github.com/honua-io/honua-sdk-js/issues/1050) this
path had no real-Cesium coverage at all: every test ran in jsdom against a
`vi.mock("cesium")` stub. It now shares the primitive adapter's browser lane,
[`test/playwright/cesium-scene-adapter-fixtures.spec.mjs`](../test/playwright/cesium-scene-adapter-fixtures.spec.mjs),
under the same rules — Playwright's headless Chromium with SwiftShader WebGL,
fixture assets generated in-process, and any off-origin request aborted and
failed.

The lane connects to a loopback GeoServices layer with `createHonua()`, accepts
a plan with `explainQuery`, and hands both to `mountSourceToCesium` with no
Cesium module injected, so the lazy optional-peer import is exercised in a real
browser. What it establishes:

- **Materialization.** Every projected feature is a real `Cesium.Entity`
  (`instanceof`, against the minified runtime). Point positions are real
  `Cartesian3` values that convert back to the source longitude, latitude, and
  ellipsoidal height; polylines carry `Cartesian3` vertices; polygons carry a
  real `PolygonHierarchy`; attributes arrive in a real `PropertyBag`.
- **Availability is Cesium's answer, not the SDK's.** Two units on opposite
  shifts are evaluated at two clock instants, and each is available at exactly
  one of them. Availability also decides what is drawn: each unit is picked out
  of a real GPU pick pass inside its window and not outside it.
- **Interior rings reach the GPU.** The zone polygon is picked where it is solid
  and not at the centre of its hole.
- **Omissions are reported.** A feature without stable identity and a feature
  with an unparseable interval are dropped with `identity-missing` and
  `time-interval-invalid`, leaving the mount honestly `degraded`.
- **Fail-closed ceiling.** A mount whose accepted plan limit exceeds
  `maxEntities` rejects with `HonuaCesiumEntityAdapterError`
  (`entity-limit-exceeded`) and adds nothing to a collection that is already
  carrying a healthy mount.
- **Teardown.** `dispose()` returns the collection to its baseline, is
  idempotent, and runs inside the primitive lane's measured ceilings. Across
  repeated cycles on fresh viewers, entities, viewers, canvases, DOM listeners,
  and Cesium worker counts all stay bounded rather than accumulating.
- **Composition with the primitive mount.** Both mounts run on one live
  `Viewer`; disposing either releases exactly its own resources and leaves the
  other's Cesium objects in place by object identity.

## Tier decision (issue #1050)

**`mountSourceToCesium` and `projectSourceToCesium` stay `@experimental` for the
life of `@honua/app-platform` 0.1.x.** The evidence above is what the surface
needed to be *considered* for the beta tier that the surrounding
[`@honua/app-platform/scene-workspace` surface](./scene-workspace.md#support-status-beta)
carries, and it is not enough on its own, because that tier is a promise about
shape: exports are not renamed or removed and behaviour changes are called out,
not slipped in. Three known changes to this slice would break that promise.

1. **Refresh rebuilds everything, and the browser lane measures it.** A feature
   whose source row did not change between two snapshots still gets a *new*
   `Entity`; only its id is carried across (`rebuildBoundary: "entity-snapshot"`).
   Anything an application holds across a refresh — an `Entity` reference,
   `viewer.selectedEntity`, a tracked entity, a per-entity graphic it mutated —
   is silently discarded. Fixing that is a visible behaviour change to a
   documented boundary, which is exactly what a beta tier commits not to do
   quietly. (Epic #395 REQ-004 asks for the diff; this is the honest statement
   of why the caveat stands rather than a promise that the rebuild is fine.)
2. **There are two lifecycle owners, not one.** The entity mount and
   `MountedCesiumScenePrimitives` compose — proven above — but nothing owns
   both, so an application still has to dispose them in the right order itself.
   Reconciling them (#395 REQ-003) changes the entry point's shape.
3. **There is no symbology surface.** Points are 8 px, lines are 2 px wide, and
   colours are Cesium's defaults; nothing in the public options can change that.
   A production entity path needs styling, and adding it means new required
   shapes rather than purely additive ones.

Bounded materialization is deliberately kept as-is: the entity ceiling is a
fail-closed backstop, not a paging strategy. Sources larger than the ceiling are
refused with a stable diagnostic instead of silently truncated, and streaming or
tiled execution stays out of this slice.

What would change the decision: a refresh that preserves untouched entities, a
single mount that owns both the entity and primitive halves, and a symbology
contract — each with the same real-Cesium evidence the promotion of the
primitive adapter carried in [#1026](https://github.com/honua-io/honua-sdk-js/pull/1026).

## Deliberate non-goals for this slice

Terrain and imagery providers, glTF/models, point clouds and 3D Tiles continue
through the existing scene primitive adapter, which is beta. Multi-part
geometry, vertical datum transforms, styling, clustering, streaming/tiled
execution, live per-feature deltas, camera/selection/filter synchronization,
attribution UI, and asset authorization/caching remain future work.
