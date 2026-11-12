---
name: connect-data
description: Use when connecting code to geospatial data with @honua/sdk-js, such as querying a Honua server or any OGC API Features collection or GeoServices FeatureServer (attribute filters, spatial intersects between layers), reading PMTiles archive metadata, or writing a Node script or service that reports values from those sources.
release: "2026.1"
stages: []
---

# Connect to data with @honua/sdk-js

One client pattern for every protocol: `createHonua()` → `connect(locator)` →
`inspect()` / `query()`. Data comes from SDK calls at run time. Do not
hand-write `fetch` calls and do not hard-code values you could query.

## Setup

```bash
npm init -y && npm pkg set type=module
npm install --save-exact @honua/sdk-js     # the published release, pinned exactly
```

Import from `@honua/sdk-js` only (`createHonua`, `queryFilter`,
`spatialIntersects`, `envelope`, `point`, `polygon`). Node 22 does not parse `await using` in plain
`.mjs`, so dispose in `finally`:

```js
import { createHonua, queryFilter, spatialIntersects } from "@honua/sdk-js";

const honua = createHonua();
try {
  // connections and queries
} finally {
  await honua.dispose();
}
```

## Locators by protocol

| Source | `connect(...)` |
| --- | --- |
| GeoServices layer | `"<server>/rest/services/<service>/FeatureServer/<layer id>"` (a service root with several layers needs `sourceId`) |
| OGC API Features collection | `{ url: "<server>/ogc/features", protocol: "ogc-features", collectionId: "<id>" }` |
| OGC API Tiles | `{ url: "<server>/ogc/tiles", protocol: "ogc-tiles", sourceId: "<collection id>" }` |
| PMTiles archive | `{ url: "https://…/archive.pmtiles", protocol: "pmtiles" }` |

Collection ids are not names. On Honua, `GET <server>/ogc/features/collections`
maps ids to titles. `await (await honua.connect({ url, protocol })).inspect()`
lists the same sources from code.

## Query rules that differ by protocol

```js
const ogc = await honua.connect({ url: `${server}/ogc/features`, protocol: "ogc-features", collectionId });
const byPrefix = await ogc.query({ filter: queryFilter.like("<field>", "<prefix>%"), outFields: ["<field>"] });
```

- Build filters with `queryFilter` (`eq`, `like`, `isIn`, `between`, `and`,
  `or`, ...). The SDK compiles them for each protocol (CQL2 for OGC API, a
  `where` clause for GeoServices) and quotes values for you, so do not
  interpolate user input into a `where` string.
- OGC API Features rejects `returnGeometry: false` with
  `query.planning.unsupported-query`. Omit it.
- GeoServices accepts `where`, `outFields`, `returnGeometry: false`, `outSr`
  and `spatialFilter`.
- Every protocol returns rows as `{ attributes, geometry }`; read values from
  `feature.attributes`.
- A query is bounded by the server's transfer limit (10,000 on Honua). For
  counts over the limit, page with `pagination` or narrow the filter.

## Spatial joins between layers

Fetch the subject feature's geometry in WGS84, then pass it to
`spatialIntersects` against each overlay layer:

```js
const subject = (await layerA.query({ filter: queryFilter.eq("<key>", "<value>"), outFields: ["*"], outSr: 4326 })).features[0];
if (!subject?.geometry) throw new Error("subject feature not found");
const within = spatialIntersects({ ...subject.geometry });
const [b, c] = await Promise.all([
  layerB.query({ spatialFilter: within, outFields: ["<field b>"], returnGeometry: false }),
  layerC.query({ spatialFilter: within, outFields: ["<field c>"], returnGeometry: false }),
]);
const values = b.features.map((f) => f.attributes["<field b>"]);   // keep every match, not just the first
```

A polygon can intersect several overlay polygons. Report all of them, joined
(for example `"AE; X"`).

## PMTiles metadata

```js
const archive = await honua.connect({ url: pmtilesUrl, protocol: "pmtiles" });
const meta = (await archive.inspect()).sources[0].metadata.pmtiles;
// meta.minZoom, meta.maxZoom, meta.bounds [w, s, e, n], meta.center, meta.tileKind,
// meta.vectorLayers[].id
```

The metadata sits under `.metadata.pmtiles`, not `.metadata`. PMTiles sources
do not support `query()`; it throws a capability error. Render them with the
map runtime instead (see the build-a-map-app skill).

## Errors

SDK errors carry `sdkCode` and `category`. `category: "capability"` means the
protocol cannot do what you asked, so change the query and do not retry.
`core.http.transient` (for example an HTTP 408) is retryable. Honua's demo server
allows 60 requests a minute per client, so keep scripts to a handful of
queries and use `Promise.all` only for independent calls.

## Verify before you finish

Run the script, then check one value against the server directly, for example
`<layer>/query?where=…&f=json` in a browser. A mismatch usually means you kept
only the first intersecting overlay.
