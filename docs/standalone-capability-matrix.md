# Backend-Agnostic vs Honua-Server-Enhanced Capability Matrix

<!-- support-manifest:standalone-matrix:start -->
This is the generated, evidence-linked line between capabilities that work
against raw standards-speaking endpoints and capabilities that require the Honua
facade. The source of truth is [`config/support-manifest.v1.json`](../config/support-manifest.v1.json).
See the [standalone quickstart](./standalone-quickstart.md) for the runnable path.

## Status vocabulary

- `supported` — release-gated implementation with linked evidence
- `beta` — implemented and evidenced, but still in pre-GA hardening
- `experimental` — usable evidence-backed preview whose shape may change
- `deprecated` — compatibility-only surface with a named replacement
- `unsupported` — no implementation claim
- `facade-required` — typed capability exists but execution requires Honua Server

Environment and execution mode are separate from status: `standalone` tells you
where a claim works, while `discovery`, `native`, `client-fallback`, and
`facade` tell you how it works.

## Matrix

| Capability | Status | Environment | Execution | Backend needed | API | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GeoServices FeatureServer query | `supported` | `standalone` | `native` | Any ArcGIS Server or ArcGIS Online endpoint | connect(), HonuaClient.queryFeatures, Source | [fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts)<br>[live: standalone-live](../scripts/standalone-live-smoke.mjs) | Uses the raw FeatureServer query path; fixture- and live-proven without a Honua account or server. |
| GeoServices MapServer and ImageServer reads | `supported` | `standalone` | `native` | Any ArcGIS Server or ArcGIS Online endpoint | HonuaClient.mapService, HonuaClient.imageService | [fixture: honua-surface-fixtures](../test/honua-surface.test.ts)<br>[fixture: geoservices-conformance](../test/contract/geoservices-conformance.test.ts)<br>[integration: map-service-integration](../test/integration/surfaces/map-server.integration.ts)<br>[integration: image-service-integration](../test/integration/surfaces/image-server.integration.ts)<br>[live: standalone-live](../scripts/standalone-live-smoke.mjs) | Uses raw GeoServices paths for query, export, identify, legend, and find. |
| Esri compatibility layer | `supported` | `standalone` | `native` | Any ArcGIS Server or ArcGIS Online endpoint | @honua/sdk-js/esri-compat | [fixture: esri-compat-fixtures](../test/feature-layer-compat.test.ts) | Compatibility classes parse public GeoServices URLs and create their own client. |
| ArcGIS scanner and migration codemod | `supported` | `build-time` | `static` | None | @honua/sdk-js/migration, honua-migrate | [fixture: migration-fixtures](../test/migration-codemod.test.ts) | Static analysis and rewrites run locally; no service is involved. |
| Geometry operations | `supported` | `client-only` | `native` | None | @honua/sdk-js/geometry | [fixture: geometry-fixtures](../test/geometry/ops.test.ts) | Buffer, area, simplify, measure, and reprojection run in the client through optional peers. |
| OGC API Features | `supported` | `standalone` | `discovery` | Any OGC API Features server | connect(), Source with locator.layout=ogc-api or auto | [fixture: ogc-features-fixtures](../test/contract/ogc-features-backend-agnostic.test.ts)<br>[live: standalone-live](../scripts/standalone-live-smoke.mjs) | Discovers collections and item links from a raw landing page; the Honua facade remains a zero-round-trip fast path. |
| WFS 2.0 | `supported` | `standalone` | `discovery` | Any WFS 2.0 server | Source, HonuaWfs | [fixture: wfs-fixtures](../test/contract/wfs-backend-agnostic.test.ts)<br>[live: standalone-live](../scripts/standalone-live-smoke.mjs) | Uses the DCP operation URLs advertised by GetCapabilities instead of assuming a server path. |
| STAC API and static catalogs | `supported` | `standalone` | `discovery` | Any STAC API or static catalog | Source with locator.layout=stac-api or stac-static | [fixture: stac-fixtures](../test/contract/stac-backend-agnostic.test.ts)<br>[live: standalone-live](../scripts/standalone-live-smoke.mjs) | Searches a raw STAC API or walks static catalog links with client-side filtering. |
| OData v4 | `supported` | `standalone` | `discovery` | Any OData v4 service | Source, HonuaOdataEntitySet | [fixture: odata-fixtures](../test/contract/odata-backend-agnostic.test.ts)<br>[live: standalone-live](../scripts/standalone-live-smoke.mjs) | Reads $metadata, intersects advertised capabilities, and uses the raw service root. |
| OGC API Tiles | `beta` | `standalone` | `discovery` | Any link-driven OGC API Tiles server | connect(), Source protocol ogc-tiles | [fixture: ogc-tiles-fixtures](../test/connect-ogc-tiles.test.ts) | Discovers raw landing, conformance, collection, tileset, and tile links; does not rewrite them to /ogc/tiles. |
| OGC API Maps | `beta` | `standalone` | `discovery` | Any link-driven OGC API Maps server | connect(), Source protocol ogc-maps | [fixture: ogc-maps-fixtures](../test/connect-ogc-maps.test.ts) | Discovers and renders from the raw map path advertised by the service; does not require /ogc/maps. |
| OGC API Records | `beta` | `standalone` | `discovery` | Any link-driven OGC API Records server | connect(), Source protocol ogc-records | [fixture: ogc-records-fixtures](../test/connect-ogc.test.ts) | Discovers and queries the raw records path advertised by the service; does not require /ogc/records. |
| OGC API Processes discovery | `experimental` | `standalone` | `discovery` | Any link-driven OGC API Processes server | discoverOgcProcesses() | [fixture: ogc-processes-fixtures](../test/connect-ogc-processes.test.ts) | Discovers conformance and process metadata at raw paths. Processes are not a protocol-neutral Source. |
| OGC API Processes execution | `facade-required` | `honua-facade` | `facade` | Honua Server | HonuaClient OGC Processes methods | [integration: ogc-processes-integration](../test/integration/surfaces/ogc-processes.integration.ts) | Typed execution uses the Honua facade today; raw third-party execution is not claimed. |
| Server compatibility gate | `facade-required` | `honua-facade` | `facade` | Honua Server | HonuaClient.checkCompatibility() | [fixture: server-compatibility-fixtures](../test/server-compatibility.test.ts) | Reads the Honua administrative capabilities contract and should be skipped for standalone reads. |
| Authored MapPackage runtime | `facade-required` | `honua-facade` | `facade` | Honua Server | @honua/sdk-js/runtime | [fixture: map-package-fixtures](../test/runtime/map-package-fetch.test.ts) | Loads server-authored styles, layer order, and metadata. |
| Realtime subscriptions | `facade-required` | `honua-facade` | `transport` | Honua Server | @honua/sdk-js/realtime | [integration: realtime-integration](../test/integration/surfaces/realtime.integration.ts) | Subscription-backed live updates depend on the Honua realtime contract. |
| Collaboration and saved maps compatibility shim | `deprecated` | `honua-facade` | `facade` | Honua Server and @honua/app-platform | @honua/sdk-js/collaboration | Lifecycle-only claim | The SDK entrypoint is a temporary shim; new code imports @honua/app-platform/collaboration. |
| MCP tools and AI execution | `facade-required` | `honua-facade` | `facade` | Honua Server and @honua/mcp-server | mcp/, @honua/sdk-js/agent-tools | [fixture: agent-tools-fixtures](../test/agent-tools.test.ts) | Tool definitions are local, while discovery and query execution use the bounded Honua server surface. |

## Current OGC line

Raw OGC API Tiles, Maps, and Records discovery/use is `beta` and fixture-proven.
Raw OGC API Processes discovery is `experimental`; typed Processes execution is
still `facade-required`. Those are deliberately separate claims so discovery
evidence can never be mistaken for execution support.
<!-- support-manifest:standalone-matrix:end -->
