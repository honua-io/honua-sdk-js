# Basemap inventory

Source inventory at SDK commit 9f63b4c3b; 34 catalog entries. Each generated playground inherits its source sample policy.

| Sample | Source | Policy | Playground |
|---|---|---|---|
| ai-spatial-app-builder | `examples/ai-spatial-app-builder` | No map renderer; no online basemap requests | Generated from source |
| app-bootstrap-basic | `examples/app-bootstrap-basic` | Offline fixture demonstration; retain local style, document live override where supported | — |
| automatic-source-workflow | `docs/examples/automatic-source-workflow` | Offline fixture demonstration; retain local style, document live override where supported | — |
| cesium-route-playback | `docs/examples/cesium-route-playback` | Scene / renderer-state demonstration; preserve declared scene fixture/provider credits | — |
| columnar-query-quickstart | `examples/columnar-query-quickstart` | Offline fixture demonstration; retain local style, document live override where supported | Generated from source |
| coverages-wcs-basic | `examples/coverages-wcs-basic` | Purpose-specific imagery/coverage/terrain/archive; keep audited fixture style and attribution | Generated from source |
| edit-workflow-demo | `examples/edit-workflow-demo` | Offline fixture demonstration; retain local style, document live override where supported | — |
| geocoding-quickstart | `examples/geocoding-quickstart` | Offline fixture demonstration; retain local style, document live override where supported | — |
| geoprocessing-job-runner | `examples/geoprocessing-job-runner` | Purpose-specific SVG buffer/result schematic; retain bounded projection and labels, no geographic basemap | — |
| geoservices-source-app | `examples/geoservices-source-app` | Offline fixture demonstration; retain local style, document live override where supported | — |
| imagery-cog-quickstart | `examples/imagery-cog-quickstart` | Purpose-specific imagery/coverage/terrain/archive; keep audited fixture style and attribution | — |
| maplibre-quickstart | `examples/maplibre-quickstart` | Live: shared OpenFreeMap Positron / Dark, Liberty for street detail; fixture: local reviewed style | — |
| mcp-gis-assistant | `examples/mcp-gis-assistant` | Offline fixture demonstration; retain local style, document live override where supported | — |
| migration-workbench | `examples/migration-workbench` | Offline fixture demonstration; retain local style, document live override where supported | — |
| nl-map-control | `examples/nl-map-control` | Offline fixture demonstration; retain local style, document live override where supported | — |
| node-backend-quickstart | `examples/node-backend-quickstart` | No map renderer; no online basemap requests | — |
| oauth-signin | `examples/oauth-signin` | No map renderer; no online basemap requests | — |
| offline-region-reference | `docs/examples/offline-region-reference` | No map renderer; no online basemap requests | — |
| overture-geoparquet | `examples/overture-geoparquet` | Purpose-specific SVG AOI point preview; retain explicit AOI bounds and labels, no geographic basemap | — |
| planning-permitting-workbench | `examples/planning-permitting-workbench` | Purpose-specific schematic parcel locator; retain visible scope labels, no geographic basemap | — |
| pmtiles-static | `examples/pmtiles-static` | Purpose-specific imagery/coverage/terrain/archive; keep audited fixture style and attribution | — |
| react-quickstart | `examples/react-quickstart` | Live: shared OpenFreeMap Positron / Dark, Liberty for street detail; fixture: local reviewed style | Generated from source |
| realtime-incident-dashboard | `examples/realtime-incident-dashboard` | Live: shared OpenFreeMap Positron / Dark, Liberty for street detail; fixture: local reviewed style | — |
| runtime-parity-showcase | `examples/runtime-parity-showcase` | Scene / renderer-state demonstration; preserve declared scene fixture/provider credits | — |
| service-explorer | `examples/service-explorer` | Live: shared OpenFreeMap Positron / Dark, Liberty for street detail; fixture: local reviewed style | — |
| shared-renderer-state | `docs/examples/shared-renderer-state` | Scene / renderer-state demonstration; preserve declared scene fixture/provider credits | — |
| sketch-editing | `examples/sketch-editing` | Offline fixture demonstration; retain local style, document live override where supported | Generated from source |
| spatial-analytics-workbench | `examples/spatial-analytics-workbench` | Purpose-specific schematic cell/aggregation maps; retain visible scope labels, no geographic basemap | — |
| stac-imagery-browser | `examples/stac-imagery-browser` | Purpose-specific imagery/coverage/terrain/archive; keep audited fixture style and attribution | Generated from source |
| storytelling-25d-map | `examples/storytelling-25d-map` | Live: shared OpenFreeMap Positron / Dark, Liberty for street detail; fixture: local reviewed style | — |
| temporal-playback | `examples/temporal-playback` | Offline fixture demonstration; retain local style, document live override where supported | Generated from source |
| terrain-rgb-elevation | `examples/terrain-rgb-elevation` | Purpose-specific imagery/coverage/terrain/archive; keep audited fixture style and attribution | — |
| unified-ops-workspace | `examples/unified-ops-workspace` | Offline fixture demonstration; retain local style, document live override where supported | — |
| web-components-basic | `examples/web-components-basic` | Offline fixture demonstration; retain local style, document live override where supported | — |

Starters: vanilla-ts and react-ts keep local default fixture style; configured VITE_HONUA_ENDPOINT lane receives shared online default/override with attribution.

honua-samples: create-honua-app-react-ts/vanilla-ts consume the published scaffold. browser-featureserver-query renders a table, and geocode-single-line, hello-featureserver-rest, odata-query-rest, ogc-features-python, stac-search-rest and wms-getmap-check are request/response checks. No map basemap required.

Installed API design: /runtime explicit basemap style loader/binding, no network in core construction. Namespaced sources/layers inserted beneath operational overlays. Preserve TileJSON attribution and complete vector glyph/sprite resources. Surface style/tile/glyph/sprite failures with self-hosted override action while operational layers stay usable; no provider substitution.

## Provider and offline evidence

The shared online defaults are OpenFreeMap Positron (thematic context), Liberty
(street detail) and Dark (dark theme). [Provider terms](https://openfreemap.org/)
and [quick start](https://openfreemap.org/quick_start/) were checked 2026-10-10:
no key or account is required, commercial use is allowed, and the public service
has no SLA. Keep OpenMapTiles and OpenStreetMap attribution; do not strip source
TileJSON attribution. Public style URLs are mutable. Use documented provider
downloads/self-hosting for offline packs with recorded style/data versions and
licenses; never scrape the public tile service as an implicit offline fallback.

`@honua/sdk-js/runtime` exports `resolveHonuaOnlineBasemapStyle` and
`HonuaOnlineBasemapBinding`. Core client construction performs no basemap I/O.
The browser binding explicitly fetches a style after the local initial map is
ready. Custom/self-hosted styles take precedence over theme defaults. A custom
glyph template must agree with any operational glyph template already on the map;
otherwise the binding reports an actionable error and preserves the current base.
Image, GeoJSON, video, glyph, sprite and tile URLs resolve relative to their style.

Online views keep operational source/layer objects, filters, feature state,
selection, camera, imported bindings and popups during theme changes. Asset
failures leave local operational rendering and controls available and show a
status message; no other provider is silently substituted. Mobile layouts use
MapLibre's compact attribution control, whose expanded credits remain accessible.
Screenshots/exports must include that control or carry the exact visible source
credits alongside the image. Canvas-only exports omit DOM attribution and must
not be distributed without those credits.

## Publication order

Publish the SDK containing the new `/runtime` exports and promote its certified release channel before publishing a
create-honua-app release whose starter templates import them. Release-please owns
both version bumps; do not move template pins ahead of registry availability.
`npm run create-app:verify:sdk-pair` verifies packed scaffold projects beside a packed SDK under default
npm peer resolution, then typechecks/builds both installed starters and imports the installed runtime default. The published scaffold consumer lane cannot exercise the new
helper until the coordinated SDK and scaffold artifacts are available.

## Map export inventory

The live map views covered here (First Map, React quickstart, service explorer,
realtime incident dashboard, storytelling) and both starters have no user-facing
map image export. Their browser evidence captures the page with expanded credits,
including at mobile width, rather than exporting only the WebGL canvas. The
imagery COG sample's `image-server-export` access path retrieves a server-authored
raster; it is not a composite map screenshot and does not include an online
basemap. Its purpose-specific imagery provenance/credits remain authoritative.
Other fixture/scene/archive examples retain their own reviewed attribution;
none exposes a canvas map PNG download. Future map image exports must include
visible credits or an attached exact credit record before they can qualify.

## Live style overrides

| View | Custom/self-hosted style environment variable |
|---|---|
| First Map | `VITE_HONUA_QUICKSTART_BASEMAP_STYLE` |
| Storytelling 2.5D | `VITE_HONUA_25D_BASEMAP_STYLE` |
| React quickstart | `VITE_HONUA_BASEMAP_STYLE` |
| Realtime incident dashboard | `VITE_HONUA_BASEMAP_STYLE` |
| Service explorer | `VITE_HONUA_BASEMAP_STYLE` |
| Vanilla and React scaffold templates | `VITE_HONUA_BASEMAP_STYLE` |

These are non-secret browser-visible style URLs. Set them when building the
corresponding Vite app; a missing provider asset message names the exact key.
Explicit overrides stay selected across light/dark changes. Fixture lanes retain
their reviewed local style and do not implicitly fetch the online defaults.

Copied playground and starter adapters detect the runtime helper at activation, so older published SDKs still build and run their local fixture lane. A live map with an older SDK displays an explicit upgrade instruction. Source examples use direct imports so their normal bundle tree shaking is preserved. The compatibility adapter does not select an alternate provider.

After the deterministic packed-pair gate, opt in to the registry compatibility lane with `HONUA_CREATE_APP_REGISTRY_COMPAT_ENABLED=true npm run create-app:verify:sdk-pair`. This additionally builds both packed starters beside registry SDK 0.1.14 and executes their shipped adapter against those installed bytes, checking the actionable upgrade notice. The 0.1.14 version is a compatibility test target, not a release or generated dependency pin.

Bundle comparison is a separate opt-in review measurement: set `HONUA_BASEMAP_BUNDLE_BASELINE_REF` to an explicit existing Git ref or SHA while running the packed-pair gate. The receipt records its resolved commit and compares both live starter builds against that template source using the same installed packed SDK and dependencies, counting every emitted JavaScript chunk and its gzip size. The ordinary gate requires no Git remote or baseline history.
