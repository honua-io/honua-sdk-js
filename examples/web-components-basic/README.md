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

```bash
npm run demo:web-components
```
