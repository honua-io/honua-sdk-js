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

// Re-executes the same accepted plan and *diffs* the result onto the live
// collection: a feature whose row did not change keeps the very same `Entity`.
const refreshed = await mounted.refresh();
console.log(refreshed.reused, refreshed.updated, refreshed.created, refreshed.disposed);
for (const crossing of refreshed.rebuildBoundaries) console.log(crossing.entityId, crossing.boundary);
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
- Serialized refresh, cancellation checks before renderer mutation,
  reentrant-disposal guards, rollback attempts, deterministic cleanup, and
  retryable failed disposal.
- Stable diagnostics for transfer-limited results, source degradation, missing
  identity, unsupported geometry, invalid time intervals, and rebuild boundaries.

Unsupported features are omitted with `fidelity: "unsupported"`; they are not
rendered as plausible substitutes. Invalid plans, CRS, limits, and adapter
options fail before mounting.

## The refresh diff

`refresh()` re-executes the accepted plan and reconciles the new snapshot onto
the collection. It is a **diff**, running the same discipline the beta primitive
mount runs on ([#930](https://github.com/honua-io/honua-sdk-js/pull/1020)):

- **Identity** is the projected entity id (`honua-<source>:s|n:<feature id>`)
  qualified by geometry kind. The kind qualification matters for the same reason
  it does on the primitive path: a point and a polyline are different renderer
  objects, so a feature that changes shape is a replacement rather than a
  revision.
- **Configuration** is an order-independent fingerprint of the projected
  feature, canonicalized per facet — geometry (with any position samples),
  attributes, and availability each fingerprint separately. Attribute key order
  is therefore not a change, and a feature that only moved does not also rewrite
  its property bag.
- **A feature that cannot be fingerprinted is treated as changed**, never as
  reusable. `projectSourceToCesium` only ever emits deeply frozen JSON-like
  snapshots, so this is a fail-closed backstop rather than a live path, and it
  resolves toward rebuilding.

What that buys, and what the browser lane asserts by object identity:

| Outcome | Boundary | The live `Entity` |
| --- | --- | --- |
| Row unchanged | `none` | The **same object**, untouched |
| Row changed | `entity-configuration` | The **same object**, with only the changed facets written onto it |
| New feature | `entity-identity` | Constructed |
| Feature left the snapshot | `snapshot-membership` | Released |
| Geometry kind changed | `entity-geometry-kind` | Released and rebuilt |
| Unfingerprintable | `unfingerprintable` | Released and rebuilt conservatively |

Because an unchanged — and a merely changed — feature keeps its `Entity`,
everything a host attached to that object survives a refresh:
`viewer.selectedEntity`, a tracked entity, an entity reference the application
holds, and a graphic property it adjusted. Geometry is written at the deepest
field Cesium accepts (`polyline.positions`, `polygon.hierarchy`, `position`), so
a width or material set on the graphic is not clobbered either.

`refresh()` returns the projection plus `revision`, `reused`, `updated`,
`created`, `disposed`, and `rebuildBoundaries` — one report per entity that
crossed a boundary, so a steady-state refresh reports nothing. The mount carries
the most recent list as `mounted.rebuildBoundaries`, and the `incremental-update`
diagnostic carries the counts and the highest boundary crossed. A refresh that
had to release an entity also emits `rebuild-boundary`.

Mutation order is chosen so a failure cannot leave a hole: in-place writes are
journaled with the values they displaced, replacements and arrivals are added
next, and **departures are released last**. If any step fails, the additions are
removed, the replaced entities are restored, and every journaled write is undone
exactly — the departed set was never touched, so the previous snapshot is still
attached. The mount reports the attempt with `incremental-update-failed`.

## One owner for both mounts

`mountCesiumScene` owns a whole Cesium scene: the primitive plan and every
accepted-plan source mounted over it. It delegates — the primitive mount keeps
its own diff, layer ceiling, and transactional apply; each entity mount keeps its
own refresh diff and rollback — and adds ordering, admission, and a single
`dispose()`.

```ts doc-test=compile
import type { Source } from "@honua/sdk-js/contract";
import { explainQuery } from "@honua/sdk-js/query-planner";
import { type CesiumSceneOwnerTarget, mountCesiumScene } from "@honua/sdk-js/scene-workspace";

declare const source: Source<Record<string, unknown>>;
/** A live Cesium `Viewer` satisfies this structurally: camera, scene, clock, entities. */
declare const viewer: CesiumSceneOwnerTarget;

const scene = await mountCesiumScene(viewer, [
  { kind: "elevation-source", id: "terrain", sourceId: "terrain", protocol: "quantized-mesh", url: "https://terrain.example.test" },
]);

const units = await scene.mountSource(
  source,
  explainQuery({
    descriptor: source.descriptor,
    query: { pagination: { limit: 5_000 }, returnGeometry: true, outSr: 4326 },
  }),
  { featureIdField: "unit_id" },
);
console.log(scene.sources.get(units.sourceId) === units);

// One teardown: entity mounts first, in reverse acquisition order, then the
// primitive plan. Idempotent, and retryable if a mount refuses to release.
scene.dispose();
```

The owner is bounded the same way the mounts are: at most
`DEFAULT_CESIUM_SCENE_SOURCE_LIMIT` (8, raise it with `maxSources`) entity mounts,
refused with `HonuaCesiumSceneOwnerError` (`source-limit-exceeded`) before
anything is attached. A second mount of a source it already holds is refused with
`source-conflict` and the redundant mount is released. Disposing the owner while
a `mountSource()` is in flight aborts it and attaches nothing. A mount that
refuses to release does not stop the teardown: everything releasable is released,
the failures are aggregated into an `AggregateError`, the owner stays in
`disposing` owning exactly what refused, and a later `dispose()` retries only
that.

`mountScenePrimitivesToCesium` is untouched and is still the supported way to own
primitives alone; `mountCesiumScene` is additive.

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
  other's Cesium objects in place by object identity. Since #1050's second slice
  the lane also drives them through the single `mountCesiumScene` owner and
  asserts that one `dispose()` releases both.
- **The refresh diff, by object identity.** A feature that is byte-identical
  across two snapshots comes back from `refresh()` as the **same `Entity`
  object**, and a `viewer.selectedEntity` set on it before the refresh is still
  that entity afterwards. A moved feature keeps its object too; a departed one
  leaves the collection.

## Tier decision (issue #1050)

**`mountSourceToCesium`, `projectSourceToCesium`, and `mountCesiumScene` stay
`@experimental` for the life of `@honua/app-platform` 0.1.x.** The evidence above
is what the surface needed to be *considered* for the beta tier that the
surrounding
[`@honua/app-platform/scene-workspace` surface](./scene-workspace.md#support-status-beta)
carries, because that tier is a promise about shape: exports are not renamed or
removed and behaviour changes are called out, not slipped in.

Three known changes stood in the way. **Two have landed**, which is why the
caveat is now narrower than it was:

1. ~~**Refresh rebuilds everything.**~~ **Cleared.** `refresh()` is a diff (see
   [The refresh diff](#the-refresh-diff)). A feature whose row did not change
   keeps its live `Entity` untouched, a changed feature keeps it and has only its
   changed facets written on, and the browser lane asserts both by object
   identity — including that `viewer.selectedEntity` survives. The old
   `rebuildBoundary: "entity-snapshot"` detail is gone, replaced by a per-entity
   `CesiumEntityRebuildBoundary` vocabulary. That is epic #395 REQ-004 for this
   path, and it is the visible behaviour change this tier decision reserved the
   right to make.
2. ~~**Two lifecycle owners.**~~ **Cleared.** `mountCesiumScene` (#395 REQ-003)
   owns both mounts behind one `dispose()`, with a bounded source ceiling, a
   measured teardown order, and delegation rather than reimplementation. It is
   purely additive: `mountScenePrimitivesToCesium` and its beta handle are
   unchanged.
3. **There is no symbology surface.** *This is the remaining blocker.* Points are
   8 px, lines are 2 px wide, and colours are Cesium's defaults; nothing in the
   public options can change that. A production entity path needs styling, and
   adding it means new required shapes — an options surface on both
   `projectSourceToCesium` and `mountSourceToCesium`, and very likely a per-facet
   contract that interacts with the in-place update path above — rather than
   purely additive ones. Promoting now would freeze a surface we already know has
   to grow a required dimension.

Issue #1050 does not ask for symbology, and its own requirements (real-Cesium
evidence, measured teardown, single-owner reconciliation, the refresh diff, and a
recorded tier decision) are met. REQ-005 asks the surface to be promoted *or*
for the reason it stays experimental to be recorded: this is that record. Two of
three blockers are cleared and the third is named, so the tier stands and the
statement of it is now specific rather than a blanket caveat.

Bounded materialization is deliberately kept as-is: the entity ceiling is a
fail-closed backstop, not a paging strategy. Sources larger than the ceiling are
refused with a stable diagnostic instead of silently truncated, and streaming or
tiled execution stays out of this slice.

What would change the decision: a symbology contract, with the same real-Cesium
evidence the promotion of the primitive adapter carried in
[#1026](https://github.com/honua-io/honua-sdk-js/pull/1026).

## Deliberate non-goals for this slice

Terrain and imagery providers, glTF/models, point clouds and 3D Tiles continue
through the existing scene primitive adapter, which is beta. Multi-part
geometry, vertical datum transforms, styling, clustering, streaming/tiled
execution, live per-feature deltas, camera/selection/filter synchronization,
attribution UI, and asset authorization/caching remain future work.
