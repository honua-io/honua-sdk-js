# Discover published content

`HonuaClient.listCatalog()` reads one page from the server's public catalog. The server filters services, layers and folders using the caller's access before computing totals and facet counts.

```ts
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://gis.example.com" });
const page = await client.listCatalog({
  q: "parcels",
  type: "layer",
  bbox: [-158, 20, -155, 23],
  limit: 25,
});

for (const item of page.items) {
  console.log(item.title, item.endpoints);
}
console.log(page.total, page.facets.protocol);
```

Filters include `q`, `type`, `protocol`, `folder`, `tag`, `owner`, `bbox` and `datetime`. A bounding box is a CRS84 tuple `[west, south, east, north]`; a west value greater than east crosses the antimeridian. `datetime` accepts an ISO instant or interval with `..` for an open bound. `offset` defaults to zero; `limit` defaults to 50 and accepts values from 1 to 200. Facets reflect all active filters before paging.

Read one item with `client.getCatalogItem(id)`. Both methods accept an abort signal and per-request headers. They inherit the client's credentials, retries, timeout and error handling, and read through the regular request pipeline without the metadata cache. Servers that do not provide the catalog return the standard `HonuaHttpError`.

Named request and result types are exported from `@honua/sdk-js/honua`, including `HonuaCatalogQuery`, `HonuaCatalogPage` and `HonuaCatalogItem`.
