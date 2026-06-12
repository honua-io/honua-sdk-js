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

```bash
npm run demo:web-components
```
