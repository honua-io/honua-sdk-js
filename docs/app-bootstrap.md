# Honua App Bootstrap (`@honua/sdk-js/app`)

Status: experimental Beta helper for issue `#177`.

`createHonuaApp()` is a framework-neutral bootstrap layer over the existing
client, hosted package fetcher, runtime, app controller, web-component
controller, and optional package watcher. It is exported from a separate
subpath so low-level consumers can keep importing `@honua/sdk-js/runtime` or
`@honua/sdk-js/app-controller` directly.

The helper does not statically import MapLibre GL JS. To render a map, pass a
prebuilt `map`, a `mapFactory`, or a prebuilt `runtime`. Applications that do
not want the helper to render can still use it to create package-aware
controller handles.

## Inline Package

```ts
import maplibregl from "maplibre-gl";
import { HonuaClient } from "@honua/sdk-js";
import { createHonuaApp } from "@honua/sdk-js/app";

const app = await createHonuaApp({
  client: new HonuaClient({ baseUrl: "https://honua.example.com" }),
  mapPackage,
  mapContainer: document.querySelector("#map")!,
  mapFactory: ({ container, mapPackage }) =>
    new maplibregl.Map({
      container: container!,
      style: { version: 8, sources: {}, layers: [] },
      center: mapPackage.initialView?.center ?? [0, 0],
      zoom: mapPackage.initialView?.zoom ?? 0,
    }),
  onEvent: (event) => {
    if (event.type === "degraded" || event.type === "error") {
      console.warn(event.stage, event);
    }
  },
});

app.controller.setLayerVisibility("parcels-fill", false);
app.dispose();
```

## Hosted Package

```ts
const app = await createHonuaApp({
  baseUrl: "https://honua.example.com",
  packageId: "response-map",
  map,
  watch: {
    intervalMs: 30_000,
    realtime: false,
  },
});
```

Package locators can be `packageId`, `packageUrl`, `src`, `locator`, or an
inline `mapPackage`. Hosted loads use `fetchMapPackage`, including its
ETag / Last-Modified validator cache. Pass `fetch.cache: false` to bypass the
SDK cache or a shared `MapPackageFetchCache` to reuse validators across app
instances.

## Source Descriptor

For quick previews, pass a single contract `SourceDescriptor`. The helper
synthesizes a minimal `MapPackage` with one layer and then runs the normal
runtime path.

```ts
await createHonuaApp({
  client,
  source: {
    id: "preview-parcels",
    title: "Preview parcels",
    descriptor,
    layer: { type: "circle", paint: { "circle-color": "#2563eb" } },
  },
  map,
});
```

## Returned Handle

`createHonuaApp()` returns stable handles for:

- `client`
- `mapPackage`, `fetch`, and `cache`
- `runtime` and `map` when rendering was requested
- `controller`
- `webComponentController`
- `watcher` when `watch` is enabled for a hosted package
- `on(listener)` and `dispose()`

`dispose()` tears down the watcher, owned controllers, owned web-component
controller, and owned runtime. Caller-provided handles are not disposed.

## Lifecycle Events

`onEvent` and `handle.on()` receive the typed `HonuaAppLifecycleEvent` union.

| Event | Meaning |
| --- | --- |
| `status` | App state changed: `loading`, `ready`, `degraded`, `error`, or `disposed`. |
| `client-ready` | A `HonuaClient` was supplied or constructed. |
| `package-loading` | A hosted package fetch is starting. |
| `package-ready` | An inline, fetched, runtime-owned, or synthesized package is available. |
| `runtime-ready` | The package was loaded onto the caller map. |
| `controller-ready` | App and web-component controllers are ready. |
| `degraded` | A non-fatal source bind or watch problem occurred. |
| `error` | Bootstrap failed. `stage` distinguishes `auth`, `fetch`, `validate`, `source-bind`, `render`, `watch`, and `dispose`. |
| `watch` | A `watchMapPackage` event was forwarded. |
| `disposed` | The handle was disposed. |

Validation failures from hosted packages surface as `stage: "validate"`.
Authentication failures are normalized to `stage: "auth"` when the thrown SDK
error carries HTTP `401` / `403` or equivalent auth codes. Tolerant source
binding failures from the runtime are reported as `degraded` events, allowing
remaining sources and layers to continue rendering.

## Runnable Example

`examples/app-bootstrap-basic` renders an inline MapPackage with default layer
visibility and controller wiring:

```sh
npm run demo:app-bootstrap
```

