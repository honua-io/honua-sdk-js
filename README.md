# Honua JS SDK

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/honua-io/honua-sdk-js/badge)](https://scorecard.dev/viewer/?uri=github.com/honua-io/honua-sdk-js)

[![npm](https://img.shields.io/npm/v/@honua/sdk-js?color=2b6cb0&label=%40honua%2Fsdk-js)](https://www.npmjs.com/package/@honua/sdk-js)
[![types](https://img.shields.io/npm/types/@honua/sdk-js?color=3178c6)](https://www.npmjs.com/package/@honua/sdk-js)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@honua/sdk-js?color=43853d)](./package.json)

> One geospatial client for GeoServices, OGC APIs, WMS/WMTS/WFS, STAC, and OData —
> with first-class TypeScript, a MapLibre runtime, and a drop-in ArcGIS migration path.

`@honua/sdk-js` is the JavaScript / TypeScript client for the [Honua](https://github.com/honua-io)
geospatial platform. It speaks the open protocols your data already uses (Esri GeoServices,
OGC API Features / Tiles / Maps / Processes, STAC, WMS, WMTS, WFS 2.0, OData v4), exposes a
single protocol-neutral `Dataset` → `Source` → `Query` → `Result` contract on top of them, and
ships a MapLibre-first map runtime plus an Esri compatibility layer so existing ArcGIS apps
can migrate file-by-file.

- **Protocol-neutral.** One `Source.query(...)` call works against GeoServices, OGC, WFS, OData
  and friends. Capability misses throw `HonuaCapabilityNotSupportedError` instead of returning
  empty results.
- **TypeScript first.** `strict` + `verbatimModuleSyntax`, exported types for every public symbol,
  declaration maps, and JSDoc on the public client surface.
- **Migrate, don't rewrite.** `FeatureLayerCompat`, `MapImageLayerCompat`, `MapViewCompat`,
  `SceneViewCompat`, `WebMapCompat`, and a safe codemod (`honua-migrate`) keep existing ArcGIS
  code running while you cut over.
- **Open runtime.** `loadMapPackage(...)` + `HonuaMapRuntime` render a Honua `MapPackage` on
  MapLibre GL JS. Cesium, kepler.gl, and OGC web-map sources are first-class.

> **What this is (and is not).** `@honua/sdk-js` is a typed geospatial *service client* and
> migration toolkit — it is **not a rendering engine**. 2D rendering rides MapLibre GL JS and 3D
> rides Cesium, so the honest comparisons are the service-client libraries, not the renderers:
>
> - vs **`@esri/arcgis-rest-js`** — that's Esri's own client for Esri services only. Honua speaks
>   GeoServices *plus* OGC API / WFS / WMS / WMTS / STAC / OData under one typed contract, with a
>   capability model that throws instead of returning silently-empty results.
> - vs **`esri-leaflet`** — dormant (last release 2025) and Leaflet-bound. Honua's esri-compat +
>   `honua-migrate` codemod is an actively maintained migration path that targets MapLibre.
> - vs **`openlayers` / `maplibre-gl` directly** — pick those when you need a renderer and are
>   happy hand-rolling service calls; pick Honua *on top of* MapLibre when you want the typed
>   client, the ArcGIS migration path, or the server-authored `MapPackage` runtime.
>
> The protocol clients work against **any** standards-speaking server — an existing ArcGIS
> Server/Online endpoint, any OGC API implementation, a STAC catalog. A
> [Honua Server](https://github.com/honua-io/honua-server) adds the server-authored `MapPackage`,
> realtime, and AI surfaces, but it is the upgrade path, not the entry fee. **When to use it
> standalone:** if your data already sits behind an ArcGIS Server / ArcGIS Online endpoint, use it
> today as a typed client and `esri-leaflet` successor — no server needed (see the
> [server-optional quickstart](./docs/standalone-quickstart.md) and the
> [backend-agnostic capability matrix](./docs/standalone-capability-matrix.md)). Reach for a Honua
> Server when you need authored map packages, realtime, collaboration, or MCP/AI.

```bash
npm install @honua/sdk-js
```

### Build-less / CDN usage

For static sites, prototypes, or CSP-strict pages that can't run a bundler, a
prebuilt browser bundle is published under `dist/browser/`. Drop in the
minified IIFE build and use the global `window.HonuaSDK`:

```html
<script src="https://cdn.jsdelivr.net/npm/@honua/sdk-js/dist/browser/honua-sdk.min.js"></script>
<script>
  const client = new HonuaSDK.HonuaClient({ baseUrl: "https://your-honua-server.example" });
  // window.HonuaSDK exposes the same public API as `import ... from "@honua/sdk-js"`.
</script>
```

Or, for native ES module imports via an ESM CDN:

```html
<script type="module">
  import { HonuaClient } from "https://esm.sh/@honua/sdk-js/browser";
  const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
</script>
```

The runtime peers (`maplibre-gl`, `cesium`, `@bufbuild/*`, `@connectrpc/*`) are
kept external — load them yourself when you need map rendering or gRPC
transport. See [`docs/browser-bundle.md`](./docs/browser-bundle.md) for details.

## Bundle size

Small and honest about size: every subpath entrypoint carries a min+gzip byte
budget that CI enforces on every PR (`npm run verify:bundle-budgets`), so drift
fails the build instead of shipping. Sizes are measured the way a consumer
builds — esbuild `--bundle --minify`, runtime peers external. A tree-shake guard
proves that importing a single symbol from the root doesn't drag the whole SDK
in.

| Entrypoint (gzip) | Size |
| --- | ---: |
| `@honua/sdk-js/geocoding` | 1.9 KiB |
| `@honua/sdk-js/expr` | 2.4 KiB |
| `@honua/sdk-js/webmap` | 5.9 KiB |
| `@honua/sdk-js/style` | 8.3 KiB |
| `@honua/sdk-js/map` | 16.2 KiB |
| `@honua/sdk-js` (root) | 108.3 KiB |
| `{ HonuaClient }` only (tree-shake guard) | 47.2 KiB |

Full per-entrypoint table (min + gzip, generated, not hand-written):
[`docs/bundle-sizes.md`](./docs/bundle-sizes.md). Refresh it with
`npm run report:bundle-sizes`.

## 60-second quickstart

**No Honua server required.** The first block below runs against a *public* Esri
GeoServices endpoint — no API key, no account, no infrastructure. The canonical
surface is protocol-neutral: build a `Dataset` over one or more `Source`s, then
call `queryAll()` (or `query()` / `stream()`).

```ts
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";

// A public Esri Living Atlas FeatureServer — nothing of Honua's is running.
const client = new HonuaClient({
  baseUrl: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis",
});

const dataset = createDataset({
  id: "states",
  client,
  sources: [
    {
      id: "apportionment",
      protocol: "geoservices-feature-service",
      locator: {
        url: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis",
        serviceId: "2020_Census_State_Apportionment",
        layerId: 0,
      },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    },
  ],
});

const states = dataset.source("apportionment")!;
const result = await states.queryAll({
  where: "Seats_2020 > 10",
  outFields: ["NAME", "Total_Pop_2020", "Seats_2020"],
  returnGeometry: true,
  pagination: { limit: 100 },
});

console.log(`Loaded ${result.features.length} states`);
```

The same code works against any GeoServices, OGC API Features, WFS, OData, or
STAC endpoint. Migrating from `esri-leaflet`? The raw GeoServices shape and the
`esri-compat` drop-in point at `services.arcgis.com`-style URLs unchanged:

```ts
const { features } = await client.queryFeatures({
  serviceId: "2020_Census_State_Apportionment",
  layerId: 0,
  where: "1=1",
  outFields: ["*"],
  returnGeometry: true,
  resultRecordCount: 25,
});
```

Run the complete standalone app locally — public endpoint in, MapLibre map out:

```bash
npm install
npm run demo:standalone:mock   # deterministic fixture lane (what CI runs)
npm run demo:standalone        # live lane against the public Esri endpoint
```

See [`docs/standalone-quickstart.md`](./docs/standalone-quickstart.md) for the
guided server-optional walkthrough,
[`docs/standalone-capability-matrix.md`](./docs/standalone-capability-matrix.md)
for the backend-agnostic vs server-enhanced breakdown, and
[`examples/standalone-quickstart/`](./examples/standalone-quickstart/README.md)
for the committed source.

### Add a Honua Server

A [Honua Server](https://github.com/honua-io/honua-server) is the **upgrade
path**, not the entry fee. It unlocks server-authored `MapPackage`s
(`loadMapPackage()`), realtime subscriptions, collaboration / saved maps, and the
MCP + AI surfaces. Point the same code at a local server (`docker compose up` in a
honua-server checkout), and gate production reads on the compatibility check:

```ts
const { supported, reasons } = await client.checkCompatibility();
if (!supported) throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
```

The server-connected lane is the [`maplibre-quickstart`](./examples/maplibre-quickstart/README.md)
example (`npm run demo:quickstart:mock`); see
[`docs/quickstart.md`](./docs/quickstart.md) and
[`docs/quickstart-troubleshooting.md`](./docs/quickstart-troubleshooting.md).

## Command-line client (`honua`)

Installing the SDK also installs a first-class **`honua` CLI** — the same
querying and catalog browsing without writing code. It wraps the SDK (no raw
HTTP, no URL-encoding, no `f=json`), prints readable tables by default, and adds
`--json` / `--format geojson` for machine output.

```bash
npm i -g @honua/sdk-js            # or: npx @honua/sdk-js honua <command>
export HONUA_BASE_URL=https://demo.honua.io   # anonymous reads on the public demo

honua services                    # list published services
honua layers maui-parcels         # list a service's layers
honua query maui-parcels/1 --count
honua query maui-parcels/1 --where "tmk_txt LIKE '2%'" --limit 5
honua query maui-parcels/1 --bbox -156.7,20.7,-156.3,21.0 --format geojson
honua stac collections
honua geocode "1 Honolulu Pl, HI"
honua map export maui-parcels --bbox -156.7,20.7,-156.3,21.0 --size 800x600 -o maui.png
```

Authentication resolves from `--api-key`, `HONUA_API_KEY`, or a saved
`honua login`. Run `honua --help` for the full command surface. This is the
recommended replacement for `curl` in docs and demos.

## What you can build

| Demo | What it shows |
|------|---------------|
| [`maplibre-quickstart`](./examples/maplibre-quickstart/README.md) | MapLibre map + Honua FeatureServer query + popup inspection |
| [`react-quickstart`](./examples/react-quickstart/README.md) | `@honua/react` provider + hooks + `HonuaMap` over the same fixture lane |
| [`storytelling-25d-map`](./examples/storytelling-25d-map/README.md) | 2.5D MapLibre storytelling, OGC overlays, route replay |
| [`kepler-analytics`](./examples/kepler-analytics/README.md) | kepler.gl analytics replay over fixture GeoJSON + KPIs |
| [`imagery-cog-quickstart`](./examples/imagery-cog-quickstart/README.md) | WMS `GetMap`, COG ImageServer tiles, `exportImage` previews |
| [`spatial-analytics-workbench`](./examples/spatial-analytics-workbench/README.md) | Honua Cloud AOI jobs + linked map/table/chart workbench |
| [`edit-workflow-demo`](./examples/edit-workflow-demo/README.md) | Optimistic create/update/delete with conflicts & attachments |
| [`geocoding-quickstart`](./examples/geocoding-quickstart/README.md) | Forward / reverse / typeahead via `HonuaGeocodingClient` |
| [`terrain-rgb-elevation`](./examples/terrain-rgb-elevation/README.md) | Terrain-RGB DEM tiles, point elevation, profile lookup |
| [`unified-ops-workspace`](./examples/unified-ops-workspace/README.md) | Composed incident-command + analysis workspace shell |
| [`cesium-route-playback`](./docs/examples/cesium-route-playback/README.md) | Cesium 3D route playback over one bounded Honua query |

Each example documents its own env surface, mock + live lanes, browser telemetry hooks, and
Playwright smoke coverage. The 11 above are the flagship walkthroughs; another 11 runnable
demos cover specialized workflows:

| Demo | What it shows |
|------|---------------|
| [`service-explorer`](./examples/service-explorer/README.md) | Catalog/service browse + linked-view explore over fixtures |
| [`migration-workbench`](./examples/migration-workbench/README.md) | Interactive Esri → Honua migration with `honua-migrate` |
| [`ai-spatial-app-builder`](./examples/ai-spatial-app-builder/README.md) | LLM-driven spatial app builder using `agent-tools` |
| [`mcp-gis-assistant`](./examples/mcp-gis-assistant/README.md) | MCP server exposing Honua tools to assistants |
| [`runtime-parity-showcase`](./examples/runtime-parity-showcase/README.md) | Parity matrix demo across MapLibre / kepler / Cesium runtimes |
| [`realtime-incident-dashboard`](./examples/realtime-incident-dashboard/README.md) | SSE-backed realtime ops dashboard |
| [`geoprocessing-job-runner`](./examples/geoprocessing-job-runner/README.md) | Async GP job submit / poll / cancel |
| [`stac-imagery-browser`](./examples/stac-imagery-browser/README.md) | STAC search + COG preview |
| [`node-backend-quickstart`](./examples/node-backend-quickstart/README.md) | Server-side Honua client (Node) |
| [`app-bootstrap-basic`](./examples/app-bootstrap-basic/README.md) | Minimal `@honua/sdk-js/app` bootstrap helper |
| [`web-components-basic`](./examples/web-components-basic/README.md) | Custom-element gallery |
| [`arcgis-source-app`](./examples/arcgis-source-app/README.md) | Drop-in ArcGIS migration target |
| [`standalone-quickstart`](./examples/standalone-quickstart/README.md) | Server-optional front door: public Esri FeatureServer → MapLibre, no Honua server |

## Mental model: `Dataset` → `Source` → `Query` → `Result`

Every Honua SDK — JavaScript, Python, .NET — speaks the same canonical
vocabulary. A `Dataset` groups one or more `Source`s. Each `Source` accepts a
protocol-neutral `Query` and returns a protocol-neutral `Result`. Operations the
canonical surface does not cover stay reachable through the typed
`source.protocol(...)` escape hatch. Method casing differs by language
(`queryAll()` / `query_all()` / `QueryAllAsync()`), the semantics do not.

Capability misses throw `HonuaCapabilityNotSupportedError` (under the default
`strict` policy) rather than silently returning empty results. See the
[60-second quickstart](#60-second-quickstart) above for the runnable shape; the
cross-language semantics, protocol/capability identifiers, language-binding
tables, and backwards-compatibility policy live in:

- [`docs/sdk-surface-alignment.md`](./docs/sdk-surface-alignment.md) — cross-language naming + semver
- [`docs/shared-client-contract.md`](./docs/shared-client-contract.md) — contract design
- [`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md) — what each protocol supports

## Documentation

- [`docs/quickstart.md`](./docs/quickstart.md) — guided quickstart walkthrough
- [`docs/guide.md`](./docs/guide.md) — long-form reference (server compatibility, subpath
  entrypoints, OGC / WFS / OData cookbooks, MapLibre runtime, migration CLI, request/auth bridge)
- [`docs/errors.md`](./docs/errors.md) — error class reference + retry policy
- [`docs/shared-client-contract.md`](./docs/shared-client-contract.md) — `Dataset` / `Source` / `Query` / `Result` design
- [`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md) — what each protocol supports
- [`docs/sdk-surface-alignment.md`](./docs/sdk-surface-alignment.md) — cross-language naming & semver policy
- [`docs/maplibre-runtime.md`](./docs/maplibre-runtime.md) — `loadMapPackage()` / `HonuaMapRuntime`
- [`docs/react.md`](./docs/react.md) — React bindings (`@honua/react`): provider, hooks, and map components
- [`docs/geometry.md`](./docs/geometry.md) — `@honua/sdk-js/geometry` curated turf/proj4 ops (buffer/area/measure/simplify/reproject) + the `geometryEngine` compat shim
- [`docs/studio-package-contracts.md`](./docs/studio-package-contracts.md) — Studio package-family projections, validation envelope, capability manifest (`@honua/sdk-js/studio`)
- [`docs/features/README.md`](./docs/features/README.md) — capability snapshot
- [`INSTALL.md`](./INSTALL.md) — install + subpath entrypoint table

## AI assistants

Coding agents (Claude Code, Cursor, and compatible assistants) can discover and
correctly use this SDK:

- **[`llms.txt`](./llms.txt)** — a curated [llms.txt](https://llmstxt.org/) index
  of the docs, plus **[`llms-full.txt`](./llms-full.txt)** with the full corpus
  concatenated for single-fetch ingestion. Both are generated from `docs/` +
  `README.md` + entrypoint JSDoc by `npm run docs:llms` (freshness-checked in CI
  via `npm run verify:llms`).
- **Agent skills** under [`skills/`](./skills/README.md) — `honua-sdk-quickstart`,
  `honua-arcgis-migration`, and `honua-mcp-setup` load procedural instructions
  into Claude Code and compatible agents. See [`skills/README.md`](./skills/README.md)
  for installation.
- **MCP server** — [`@honua/mcp-server`](./mcp/README.md) exposes Honua discovery
  and query tools to assistants over the Model Context Protocol.
- **Context7** — [`context7.json`](./context7.json) registers the library so
  [Context7](https://context7.com) serves current docs to coding agents; the
  submission steps are in [`skills/README.md`](./skills/README.md).

## Stability and versioning

- The SDK follows [Semantic Versioning](https://semver.org/). The public contract is the set
  of symbols reachable from the documented subpath entrypoints in [`INSTALL.md`](./INSTALL.md).
- Symbols marked `@experimental` in JSDoc may change in any minor release. The full table of
  stable and experimental subpaths lives in [`INSTALL.md`](./INSTALL.md). The short version:
  - **Stable** (semver-protected): `@honua/sdk-js`, `@honua/sdk-js/honua`,
    `@honua/sdk-js/contract`, `@honua/sdk-js/esri-compat`, `@honua/sdk-js/migration`,
    `@honua/sdk-js/runtime`, `@honua/sdk-js/expr`, `@honua/sdk-js/webmap`,
    `@honua/sdk-js/geocoding`, `@honua/sdk-js/exploration`, `@honua/sdk-js/interactions`,
    `@honua/sdk-js/filter-registry`, `@honua/sdk-js/style`, `@honua/sdk-js/map`.
  - **Experimental** (subpath-only — not re-exported from the root barrels):
    `/app`, `/app-controller`, `/app-workspace`, `/scene-workspace`, `/collaboration`,
    `/control-plane`, `/controls`, `/generated-app`, `/studio`, `/agent-tools`, `/realtime`,
    `/web-components`, `/react`, `/operator`, `/operator/*`.

## More guides

Long-form reference material now lives in [`docs/guide.md`](./docs/guide.md):

- Demo apps in depth (each example's env contract, browser hooks, run lanes)
- Server compatibility baseline + `checkCompatibility()` contract
- Subpath entrypoints and the `@experimental` tier
- Protocol cookbooks — OGC Features / Tiles / Maps / Processes / STAC, WMS / WMTS, WFS 2.0, OData v4
- Mixed Esri + OGC composition, streaming pagination, event lifecycle
- MapLibre `MapPackage` runtime + Generated App preview runtime
- Request/Auth bridge (interceptors, ArcGIS token + esri-request interop)
- `honua-migrate` CLI, admin scanner, parity matrix, sample-corpus harness

Protocol-specific deep dives also live alongside the guide: see
[`docs/wfs.md`](./docs/wfs.md), [`docs/ogc-api.md`](./docs/ogc-api.md),
[`docs/maplibre-runtime.md`](./docs/maplibre-runtime.md),
[`docs/webmap-json-compatibility.md`](./docs/webmap-json-compatibility.md),
[`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md), and
[`docs/migration-punch-list.md`](./docs/migration-punch-list.md).

## Contributing

This SDK ships from a single repository. The shipping package is `@honua/sdk-js`;
all subpath entrypoints in [`INSTALL.md`](./INSTALL.md) live under that name.
See [`AGENTS.md`](./AGENTS.md) for contributor instructions and the Specifica
issue format used for backlog items.

## License

[Apache 2.0](./LICENSE)
