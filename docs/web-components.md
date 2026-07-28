# Honua Web Components

`@honua/sdk-js/web-components` registers framework-neutral custom elements for
plain TypeScript applications:

- `honua-map`
- `honua-layer-list`
- `honua-legend`
- `honua-feature-table`
- `honua-search`
- `honua-editor`
- `honua-feature-editor` (production tier — see below)
- `honua-chart`
- `honua-basemap-control`
- `honua-bookmarks`
- `honua-locate-control`
- `honua-measure-control`
- `honua-sketch-control`
- `honua-print-export`
- `honua-map-status`
- `honua-action-panel`

Import the subpath once in a browser module. The module auto-registers the
elements when `customElements` is available and also exports
`defineHonuaWebComponents()` for scoped registries.

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createHonuaWebComponentController,
  defineHonuaWebComponents,
} from "@honua/sdk-js/web-components";

defineHonuaWebComponents();

const controller = createHonuaWebComponentController({
  mapPackage,
  featuresBySource: {
    incidents: incidentFeatures,
  },
});

document.querySelector("honua-map")!.controller = controller;
```

`honua-map` owns a MapLibre GL JS map for package and controller bindings.
Import MapLibre's CSS in browser demos, then pass either an inline `MapPackage`,
a hosted package URL, or a controller whose state contains a package. MapLibre
6 bundler hosts must configure the ESM worker before the element creates its
map; for Vite:

```ts doc-test=skip reason="Vite worker URL import requires a browser build"
import { setWorkerUrl } from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(maplibreWorkerUrl);
```

```html
<honua-map id="map" package-url="/fixtures/response-map-package.json"></honua-map>
```

```ts doc-test=skip reason="partial excerpt requires application host context"
const map = document.querySelector("honua-map")!;
map.mapPackage = mapPackage;
map.controller = createHonuaWebComponentController({ mapPackage });
```

If an application already created a `HonuaMapRuntime`, adapt it through
the existing controller bridge and bind that controller to the element:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createHonuaWebComponentControllerFromRuntime } from "@honua/sdk-js/web-components";

document.querySelector("honua-map")!.controller = createHonuaWebComponentControllerFromRuntime(runtime);
```

Sibling controls bind to the same controller with `for="<map-id>"`.

```html
<honua-map id="map"></honua-map>
<honua-layer-list for="map"></honua-layer-list>
<honua-legend for="map"></honua-legend>
<honua-feature-table for="map" source="incidents"></honua-feature-table>
<honua-search for="map" source="incidents"></honua-search>
<honua-basemap-control for="map"></honua-basemap-control>
<honua-bookmarks
  for="map"
  bookmarks='[{"id":"north","label":"North district","viewport":{"center":[-157.86,21.3],"zoom":12}}]'
></honua-bookmarks>
<honua-locate-control for="map"></honua-locate-control>
```

The controller contract is intentionally small so this package can integrate
with the runtime today and a richer `HonuaController` later. Use
`createHonuaWebComponentControllerFromRuntime(runtime)` when a
`HonuaMapRuntime` already owns the MapPackage and layer operations.

Components dispatch typed custom events:

- `honua-controller-ready`
- `honua-map-ready`
- `honua-map-error`
- `honua-map-click`
- `honua-map-hover`
- `honua-layer-visibility-change`
- `honua-selection-change`
- `honua-viewport-change`
- `honua-filter-change`
- `honua-search`
- `honua-edit-change`
- `honua-feature-edit-change`
- `honua-feature-edit-commit`
- `honua-basemap-change`
- `honua-bookmark-change`
- `honua-locate-change`
- `honua-measure-change`
- `honua-sketch-change`
- `honua-export`
- `honua-fullscreen-change`
- `honua-action`

Styling is scoped to each component's shadow root and can be themed with CSS
custom properties such as `--honua-ui-bg`, `--honua-ui-fg`,
`--honua-ui-border`, and `--honua-ui-accent`.

Controller state drives the renderer after initialization. Layer
visibility updates call the runtime layer API, viewport updates call
`setViewState`, selection updates set the `selected` feature-state key,
and `controller.setFeatureState()` / `removeFeatureState()` apply
source-qualified feature-state patches to the MapLibre map.

## Expanded Map Controls

The expanded controls are framework-neutral siblings of `honua-map`. They bind
with the same `for="<map-id>"` convention and dispatch typed custom events so
applications can connect richer adapters later without replacing markup.

```html
<honua-map id="map"></honua-map>
<honua-basemap-control for="map"></honua-basemap-control>
<honua-bookmarks for="map"></honua-bookmarks>
<honua-locate-control for="map"></honua-locate-control>
<honua-measure-control for="map"></honua-measure-control>
<honua-sketch-control for="map"></honua-sketch-control>
<honua-print-export for="map" title="Operations map"></honua-print-export>
<honua-map-status for="map" attribution="Honua"></honua-map-status>
<honua-action-panel
  for="map"
  actions='[{"id":"refresh","label":"Refresh sources"}]'
></honua-action-panel>
```

`honua-basemap-control` lists background layers and layers with
`metadata.basemap === true`. Selecting a basemap toggles those layer
visibilities through the shared controller and emits `honua-basemap-change`.

`honua-bookmarks` always includes the package `initialView` as `Home` when it
is available. Additional bookmarks can be supplied as a JSON array through the
`bookmarks` attribute. Activating a bookmark calls `controller.setViewport()`
and emits both `honua-bookmark-change` and `honua-viewport-change`.

`honua-locate-control` uses a configured `latitude` / `longitude` pair when
present, otherwise it requests browser geolocation. If neither path is
available it renders an explicit unsupported state and emits
`honua-locate-change` with `status: "unsupported"`.

`honua-measure-control` and `honua-sketch-control` expose accessible mode
buttons and typed events (`honua-measure-change`, `honua-sketch-change`). Until
a geometry editing or measurement adapter is attached to the shared controller,
they render visible unsupported messaging instead of disappearing.

`honua-print-export` emits `honua-export` for print, snapshot, and JSON export
actions. Browser print calls `window.print()` when available. Snapshot and state
export **fail closed** until an application supplies an export adapter — see
[Secure export](#secure-export) below.

`honua-map-status` displays an approximate scale, attribution text, and a
fullscreen action. Fullscreen emits `honua-fullscreen-change` and renders an
unsupported event when the browser does not expose `requestFullscreen()`.

`honua-action-panel` renders application-defined action buttons from an
`actions` JSON array and emits `honua-action`. Empty panels render a visible
unsupported state so apps do not appear to lose configured controls.

## Secure export

Print, snapshot, and sanitized-state export all run through one explicit
adapter contract (issue #683). There is deliberately no ambient fallback for
snapshot or state export: reading renderer pixels needs a canvas the application
created with `preserveDrawingBuffer: true` and is authorized to read, and
serializing "the current state" would otherwise carry the signed tile URLs,
`Authorization` headers, SAS query strings, and OAuth scope detail that made the
map work. With no adapter, both **fail closed** — no bytes at all, and a
`HonuaCapabilityNotSupportedError` on the result — rather than degrading into a
blank image or a partially credentialed JSON file. Browser print keeps working
without an adapter because `window.print()` reads no pixels and serializes no
state.

```ts doc-test=skip reason="requires a live MapLibre map created with preserveDrawingBuffer"
import {
  createHonuaExportAdapter,
  runHonuaExport,
} from "@honua/sdk-js/web-components";

const adapter = createHonuaExportAdapter({
  id: "operations-console",
  snapshot: { getCanvas: () => map.getCanvas() },
  state: true,
});

// Wire it to the element...
document.querySelector("honua-print-export")!.exportAdapter = adapter;

// ...or drive an export directly.
const result = await runHonuaExport({ kind: "snapshot", adapter, state });
if (result.status === "ready") {
  download(result.bytes!, result.filename!);
}
await result.release(); // always safe to call once; `bytes` stay valid
```

Every export is redacted by default in two independent layers: the state
document is an **allowlist projection** (a field nobody allowlisted has no path
into the output, so upstream state growth cannot silently widen an export), and
everything that survives is then scrubbed and re-scanned. A credential reaching
the final scan is a hard failure, not a silent scrub. The same treatment applies
to download filenames, to the adapter-supplied media type (validated against a
strict `type/subtype` grammar with an allowlisted parameter set, so
`text/plain; token=…` cannot ride out on the result), and to every message
placed on a `honua-export` event or a log line — a token disclosed through a
filename is exactly as disclosed as one in the payload. Binary artifacts are
scanned too: "binary" is not a security boundary, so printable runs are
extracted from every byte payload and swept, catching a token inside a PNG
`tEXt` chunk, a JPEG comment, or PDF/XMP metadata.

Attribution, licence notices, scale, export timestamp, data freshness, and
fidelity warnings travel with every artifact. Whether the artifact's **bytes**
carry the attribution is tracked separately as `provenanceEmbedded`, because
conflating the two is how an unattributed image ships: reading a WebGL canvas
captures the map's pixels and nothing else, since MapLibre renders attribution
as DOM outside the canvas. An adapter that does not composite attribution must
not claim it did, so the result reports `provenanceEmbedded: false` and carries
an explicit fidelity warning naming what the caller has to present alongside the
artifact. Pass `requireEmbeddedProvenance: true` to turn that into a hard
failure when the artifact will travel on its own with no surrounding surface to
carry the notice.

## Production Feature Table (bounded query + linked state)

`honua-feature-table` has two lanes and renders the same accessible WAI-ARIA
`grid` in both.

The **controller lane** is the original behavior: with no engine attached the
element asks the shared controller for one bounded page and renders it. Nothing
about that markup or its events changed.

The **bounded lane** is for operational applications. Assign the element's
`table` property a bounded engine created with `createHonuaFeatureTable`. The
engine owns remote paging, multi-column sort, typed filters, column semantics,
budgets, virtualization, bounded export, and realtime reconciliation; the
element only renders its snapshot and forwards input.

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createHonuaFeatureTable,
  linkFeatureTableToExploration,
} from "@honua/sdk-js/web-components";
import { explainQuery } from "@honua/sdk-js/query-planner";

const source = dataset.source<Incident>("incidents")!;

const table = createHonuaFeatureTable({
  source,
  sourceId: "incidents",
  columns: [
    { field: "OBJECTID", label: "ID", type: "integer" },
    { field: "NAME", label: "Incident", type: "string" },
    { field: "SEVERITY", label: "Severity", type: "number", format: (v) => `P${v}` },
    { field: "INTERNAL_NOTE", visible: false },
  ],
  budgets: { pageSize: 200, maxCachedRows: 2_000, maxRequests: 64 },
  planner: (query) => explainQuery({ descriptor: source.descriptor, query }),
});

document.querySelector("honua-feature-table")!.table = table;
await table.refresh();
```

### Bounded by construction

Every fetch is bounded by `HonuaFeatureTableBudgets` — `pageSize`,
`maxCachedRows`, `maxCachedBytes`, `maxRequests`, `maxExportRows`, and
`windowOverscan`. The engine loads only the pages the visible window needs,
evicts least-recently-used pages to hold the row and byte ceilings, and stops
issuing requests once `maxRequests` is reached. `snapshot.ledger` reports exact
consumption and names the ceiling that was hit in `ledger.exhausted`. A window
row whose page is not resident is `undefined` in `snapshot.rows`, and the grid
paints a placeholder rather than inventing values.

The row and byte ceilings are hard. If a single page cannot fit under
`maxCachedBytes`, that page is evicted too rather than left resident above the
ceiling; `ledger.exhausted` reports `bytes` and `snapshot.message` explains it.
A `pageSize` larger than `maxCachedRows` can never fit, so it is rejected up
front as `unsupported` instead of failing per page.

`maxRequests` bounds **one** filter/sort/projection identity, so
`ledger.requests` resets when that identity changes and an exhausted table can
still load a new question. `ledger.lifetimeRequests`, `ledger.rows`,
`ledger.bytes`, and `ledger.evictedRows` are lifetime totals and never reset.

`table.export({ format: "csv", maxRows })` reuses the same paged query path.
`maxRows` can only lower the ceiling — a request above `budgets.maxExportRows`
is clamped and the result reports `truncated: true` with the `limit` that
applied.

### Result truth, never a manufactured count

`snapshot.state` is one of `idle`, `loading`, `ready`, `partial`, `stale`,
`cancelled`, `unsupported`, or `error`, and `snapshot.count` names the evidence
behind any number:

| `count.kind` | `count.evidence`                             | Meaning                                  |
| ------------ | -------------------------------------------- | ---------------------------------------- |
| `known`      | `result-total-count` / `exhausted-pages`     | The source reported it, or paging drained |
| `estimated`  | `plan-estimate`                              | The accepted plan estimated it            |
| `partial`    | `loaded-rows`                                | Only `count.loaded` is known             |
| `unknown`    | `none`                                       | No evidence exists                        |

`count.value` is absent for `partial` and `unknown`, the grid renders
`aria-rowcount="-1"`, and the live region says "at least N rows loaded; total
unknown".

Stable row identity is required, not best-effort. A table with no
`identityField` (or `descriptor.schema.primaryKey`) reports `unsupported`, and so
does a table whose declared identity attribute is absent, `null`, or not a
string/number on any returned row. Substituting a row's position in its page
would key it by an offset that changes with every sort, filter, and page
boundary, corrupting selection — so the engine refuses instead.

### Paging modes

`pagingMode: "offset"` (default) issues random-access `Query.pagination`
requests. `pagingMode: "cursor"` drives the source's `stream()` generator — the
protocol-neutral cursor seam — and is therefore forward-only: a jump past the
drained frontier reports `unsupported` instead of serving the wrong page. A
source without `stream` reports `unsupported` for cursor paging.

### Query evidence

`snapshot.evidence` carries the accepted plan's `planId`, `planFingerprint`,
`pushdown`, and `fidelity`, plus a `work` list that attributes each unit of work
to the `server`, `worker`, or `client` tier. Remote plan steps are server work,
non-remote residual steps are attributed to `residualExecution` (`"client"` by
default, `"worker"` when a worker executes them), filter degradation is recorded
as a residual, and virtualization plus column formatting are always recorded as
client presentation work. `featureTableWorkByTier(evidence, tier)` selects one
tier.

Page-cache identity (`featureTablePageCacheKey`) includes the source id and
version, schema identity, accepted-plan fingerprint, filter, sort, projection,
authorization scope, and freshness — so a stale page can never answer a
different question.

### Linked exploration state

`linkFeatureTableToExploration(table, view)` binds the table to an
`ExplorationViewController` in both directions. Table selection, sort, and the
virtualization window (as the shared `page` slice) publish outward; peer
changes to selection, sort, visible fields, and filters apply inward. Row keys
and exploration selection targets round-trip deterministically through
`table.keysForTargets()` and `table.selectionTargets()`, so map-to-table and
table-to-map selection agree on identity.

Selection is independent of cache residency: `keysForTargets()` resolves any
target for the table's own source — computed from the target's id, not looked up
in the page cache — so a map selecting a feature far outside the loaded window
still selects the right row, and selecting it does not clear the shared
selection. Targets for other sources resolve to nothing, and publishing the
table's selection outward replaces only its own source's entries, leaving a
multi-source workspace's peer selections intact.

```ts doc-test=skip reason="partial excerpt requires application host context"
const grid = context.connectView({ id: "grid", role: "grid" });
const unlink = linkFeatureTableToExploration(table, grid);
// ... later, on teardown:
unlink();
```

### Realtime deltas preserve interaction state

`table.applyRealtimeDiff(diff)` accepts a reconciliation diff from
`@honua/sdk-js/realtime` directly. Updates patch rows in place — a delta never
reorders a materialized page behind the user — so the focused cell, selected
rows, sort, and window survive. When state cannot be preserved the outcome
announces a documented conflict instead of failing silently:

| Conflict code            | Cause                                              |
| ------------------------ | -------------------------------------------------- |
| `sort-key-changed`       | An update changed a sorted column's value           |
| `selection-invalidated`  | Selected rows were deleted upstream                 |
| `focused-row-deleted`    | The focused row was deleted upstream                |
| `snapshot-reset`         | A replacement snapshot arrived                      |
| `schema-changed`         | The source schema changed                           |

Conflicts appear in `snapshot.conflicts`, are read out by the grid's polite live
region, and are dispatched as `honua-table-conflict`.

### Keyboard and screen-reader contract

The grid follows the WAI-ARIA `grid` pattern for the WCAG 2.2 AA workflow:
`role="grid"` with `aria-rowcount` / `aria-colcount` / `aria-busy`,
`role="row"` and `role="gridcell"` carrying 1-based
`aria-rowindex` / `aria-colindex` so a virtualized window still announces
absolute positions, `aria-sort` per column header, `aria-selected` per row, and
a `role="status" aria-live="polite"` region for result truth and conflicts.
Exactly one cell is tabbable (roving `tabindex`).

| Keys                    | Action                                                |
| ----------------------- | ----------------------------------------------------- |
| Arrow keys              | Move the focused cell                                 |
| `Home` / `End`          | First / last cell in the row                          |
| `Ctrl`/`Cmd` + `Home`/`End` | First / last cell in the grid                     |
| `PageUp` / `PageDown`   | Move one window, loading the page focus lands on      |
| `Enter` / `Space`       | Select the focused row                                |

Clicking a column header toggles its sort (`Shift`-click adds a secondary sort
key). The `row-height` attribute sizes the virtualization spacers; keep it in
step with any custom row CSS.

## Production-Tier Feature Editing (`honua-feature-editor`)

`honua-feature-editor` is the production-tier editing surface (issue #680). It
composes the public contract edit primitives — `createEditSketchWorkflow`,
`createEditSession`, snapping, attachment staging, undo/redo, optimistic hooks
— rather than reimplementing any protocol behavior, and it imports no
protocol-specific adapter. The survival-tier `honua-editor` remains available
as the simpler controller-bound widget.

Wire it to a `Source` through `createFeatureEditorWorkflow`:

```ts doc-test=skip reason="partial excerpt requires an editable Source and application host context"
import {
  createFeatureEditorWorkflow,
  defineHonuaWebComponents,
} from "@honua/sdk-js/web-components";

defineHonuaWebComponents();

const workflow = createFeatureEditorWorkflow({
  source: dataset.source("permits")!,
  // Optional. Subtypes are a presentation contract: one field carries the
  // subtype code, and each subtype narrows the valid choices per field.
  subtypes: {
    field: "permit_kind",
    defaultCode: 1,
    subtypes: [
      { code: 1, name: "Residential" },
      {
        code: 2,
        name: "Commercial",
        fieldOverrides: {
          status: { domain: { type: "coded-value", codedValues: [{ name: "Under review", code: "review" }] } },
          inspector: { required: true },
        },
      },
    ],
  },
  // Deny-only. An override can never grant an operation the source lacks.
  operations: { delete: { available: false, reason: "Permits are archived, never deleted." } },
});

const editor = document.querySelector("honua-feature-editor")!;
editor.workflow = workflow;
editor.selectedFeature = selectedPermit; // drives update / delete availability
```

What the element derives, and what it refuses:

- **Form from metadata.** Controls, labels, coded-value choices, numeric range
  bounds, max lengths, required and read-only state all come from the source's
  public schema (with domains projected across by `editorFieldsFromSchema`) plus
  the active subtype's overrides. No service field name is hard-coded.
- **Truthful per-operation state.** `create` / `update` / `delete` are gated
  independently. An evaluated `capabilityProfile` wins over the coarse
  `applyEdits` capability, so `authorization-required`, `authorization-denied`,
  and `policy-disabled` are surfaced with their reason codes instead of a
  disabled button with no explanation. A read-only or partially editable service
  renders each blocked operation's reason.
- **Rejection is never success.** A draft that fails validation (including a
  subtype-narrowed domain) is never transported — the commit reports
  `transported: false`. Every non-succeeded `applyEdits` outcome maps to
  `rejected`, `conflict`, `unsupported`, or `cancelled`, and a partial apply is
  reported as such.
- **Explicit conflict resolution.** A version / precondition failure, or a
  divergent external change to the drafted feature, parks the draft in
  `conflict`; submitting again is refused until `resolveConflict("keep-mine" |
  "discard-mine" | "reload")` records a decision.
- **Realtime safety.** `workflow.applyExternalChange(feature)` ignores changes to
  other features entirely (no re-render, so selection, unsaved values, focus, and
  caret survive), adopts server values only for fields the user has not touched,
  and escalates a divergent token to a conflict.
- **Redacted attachments.** Staged attachment payloads — including string URLs
  that may carry credentials — never enter component state or an emitted event;
  only name, content type, size, and status do.
- **Keyboard and screen-reader complete.** The whole workflow, geometry
  included, is usable without the map canvas: labelled native controls with
  `aria-required` / `aria-invalid` / `aria-describedby`, `role="alert"` problem
  regions, a `role="status"` live message, a GeoJSON geometry textarea with
  **Apply geometry** / **Clear geometry**, `Escape` to cancel, and
  `Ctrl`/`Cmd`+`Z` (with `Shift`) for undo / redo.

Geometry can additionally be drawn on the map. `createTerraDrawEditorSketch` is
the app-platform default: it constructs terra-draw (an optional peer) for a
MapLibre map, wires SDK snapping, reports terra-draw's real tool support so
`rectangle` / `circle` become enabled, and re-binds itself to each new draft.

```ts doc-test=skip reason="partial excerpt requires terra-draw peers and a MapLibre map"
import { createTerraDrawEditorSketch } from "@honua/sdk-js/web-components";

const sketch = await createTerraDrawEditorSketch(map, { workflow, snapping: { index } });
sketch.setTool("polygon"); // arms terra-draw and the workflow together
await sketch.ready(); // resolves once bound to the current draft
```

Apps that construct terra-draw themselves use `bindEditorSketch(draw, { workflow })`
and, for snapping, `editorSnappingOptions(workflow, { index })`. Route snapping
through that helper rather than passing a model directly: terra-draw resolves its
snapping hook once per mode, and the editor builds a new contract sketch model
for every draft, so a directly-passed model would pin snapping to the first
draft and make `setSnapping(...)` on later drafts a silent no-op.

Two lifecycle details worth knowing:

- **Superseded submits.** An `AbortSignal` is advisory, so a transport may settle
  a submit the editor has already moved on from. A completion that no longer
  owns the workflow never writes to it: the commit comes back with
  `superseded: true` and `status: "cancelled"`, its `snapshot` describes the
  *current* draft, and the workflow makes no claim about the superseded edit's
  server outcome (`failures` carries whatever the service reported).
- **Detach and reattach.** The element holds its workflow subscription only
  while connected, and re-takes it — re-reading state it missed — on reconnect,
  so moving the editor in the DOM does not leave it frozen.

Events: `honua-feature-edit-change` (redacted snapshot on every state change)
and `honua-feature-edit-commit` (the submit outcome, including `transported`).

## Production qualification matrix

Production support for the component kit is tracked as an enforceable matrix
rather than a claim in prose: every shipped tag in the component catalog against
every gate that matters for accessibility, localization, visual behavior, CSP,
lifecycle cleanup, and bundle cost (issue #683, REQ-004/REQ-005/NFR-001).

The matrix is seeded from what the test suite actually asserts today. `passing`
requires evidence files that are verified to exist, so deleting the test behind a
gate fails CI instead of quietly downgrading the claim. `failing` records a
requirement we know is unmet — including from code inspection, before an
automated gate exists. `pending` — most of this matrix — means no automated gate
and no verdict yet. `not-applicable` requires an argument.

These gates are a **different axis** from the catalog's `supportTier`. The tier
records the functional maturity a feature issue delivered on a component
(`honua-feature-editor` is `production-tier` because issue #680 delivered
capability-aware editing, conflict handling, snapping, and attachment staging).
Gate completion is the strictly harder bar, so the verifier enforces only that
direction — anything clearing every gate must carry the production tier — and
every production-tier component's still-open gates are listed as `openGates` in
the manifest, so the tier can never be mistaken for gate completion.

<!-- component-qualification:start -->
<!-- GENERATED by scripts/component-qualification.mjs from src/controls/qualification.ts. Do not edit by hand; run npm run qualification:components. -->

357 cells across 21 components x 17 gates: **134 passing**, 129 failing, 73 pending, 21 not applicable.

0 of 21 components have cleared every gate. That is a different axis from the catalog's `supportTier`, which records the functional maturity a feature issue delivered: 1 component(s) are `production-tier` and still carry open gates, listed per component as `openGates` in the manifest.

| Component | Tier | keyboard-behavior | screen-reader-semantics | focus-restoration | reduced-motion | high-contrast | responsive-layout | localization | pseudo-locale | rtl | visual-regression | strict-csp | zero-console-error | deterministic-disposal | duplicate-listener | memory-leak | ssr-import | bundle-budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `honua-basemap-switcher` (controls) | survival | pending | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pending | pending | pass | pass |
| `honua-swipe-control` (controls) | survival | pass | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pending | pending | pass | pass |
| `honua-legend` (controls) | survival | pending | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pending | pending | pass | pass |
| `honua-layer-list` (controls) | survival | pending | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pending | pending | pass | pass |
| `honua-map` (web-components) | survival | pending | pass | pending | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pending | pending | pass | pass |
| `honua-layer-list` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-legend` (web-components) | survival | pending | pass | n/a | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | n/a | pending | pass | pass |
| `honua-feature-table` (web-components) | survival | pass | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-search` (web-components) | survival | pass | pass | pass | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-editor` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-feature-editor` (web-components) | production | pass | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | pending | pending | FAIL | pending | pass | pass | pending | pass | pass |
| `honua-chart` (web-components) | survival | pending | pass | n/a | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | n/a | pending | pass | pass |
| `honua-basemap-control` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-bookmarks` (web-components) | survival | pending | pass | pass | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-locate-control` (web-components) | survival | pending | pass | pass | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-measure-control` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-measurement` (web-components) | survival | pass | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pass | pending | pending | pass | pass |
| `honua-sketch-control` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-print-export` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-map-status` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-action-panel` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |

Gate definitions and per-cell evidence and notes live in
[`config/component-qualification.v1.json`](../config/component-qualification.v1.json).
<!-- component-qualification:end -->

Regenerate with `npm run qualification:components`; `npm run
qualification:components:check` is the CI drift and invariant gate.

