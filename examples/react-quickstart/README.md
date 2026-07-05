# Honua React Quickstart

Browser sample for the `@honua/sdk-js/react` bindings (published standalone as `@honua/react`). It demonstrates:

- `HonuaProvider` supplying a `HonuaClient` to the component tree
- `useDataset` + `useQuery` driving a fixture-backed FeatureServer query with loading/error states
- `useCapabilities` surfacing server compatibility in the UI
- `HonuaMap` owning a MapLibre GL JS map lifecycle, with `HonuaLayer` and `HonuaPopup` children

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
| Feature list panel | `useQuery(source, query)` — abortable, referentially stable results |
| Compatibility banner | `useCapabilities()` |
| Map + overlay | `HonuaMap` with `HonuaLayer` (query results) and `HonuaPopup` |

MapLibre GL JS is loaded through a dynamic import inside `HonuaMap`, so the example stays
SSR-safe and the map engine is code-split out of the initial chunk. The app renders under
`<React.StrictMode>` on purpose: mount → unmount → remount must not leak subscriptions or
double-fetch in production mode.

For browser smoke tests and troubleshooting, the runtime exposes
`window.__HONUA_REACT_QUICKSTART__` with readiness flags, feature counts, and the resolved
configuration. The Playwright spec `test/playwright/react-quickstart.spec.mjs` asserts a
StrictMode boot, three fixture features, a mounted map canvas, and zero page errors.
