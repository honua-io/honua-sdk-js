# Shared MapLibre and Cesium application state

This deterministic browser fixture runs a real MapLibre `Map` and a real Cesium `Viewer` in one page against one renderer-neutral Honua state synchronizer. Nothing here hand-rolls a port: the two bindings are the SDK's shipped `createMapLibreStateSyncPort()` and `createCesiumStateSyncPort()`, and CesiumJS is reached through the bare `cesium` specifier the page's import map resolves — the same lazy peer path the Cesium port uses internally.

Every fact the fixture reports is read back out of a renderer, not out of a dictionary it kept for itself:

| What crosses | Read back from |
| --- | --- |
| camera, 2D → 3D | `viewer.camera.positionCartographic`, `viewer.camera.heading/pitch` |
| camera, 3D → 2D | `map.getCenter()`, `map.getZoom()`, `map.getBearing()`, `map.getPitch()` |
| selection, 2D → 3D | `viewer.selectedEntity` |
| selection, 3D → 2D | `map.getFeatureState(...)` |
| filters | `map.getFilter("incidents")`, `viewer.entities.getById(...).show` |
| time | `map.getFilter("incidents")`, `viewer.clock.currentTime` / `shouldAnimate` |
| detail | `map.getFeatureState(...)`, and the globe's `unsupported-target` refusal |
| attribution | the shared snapshot, derived from live style credits and primitive attribution |

It also drives one globe pose a Web Mercator plane cannot hold (latitude 88, near-horizon pitch) to show the clamps being reported as typed degradations while the shared 3D state is left intact.

Build the SDK and serve the repository root so `/dist`, `/node_modules`, and this directory share an origin. The browser assertions live in `test/playwright/shared-renderer-state.spec.mjs`, which recomputes the expected camera values from the SDK's own exported correspondence (`mapLibreZoomToCameraHeight` / `mapLibreCameraHeightToZoom`) against the viewport the live map reported. No MapLibre or Cesium dependency is statically imported by the SDK entrypoint; both remain optional peer/runtime choices owned by the application.
