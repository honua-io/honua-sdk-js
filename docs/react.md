# React bindings (`@honua/react`)

`@honua/react` is the idiomatic React layer over the framework-neutral
`@honua/sdk-js` core: a context provider, data hooks, and declarative map
components. The core SDK stays React-free — React is imported only from this
entry point (`@honua/sdk-js/react`, published standalone as `@honua/react`).

- **SSR-safe.** Nothing touches `window` / `document` at import time; `HonuaMap`
  only imports `maplibre-gl` inside a mount effect.
- **StrictMode-safe.** Works under React 18 and 19 StrictMode double-invocation
  — mount/unmount/remount leaks nothing and never double-subscribes.
- **Optional peers.** `react` and `react-dom` are optional peer dependencies;
  `maplibre-gl` is needed only when you render a `HonuaMap`.

## Install

```bash
npm install @honua/sdk-js @honua/react react react-dom maplibre-gl
```

Inside this monorepo the same surface is available at the subpath
`@honua/sdk-js/react`.

## Provider setup

Wrap your app once with a `HonuaClient`. The provider owns a session-scoped
query cache shared by every hook below it.

```tsx
import { HonuaClient } from "@honua/sdk-js/honua";
import { HonuaProvider } from "@honua/react";

const client = new HonuaClient({ baseUrl: "https://honua.example.com" });

export function Root() {
  return (
    <HonuaProvider client={client}>
      <App />
    </HonuaProvider>
  );
}
```

## Hooks

| Hook | Purpose |
|------|---------|
| `useHonuaClient()` | The active `HonuaClient`. |
| `useDataset(options)` | A memoized `Dataset` (`createDataset`) bound to the provider client. |
| `useQuery(source, query?, options?)` | Run a contract `Query` against a `Source` with loading/error/data state. |
| `useCapabilities(options?)` | Fetch the server's capability / compatibility descriptor. |
| `useMapRuntime()` | The `HonuaMapRuntime` owned by the enclosing `HonuaMap`. |
| `useRealtime(factory, deps?)` | Open a realtime subscription and tear it down on unmount. |

```tsx
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { useDataset, useQuery } from "@honua/react";

function Incidents() {
  const dataset = useDataset({
    id: "ops",
    sources: [
      {
        id: "incidents",
        protocol: "geoservices-feature-service",
        locator: { url: "https://honua.example.com", serviceId: "incidents", layerId: 0 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      },
    ],
  });

  const source = dataset.source("incidents");
  const { data, isLoading, error, refetch } = useQuery(source, {
    where: "STATUS = 'OPEN'",
    returnGeometry: true,
  });

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Query failed: {String(error)}</p>;
  return <p>{data?.features.length ?? 0} open incidents. <button onClick={refetch}>Refresh</button></p>;
}
```

### Memoization contract (NFR-001)

`useQuery` caches per `(source, query-hash)` inside the provider and reads
through `useSyncExternalStore`, so:

- the returned `data` keeps a **stable reference** until the underlying result
  changes — safe as a `useEffect` / `useMemo` dependency;
- two components issuing the same `(source, query)` share **one** in-flight
  request;
- the request is aborted (via `AbortController`) when the last consumer
  unmounts or the query key changes, and superseded responses are ignored (no
  races).

To keep the query key stable, memoize the `query` object (or pass a literal) and
the dataset `sources`. `refetch()` forces a fresh fetch; `useHonuaQueryCache()`
exposes `invalidate(key)` / `clear()` for manual cache control.

## Map components

`HonuaMap` owns a `HonuaMapRuntime` over a MapLibre map. `HonuaLayer` and
`HonuaPopup` declaratively add a runtime source/layer and a click popup; they
add on mount and remove on unmount.

```tsx
import { HonuaMap, HonuaLayer, HonuaPopup } from "@honua/react";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "@honua/sdk-js/runtime";

const mapPackage = {
  mapPackageId: "sites",
  format: HONUA_MAP_PACKAGE_FORMAT_V1,
  sourceBindings: [],
  mapSpec: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1021" } }] },
  initialView: { center: [-157.84, 21.31], zoom: 10 },
};

<HonuaMap package={mapPackage} style={{ height: 480 }}>
  <HonuaLayer
    source={{ id: "sites", spec: { type: "geojson", data: sitesGeoJson } }}
    layer={{ id: "sites-circles", type: "circle", source: "sites", paint: { "circle-radius": 8 } }}
  />
  <HonuaPopup layer="sites-circles" binding={{ sourceId: "sites", title: "Site", fieldName: "name" }} />
</HonuaMap>;
```

By default `HonuaMap` creates and owns the MapLibre map (dynamically importing
`maplibre-gl`). Pass `mapLibre={maplibregl}` to supply the module explicitly, or
`mapOptions` to tune the constructor.

### Composing with an externally-owned map (`@vis.gl/react-maplibre`)

When another library owns the map (e.g. `@vis.gl/react-maplibre`'s `<Map>`),
pass the existing instance to `HonuaMap` via `map`. `HonuaMap` then attaches its
runtime to that map and **does not** remove it on unmount — the owner keeps
control of the map lifecycle; Honua only disposes its runtime.

```tsx
import { Map, useMap } from "@vis.gl/react-maplibre";
import { HonuaMap, HonuaLayer } from "@honua/react";

function HonuaOverlay({ mapPackage }) {
  const { current } = useMap();
  const map = current?.getMap();
  if (!map) return null;
  return (
    <HonuaMap package={mapPackage} map={map}>
      <HonuaLayer {...} />
    </HonuaMap>
  );
}

<Map initialViewState={{ longitude: -157.84, latitude: 21.31, zoom: 10 }} mapStyle={style}>
  <HonuaOverlay mapPackage={mapPackage} />
</Map>;
```

## Web components vs. React

The SDK also ships framework-neutral web components (`@honua/sdk-js/web-components`).
Choose based on your app:

- **Use `@honua/react`** in a React app: you get JSX, typed props, hooks that
  participate in React state/effects, Suspense-friendly data flow, and
  ref-free composition with the rest of your component tree.
- **Use web components** in a framework-agnostic page, a non-React framework, or
  when embedding a Honua map into server-rendered HTML with no build step. They
  work anywhere custom elements do, at the cost of React ergonomics.

Both talk to the same `HonuaClient` and runtime, so you can mix them.

## Runnable example

`examples/react-quickstart/` is a Vite app wiring `HonuaProvider`, `useDataset`,
`useQuery`, `useCapabilities`, `HonuaMap`, `HonuaLayer`, and `HonuaPopup`
together under `StrictMode`:

```bash
npm run demo:react-quickstart          # dev server
npm run demo:react-quickstart:mock     # build + serve against fixtures
npm run demo:react-quickstart:build    # production build
```
