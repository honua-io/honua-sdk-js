# Linked analytics and chart presentation (experimental)

`@honua/sdk-js/analytics` is the versioned seam between accepted analytics
results and whatever draws them. It is an experimental slice of
[#682](https://github.com/honua-io/honua-sdk-js/issues/682).

Honua does not ship a chart suite and is not going to. What it does ship is the
contract that lets a server-pushdown widget model, a bounded columnar
reduction, a small accessible default presentation, and a specialist chart
library participate in **one** filter / selection / temporal / capability /
provenance model.

Two rules make the seam worth having:

1. **No renderer objects in SDK core.** An adapter receives an
   `AnalyticsArtifact` and an `AnalyticsPresentationHost`, and emits
   protocol-neutral `AnalyticsInteraction` values. Canvas contexts, chart
   instances, and library option objects never cross back.
2. **No duplicate data ownership.** An artifact is accepted once and shared by
   reference. Presentations own no persistent cache, and a later artifact is
   resolved by identity into an explicit patch / invalidate / ignore decision.

## The artifact

An artifact is one of four kinds — `category`, `histogram`, `aggregate`,
`time-series` — and always declares units, null handling, ordering, source
identity, and provenance. Marks carry a stable `key` that is the interaction
identity: a click, a hover, and a brush all resolve back through it.

| Field | Why it exists |
|---|---|
| `identity.artifactId` / `sourceId` / `planFingerprint` | Lineage. A change to any of these invalidates a mounted presentation. |
| `identity.sequence` | Orders deltas within one lineage. A lower sequence is a late delta and is **ignored**, so numbers never rewind. |
| `identity.freshness` | `authority` / `observedAt` / `staleAfter` / `validator`, matching `ColumnarFreshnessV1` so one badge serves both. |
| `provenance.computedBy` / `pushdown` | Where the numbers were aggregated. A client reduction can never claim pushdown by default. |
| `provenance.bounds` | Structured truncation: `truncated`, `rowBudget`, `scannedRowCount`, `transferredRowCount`. Count fields are **absent** rather than approximated when the producer does not expose them. |
| `nullPolicy` | `excluded`, `counted-as-zero`, `separate-bucket`, `propagated-as-null`, or `unknown` — never implicit. |
| `ordering` | Declared once and validated at accept time, so every linked presentation shows the same sequence. |

Statuses are `ready`, `partial`, `stale`, `unsupported`, and `error`. All five
render; none of them is allowed to look authoritative when it is not.

## Accepting from a widget source

`createWidgetSource()` already prefers OData `$apply`, `source.queryAggregate`,
and typed protocol histogram/time-series adapters, and only falls back to a
bounded client scan. The bridge preserves that decision instead of flattening
it:

```ts doc-test=skip reason="requires a connected Source; the accept call itself is pure"
import { createWidgetSource } from "@honua/sdk-js/contract";
import {
  acceptWidgetCategoriesArtifact,
  assertAnalyticsPushdown,
} from "@honua/sdk-js/analytics";

const widgets = createWidgetSource(source, { maxClientRows: 10_000 });
const response = await widgets.categories({ field: "status" });

const artifact = acceptWidgetCategoriesArtifact(response, {
  artifactId: "incidents-by-status",
  title: "Incidents by status",
  rowBudget: 10_000,
});

// Dashboards that must never pull a dataset to the browser can enforce it.
assertAnalyticsPushdown(artifact.provenance, "The status widget");
```

When the widget source had to bound a client-side scan, the artifact comes back
`partial`, `provenance.bounds.truncated` is `true`, and the accessible
projection says so in words. Nothing silently rounds up to "complete".

`bounds.transferredRowCount` is only populated on the pushdown path, where the
aggregate rows genuinely *are* the transfer. After a client or mixed reduction
the rows that crossed the wire are the underlying features — a number the widget
response does not expose — so the field is left absent and a provenance note
says why. Reporting "5 rows transferred" for five buckets distilled from a
10,000-row scan would understate the cost by three orders of magnitude, and an
absent number is easier to handle correctly than a confident wrong one.

## Linking to shared exploration state

`bindAnalyticsToExploration()` owns the mapping from interactions to the shared
`filters` and `selection` slices — the same slices the MapLibre and table
bindings in `@honua/sdk-js/interactions` already use.

| Interaction | Shared-state effect |
|---|---|
| `mark-select` on a category | `=` or `in` clause on the dimension (`is-null` for the null bucket); publishes the mark's `targets` as selection when it has them |
| `mark-select` on a time series | `between` clause on the temporal clause id — clicks and brushes share one temporal contract |
| `range-brush` | `between` clause on the range clause id |
| `temporal-brush` | `between` clause on the temporal clause id |
| `hover` | Ephemeral. Shared with peer presentations through the binding, never written into the reducer, so it cannot pollute a shareable snapshot |
| `clear` | Clears the channels this view owns |

Every commit is invertible. `apply()` captures the previous values of *only the
slices it touched* and returns an `undo()` that restores them — never a
whole-state snapshot restore, so a concurrent change published by a peer view
survives an undo of a chart interaction.

An overflow ("other") bucket is explicitly non-filterable: selecting it writes
no clause rather than a clause that would quietly match the wrong rows. A mixed
null-plus-value selection keeps the value clause and drops the null bucket,
rather than widening to `is-null OR in (...)` in only the protocols that could
express it.

Two subtleties the binding handles for you:

- **Replacement selection clears what it replaced.** Selecting a mark that
  carries no enumerable `targets` still clears the feature selection this
  binding previously published, so the map can never highlight rows the filter
  has since excluded.
- **A binding must follow its artifact.** `retarget(next)` points the binding at
  a newly accepted artifact; mark lookups, clause projections, and feature
  targets all resolve against the artifact the binding holds, so a binding left
  on a superseded artifact would resolve a newly added mark to nothing and clear
  the filter instead of selecting it. `createAnalyticsLinkedSession()` calls
  `retarget()` on every non-ignored `accept()`, so sessions get this for free;
  call it yourself only if you drive a binding directly. `clauseIds` never
  change, so a retarget cannot orphan a clause the view already wrote.

## One artifact, many presentations

```ts doc-test=skip reason="requires an ExplorationViewController and a DOM target"
import {
  createAnalyticsAdapterRegistry,
  createAnalyticsLinkedSession,
  createDefaultAnalyticsPresentation,
} from "@honua/sdk-js/analytics";

const registry = createAnalyticsAdapterRegistry({
  adapters: [createDefaultAnalyticsPresentation()],
});

const session = createAnalyticsLinkedSession({ view, artifact, registry });
await session.present({ target: panel });                 // visual
await session.present({ id: "a11y", headlessOnly: true }); // text equivalent

session.accept(nextArtifact); // patch / invalidate / ignore, decided by identity
session.undo();               // exact inverse of the last committed interaction
session.dispose();            // every presentation, listener, and peer released
```

Both presentations receive the session's own artifact reference. There is no
second copy of the numbers to drift.

## The default presentation

`createDefaultAnalyticsPresentation()` renders the shared table model as a real
`<table>` whose value cells carry a proportional bar, so one DOM tree serves
both the visual and the assistive-technology reading. Rows are focusable
buttons (keyboard mark selection) and brushing uses a native `<input
type="range">` pair rather than a drag surface. Null measures render as
`no data`, never as `0`.

The brush inputs are initialized from the current linked state (via
`analyticsBrushIndices()`), not from the artifact's extent, so the range the
user just brushed — or one a peer presentation published — survives the
rerender instead of snapping back to full width.

`analyticsTableModel()` is the renderer-neutral truth behind it — a caption, a
status banner, columns, rows, and a full text `description`. Chart adapters use
it for `accessibleDescription`, and the registry's fallback adapter renders it
when no chart adapter can honestly present an artifact. That is how an
unsupported visualization request degrades to a truthful table instead of an
empty box:

```ts doc-test=skip reason="requires an accepted artifact"
const resolution = registry.resolve(artifact);
resolution.fallback; // true when every chart adapter declined
resolution.rejected; // [{ adapterId, reason: "kind-not-supported", message }]
```

## Writing an adapter

An adapter is four things: an id, the kinds and channels it handles, a cheap
synchronous `describeSupport()`, and a `mount()` that returns a disposable
handle. Use `createDisposableHandle()` to inherit the shared update-disposition
and disposal semantics — it consults `resolveAnalyticsUpdateDisposition()` for
you and permanently rejects `update()` after `dispose()`, so a late realtime
delta cannot resurrect a torn-down chart.

Declining is a feature. An adapter that cannot honestly render an artifact
should say so with a machine-readable reason and let the registry fall back.

## Reference adapter: µPlot

`@honua/sdk-js/analytics/uplot` proves the contract against a real library.
[µPlot](https://github.com/leeoniya/uPlot) is small (~50 KiB), MIT-licensed,
and widely deployed for time-series rendering.

```ts doc-test=skip reason="requires the optional uplot peer and a DOM target"
import { createUplotAnalyticsAdapter } from "@honua/sdk-js/analytics/uplot";

registry.register(createUplotAnalyticsAdapter({ stroke: "#2563eb" }));
```

Install the optional peer with `npm i uplot`. It is declared in
`peerDependenciesMeta` as optional and is reached **only** through a dynamic
import with a variable specifier inside `mount()`, so no bundler pulls it into
a Honua entrypoint. `createUplotAnalyticsAdapter({ module })` injects a module
directly, following the same seam as `loadDeckGlPeers` and `loadApacheArrow`.

The adapter:

- supports `time-series` (epoch-second x axis) and `histogram` (bin-midpoint x
  axis), and declines `category` / `aggregate` with `kind-not-supported`;
- keeps `null` measures as `null` in the aligned data so µPlot draws a gap
  rather than a false zero;
- maps `hooks.setSelect` to `temporal-brush` / `range-brush`, `hooks.setCursor`
  to deduplicated `hover`, and a click on the plot area to `mark-select`;
- patches with `setData(data, false)` on a newer sequence, so the user's zoom,
  focus, and cursor survive a realtime delta, and rebuilds only when the
  lineage, plan, or shape changed;
- calls `destroy()` and removes its click listener on `dispose()`.

`projectAnalyticsArtifactToUplot()` is the pure projection underneath, so the
whole artifact-to-options mapping is unit-testable without a canvas.

## Bundle cost

The `/analytics` barrel exports no adapters, and the bundle gate enforces it
structurally: both `/analytics` and `tree-shake:analytics-core` declare
`forbiddenInputs` on `dist/src/analytics/adapters/` and `node_modules/uplot/`,
so a build fails if either is ever retained. `/analytics/uplot` carries the same
peer exclusion. Root, `/honua`, and browser entrypoints are unchanged — the
subpaths are experimental and are not re-exported from any barrel.

See `docs/bundle-sizes.md` for current measurements.

## Limits

- `MAX_ANALYTICS_MARKS` is 2,000. A widget that needs more rows is asking for a
  table or a tile, not a chart.
- Presentation adapters own no persistent caches. Caching belongs to the widget
  source and the metadata cache, not the seam.
- Mixed null-and-value category selections drop the null bucket (see above).
