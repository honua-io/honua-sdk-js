# Honua Web Components

`@honua/sdk-js/web-components` registers framework-neutral custom elements for
plain TypeScript applications:

- `honua-map`
- `honua-layer-list`
- `honua-legend`
- `honua-feature-table`
- `honua-search`
- `honua-editor`
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
actions. Browser print calls `window.print()` when available. Snapshot export
is explicitly unsupported by default so generated images do not accidentally
include private map credentials.

`honua-map-status` displays an approximate scale, attribution text, and a
fullscreen action. Fullscreen emits `honua-fullscreen-change` and renders an
unsupported event when the browser does not expose `requestFullscreen()`.

`honua-action-panel` renders application-defined action buttons from an
`actions` JSON array and emits `honua-action`. Empty panels render a visible
unsupported state so apps do not appear to lose configured controls.
