---
type: guide
title: "Put a map on the page"
description: "Install @honua/sdk-js, point it at a public FeatureServer or OGC API Features endpoint, and render the result on MapLibre. No Honua server and no account required."
resource: "https://www.npmjs.com/package/@honua/sdk-js"
---
# Put a map on the page

The SDK's map workflow is five verbs in order: **connect → discover → explain →
query → mount**. This page runs them against a public endpoint. Nothing of
Honua's needs to be running, and no account or API key is involved.

## 1. Install

```bash
npm install @honua/sdk-js maplibre-gl
```

The SDK supports MapLibre GL JS 5 and 6. Use **6.4.1 or newer**: every release
at or below 6.4.0 carries [GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579),
a sanitizer bypass the runtime cannot protect you from. MapLibre 6 is ESM-only
and loads its worker as a separate module; a Vite host configures it once with
`maplibregl.setWorkerUrl(...)` before the first map is created (see
[MapLibre 5 and 6 compatibility](maplibre-runtime.md#maplibre-5-and-6-compatibility)).

## 2. Connect, query, explain

This runs against a public Esri Living Atlas FeatureServer and walks the first
verbs without a map. Capability gaps throw `HonuaCapabilityNotSupportedError`
rather than returning empty data.

```ts doc-test=compile
import { connect, explainQuery, envelope, queryFilter, type Query } from "@honua/sdk-js";

// 1. connect — a public FeatureServer; nothing of Honua's is running.
const data = await connect({
  endpoint:
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0",
  protocol: "auto",
  authorizationScopeFingerprint: "public",
});
const states = data.source<{ NAME: string; Total_Pop_2020: number }>();

// 2. query — one typed, protocol-neutral filter expression.
const query: Query = {
  filter: queryFilter.and(
    queryFilter.gt("Total_Pop_2020", 1_000_000),
    queryFilter.spatial("intersects", envelope(-125, 24, -66, 50)),
  ),
  outFields: ["NAME", "Total_Pop_2020"],
  pagination: { limit: 100 },
};

// 3. explain — the serializable plan, inspectable before anything executes.
const plan = explainQuery({ descriptor: states.descriptor, query });
console.log(plan.fingerprint, plan.steps.map((step) => `${step.engine}:${step.operation}`));

const result = await states.queryAll(query);
console.log(`Loaded ${result.features.length} states`);
```

`Query.filter` compiles to GeoServices SQL-92, CQL2, FES 2.0, OData `$filter`,
or DuckDB SQL depending on the endpoint, so the same query runs against any
GeoServices, OGC API Features, WFS, OData, or STAC source.

## 3. Mount it on a map

The kernel connection can own the whole path from discovery to a rendered
MapLibre layer. Give it a container and the renderer:

```ts doc-test=skip reason="requires a browser MapLibre host and a public endpoint"
import { createHonua } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

const endpoint =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";

const honua = createHonua();
const connection = await honua.connect(
  { url: endpoint, protocol: "geoservices-feature-service" },
  { authorizationScopeFingerprint: "anonymous-public" },
);
const inspection = await connection.inspect();
const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
const plan = await connection.explain({ returnGeometry: true, pagination: { limit: 250 } }, { sourceId });
const mounted = await connection.mount("#map", { renderer: maplibreRenderer(maplibregl), query: plan, sourceId });
await mounted.ready; // first usable frame, not merely source mutation

// Later: releases the connection, its layers and sources, and the owned map.
await honua.dispose();
```

`inspect()` reports the sources and capabilities the endpoint advertises.
`explain()` returns the accepted plan, and `mount()` executes exactly that plan
for the renderer, so what is drawn is what was reviewed. Pass an existing
`maplibregl.Map` instead of a selector to borrow a map you already own.

For an OGC API Features landing page, use `protocol: "ogc-features"` and add
`collectionId` when the service exposes more than one collection. For a
lower-level, caller-owned map with popups, hover, filters and fit-bounds
controls, use [`mountSource`](data-to-map-bridge.md).

## Start from a scaffold instead

```bash
npm create honua-app@latest my-map
cd my-map
npm install
npm run dev
```

The starter already contains the code above, served against a committed fixture
so it works with no third-party network call; set `VITE_HONUA_ENDPOINT` to run it
against a live endpoint. See [Scaffold a new app](create-honua-app.md), or open
the same starters in a browser from [Zero-install playgrounds](playgrounds.md).

## The full example

[`examples/maplibre-quickstart`](../examples/maplibre-quickstart/README.md) is
the complete version of this page: endpoint input, a table and filter over the
bounded result, popup selection, the accepted plan and its degradation reasons,
copyable code, and managed cleanup. From a clone of the repository:

```bash
npm ci
npm run demo:quickstart:mock
```

Open the printed `quickstartMockUrl`. The mock lane serves a committed fixture
and needs no network. To run it against a public endpoint, copy
`examples/maplibre-quickstart/.env.example` to `.env`, set
`VITE_HONUA_QUICKSTART_ENDPOINT` and `VITE_HONUA_QUICKSTART_PROTOCOL` (`auto`,
`geoservices-feature-service`, or `ogc-features`), and run `npm run demo:quickstart`.
Never put an API key or bearer token in a `VITE_*` variable: Vite embeds those
values in public JavaScript.

If the map does not render, see
[When the quickstart does not render](quickstart-troubleshooting.md).
