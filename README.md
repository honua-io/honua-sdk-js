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

> **When to reach for `@honua/sdk-js`.** Pick this SDK when you need *one* typed client across
> the GeoServices / OGC / WFS / WMS / STAC / OData stack, an ArcGIS migration path you can run
> file-by-file, or a MapLibre runtime that loads a server-authored `MapPackage`. Pick
> `esri-leaflet` / `arcgis-rest-js` when you only ever talk to GeoServices; pick
> `openlayers` / `maplibre-gl` directly when you're not migrating from ArcGIS and don't need a
> shared cross-protocol contract.

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

The canonical surface is protocol-neutral: build a `Dataset` over one or more
`Source`s, then call `queryAll()` (or `query()` / `stream()`). The same code
works against GeoServices, OGC API Features, WFS, OData, and STAC.

```ts
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });

const dataset = createDataset({
  id: "parcels",
  client,
  sources: [
    {
      id: "parcels-fs",
      protocol: "geoservices-feature-service",
      locator: { url: "https://your-honua-server.example", serviceId: "parcels", layerId: 0 },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    },
  ],
});

const parcels = dataset.source("parcels-fs")!;
const result = await parcels.queryAll({
  where: "STATUS = 'ACTIVE'",
  outFields: ["OBJECTID", "NAME"],
  returnGeometry: true,
  pagination: { limit: 500 },
});

console.log(`Loaded ${result.features.length} features`);
```

Prefer the raw GeoServices shape (e.g. for an ArcGIS migration)? `HonuaClient`
still ships the protocol-specific call as a typed escape hatch:

```ts
const { features } = await client.queryFeatures({
  serviceId: "natural-earth",
  layerId: 0,
  where: "1=1",
  outFields: ["*"],
  returnGeometry: true,
  resultRecordCount: 25,
});
```

For production code, gate on `client.checkCompatibility()` so the SDK fails loudly
when the server is older than the SDK's tested floor:

```ts
const { supported, reasons } = await client.checkCompatibility();
if (!supported) throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
```

Want to run a complete app locally? Clone this repo and:

```bash
npm install
npm run demo:quickstart:mock   # serves examples/maplibre-quickstart against a deterministic fixture
```

The `demo:quickstart:mock` script prints `quickstartMockUrl=http://127.0.0.1:PORT`; open that URL
to see the same code rendering live on MapLibre.

See [`docs/quickstart.md`](./docs/quickstart.md) for the guided walkthrough,
[`docs/quickstart-troubleshooting.md`](./docs/quickstart-troubleshooting.md) for common failure
modes, and [`examples/maplibre-quickstart/`](./examples/maplibre-quickstart/README.md) for the
committed source.

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
