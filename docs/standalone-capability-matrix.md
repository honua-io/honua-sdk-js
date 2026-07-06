# Backend-Agnostic vs Honua-Server-Enhanced Capability Matrix

This is the honest line between what `@honua/sdk-js` does against **any**
standards-speaking server (no Honua infrastructure) and what needs a
[Honua Server](https://github.com/honua-io/honua-server). It complements the
per-protocol [Protocol × Capability Matrix](./protocol-capability-matrix.md),
which is the code-of-record for what each protocol's client supports; this page
answers the orthogonal question: *does the capability require a Honua server?*

See the [standalone quickstart](./standalone-quickstart.md) for the runnable
backend-agnostic path.

## Legend

- `standalone` — works against any public/self-hosted standards server (an ArcGIS
  Server / ArcGIS Online endpoint, etc.) with no Honua server, key, or account.
  Proven live against public endpoints; replayed from fixtures in CI.
- `honua-enhanced` — requires a Honua Server (or a server that implements Honua's
  facade paths). These are the upgrade-path features.
- `facade-bound` — the *typed* SDK surface exists and is protocol-correct, but it
  currently addresses Honua's server facade paths (e.g. `/ogc/features/...`)
  rather than a raw third-party endpoint's own path layout. Backend-agnostic
  support for raw endpoints is roadmap; use GeoServices for the standalone lane
  today.

## Matrix

| Capability | Standalone? | Backend needed | Sample app / API | Notes |
| --- | :-: | --- | --- | --- |
| GeoServices FeatureServer query (`queryFeatures`, `queryFeaturesAll`, streaming, count, extent) | `standalone` | Any ArcGIS Server / Online | `examples/standalone-quickstart`, `HonuaClient.queryFeatures`, `Source` (`geoservices-feature-service`) | Raw `/rest/services/.../FeatureServer/{id}/query` path; verified live against `services.arcgis.com`. |
| GeoServices MapServer / ImageServer reads (query, export, identify, legend, find) | `standalone` | Any ArcGIS Server / Online | `HonuaClient.mapService` / `imageService` | Raw GeoServices paths; verified live against `sampleserver6.arcgisonline.com`. |
| Esri → GeoJSON → MapLibre source | `standalone` | Any ArcGIS Server / Online | `loadHonuaFeatureServiceGeoJson` (`@honua/sdk-js/map`) | One call from a public FeatureServer URL to a MapLibre `geojson` source. |
| Esri compat drop-in (`FeatureLayerCompat`, `MapImageLayerCompat`, query/edits API) | `standalone` | Any ArcGIS Server / Online | `@honua/sdk-js/esri-compat`, `examples/standalone-quickstart` | The `esri-leaflet` migration path; parses `services.arcgis.com`-style URLs and builds its own client. |
| `honua-migrate` codemod / ArcGIS scanner | `standalone` | None (build-time) | `@honua/sdk-js/migration`, `npm run scan:arcgis` | Static analysis + rewrites; no server involved at all. |
| Geometry ops (buffer/area/measure/simplify/reproject) | `standalone` | None (client-side) | `@honua/sdk-js/geometry` | Pure client-side turf/proj4 ops. |
| OGC API Features / Tiles / Maps / Processes, WFS 2.0, STAC, OData (typed surface) | `facade-bound` | Honua Server (facade paths) today | `Source` (`ogc-features`, `wfs`, `stac`, `odata`, …), `HonuaClient` OGC/WFS/STAC methods | Protocol-correct clients that currently address Honua's `/ogc/...` facade paths; raw third-party OGC/WFS/STAC endpoints are roadmap. GeoServices is the standalone lane today. |
| Server compatibility gate (`checkCompatibility`) | `honua-enhanced` | Honua Server | `HonuaClient.checkCompatibility` | Reads `/api/v1/admin/capabilities`; skip it for standalone reads. |
| Authored `MapPackage` runtime (`loadMapPackage`, `HonuaMapRuntime`) | `honua-enhanced` | Honua Server | `@honua/sdk-js/runtime`, `examples/maplibre-quickstart` | Server-authored styles/layer order/metadata. |
| Realtime subscriptions | `honua-enhanced` | Honua Server | `@honua/sdk-js/realtime`, `examples/realtime-incident-dashboard` | Subscription-backed live updates. |
| Collaboration / saved maps | `honua-enhanced` | Honua Server | `@honua/sdk-js/collaboration` | Shared/saved maps, multi-user sessions. |
| MCP tools / AI surfaces | `honua-enhanced` | Honua Server + `@honua/mcp-server` | `mcp/`, `@honua/sdk-js/agent-tools` | Assistant discovery/query over MCP. |

## Rule of thumb

If your data already lives behind an ArcGIS Server / ArcGIS Online endpoint, the
SDK is a drop-in typed client and `esri-leaflet` successor **today, standalone**.
Reach for a Honua Server when you need authored map packages, realtime,
collaboration, or the MCP/AI surfaces — or when you want raw OGC/WFS/STAC/OData
endpoints unified behind the same typed contract (the facade lane).
