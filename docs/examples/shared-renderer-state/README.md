# Shared MapLibre and Cesium application state

This deterministic browser fixture runs real MapLibre and Cesium renderers against one renderer-neutral Honua state synchronizer. It demonstrates bidirectional camera changes plus shared selection, filter, and time state, while intentionally echoing applied revisions to prove loop suppression and deterministic cleanup.

Build the SDK and serve the repository root so `/dist`, `/node_modules`, and this directory share an origin. No MapLibre or Cesium dependency is statically imported by the SDK entrypoint; both remain optional peer/runtime choices owned by the application.
