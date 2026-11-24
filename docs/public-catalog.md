---
type: reference
title: "Public catalog"
description: "Typed listing and detail reads of the server's access-filtered catalog of published services and Layers, with their API and download links."
---
# Public catalog

> **Native application path:** [gRPC for live data and edits; PMTiles, GeoParquet and COG through the CDN](native-data-paths.md). Start there for browser gRPC-Web setup, signed private URLs and regeneration after changes. OGC API and GeoServices REST examples below are compatibility workflows.

`HonuaClient.listCatalog()` and `HonuaClient.getCatalogItem()` read the server's catalog of published
services and Layers. The server filters the catalog for the caller before it pages and counts, so an
anonymous client sees public content and a signed-in client also sees what its credential allows.
Content hidden from the catalog is never listed, even when it stays requestable.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import type { HonuaCatalogItem } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://gis.example.com" });

const page = await client.listCatalog({
  q: "parcels",
  type: "dataset",
  bbox: [-157.4, 20.5, -155.9, 21.3],
  limit: 25,
});
console.log(`${page.numberMatched} matching records`);

function downloadLinks(item: HonuaCatalogItem): string[] {
  return item.links.filter((link) => link.rel === "data").map((link) => link.href);
}

for (const item of page.features) {
  console.log(item.properties.title, item.properties.resourceType, downloadLinks(item));
}

const service = await client.getCatalogItem("service:parcels");
console.log(service.properties.layerIds);
```

## Records

Each record is a GeoJSON feature. Its `id` is `service:<service name>` for a service and
`layer:<publication id>` for a dataset published as a Layer. `properties` carries the title,
description, `type` (`service` or `dataset`), `resourceType` (`Service` or `Layer`), the Layer's
geometry type, `externalIds`, and for a service the publication ids of its visible Layers in
`layerIds`. `geometry` and `bbox` give the CRS84 extent when the server knows it.

`links` are the API links for the record. `rel: "alternate"` links point at the protocol documents
the service enables (FeatureServer, MapServer, OGC API Features collection, STAC collection,
FeatureServer layer); `rel: "data"` points at the OGC API Features items a download reads.

## Filters and paging

| Option | Meaning |
| --- | --- |
| `q` | Search terms over id, title and description; an array matches any term |
| `type` | `service`, `dataset`, or both |
| `ids` | Record ids |
| `externalIds` | Service names, publication ids or Layer names |
| `bbox` | CRS84 `[west, south, east, north]`; west greater than east crosses the antimeridian |
| `datetime` | RFC 3339 instant or interval, `..` for an open bound, matched against the record's last update |
| `limit`, `offset` | Page size (server default 10, capped at 1,000) and start offset |

`numberMatched` counts every visible match; a `rel: "next"` link is present while more pages remain.

## Transport

Both methods accept `signal` and per-request `headers`, and use the client's credentials, retries,
timeout and error mapping. Catalog responses depend on the caller, so they bypass the metadata cache:
every call reads from the server. An unknown, hidden or restricted record returns `HonuaHttpError`
with status 404.

The catalog is the server's `honua-catalog` OGC API Records collection, so standard Records clients
read the same records at `/ogc/records/collections/honua-catalog/items`. `client.ogcRecords()` gives
raw Records access for other catalogs.
