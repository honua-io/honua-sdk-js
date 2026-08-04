# Honua map app (React + TypeScript)

A Vite + React + TypeScript starter for the [Honua JavaScript SDK](https://github.com/honua-io/honua-sdk-js). The app
owns a plain `maplibre-gl` map and the SDK's React bridge mounts a discovered source onto it:

```text
connect → source → useMountedSource
```

## Run it

```bash
npm install
npm run dev
```

The default lane serves a committed GeoServices fixture from the Vite dev server, so the first map needs no account,
no API key, and no third-party network call. The same fixture is served by `npm run preview` after `npm run build`.

## Point it at live data

```bash
VITE_HONUA_ENDPOINT=https://your-public-service.example/rest/services/example/FeatureServer/0 npm run dev
```

- `VITE_HONUA_ENDPOINT` — an anonymous, CORS-enabled GeoServices FeatureServer layer or OGC API Features landing page.
- `VITE_HONUA_PROTOCOL` — `auto`, `geoservices-feature-service`, or `ogc-features` (default:
  `geoservices-feature-service`, which matches the fixture).

Do not put durable credentials in Vite environment variables: Vite embeds them in public JavaScript. Use an anonymous
endpoint or a server-side proxy.

## What to edit

| File | Why |
| --- | --- |
| `src/App.tsx` | Connection, query, and the mounted-source hook. Change the query here. |
| `src/main.tsx` | React root. `StrictMode` stays on: the SDK hooks are StrictMode-safe. |
| `src/fixture-endpoint.ts` | The same-origin path the offline fixture is served on. |
| `vite.config.ts` | The fixture service. Delete it once you point the app at a real endpoint. |

`HonuaMapProvider` publishes an app-owned map to descendants when the map is created deeper in the tree; this starter
passes the map to `useMountedSource` directly. Add `@vitejs/plugin-react` if you want React Fast Refresh — Vite
compiles the JSX without it.

## Dependencies

`@honua/sdk-js`, `maplibre-gl`, and React are the packages this app calls directly. `@bufbuild/protobuf` and the two
`@connectrpc` packages are the SDK's optional transport peers: they are installed and pinned here so the bundle builds
without any peer-dependency assembly, and they are what a Honua-server connection uses.

## Checks

```bash
npm run typecheck
npm run build
```

The fixture data is synthetic demonstration data from the Honua SDK sample fixtures (Apache-2.0).
