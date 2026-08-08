# Dynamic STAC workflows

`@honua/sdk-js/stac` provides the task-level API above the SDK's existing STAC
wire client. It uses the standard `HonuaClient` auth, retry, interceptor,
timeout, injected-fetch, and cancellation pipeline.

## Build a small catalog browser

### 1. Create a client and list the catalog

```ts
import { createDynamicStacClient } from "@honua/sdk-js/stac";

const stac = createDynamicStacClient({
  baseUrl: "https://demo.honua.io/api/stac",
  clientOptions: {
    auth: async () => ({ bearerToken: await loadAccessToken() }),
    interceptors: [requestTiming],
  },
});

const catalog = await stac.catalog(AbortSignal.timeout(5_000));
for (const collection of catalog.collections) {
  addCollectionOption(collection.id, collection.title ?? collection.id);
}
```

Expected output: the catalog landing page, conformance declarations, resolved
HTTP(S) links, and collection summaries. The application does not construct
`/collections` or traverse relative links itself.

### 2. Search Maui and iterate pages

```ts
for await (const item of stac.items({
  method: "auto",
  collections: ["sentinel-2-l2a"],
  bbox: [-156.75, 20.55, -155.85, 21.05],
  datetime: "2026-04-01T00:00:00Z/2026-05-05T23:59:59Z",
  filterLang: "cql2-json",
  filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, 20] },
  fields: { include: ["id", "collection", "properties.datetime", "assets", "links"] },
  sortby: [{ field: "properties.datetime", direction: "desc" }],
  pageSize: 20,
  maxPages: 5,
  prefetchPages: 1,
  signal: AbortSignal.timeout(10_000),
})) {
  addResult(item);
}
```

`auto` verifies an advertised POST search once and falls back to GET when POST
is unavailable. Pagination follows server-provided next cursors. Prefetch is
bounded to one page and is cancelled when iteration stops.

### 3. Select an asset without guessing its connector

```ts
const asset = await stac.selectAsset(selectedItem, {
  roles: ["visual", "data"],
  formats: ["cog", "pmtiles", "geoparquet", "raster"],
  refreshAssetUrl: async ({ assetKey, signal }) => signAsset(assetKey, signal),
});

switch (asset.handoff?.kind) {
  case "cog":
    showCog(asset.handoff.href);
    break;
  case "pmtiles":
    showPmtiles(asset.handoff.href);
    break;
  case "geoparquet":
    queryGeoParquet(asset.handoff.href);
    break;
  case "raster":
    showRaster(asset.handoff.href);
    break;
}
```

Asset descriptors retain media type, roles, Projection fields, Raster bands,
and common band names. GeoParquet/COG handoffs are experimental. GeoArrow is
metadata-only. Zarr and NetCDF are explicitly unavailable and receive no
executable handoff.

## Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| POST search falls back to GET | The landing page omitted POST or the first POST was rejected. | Use `method: "GET"`, or correct the server/CORS advertisement. |
| `HonuaCapabilityNotSupportedError` from `selectAsset` | No asset matched the requested roles/formats with a supported handoff. | Inspect `await stac.assets(item)` and show the unsupported state. |
| `HonuaDiscoveryError` for a link/asset | A link was malformed or used a non-HTTP(S) scheme. | Fix the STAC document; do not bypass the URL guard. |
| Iteration stops early | The caller aborted, `maxPages` was reached, or no next link remained. | Increase the explicit bound or inspect the last response links. |
| Signed URL expires | Asset credentials are deliberately not copied from API auth. | Supply `refreshAssetUrl` and return a new HTTPS URL. |

The complete fixture-backed project is
[`examples/stac-imagery-browser`](../examples/stac-imagery-browser/README.md).
