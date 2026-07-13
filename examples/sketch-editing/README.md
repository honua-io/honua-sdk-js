# Sketch editing with terra-draw

Interactive draw/edit/delete on a MapLibre map through the SDK's
`EditSketchWorkflowModel`, powered by the optional
[terra-draw](https://terradraw.io) peer.

What it demonstrates:

- **One workflow, one history.** terra-draw modes (point, line, polygon,
  rectangle, circle, freehand, select) finish into the edit-sketch workflow via
  `createTerraDrawSketch` / `bindTerraDrawSketch` from `@honua/sdk-js/runtime`,
  so undo/redo and validation are workflow features, not renderer features.
- **Snapping through terra-draw's own pointer pipeline.**
  `createTerraDrawSnapping` bridges the SDK `SnapIndex` into terra-draw's
  `snapping.toCustom` hook on the linestring and polygon modes; the status
  panel shows the resolved candidate. Modes without a snapping option (point,
  rectangle, circle, freehand) keep terra-draw-native behavior.
- **Edits land in `applyEdits` unchanged.** Submit drives the standard
  edit-session path against a deterministic in-memory fixture source (mock
  lane); the operation log shows each applied envelope.
- **Optional peer discipline.** `terra-draw` and
  `terra-draw-maplibre-gl-adapter` are optional peers of `@honua/sdk-js`; the
  SDK imports them lazily via `createTerraDrawSketch` and works without them.

## Run it

```bash
npm ci
npm run demo:sketch-editing          # Vite dev server
npm run demo:sketch-editing:build    # production build
npm run demo:sketch-editing:mock     # build + serve the fixture build
npm run demo:sketch-editing:typecheck
```

Browser smoke test:

```bash
npm run test:playwright:sketch-editing
```

## Live lane

Pointing the fixture source at a live editable endpoint (an isolated,
resettable dataset) is planned; the workflow code is identical — only the
`Source` changes.
