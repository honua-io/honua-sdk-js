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

Import the subpath once in a browser module. The module auto-registers the
elements when `customElements` is available and also exports
`defineHonuaWebComponents()` for scoped registries.

```ts
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

Sibling controls bind to the same controller with `for="<map-id>"`.

```html
<honua-map id="map"></honua-map>
<honua-layer-list for="map"></honua-layer-list>
<honua-legend for="map"></honua-legend>
<honua-feature-table for="map" source="incidents"></honua-feature-table>
<honua-search for="map" source="incidents"></honua-search>
```

The controller contract is intentionally small so this package can integrate
with the runtime today and a richer `HonuaController` later. Use
`createHonuaWebComponentControllerFromRuntime(runtime)` when a
`HonuaMapRuntime` already owns the MapPackage and layer operations.

Components dispatch typed custom events:

- `honua-controller-ready`
- `honua-layer-visibility-change`
- `honua-selection-change`
- `honua-viewport-change`
- `honua-filter-change`
- `honua-search`
- `honua-edit-change`

Styling is scoped to each component's shadow root and can be themed with CSS
custom properties such as `--honua-ui-bg`, `--honua-ui-fg`,
`--honua-ui-border`, and `--honua-ui-accent`.
