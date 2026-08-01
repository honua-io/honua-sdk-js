# Kepler.gl analytics workspace bridge (experimental)

`@honua/sdk-js/kepler` projects an accepted Honua result, a columnar artifact, or
a supported remote tile/imagery source into a [Kepler.gl](https://kepler.gl)
workspace. It is an experimental slice of
[#684](https://github.com/honua-io/honua-sdk-js/issues/684) under the analytics
epic [#384](https://github.com/honua-io/honua-sdk-js/issues/384).

Honua keeps discovery, query, plan, edit, and stream semantics. Kepler owns
exploratory presentation. The bridge is the seam: it carries capability truth,
provenance, bounded execution, auth safety, and shared exploration state across
that seam without either side reaching into the other.

## Optional by construction

`kepler.gl`, `react`, `react-dom`, and `redux` are **optional peers**. Nothing in
this entrypoint imports them:

- Kepler-facing values are described by minimal structural interfaces
  (`KeplerField`, `KeplerProtoDataset`, `KeplerMapState`, `KeplerFilter`,
  `KeplerPeers`).
- `loadKeplerPeers()` resolves `@kepler.gl/actions` through a dynamic import and
  validates the caller-declared Kepler version against
  `KEPLER_COMPATIBILITY_RANGE` (`>=3.0.0 <4.0.0`) *before* touching the peer.
- `loadKeplerProcessors()` resolves `@kepler.gl/processors` through the same
  optional dynamic-import seam for Arrow-table ingestion.
- Every projection, mapping, and reconciliation function works with no peer
  present at all — peers are needed only to dispatch into a live Kepler store.

The `/kepler` bundle budget (`bundle-budgets.json`) declares
`node_modules/@kepler.gl/`, `react`, `react-dom`, and `redux` as forbidden
inputs, so CI fails if any of them ever enters the static graph.

## Ingestion mapping table

Every path is explicit, and the projection reports which one it took plus the
exact GeoJSON cost. `geoJsonBytes === 0` is the machine-checkable evidence that
no GeoJSON round trip happened.

| Input | Strategy | GeoJSON round trip |
| --- | --- | --- |
| attribute rows / `Result.aggregateRows`, no geometry | `row-object-direct` | no |
| point geometry (Esri `{x,y}` or GeoJSON `Point`) | `point-columns-direct` | no |
| columnar artifact columns (typed arrays or arrays) | `columnar-columns-direct` | no |
| line / polygon / multi-part geometry | `geojson-column` | yes, measured |
| raster tile or style source | `remote-basemap-style` | no (reference only) |
| vector tile source | `remote-vector-tileset` | no (reference only) |
| Apache Arrow table through Kepler processor | `arrow-table-processor` | no (`geoJsonBytes === 0`) |

Kepler exposes no tabular or binary ingestion path for line, polygon, or
multi-part geometry, so that case is a declared fallback rather than a silent
one: the projection emits a `geometry-serialized-to-geojson` fidelity loss and
records the serialized byte count. `KEPLER_BRIDGE_CAPABILITIES` publishes the
same table at runtime.

```ts doc-test=compile
import { projectResultToKeplerDataset } from "@honua/sdk-js/kepler";

const projection = projectResultToKeplerDataset({
  datasetId: "incidents",
  label: "Incidents",
  provenance: {
    sourceId: "incidents",
    planId: "plan-1",
    authorizationScope: "scope:public-read",
    attribution: "City of Honua open data",
    freshness: { observedAt: "2026-07-25T12:00:00Z" },
  },
  rowIdentityField: "objectid",
  temporalFields: ["reported_at"],
  result: {
    features: [
      {
        attributes: { objectid: 1, status: "open", reported_at: "2026-07-25T11:00:00Z" },
        geometry: { x: -122.4, y: 37.8 },
      },
    ],
    exceededTransferLimit: false,
  },
});

console.log(projection.diagnostic.strategy); // "point-columns-direct"
console.log(projection.diagnostic.geoJsonBytes); // 0
```

## Preserved truth

`KeplerProtoDataset.metadata` travels with every dataset and carries field
types, the CRS decision, temporal fields, row identity, and the full provenance
record (source id and version, schema version, plan id and fingerprint,
authorization scope, attribution, freshness validators, and any source
degradations), plus the ingestion diagnostic and its fidelity losses.

Esri-JSON geometry is converted by the repository's canonical converter
(`src/core/esri-geojson.ts`), so a polygon with several clockwise exterior rings
becomes a `MultiPolygon` instead of one `Polygon` whose later exterior rings are
misread as holes, and every ring is rewound to the RFC 7946 right-hand rule.

Kepler renders WGS84 lon/lat only, so the bridge never silently reprojects: a
non-WGS84 input throws `unsupported-crs` and tells the caller to reproject
first. A declared field type with no Kepler equivalent is dropped with an
`unsupported-field-type` loss rather than coerced into a string column.

## Linked state — only where semantics match

`KEPLER_LINKED_STATE_MAPPINGS` is the honest channel table. Each entry declares
a direction (`bidirectional`, `honua-to-kepler`, `kepler-to-honua`,
`unsupported`), whether the mapping is `exact` or `lossy`, and why.

| Channel | Direction | Equivalence |
| --- | --- | --- |
| `viewport` | bidirectional | lossy (needs the viewport pixel size; bearing/pitch are not extent-representable) |
| `temporal-window` | bidirectional | exact (both sides are closed epoch-millisecond intervals) |
| `selection` | kepler → honua | exact (a pick is one row identity) |
| `selection-as-filter` | honua → kepler | lossy (Kepler has no selection; only a `multiSelect` mask) |
| `value-filter` | bidirectional | exact for `=` / `in` / `between`; other operators reported unsupported |
| `hover` | unsupported | `ExplorationState` has no hover slice |
| `spatial-filter` | unsupported | Kepler's polygon filter is a client-side mask, not a server predicate |
| `sort`, `pagination`, `grouping`, `aggregation`, `visible-fields` | unsupported | Honua query concerns with no Kepler workspace equivalent |

`createKeplerLinkedStateSync()` is loop-free by construction, without going
stale. Three guards apply:

1. The exploration view controller ignores its own notifications, so a
   Kepler-originated intent never bounces straight back out.
2. Each direction of each channel holds a **one-shot** echo marker: the value
   this side just handed the other side, *consumed by the first matching echo*.
   Retaining it instead would desynchronize the views on an `A → B → A`
   sequence — after Honua sends `A` and Kepler moves to `B`, Kepler returning to
   `A` would match the stale marker and be dropped, leaving Honua on `B`.
3. A consecutive repeat of the value Kepler already reported is deduped
   separately, since re-applying it is a no-op.

Suppressed values are counted in `suppressedEchoes` and reported in
`diagnostics`.

## Snapshot and bounded delta reconciliation

`reconcileKeplerDataset()` (or `bridge.reconcile()`) never silently rebuilds a
workspace. It returns bounded `replace-rows` / `update-rows` / `append-rows` /
`remove-rows` operations, or a single `rebuild-workspace` operation carrying an
explicit reason: `schema-changed`, `plan-identity-changed`,
`authorization-scope-changed`, `missing-row-identity`, `resume-gap`,
`delta-budget-exceeded`, or `row-budget-exceeded`.

A delta upsert addresses its row by the envelope's `id`, and that id — not
`attributes` — is what lands in the identity column. Sparse patches that omit
the identity field therefore stay addressable, and a patch whose attributes
carry a *different* identity is reported in `diagnostic.identityMismatches`
rather than silently splitting into a duplicate row.

### Driving it from a realtime subscription

The realtime and reconciliation models are close but not identical:
`RealtimeFeaturePatch` carries the row under `feature`, and a
`RealtimeSnapshotEvent` carries `features` rather than an already-projected
dataset. Two adapters close that gap explicitly:

- `keplerDeltaFromRealtimeEvent(event, options?)` accepts a `delta`, `upsert`,
  or `delete` event and projects each patch's `feature` payload into
  `{ attributes, geometry }`. The default projector understands a canonical
  `HonuaTypedFeature`, a GeoJSON `Feature`, and a flat attribute record; supply
  `projectFeature` for anything adapter-specific. `expectedPreviousCursor`,
  `planId`, `schemaVersion`, and `authorizationScope` are supplied here because
  realtime events do not carry them.
- `keplerSnapshotFromRealtimeEvent(event, request, options?)` re-projects a
  snapshot's `features` through the same ingestion mapping `openResult()` uses.

```ts doc-test=compile
import type { RealtimeDeltaEvent } from "@honua/sdk-js/realtime";
import { keplerDeltaFromRealtimeEvent } from "@honua/sdk-js/kepler";

interface Incident {
  readonly attributes: { readonly objectid: number; readonly status: string };
  readonly geometry?: { readonly x: number; readonly y: number };
}

const event: RealtimeDeltaEvent<Incident> = {
  type: "delta",
  upserts: [{ id: 1, feature: { attributes: { objectid: 1, status: "resolved" } } }],
  deletes: [{ id: 2 }],
  cursor: "cursor-2",
};

const delta = keplerDeltaFromRealtimeEvent(event, { expectedPreviousCursor: "cursor-1" });
console.log(delta.upserts?.[0].attributes);
```

## Credential safety

Two enforcement points, both on by default:

1. **Ingestion** refuses credential-bearing input. A remote source URL with
   userinfo credentials, an AWS SigV4 / Azure SAS / GCS / CloudFront signed
   parameter, or a `?key=` / `?access_token=` grant is rejected with
   `credential-leak`. Authorization belongs in a host transport interceptor, not
   in serializable Kepler configuration.
2. **Export** redacts a Kepler saved map before it is persisted or shared:
   `redactKeplerExportState()` (also `bridge.exportState()`) removes
   credential-bearing config keys (`accessToken`, `mapboxApiAccessToken`,
   `headers`, `cookie`, …), rewrites signed-URL parameters, strips URL userinfo
   (`https://user:password@host/...`, which neither the parameter scan nor the
   opaque-value scan can see), and blanks opaque token values, returning a
   per-path redaction report. Matching is fail-closed
   and the walk is bounded — an over-budget state throws rather than silently
   truncating. The non-secret `authorizationScope` is preserved so provenance
   stays traceable.

```ts doc-test=compile
import { redactKeplerExportState } from "@honua/sdk-js/kepler";

const saved = {
  config: { mapStyle: { mapStyles: { custom: { url: "https://tiles.example.com/style.json" } } } },
};
const { state, redactions, redacted } = redactKeplerExportState(saved);

console.log(redacted, redactions.length, state);
```

## Bridge lifecycle

```ts doc-test=skip reason="requires the optional @kepler.gl/actions peer and a live Redux store"
import { createKeplerWorkspaceBridge, loadKeplerPeers } from "@honua/sdk-js/kepler";

const bridge = createKeplerWorkspaceBridge({
  peers: await loadKeplerPeers({ version: "3.2.6" }),
  host: { dispatch: store.dispatch, instanceId: "ops-replay" },
});

const opened = bridge.openResult(request);
const sync = bridge.linkState({
  view: exploration.connectView({ id: "kepler", role: "map" }),
  datasetId: opened.projection.dataset.info.id,
  temporalField: "reported_at",
  viewportSize: { width: 1200, height: 800 },
  applyToKepler: (update) => store.dispatch(toKeplerAction(update)),
});

// … later
sync.dispose();
bridge.dispose();
```

Default budgets (`DEFAULT_KEPLER_BRIDGE_LIMITS`) cap the workspace at 16
datasets, 250,000 rows and 256 fields per dataset, ~128 MiB of retained row
bytes, and 10,000 rows per bounded delta. Exceeding a budget throws
`limit-exceeded` rather than truncating, and `bridge.dispose()` releases the
tracked rows and every linked-state subscription.

## Apache Arrow processor path

`loadKeplerProcessors()` and `bridge.openArrowTable()` accept an opaque Apache
Arrow table supplied by the host. Kepler's `processArrowTable` interprets the
schema; the SDK validates the bounded `{ fields, rows }` result, adds Honua
provenance and credential-free metadata, and applies the same row/field
budgets as every other workspace path. The diagnostic strategy is
`arrow-table-processor` and `geoJsonBytes` is always `0`: the bridge never
serializes the table through GeoJSON. Set `geometryField` and `crs` when the
table contains GeoArrow geometry; non-WGS84 inputs fail closed.

This is an explicit processor path, not a claim of Arrow-buffer zero-copy:
Kepler's current processor returns a row-oriented dataset. The future
zero-copy contract remains separately reported as unsupported.

## Packed browser qualification

The SDK's split package is qualified in a real browser by
`test/playwright/kepler-arrow-packed.spec.mjs`. The test builds
`dist/packages/honua-sdk`, serves only that packed `@honua/sdk/kepler` tree, and
opens the Arrow adapter through the public entrypoint. It verifies the declared
Kepler compatibility range, Arrow processor projection, zero GeoJSON bytes,
temporal and row-identity metadata, provenance, and bridge workspace metrics.

Run the bounded qualification with:

```bash
npm run test:playwright:kepler-arrow-packed
```

The focused test always runs `npm run build:split-packages` from the current
checkout before starting its browser server. This prevents a clean checkout
from failing on missing output and prevents an ignored stale `dist/` tree from
being qualified accidentally. To run the Playwright file directly, it has the
same build behavior:

```bash
npx playwright test test/playwright/kepler-arrow-packed.spec.mjs
```

The fixture injects the processor result and therefore proves the SDK adapter
and packed browser boundary without claiming that a live Arrow object or
`honua-site` deployment has been exercised.

## Cloud-native journey handoff and live evidence

`examples/spatial-analytics-workbench/src/kepler-handoff.ts` executes the
accepted #547 fixture plan and returns a reusable `KeplerResultProjectionRequest`.
`examples/kepler-analytics/` opens that request and its three replay datasets
through `createKeplerWorkspaceBridge()`; the example no longer calls Kepler's
example-local GeoJSON processor. The browser smoke exposes the four ingestion
diagnostics, accepted plan fingerprint, row counts, and retained-byte metrics.

The matching live lane is `.github/workflows/spatial-analytics-kepler-live.yml`.
On its schedule (and on manual dispatch), it builds `@honua/sdk` split-package
output, executes one bounded anonymous aggregate query against the reviewed
SampleServer6 CitizenRequests layer, and opens the actual accepted result
through the packed `@honua/sdk/kepler` entrypoint. Evidence requires direct
aggregate-row ingestion, zero GeoJSON bytes, preserved row count and plan
fingerprint, and disposal of the bridge. The workflow uploads the evidence for
90 days and never substitutes fixture rows when the public query fails.

## Known gaps

- Kepler's Arrow/GeoArrow buffer-preserving path remains unsupported; the new
  processor path is bounded and GeoJSON-free but intentionally reports its
  row-oriented processor boundary.
- The packed fixture and scheduled public live lanes qualify the SDK-owned
  handoff. Publication of the demo in `honua-site` remains a site-owned concern.
