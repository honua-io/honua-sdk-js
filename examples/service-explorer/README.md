# Universal GIS Service Explorer

This sample demonstrates a linked service/layer explorer using the Honua SDK app-workspace and linked-view abstractions.

## Public-kernel capability truth (S1)

[`src/truth-model.ts`](./src/truth-model.ts) is the renderer-neutral substrate
for the replacement golden journey. It owns one public `createHonua()` kernel
(or borrows an explicitly injected kernel), connects a pasted URL, calls the
managed connection's immutable `inspect()` surface, and projects only inspected
truth. It performs no protocol guessing and adds no capability inference.

The model exposes explicit `loading`, `ready`, `partial`, `ambiguous`, `auth`,
`unsupported`, `cancelled`, and `error` states. A successful inspection includes
service detection evidence, sources and locators, legacy and v2 schema identity,
CRS/extent, effective capabilities, structured evidence decisions,
claimed/observed/effective capability profiles, pagination constraints,
provenance, metadata-cache status, and a credential-free authorization-scope
label. Capability-profile evidence retains bounded `metadata`, `conformance`,
and `probe` identities and freshness without retaining credential-bearing URL
parameters. The public kernel does not currently report detector confidence, so
the model says `not-reported` instead of inventing a score. Feature data is
never described as metadata-cache content.

Renderer state is deeply frozen and bounded. URL user-info, fragments, and
identity-bearing query strings are rejected before the kernel runs; only
`f`/`format=json|pjson` discovery controls are safely removed, matching the
public kernel boundary. Opaque authorization-scope fingerprints remain
transport-only; the renderer receives a separate validated structural label,
an exact SHA-256 identity, or `[configured]`. Credential-shaped diagnostic text
is redacted; source, field, decision, evidence, provenance, extent, and
diagnostic collections have explicit limits with visible truncation diagnostics.
An inspected default source is accepted only as kernel truth; a caller-supplied
selector cannot manufacture selection truth, and the model states whether a
selected source is inside the bounded visible projection.
The live managed connection is retained separately for the accepted-operation
workflow in S2 and is disposed on replacement, cancellation, or model teardown.

The focused fixture matrix covers GeoServices Feature/Map, OGC API
Features/Tiles/Maps, WFS, WMS, WMTS, STAC, and OData inspection profiles. WMS
and WMTS are projection fixtures only in this slice: if the installed public
kernel does not yet expose a connect adapter for a supplied protocol, the model
truthfully returns `unsupported` rather than simulating discovery.

The existing presentation shell below remains in place until S2/S3 wire the
paste-URL workflow and remove the compatibility app-workspace surface.

The default app configuration targets cloud Honua:

- `VITE_HONUA_SERVICE_EXPLORER_BASE_URL=https://cloud.honua.io`
- `VITE_HONUA_SERVICE_EXPLORER_SERVICE_ID=natural-earth`
- `VITE_HONUA_SERVICE_EXPLORER_LAYER_ID=0`

When no API key is configured and `VITE_HONUA_SERVICE_EXPLORER_MODE=auto`, the app loads a bundled fixture so the sample remains buildable and useful locally. The UI keeps the cloud target visible and surfaces the fixture lane as a degraded diagnostic. Browser bearer-token forwarding through `VITE_HONUA_SERVICE_EXPLORER_BEARER_TOKEN` is disabled unless `VITE_HONUA_ALLOW_BROWSER_BEARER_TOKEN=true` is also set; prefer short-lived API keys or backend-issued sessions for browser demos.

The source picker covers **every protocol identifier the SDK contract supports** (`src/contract/types.ts` `Protocol`), grouped by family:

- **Honua native** — Honua gRPC FeatureService transport.
- **Esri GeoServices** — FeatureServer, MapServer, ImageServer, Geometry Service, GP Service.
- **OGC API & catalogs** — OGC API Features, Tiles, Maps, Records, and STAC.
- **OGC web services** — WFS, WMS, WMTS.
- **OData** — OData v4 entity sets.
- **MapLibre native** — vector, raster, and GeoJSON sources composed alongside protocol sources.

Queryable sources participate in the shared linked context. Render-only standards sources keep metadata, cache, capability, map, and diagnostics panels active while table/query controls are disabled. Utility-only services (Geometry, GP) host no features, so they expose metadata and diagnostics while the table/query/render lanes report as unsupported — mirroring how the SDK exposes them only through the typed `Source.protocol()` escape hatch.

## Control-Plane Handoff

Hosted Honua deployments can use the experimental control-plane subpath to discover a hosted map and pass its package locator to the runtime loader without mixing admin APIs into data queries:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { HonuaClient } from "@honua/sdk-js";
import { createHonuaControlPlane } from "@honua/sdk-js/control-plane";
import { loadMapPackageFromId } from "@honua/sdk-js/runtime";

const client = new HonuaClient({ baseUrl: "https://cloud.honua.io", apiKey: process.env.HONUA_API_KEY });
const controlPlane = createHonuaControlPlane({ client });
const maps = await controlPlane.hostedMaps.list({ workspaceId: "workspace-ops", limit: 10 });

if (maps.supported && maps.value.items[0]) {
  const locator = await controlPlane.hostedMaps.getPackageLocator(maps.value.items[0].id);
  if (locator.supported) {
    await loadMapPackageFromId(locator.value, maplibreMap, { client });
  }
}
```

When `/api/v1/admin` is not exposed, control-plane calls return `{ supported: false, capability, reason }` for 404/501 capability misses so the sample can stay on fixture/service discovery lanes.

## Run

```sh
npm run demo:service-explorer
```

Use the shared runner for the maintained source and packed-package workflows:

```sh
npm run samples:run -- verify --sample service-explorer --sdk-mode source
npm run samples:run -- verify --sample service-explorer --sdk-mode packed
```

The presentation shell identifies the SDK mode and keeps cloud-to-fixture
degradation explicit. Each build separately records bounded entrypoint and
bundle resolution evidence in `dist/honua-sample-sdk-resolution.json`. Explicit
disposal aborts in-flight discovery, removes map and delegated DOM listeners,
and rejects work registered after teardown.

To open a specific fixture source, pass `?source=<id>` in the URL. Useful source ids include `honolulu-civic-services:0`, `grpc-service-requests`, `ogc-features-parcels`, `ogc-records-catalog`, `stac-imagery`, `imageserver-elevation`, `geometry-utility`, `gp-routing`, `wms-hazard`, `ogc-tiles-basemap`, `wfs-service-requests`, `wmts-basemap`, `ogc-maps-zoning`, `odata-assets`, and `maplibre-vector-basemap`.

## Validate

```sh
npm run demo:service-explorer:typecheck
npm run demo:service-explorer:build
npm test -- test/service-explorer-truth-model.test.ts
npm test -- test/service-explorer-workspace.test.ts
npm run test:playwright:service-explorer
```

The focused truth-model suite currently exercises 24 cases across the ten
declared protocol profiles, input normalization/redaction, nested collection
budgets, selection integrity, supersession, cancellation, and disposal.

The Playwright workflow exercises the source picker, map, result table, and
chart at desktop and mobile viewports, performs a real keyboard activation,
runs axe-core, and fails on page or console errors. It also proves table and
chart handlers are inert after disposal. The runner's one-shot fixture gate
additionally proves loopback readiness and complete server shutdown.

## Slice Coverage

- Public-kernel URL-to-inspection truth model with explicit terminal states,
  bounded renderer projection, cancellation, redaction, and multi-protocol
  fixture coverage.
- Service and layer discovery from cloud Honua or the local fixture catalog.
- Standards source picker for every SDK protocol — Honua gRPC, FeatureServer, MapServer, ImageServer, Geometry Service, GP Service, OGC API Features/Tiles/Maps/Records, STAC, WFS, WMS, WMTS, OData, and MapLibre vector/raster/GeoJSON — grouped by protocol family.
- Schema, capabilities, extent, metadata cache status, and revalidate controls.
- Map, table, chart, filter, and detail panels synchronized through one `ExplorationContext`.
- Map extent publishes a debounced spatial filter that drives table and chart projections.
- Filters update the map layer filter, table rows, chart buckets, and query diagnostics.
- Shared selection drives map feature-state, table highlighting, and the detail panel.
- Unsupported/degraded states are represented as diagnostics and capability badges.
- Experimental control-plane handoff can locate a hosted map package, then runtime loading remains on `@honua/sdk-js/runtime`.

S2 and S3 remain intentionally outside this slice: the current compatibility
shell still needs replacement by the paste-URL operation workflow, accepted
query/render explain plan and TypeScript generator, followed by source/packed,
hostile-browser, scheduled-live, catalog/gallery, and route-retirement evidence.

## Caching Notes

- Cache catalog, capabilities, schema/domain metadata, drawingInfo/style metadata, WFS capabilities, WMTS tile matrix metadata, OGC Maps collection/style metadata, and OData `$metadata` by source/config version.
- Treat viewport filters, ad hoc feature queries, MapServer export requests, WFS GetFeature requests, OData table queries, and explicit user refreshes as fresh requests unless a materialized result includes visible provenance.
- Realtime is not required for this source-picker sample; a selected source would need to advertise stream capability before live state can be treated as authoritative.
