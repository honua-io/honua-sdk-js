# Honua Web Components Basic

Plain TypeScript sample for `@honua/sdk-js/web-components` and the native
control kit in `@honua/sdk-js/controls`.

The sample registers Honua custom elements, shares one controller across map,
layer list, legend, table, search, editor, and chart widgets, and demonstrates
read-only editor capability state without React or another framework.

Basemaps are driven by `<honua-basemap-switcher>` from
`@honua/sdk-js/controls`: three exclusive bases (Light, Dark, and a composite
Terrain option) are applied directly to the MapLibre map, wired declaratively
via `for="ops-map"`, and themed from `styles.css` through the control's
`::part(group)` / `::part(radio)` / `::part(radio-active)` hooks.

The legend is `<honua-legend>` from the same controls entry (imported before
`@honua/sdk-js/web-components`, so the controls element owns the tag). It
combines explicit incident-priority entries with a section *derived* from the
zoning fill layer's `match` expression on the `district` attribute — the map
style is the single source of truth, so restyling the layer restyles the
legend. `follow-layer-visibility` hides a section while its layer is toggled
off in the layer list, and `auto-refresh` re-derives on the map's `styledata`
events. Themed via `::part(root)` / `::part(section-title)` / `::part(row)` /
`::part(swatch)`.

## Measure and sketch require a geometry provider

`<honua-measure-control>` and `<honua-sketch-control>` draw on the map, so they
need a drawing backend. The SDK never bundles one (it has no hard dependency on
maplibre-gl-draw or any other drawing library). Instead, the controller exposes
a pluggable seam: pass a `measurementGeometry` and/or `sketchGeometry` provider
to `createHonuaWebComponentController(...)`.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createHonuaWebComponentController } from "@honua/sdk-js/web-components";
import type { HonuaMeasureProvider, HonuaSketchProvider } from "@honua/sdk-js/web-components";

const measurementGeometry: HonuaMeasureProvider = {
  // Adapt maplibre-gl-draw (or any drawing tool) here.
  startMode(mode) {
    /* enter distance/area mode; return { mode, coordinates, distance/area } */
  },
  stop() {
    /* leave drawing mode */
  },
};

const controller = createHonuaWebComponentController({
  mapPackage,
  measurementGeometry,
  sketchGeometry: { startMode(mode) {/* ... */} } satisfies HonuaSketchProvider,
});
```

When a provider is supplied the control's mode buttons become enabled, switching
mode activates the provider, and the control emits `honua-measure-change` /
`honua-sketch-change` with real geometry (and, for measuring, distance/area).

This basic sample wires the bare in-memory controller **without** a provider, so
both controls render disabled by design with a "configure a provider" message —
that is the expected state, not a bug. Supply the providers above to enable them.

## Survival-tier widget set (issue #493)

The sample also exercises the four survival-tier components:

- `<honua-layer-list>` now renders an opacity slider ("Opacity") and
  keyboard-operable "Move up" / "Move down" reorder buttons (plus HTML5
  drag-and-drop between rows) for every layer, bound to the controller's
  `setLayerOpacity` / `moveLayer` layer-state operations.
- The web-components `<honua-legend>` reacts to layer visibility: entries
  carrying a `layerId` disappear while that layer is toggled off (the
  controls-entry legend used in the markup demonstrates the same coupling via
  `follow-layer-visibility`).
- A second `<honua-search id="place-search">` gets a geocoding provider
  assigned to its `geocoder` property (any `HonuaGeocodingClient`-shaped
  object; the offline demo uses an in-memory gazetteer). Typing shows
  debounced ARIA-combobox suggestions; selecting one pans/zooms the shared
  map and emits `honua-geocode-select`.
- `<honua-measurement>` measures distance/area with **no** external drawing
  provider: click the map to add vertices, double-click or Finish to complete,
  Escape or Cancel to discard. Values come from the geodesic
  `@honua/geometry` ops.

```bash
npm run demo:web-components
```
