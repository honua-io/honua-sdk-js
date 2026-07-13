# Renderer objects and temporal playback

> Status: `@experimental` — the surfaces ship on the stable `/style` and
> `/map` entrypoints but the descriptor shapes may still change in minor
> releases. (Issue #497.)

First-class renderer objects give standalone MapLibre users the smart-mapping
vocabulary Esri/CARTO users expect — class breaks, unique values, heatmaps,
clustering — without Honua becoming a renderer. A renderer object is a
serializable, renderer-neutral description that compiles deterministically to
MapLibre style fragments through the `/expr` builder. Compilation is a pure
function: the same descriptor always produces byte-identical style JSON, and
nothing is cached.

```ts doc-test=skip reason="requires a browser MapLibre host"
import { classBreaksRenderer } from "@honua/sdk-js/style";

const renderer = classBreaksRenderer({
  field: "magnitude",
  breaks: [
    { min: 0, max: 3, label: "Minor" },
    { min: 3, max: 6, label: "Moderate" },
    { min: 6, label: "Strong" },
  ],
  colors: ["#fed976", "#fd8d3c", "#b10026"],
  defaultColor: "#cccccc",
});

const [fragment] = renderer.toMapLibre("point"); // "point" | "line" | "polygon"
map.addLayer({ id: "quakes", type: fragment.type, source: "quakes", paint: fragment.paint });
renderer.legendItems(); // [{ kind: "class-break", label: "Minor", color: "#fed976", minValue: 0, maxValue: 3 }, …]
```

## The four renderers

All four factories live on `@honua/sdk-js/style` and share the same contract:
`toMapLibre(geometryType)` returns layer fragments, `legendItems()` returns
legend metadata, and `toJSON()` returns a serializable descriptor that
`rendererFromJSON()` revives.

| Factory | Compiles to | Notes |
| --- | --- | --- |
| `classBreaksRenderer({ field, breaks, colors?, defaultColor? })` | one `step` expression per styled property | `breaks[i].min ?? max` is the step threshold; positional `colors` fill in omitted break colors |
| `uniqueValueRenderer({ field, values, defaultColor? })` | one `match` expression per styled property | `field2`/`field3` + `fieldDelimiter` concatenate multi-field keys |
| `heatmapRenderer({ weightField?, radius?, intensity?, colorRamp? })` | a single `heatmap` layer fragment | `colorRamp` is explicit `{ stop, color }` stops or a color list spread evenly over density 0..1 |
| `clusterRenderer({ radius?, maxZoom?, countField?, steps })` | `clusters` + `cluster-count` + `unclustered` fragments | `toMapLibreSource()` returns the GeoJSON-source cluster options; `countField` sums a property per cluster instead of counting points |

Advanced entries accept a `style: { paint, layout }` override instead of the
`color` shorthand — that is how WebMap symbols round-trip losslessly.

### Legend metadata (stable contract)

`legendItems()` always yields `{ kind, label, color }`, with `value` on
unique-value entries, `minValue`/`maxValue` on ranged entries (class breaks,
cluster steps), and the ramp position in `value` for heatmap stops. A trailing
`kind: "default"` item appears when the renderer declares a default
color/label/style. Legend components can consume this without knowing the
renderer kind.

### Serialization

Descriptors are plain JSON:

```ts doc-test=skip reason="illustrative snippet"
const descriptor = renderer.toJSON(); // safe to persist / send over the wire
const revived = rendererFromJSON(descriptor); // identical compile output
```

## One implementation everywhere

WebMap JSON conversion (`@honua/sdk-js/webmap`'s `convertRenderer`) and the
esri-compat renderer shims emit these objects and compile through the same
`/expr` path — there is exactly one class-breaks/unique-value compiler in the
SDK, and the WebMap converter's style output is unchanged byte for byte.

- `uniqueValueRendererFromWebMap(renderer, warn)` /
  `classBreaksRendererFromWebMap(renderer, warn)` build renderer objects from
  WebMap renderer JSON.
- `rendererObjectFromClassBreaksCompat(compat)` /
  `rendererObjectFromUniqueValueCompat(compat)` (on `/esri-compat`) project a
  `ClassBreaksRendererCompat` / `UniqueValueRendererCompat` shim to a renderer
  object plus any symbol-conversion warnings.

## Bridge integration

`mountSource(map, source, { renderer })` derives the mounted layer set from a
renderer object; explicit `paint`/`layout` overrides still win per property.
A cluster renderer additionally configures GeoJSON-source clustering
(`cluster`, `clusterRadius`, `clusterMaxZoom`, `clusterProperties`) and
therefore requires the `"geojson"` strategy.

```ts doc-test=skip reason="requires a browser MapLibre host"
import { mountSource } from "@honua/sdk-js/map";
import { uniqueValueRenderer, heatmapRenderer } from "@honua/sdk-js/style";

const mounted = await mountSource(map, data.source(), {
  renderer: uniqueValueRenderer({
    field: "priority",
    values: [
      { value: "high", color: "#b91c1c" },
      { value: "low", color: "#0f766e" },
    ],
  }),
});

// Swap renderers without teardown where MapLibre allows: same layer
// structure → per-property setPaintProperty/setLayoutProperty diff;
// structural change → only the owned layers (and, for cluster-option
// changes, the source) are recreated.
await mounted.setRenderer(heatmapRenderer({ weightField: "priorityScore" }));
```

Diagnostics record which path ran: `renderer-applied` (in-place diff),
`renderer-recreated-layers`, or `renderer-recreated-source`.

## Temporal playback

`createTemporalPlayback` from `@honua/sdk-js/map` is a renderer-neutral
play/pause/scrub controller over a time extent with a bounded frame cadence.
It drives time filters through a thin binding — either the bridge handle
(`MountedSource.setFilter` with a generated `where` clause) or client-side
MapLibre layer filters composed with each layer's bind-time filter.

```ts doc-test=skip reason="requires a browser MapLibre host"
import { createTemporalPlayback } from "@honua/sdk-js/map";

const playback = createTemporalPlayback({
  handle: mounted, // or layer: { map, layerIds: ["quakes"] } for client-side filters
  timeField: "event_time",
  extent: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"],
  windowMs: 24 * 60 * 60 * 1000, // one-day window
  stepMs: 6 * 60 * 60 * 1000, // advance six hours per frame
  frameIntervalMs: 400,
  loop: true,
});
playback.on("tick", ({ window, progress }) => updateSlider(progress));
playback.play();
playback.scrub("2026-01-15T00:00:00Z");
playback.setWindow(3 * 24 * 60 * 60 * 1000);
playback.dispose();
```

Memory is bounded by construction (issue #497 REQ-004): the controller keeps
only the current window, and filter application is coalesced — at most one
request in flight plus the single latest pending window; intermediate windows
are dropped, never queued. No window data is pre-fetched or cached by the
controller. Playback over static data has no realtime dependency; layering it
over a live feed is where #393's snapshot-plus-delta resume vocabulary
applies, and that integration is intentionally out of scope here.

For the `layer` binding the time property must be numeric (epoch
milliseconds) because MapLibre filters compare numbers; the `handle` binding
generates `<timeField> >= <startMs> AND <timeField> < <endMs>` by default and
accepts a `formatWhere` override for servers that need date literals.

## Demos

- [`examples/temporal-playback/`](../examples/temporal-playback/README.md) —
  class-breaks renderer + playback over a deterministic time-enabled fixture
  (mock lane, no network).
- [`examples/service-explorer/`](../examples/service-explorer/README.md) and
  [`examples/realtime-incident-dashboard/`](../examples/realtime-incident-dashboard/README.md)
  build their categorical styling from `uniqueValueRenderer` instead of
  hand-written `match` expressions.
