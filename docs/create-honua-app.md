---
type: guide
title: "Scaffold a new app"
description: "npm create honua-app: what the template generates, which versions it pins, and what to change first."
resource: "https://www.npmjs.com/package/create-honua-app"
---
# create-honua-app

`create-honua-app` scaffolds a Vite + TypeScript application that already connects to a geospatial endpoint and mounts
a source on MapLibre. It exists so the first minute with the SDK is spent reading a working workflow instead of
assembling peer dependencies.

```bash
npm create honua-app@latest my-map
cd my-map
npm install
npm run dev
```

The starter package lives in this repository at `packages/create-honua-app`.

## Templates

| Template | Entry point | What it demonstrates |
| --- | --- | --- |
| `vanilla-ts` (default) | `src/main.ts` | `connect → inspect → explain → query → mount`. The SDK owns the MapLibre map and mounts an accepted query plan. |
| `react-ts` | `src/App.tsx` | The app owns a plain `maplibre-gl` map; the same kernel connection inspects, explains, queries, and mounts onto it. |

Both templates pin **MapLibre GL JS 6.1.0**, the current major. A scaffolded app installs `@honua/sdk-js` from the
registry, which declares the `^5.0.0 || ^6.0.0` peer range, so `npm install` resolves the pair with no `overrides` and
no `--legacy-peer-deps`. MapLibre 5 remains supported by the SDK for apps that have not migrated. Because MapLibre 6 is
ESM-only and loads its worker as a separate module, each starter ships `src/maplibre-worker.ts` and imports it before
the first map is created. See [`maplibre-runtime.md`](./maplibre-runtime.md#maplibre-5-and-6-compatibility).

```bash
npm create honua-app@latest my-map -- --template react-ts
create-honua-app --list-templates
```

The copyable core of the vanilla starter is the published workflow, not a private shortcut:

```ts doc-test=skip reason="the scaffolded starter runs this against its own dev-server fixture endpoint"
import { createHonua } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

const honua = createHonua();
const connection = await honua.connect(
  { url: endpoint, protocol: "geoservices-feature-service" },
  { authorizationScopeFingerprint: "anonymous-public" },
);
const inspection = await connection.inspect();
const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
const plan = await connection.explain({ returnGeometry: true, pagination: { limit: 250 } }, { sourceId });
const mounted = await connection.mount("#map", { renderer: maplibreRenderer(maplibregl), query: plan, sourceId });
await mounted.ready;
```

## The fixture-first default

Both starters ship a committed GeoServices fixture (the reviewed First Map sample fixture) and serve it from the Vite
dev and preview servers. The default lane therefore needs no account, no API key, and no third-party network call —
which is also what makes the starters runnable in a browser playground. See
[Zero-install playgrounds](./playgrounds.md).

Set `VITE_HONUA_ENDPOINT` (and optionally `VITE_HONUA_PROTOCOL`) to run the identical code against any anonymous,
CORS-enabled GeoServices FeatureServer layer or OGC API Features landing page. Durable credentials never belong in
Vite environment variables: Vite embeds them in public JavaScript.
