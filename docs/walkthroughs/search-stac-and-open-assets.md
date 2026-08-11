# Walkthrough: search STAC and open an asset

Use this walkthrough when an application needs to discover a catalog, run a bounded Item Search, and hand the selected asset to the SDK surface that can execute it.

The SDK has two deliberately separate STAC surfaces:

- `connect({ protocol: "stac" })` is the supported protocol adapter for STAC APIs and static catalogs.
- `@honua/sdk-js/stac` is an experimental task facade for dynamic search, bounded pagination, signed asset refresh, and typed cloud-native handoff.

Start with the fixture-backed [STAC imagery browser project](../../examples/stac-imagery-browser/README.md). The project is classified as a Walkthrough because it covers discovery, search negotiation, paging, selection, signing, rendering, and format handoff. Its [focused source](../../examples/stac-imagery-browser/src/dynamic-stac-example.ts) remains the distinct atomic Example: one bounded search and one typed selection in a single code view.

The deterministic project records browser request and signing evidence but does not claim a live Honua STAC canary. Replace its injected fixture transport only after pinning an endpoint and reviewing its CORS, authentication, and data provenance.

## 1. Create the dynamic client

```ts doc-test=compile
import { createDynamicStacClient } from "@honua/sdk-js/stac";

const stac = createDynamicStacClient({
  baseUrl: "https://your-honua.example/api/stac",
});

const catalog = await stac.catalog(AbortSignal.timeout(5_000));
for (const collection of catalog.collections) {
  console.log(collection.id, collection.title ?? collection.id);
}
```

The client resolves advertised HTTP(S) links and uses the shared `HonuaClient` authentication, retry, interceptor, timeout, injected-fetch, and cancellation pipeline. It does not guess server routes.

## 2. Search a bounded area and iterate pages

```ts doc-test=skip reason="continues the catalog client and application result state from step 1"
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

`auto` probes advertised POST search once and otherwise uses GET. Pagination follows server-provided cursors, prefetch is capped at one page, and stopping iteration cancels outstanding work.

## 3. Select by role and format

```ts doc-test=skip reason="continues the selected item and signing service from the prior steps"
const asset = await stac.selectAsset(selectedItem, {
  roles: ["visual", "data"],
  formats: ["cog", "pmtiles", "geoparquet", "raster"],
  refreshAssetUrl: async ({ assetKey, signal }) => signAsset(assetKey, signal),
});
```

Classification and format filtering happen before the signer is called, so excluded assets do not consume credentials or signing work. COG classification requires the exact `profile=cloud-optimized` media-type parameter; a TIFF suffix, Projection metadata, or Raster bands alone are not proof.

## 4. Continue through the real execution surface

The descriptor's `handoff.packageExport` is executable documentation, not a generic root import:

| Asset | Maturity | Continue with |
| --- | --- | --- |
| COG | experimental | `@honua/sdk-js/cog` |
| PMTiles | supported | `@honua/sdk-js/contract` |
| GeoParquet | experimental | `@honua/sdk-js/columnar-workflow` |
| GeoArrow | metadata-only | No executable STAC handoff yet |
| Browser raster | supported | `@honua/sdk-js/runtime` |
| Zarr / NetCDF | unavailable | No executable client workflow yet |

PMTiles metadata inspection uses the contract entrypoint:

```ts doc-test=skip reason="continues the selected asset from step 3 and performs a network range read"
if (asset.handoff?.kind === "pmtiles") {
  const { describePmtilesArchive } = await import("@honua/sdk-js/contract");
  const archive = await describePmtilesArchive(asset.handoff.href);
  console.log(archive.tileKind, archive.minZoom, archive.maxZoom);
}
```

Direct GeoParquet work uses the bounded columnar session rather than the lower-level profiler:

```ts doc-test=skip reason="continues the selected asset from step 3 and requires DuckDB-WASM runtime assets"
if (asset.handoff?.kind === "geoparquet") {
  const { openColumnarSession } = await import("@honua/sdk-js/columnar-workflow");
  const session = openColumnarSession({
    kind: "direct-geoparquet",
    id: `${asset.itemId}:${asset.key}`,
    url: asset.handoff.href,
    sourceVersion: "pinned-stac-item-v1",
    schemaVersion: "geo-1.1",
    authorizationScope: "public",
  });
  console.log(await session.inspect());
}
```

See [PMTiles](../pmtiles.md) and [server or browser columnar queries](./server-or-browser-columnar.md) for the complete execution contracts and hard budgets.

For bounded COG inspection and rendering, continue through the unified raster session instead of treating an asset URL as a rendered layer:

```ts doc-test=skip reason="continues the selected asset from step 3 and requires a caller-owned COG decoder when the selected kind is cog"
if (asset.handoff?.kind === "cog") {
  const { openRasterSession } = await import("@honua/sdk-js/raster");
  const session = await openRasterSession({
    kind: "cog",
    id: `${asset.itemId}:${asset.key}`,
    candidate: asset,
  });
  console.log(session.plan("read-window"));
}
```

The complete runnable project, including the deterministic transport and browser evidence, is at [`examples/stac-imagery-browser`](../../examples/stac-imagery-browser/README.md).

## Troubleshooting

| Symptom | Meaning | Action |
| --- | --- | --- |
| POST search falls back to GET | The API omitted POST or rejected the probe. | Use `method: "GET"`, or correct the server/CORS advertisement. |
| `HonuaCapabilityNotSupportedError` | No asset matched the requested roles and formats with an executable handoff. | Inspect `await stac.assets(item)` and present the reported maturity. |
| `HonuaDiscoveryError` | A catalog link or asset URL is malformed or uses a non-HTTP(S) scheme. | Correct the STAC document; do not bypass the URL guard. |
| Iteration stops early | The caller aborted, `maxPages` was reached, or no next link remained. | Adjust the explicit bound or inspect the last response links. |
| Signed URL expires | API authentication does not automatically become asset authorization. | Supply `refreshAssetUrl` and return a fresh HTTPS URL. |
