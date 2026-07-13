# terra-draw sketch binding (`@honua/sdk-js/runtime`)

Status: experimental (issue `#492`, Esri Widget Cliff workstream).
Public entrypoint: `@honua/sdk-js/runtime` — `bindTerraDrawSketch`,
`createTerraDrawSketch`, `createTerraDrawSnapping`,
`terraDrawSketchToolCapabilities`, `editSketchToolForTerraDrawMode`,
`TERRA_DRAW_SKETCH_TOOL_MODES`.

Interactive drawing on the MapLibre path is provided by
[terra-draw](https://terradraw.io), the engine-agnostic community successor to
mapbox-gl-draw. The SDK does not fork or wrap terra-draw's rendering — it
adapts terra-draw's mode events onto the renderer-neutral
`EditSketchWorkflowModel` from `@honua/sdk-js/contract`, so undo/redo,
validation, snapping configuration, and edit-session `applyEdits` submission
are workflow features that apply to every sketch the same way.

## Peer setup

`terra-draw` and `terra-draw-maplibre-gl-adapter` are **optional** peer
dependencies. The SDK never imports them at module scope: `bindTerraDrawSketch`
accepts a duck-typed instance your app constructed, and `createTerraDrawSketch`
loads both packages lazily via dynamic `import()` (throwing a descriptive error
when they are missing). Importing `@honua/sdk-js/runtime` without terra-draw
installed stays side-effect free; the `tree-shake:runtime-terra-draw-sketch`
bundle-budget fixture guards this.

```bash
npm i terra-draw terra-draw-maplibre-gl-adapter   # only if you use the binding
```

## Modes and tools

terra-draw mode names map onto the contract `EditSketchTool` values:

| terra-draw mode | `EditSketchTool` |
| --- | --- |
| `point`, `marker` | `point` |
| `linestring`, `polyline`, `freehand-linestring` | `line` |
| `polygon`, `freehand`, `sector`, `sensor` | `polygon` |
| `rectangle`, `angled-rectangle` | `rectangle` |
| `circle` | `circle` |
| `select`, `render`, `static`, custom modes | — (not applied) |

The contract defaults mark `rectangle` and `circle` as unsupported (they need
renderer support); pass `terraDrawSketchToolCapabilities()` as the workflow's
`sketchTools` to mark the terra-draw-backed tools supported. `buffer` stays
unsupported — it needs geometry-service support, not a drawing engine.

## One-call setup

```ts doc-test=skip reason="partial excerpt requires a map instance and an editable source"
import { createEditSketchWorkflow, createSnapIndex } from "@honua/sdk-js/contract";
import { createTerraDrawSketch, terraDrawSketchToolCapabilities } from "@honua/sdk-js/runtime";

const workflow = createEditSketchWorkflow({
  source,                                          // any editable contract Source
  kind: "create",
  feature: { attributes: {} },
  sketchTools: terraDrawSketchToolCapabilities(),
  snapping: { enabled: true, tolerance: 16 },
});

const index = createSnapIndex();
index.setSourceFeatures("parcels", parcels);

const sketch = await createTerraDrawSketch(map, {
  model: workflow,
  snapping: { index, model: workflow },
});

sketch.setTool("polygon");   // user draws on the map
sketch.undo();               // workflow history, mirrored back into terra-draw
await workflow.submit();     // edit-session applyEdits path, unchanged
```

Every terra-draw `finish` event — freshly drawn features and select-mode edits
(dragged features, dragged/inserted/deleted coordinates) — flows through
`model.setSketchGeometry`, so each is one undoable workflow step. Deleting the
tracked feature stages an undoable `null` geometry. `undo()`/`redo()` on the
handle drive the model and push the restored geometry back into terra-draw.

Apps that need custom terra-draw mode options construct the instance
themselves and call `bindTerraDrawSketch(draw, { model })` — the binding only
attaches listeners (detached by `handle.remove()`).

## Geometry round-trip and reprojection

terra-draw emits EPSG:4326 GeoJSON. When the edit source stores another CRS,
pass the `@honua/sdk-js/geometry` reprojection helpers through the binding:

```ts doc-test=skip reason="partial excerpt requires a terra-draw instance and workflow model"
import { toWebMercator, toWgs84 } from "@honua/sdk-js/geometry";

bindTerraDrawSketch(draw, {
  model,
  transformGeometry: (g) => toWebMercator(g, 4326),  // model/applyEdits side
  restoreGeometry: (g) => toWgs84(g, 3857),          // terra-draw side (undo/redo sync)
});
```

## Snapping

`createTerraDrawSnapping({ index, model })` produces a function with
terra-draw's `Snapping.toCustom` shape, backed by the SDK `SnapIndex` and the
workflow's live snapping config — the same deterministic candidate ordering as
`bindEditSketchSnapping`. `createTerraDrawSketch` wires it automatically.

The seam is honest: terra-draw exposes per-mode snapping options on its
**linestring, polygon, and polyline** modes only. Point, rectangle, circle,
and freehand modes have no custom-snapping hook in terra-draw's pointer
pipeline, so those modes keep terra-draw-native behavior. If you need snapped
point placement, resolve the position with `SnapIndex.resolve()` on click and
set the geometry through the workflow directly.

## esri-compat delegation

The `Sketch` shim (`@honua/sdk-js/esri-compat`) feature-detects a binding via
its `sketchBinding` option: any object with a callable `setTool` (the
`bindTerraDrawSketch` / `createTerraDrawSketch` handle qualifies) receives
`create` tool-mode changes (`polyline` → `line`), `update()` switches to
select mode, and `cancel`/`reset` leave the drawing mode. Without a binding —
including when terra-draw is not installed — the shim keeps its existing
headless behavior and events.

## Example

`examples/sketch-editing` demonstrates draw/edit/delete with undo/redo,
snapping, and fixture-lane `applyEdits` (`npm run demo:sketch-editing`,
Playwright smoke via `npm run test:playwright:sketch-editing`).
