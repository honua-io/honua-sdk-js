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
- `backend-agnostic` — the typed surface addresses a raw third-party endpoint's
  own path layout (discovered from the server, not a fixed prefix), no Honua
  infrastructure required. The Honua facade layout stays a detected fast path.
  Proven from recorded fixtures per raw layout in CI; live-proven against the
  named public servers by the scheduled `standalone-live-smoke` lane.
- `honua-enhanced` — requires a Honua Server (or a server that implements Honua's
  facade paths). These are the upgrade-path features.
- `facade-bound` — the *typed* SDK surface exists and is protocol-correct, but it
  currently addresses Honua's server facade paths (e.g. `/ogc/features/...`)
  rather than a raw third-party endpoint's own path layout. Backend-agnostic
  support for raw endpoints is roadmap; use GeoServices or the backend-agnostic
  lanes for the standalone path today.

## Matrix

| Capability | Standalone? | Backend needed | Sample app / API | Notes |
| --- | :-: | --- | --- | --- |
| GeoServices FeatureServer query (`queryFeatures`, `queryFeaturesAll`, streaming, count, extent) | `standalone` | Any ArcGIS Server / Online | `examples/standalone-quickstart`, `HonuaClient.queryFeatures`, `Source` (`geoservices-feature-service`) | Raw `/rest/services/.../FeatureServer/{id}/query` path; verified live against `services.arcgis.com`. |
| GeoServices MapServer / ImageServer reads (query, export, identify, legend, find) | `standalone` | Any ArcGIS Server / Online | `HonuaClient.mapService` / `imageService` | Raw GeoServices paths; verified live against `sampleserver6.arcgisonline.com`. |
| Esri → GeoJSON → MapLibre source | `standalone` | Any ArcGIS Server / Online | `loadHonuaFeatureServiceGeoJson` (`@honua/sdk-js/map`) | One call from a public FeatureServer URL to a MapLibre `geojson` source. |
| Esri compat drop-in (`FeatureLayerCompat`, `MapImageLayerCompat`, query/edits API) | `standalone` | Any ArcGIS Server / Online | `@honua/sdk-js/esri-compat`, `examples/standalone-quickstart` | The `esri-leaflet` migration path; parses `services.arcgis.com`-style URLs and builds its own client. |
| `honua-migrate` codemod / ArcGIS scanner | `standalone` | None (build-time) | `@honua/sdk-js/migration`, `npm run scan:arcgis` | Static analysis + rewrites; no server involved at all. |
| Geometry ops (buffer/area/measure/simplify/reproject) | `standalone` | None (client-side) | `@honua/sdk-js/geometry` | Pure client-side turf/proj4 ops. |
| OGC API Features query (`Source` `ogc-features`) | `backend-agnostic` | Any OGC API Features server | `Source` (`ogc-features`, `locator.layout: "ogc-api" \| "auto"`), `HonuaClient.resolveOgcFeaturesLayout` | Discovers the collections/items layout from the landing page `rel="data"`/`rel="conformance"` links (OGC API - Common); item paths follow the `{collections}/{id}/items` template. Fixture-proven against **pygeoapi** (`demo.pygeoapi.io/master`) and **ldproxy** (`demo.ldproxy.net`); same typed `Query` yields an identical `Result` on a raw collection and the Honua facade. Facade (`/ogc/features/...`) stays the zero-round-trip default. |
| WFS 2.0 query / GetFeature (`Source` `wfs`) | `backend-agnostic` | Any WFS 2.0 server | `Source` (`wfs`), `HonuaWfs` | Drives a raw `GetCapabilities` endpoint and issues GetFeature against the **DCP operation URL** the server advertises (`ows:DCP/ows:HTTP/*/@xlink:href`), not an assumed path — e.g. a GeoServer mounted at `/geoserver/ows` that advertises `/geoserver/wfs`. Fixture-proven against **GeoServer** (`ahocevar.com/geoserver`). |
| STAC search (`Source` `stac`) | `backend-agnostic` | Any STAC API or static catalog | `Source` (`stac`, `locator.layout: "stac-api" \| "stac-static"`), `HonuaStacSearch`, `HonuaStacStaticCatalog` | `stac-api` runs `/search` under a raw API root; `stac-static` walks a static `catalog.json` tree via `rel="child"`/`rel="item"` links with client-side filtering. Fixture-proven against **Earth Search** (`earth-search.aws.element84.com/v1`) and a static catalog tree. |
| OData v4 query (`Source` `odata`) | `backend-agnostic` | Any OData v4 service | `Source` (`odata`), `HonuaOdataEntitySet` | Capability-negotiated via `$metadata`; the service `basePath` is taken from `locator.url` so any service root works. Fixture-proven against the OASIS **TripPin** reference service (`services.odata.org/TripPinRESTierService`). |
| OGC API Tiles / Maps / Processes / Records (typed surface) | `facade-bound` | Honua Server (facade paths) today | `Source` (`ogc-tiles`, `ogc-maps`, `ogc-records`), `HonuaClient` OGC methods | Protocol-correct clients that still address Honua's `/ogc/...` facade paths; raw third-party layout discovery for these families is roadmap. Use the backend-agnostic Features/WFS/STAC/OData lanes or GeoServices for the standalone path today. |
| Server compatibility gate (`checkCompatibility`) | `honua-enhanced` | Honua Server | `HonuaClient.checkCompatibility` | Reads `/api/v1/admin/capabilities`; skip it for standalone reads. |
| Authored `MapPackage` runtime (`loadMapPackage`, `HonuaMapRuntime`) | `honua-enhanced` | Honua Server | `@honua/sdk-js/runtime`, `examples/maplibre-quickstart` | Server-authored styles/layer order/metadata. |
| Realtime subscriptions | `honua-enhanced` | Honua Server | `@honua/sdk-js/realtime`, `examples/realtime-incident-dashboard` | Subscription-backed live updates. |
| Collaboration / saved maps | `honua-enhanced` | Honua Server | `@honua/sdk-js/collaboration` | Shared/saved maps, multi-user sessions. |
| MCP tools / AI surfaces | `honua-enhanced` | Honua Server + `@honua/mcp-server` | `mcp/`, `@honua/sdk-js/agent-tools` | Assistant discovery/query over MCP. |

## Rule of thumb

If your data lives behind an ArcGIS Server / ArcGIS Online endpoint, an OGC API
Features server (pygeoapi, ldproxy, GeoServer OGC API), a WFS 2.0 server, a STAC
API or static catalog, or an OData v4 service, the SDK is a drop-in typed client
**today, standalone** — point a `Source` at the raw endpoint (set
`locator.layout` for OGC API Features / STAC where the server is not a Honua
facade). Reach for a Honua Server when you need authored map packages, realtime,
collaboration, the MCP/AI surfaces, or the OGC API Tiles / Maps / Processes /
Records families (still facade-bound today).
