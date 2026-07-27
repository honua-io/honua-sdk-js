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

`honua-map` owns a MapLibre GL JS map for package and controller
bindings. Import MapLibre's CSS in browser demos, then pass either an
inline `MapPackage`, a hosted package URL, or a controller whose state
contains a package.

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

357 cells across 21 components x 17 gates: **114 passing**, 131 failing, 91 pending, 21 not applicable.

0 of 21 components have cleared every gate. That is a different axis from the catalog's `supportTier`, which records the functional maturity a feature issue delivered: 1 component(s) are `production-tier` and still carry open gates, listed per component as `openGates` in the manifest.

| Component | Tier | keyboard-behavior | screen-reader-semantics | focus-restoration | reduced-motion | high-contrast | responsive-layout | localization | pseudo-locale | rtl | visual-regression | strict-csp | zero-console-error | deterministic-disposal | duplicate-listener | memory-leak | ssr-import | bundle-budget |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `honua-basemap-switcher` (controls) | survival | pending | pending | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pass | pending | pending | pass | pass |
| `honua-swipe-control` (controls) | survival | pass | pending | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pending | pending | pending | pass | pass |
| `honua-legend` (controls) | survival | pending | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pass | pending | pending | pass | pass |
| `honua-layer-list` (controls) | survival | pending | pending | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pass | pending | pending | pass | pass |
| `honua-map` (web-components) | survival | pending | pending | pending | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pass | pending | pending | pass | pass |
| `honua-layer-list` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-legend` (web-components) | survival | pending | pass | n/a | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | n/a | pending | pass | pass |
| `honua-feature-table` (web-components) | survival | pass | pending | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-search` (web-components) | survival | pass | pass | pass | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-editor` (web-components) | survival | pending | pending | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-feature-editor` (web-components) | production | pass | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | pending | pending | FAIL | pending | pass | pass | pending | pass | pass |
| `honua-chart` (web-components) | survival | pending | pending | n/a | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | n/a | pending | pass | pass |
| `honua-basemap-control` (web-components) | survival | pending | pending | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-bookmarks` (web-components) | survival | pending | pending | pass | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-locate-control` (web-components) | survival | pending | pending | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-measure-control` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-measurement` (web-components) | survival | pass | pass | pending | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pending | pass | pending | pending | pass | pass |
| `honua-sketch-control` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-print-export` (web-components) | survival | pending | pass | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-map-status` (web-components) | survival | pending | pending | FAIL | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |
| `honua-action-panel` (web-components) | survival | pending | pending | pass | n/a | FAIL | FAIL | FAIL | FAIL | FAIL | pending | FAIL | pass | pass | pass | pending | pass | pass |

Gate definitions and per-cell evidence and notes live in
[`config/component-qualification.v1.json`](../config/component-qualification.v1.json).
<!-- component-qualification:end -->

Regenerate with `npm run qualification:components`; `npm run
qualification:components:check` is the CI drift and invariant gate.

