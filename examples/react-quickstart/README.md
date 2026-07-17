# Honua React Quickstart

> Focused framework recipe: learn endpoint discovery and the bounded map workflow in
> [First Map](../maplibre-quickstart/README.md), then use this app for React provider, hook, selection, and StrictMode
> integration. Existing React commands and routes remain supported.

Browser sample for the `@honua/sdk-js/react` bindings (published standalone as `@honua/react`). It demonstrates:

- an **externally-created plain `maplibre-gl` map** owned by the app (the `@vis.gl/react-maplibre` interop shape), published to Honua through `HonuaMapProvider`
- `HonuaSourceLayer` mounting the queried source through the data-to-map bridge, with a selection/hover-aware `renderer` prop and click popups
- `HonuaSelectionProvider` + `useSelection` / `useHover` sharing selection between map clicks and the sidebar feature list
- `HonuaProvider` supplying a `HonuaClient` to the component tree
- `useDataset` + `useQuery` driving a fixture-backed FeatureServer query with loading/error states
- `useCapabilities` surfacing server compatibility in the UI

## Fast Local Run

The fixture lane is same-origin and does not need a live Honua server.

```bash
npm install
npm run demo:react-quickstart:mock
```

The script builds the app, serves it locally, and serves fixture responses for
`GET /rest/services/natural-earth/FeatureServer/0/query` from
`test/fixtures/honua-quickstart-demo` (the same fixtures as the MapLibre quickstart).
The local URL is printed as `reactQuickstartMockUrl=http://127.0.0.1:PORT`.

For iterative development against the mock server, `npm run demo:react-quickstart` starts the
Vite dev server (pair it with the mock lane or a live server below).

## Live Honua Run

```bash
npm run demo:react-quickstart
```

Supported env vars (see `.env.example`):

- `VITE_HONUA_REACT_BASE_URL`: Honua server origin. Empty string targets the same origin (fixture lane).
- `VITE_HONUA_REACT_SERVICE_ID`: FeatureServer service id. Default: `natural-earth`.
- `VITE_HONUA_REACT_LAYER_ID`: layer index. Default: `0`.
- `VITE_HONUA_REACT_WHERE`: attribute filter for the query panel. Default: `1=1`.

## What To Look At

| UI element | React surface |
| --- | --- |
| Feature list panel | `useQuery(source, query)` — abortable, referentially stable results; rows toggle the shared selection |
| Selection summary | `useSelection()` from `HonuaSelectionProvider` (map clicks and sidebar clicks share one store) |
| Compatibility banner | `useCapabilities()` |
| Map | app-owned `maplibre-gl` map + `HonuaMapProvider` + `HonuaSourceLayer` (bridge mount, renderer prop, popup, hover) |

The app renders under `<React.StrictMode>` on purpose: mount → unmount → remount must not
leak MapLibre sources/layers/listeners, double-add layers, or double-fetch in production
mode — the bridge components mount fresh per effect run and dispose on cleanup.

For browser smoke tests and troubleshooting, the runtime exposes
`window.__HONUA_REACT_QUICKSTART__` with readiness flags, feature counts, the shared
selection count, and any bridge error. The Playwright spec
`test/playwright/react-quickstart.spec.mjs` asserts a StrictMode boot, three fixture
features, a mounted map canvas, shared sidebar selection, and zero page errors.
