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

```tsx doc-test=skip reason="partial excerpt requires application host context"
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
| `useHonuaMap(map?)` *(experimental)* | Resolve the nearest MapLibre map (explicit arg → `HonuaMapProvider` → `HonuaMap`). |
| `useMountedSource(map, source, options?)` *(experimental)* | Mount a `Source` through the data-to-map bridge for the component lifetime. |
| `useSelection()` / `useHover()` *(experimental)* | Read/write the shared selection & hover state of the enclosing `HonuaSelectionProvider`. |
| `useMapSelectionBinding(map, options)` / `useMapHoverBinding(map, options)` *(experimental)* | Two-way-bind MapLibre layers to the shared selection/hover state. |

```tsx doc-test=compile
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
    pagination: { limit: 100 },
    returnGeometry: true,
  });

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Query failed: {String(error)}</p>;
  return <p>{data?.features.length ?? 0} incidents. <button onClick={refetch}>Refresh</button></p>;
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

### Stale-while-revalidate, Suspense, and error boundaries (experimental)

Three `useQuery` options extend the cache semantics (all `@experimental`):

- **`staleTimeMs`** — when a consumer (re)mounts and the cached result is at
  least this old, the cached data keeps rendering while a background refetch
  runs (`isFetching: true`, `data` preserved). `0` revalidates on every mount;
  omitted keeps the historical never-revalidate behavior. The snapshot's
  `dataUpdatedAt` reports the last successful fetch time.
- **`suspense`** — the hook suspends while the *first* fetch (no cached data)
  is in flight, and throws errors to the nearest error boundary. Background
  refetches never suspend. The render-phase fetch kick is idempotent, so
  StrictMode does not double-fetch.
- **`throwOnError`** — throw query errors during render without Suspense.
  Typed errors (e.g. `HonuaCapabilityNotSupportedError` with its `capability` /
  `protocol` fields) arrive at the boundary intact.

```tsx doc-test=compile
import { Suspense } from "react";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { useDataset, useQuery } from "@honua/react";

function Rows() {
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
  const { data } = useQuery(
    dataset.source("incidents"),
    { pagination: { limit: 100 } },
    { suspense: true, staleTimeMs: 30_000 },
  );
  return <p>{data?.features.length ?? 0} rows</p>;
}

export function Panel() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Rows />
    </Suspense>
  );
}
```

## Map components

`HonuaMap` owns a `HonuaMapRuntime` over a MapLibre map. `HonuaLayer` and
`HonuaPopup` declaratively add a runtime source/layer and a click popup; they
add on mount and remove on unmount.

```tsx doc-test=skip reason="partial excerpt requires application host context"
import { HonuaMap, HonuaLayer, HonuaPopup } from "@honua/react";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const mapPackage = {
  mapPackageId: "sites",
  format: HONUA_MAP_PACKAGE_FORMAT_V1,
  sourceBindings: [],
  mapSpec: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0b1021" } }] },
  initialView: { center: [-157.84, 21.31], zoom: 10 },
};

<HonuaMap package={mapPackage} mapLibre={maplibregl} style={{ height: 480 }}>
  <HonuaLayer
    source={{ id: "sites", spec: { type: "geojson", data: sitesGeoJson } }}
    layer={{ id: "sites-circles", type: "circle", source: "sites", paint: { "circle-radius": 8 } }}
  />
  <HonuaPopup layer="sites-circles" binding={{ sourceId: "sites", title: "Site", fieldName: "name" }} />
</HonuaMap>;
```

By default `HonuaMap` creates and owns the MapLibre map (dynamically importing
`maplibre-gl`). MapLibre 6 bundler hosts must configure its ESM worker before
the first map is created; the Vite form above uses `?worker&url`. Pass the
configured module as `mapLibre={maplibregl}`, or use `mapOptions` to tune the
constructor. Direct CDN ESM loading auto-detects the worker URL.

## External-map interop (`@vis.gl/react-maplibre`) — experimental

Every map-attached hook/component resolves its MapLibre map through the same
chain: an explicit `map` prop/argument wins, then the nearest
**`HonuaMapProvider`** (or enclosing `HonuaMap`, which publishes the same
context). The map is duck-typed on the MapLibre `Map` instance —
`@vis.gl/react-maplibre` is *not* a dependency; hand over the raw instance from
its `useMap()` and everything works:

```tsx doc-test=skip reason="requires the @vis.gl/react-maplibre host application"
import { Map, useMap } from "@vis.gl/react-maplibre";
import { HonuaMapProvider, HonuaSourceLayer } from "@honua/react";

function HonuaOverlay({ source }) {
  const { current } = useMap();
  return (
    <HonuaMapProvider map={current?.getMap() ?? null}>
      <HonuaSourceLayer source={source} hover />
    </HonuaMapProvider>
  );
}

<Map initialViewState={{ longitude: -157.84, latitude: 21.31, zoom: 10 }} mapStyle={style}>
  <HonuaOverlay source={source} />
</Map>;
```

The provider never mutates or removes the map — the owner keeps the lifecycle.
A plain, self-created `maplibre-gl` map works identically (see
`examples/react-quickstart/`).

## Bridge components: `HonuaSourceLayer` and `useMountedSource` — experimental

`HonuaSourceLayer` is the declarative face of the data-to-map bridge
(`mountSource` from `@honua/sdk-js/map`): it mounts a contract `Source` as a
styled, interactive MapLibre layer set inside the enclosing map and owns the
full disposal on unmount. React 18/19 **StrictMode double-mounts neither leak
MapLibre resources nor double-add layers** — each effect run performs one fresh
mount and its cleanup aborts/disposes it.

Prop changes are **diffed in place, never torn down**:

- `query` → `handle.setFilter(query)` (GeoJSON `setData` / tile URL rewrite);
- `renderer.paint` / `renderer.layout` → per-property `setPaintProperty` /
  `setLayoutProperty` on the bridge-owned layers (hosts without those methods
  fall back to a transactional remount);
- structural options (`renderer.geometry`, `renderer.layers`, `strategy`,
  `sourceId`, `queryTiles`, …) → remount.

```tsx doc-test=compile
import type { DataToMapLibreMap } from "@honua/sdk-js/map";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaSourceLayer, useDataset } from "@honua/react";

export function IncidentLayer({ map }: { map: DataToMapLibreMap | null }) {
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
  return (
    <HonuaSourceLayer
      map={map}
      source={dataset.source("incidents")}
      query={{ pagination: { limit: 500 } }}
      renderer={{ paint: { point: { "circle-color": "#38bdf8" } } }}
      hover
      onDiagnostics={(diagnostics) => console.log(diagnostics.strategy, diagnostics.featureCount)}
    />
  );
}
```

`useMountedSource(map, source, options)` is the same lifecycle as a hook: it
returns `{ handle, diagnostics, error, isMounting, refresh }` for imperative
composition (pass `undefined` as `map` to resolve it from context). Mount
failures and update failures surface on `error` / `onError`; the bridge's
strategy explanation and overflow reporting arrive through `diagnostics` /
`onDiagnostics`.

## Shared selection & hover: `HonuaSelectionProvider` — experimental

`HonuaSelectionProvider` owns selection/hover state built on the interactions
layer's source-qualified targets, so map and non-map components stay in sync:

- `useSelection()` → `{ selected, isSelected, select, deselect, toggle, clear }`;
- `useHover()` → `{ hovered, isHovered, setHovered, clearHovered }`;
- `HonuaSourceLayer selection` (or `useMapSelectionBinding`) two-way-binds the
  mounted layers: map clicks toggle the shared selection, and every selection
  change — from the map *or* a sidebar — is mirrored onto MapLibre
  feature-state (default key `"selected"`) for paint expressions;
- `useMapHoverBinding` publishes the map-hovered feature; visual hover
  feature-state stays with the bridge's `hover` option.

```tsx doc-test=compile
import type { DataToMapLibreMap } from "@honua/sdk-js/map";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaMapProvider, HonuaSelectionProvider, HonuaSourceLayer, useDataset, useSelection } from "@honua/react";

function Sidebar() {
  const { selected, clear } = useSelection();
  return (
    <button type="button" onClick={clear}>
      {selected.length} selected
    </button>
  );
}

function ParcelsLayer() {
  const dataset = useDataset({
    id: "ops",
    sources: [
      {
        id: "parcels",
        protocol: "geoservices-feature-service",
        locator: { url: "https://honua.example.com", serviceId: "parcels", layerId: 0 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      },
    ],
  });
  return <HonuaSourceLayer source={dataset.source("parcels")} hover selection />;
}

export function Workspace({ map }: { map: DataToMapLibreMap | null }) {
  return (
    <HonuaSelectionProvider>
      <HonuaMapProvider map={map}>
        <ParcelsLayer />
      </HonuaMapProvider>
      <Sidebar />
    </HonuaSelectionProvider>
  );
}
```

Pair it with a selection-aware paint expression, e.g.
`["case", ["boolean", ["feature-state", "selected"], false], "#f59e0b", "#2dd4bf"]`.
Feature-state needs stable feature ids: give the source descriptor a
`schema.primaryKey` (the bridge promotes it to MapLibre feature ids).

### Attaching a `HonuaMap` runtime to an external map

`HonuaMap` (the `MapPackage` runtime component) also accepts an existing map
instance via its `map` prop; it then attaches its runtime and **does not**
remove the map on unmount — the owner keeps control; Honua only disposes its
runtime.

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

`examples/react-quickstart/` is a Vite app running under `StrictMode` that
wires the whole depth-pass surface together: an **externally-created plain
`maplibre-gl` map** (standing in for `@vis.gl/react-maplibre`'s `<Map>`)
published through `HonuaMapProvider`, a `HonuaSourceLayer` with a
selection-aware `renderer` prop, popups/hover from the bridge, and a sidebar
list sharing selection with the map through `HonuaSelectionProvider` — plus
the existing `HonuaProvider` / `useDataset` / `useQuery` / `useCapabilities`
data panel:

```bash
npm run demo:react-quickstart          # dev server
npm run demo:react-quickstart:mock     # build + serve against fixtures
npm run demo:react-quickstart:build    # production build
```
