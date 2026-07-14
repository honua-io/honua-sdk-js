# Honua JS SDK

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/honua-io/honua-sdk-js/badge)](https://scorecard.dev/viewer/?uri=github.com/honua-io/honua-sdk-js)

[![npm](https://img.shields.io/npm/v/@honua/sdk-js?color=2b6cb0&label=%40honua%2Fsdk-js)](https://www.npmjs.com/package/@honua/sdk-js)
[![types](https://img.shields.io/npm/types/@honua/sdk-js?color=3178c6)](https://www.npmjs.com/package/@honua/sdk-js)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@honua/sdk-js?color=43853d)](./package.json)
[![docs](https://img.shields.io/badge/docs-honua--io.github.io-2b6cb0)](https://honua-io.github.io/honua-sdk-js/)

> **MapLibre gives you the map. Honua gives you everything else.**

`@honua/sdk-js` is the integration layer for the open map stack: typed clients for the
protocols your data already speaks (Esri GeoServices, OGC API Features / Tiles / Maps /
Processes, STAC, WMS, WMTS, WFS 2.0, OData v4), a one-call data→map bridge and MapLibre
runtime, provider-pluggable geocoding and routing, and a drop-in ArcGIS compatibility
layer with a codemod — everything around the renderer, so MapLibre (2D) and Cesium (3D)
can do what they do best.

**Leaving ArcGIS?** Every classic Esri widget was deprecated at ArcGIS JS SDK 5.0 and is
removed at 6.0 — planned for **Q1 2027**. If your app constructs one, that code stops
compiling and running when you take the 6.0 upgrade. Run
`npm run scan:arcgis:widgets -- ./src` for a per-file readiness report, then read the
[widget-removal survival guide](./docs/widget-survival-guide.md) — every deprecated
widget mapped to its Honua/MapLibre disposition.

## A public endpoint to a styled map

Nine application lines. No Honua server, no API key, no account — a public Esri Living
Atlas FeatureServer becomes a styled, interactive MapLibre map:

```ts doc-test=compile
import { connect } from "@honua/sdk-js";
import { mountSource } from "@honua/sdk-js/map";
import maplibregl from "maplibre-gl";

const endpoint = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
const map = new maplibregl.Map({ container: "map", style: "https://demotiles.maplibre.org/style.json", center: [-98, 39], zoom: 3 });
await map.once("load");
const data = await connect({ endpoint, protocol: "auto", authorizationScopeFingerprint: "public" });
await mountSource(map, data.source(), {
  popup: { factory: () => new maplibregl.Popup(), fields: ["NAME", "Seats_2020"] },
  hover: true,
  fitBounds: true,
});
```

For those nine lines the bridge selected a materialization strategy from the source's
declared capabilities, installed geometry-appropriate default styling, wired click popups
and hover feature-state, fit the map to the data, and returned one owned handle
(`setFilter()` diff-updates in place; `dispose()` removes everything the bridge added).
Run it locally with `npm run demo:endpoint-to-map`
([`examples/endpoint-to-map/`](./examples/endpoint-to-map/README.md)); the full cookbook
is [`docs/data-to-map-bridge.md`](./docs/data-to-map-bridge.md).

<!-- support-manifest:release:start -->
**Release status: beta** (`0.1.0-beta.0`). The 22-entrypoint stable tier is frozen and guarded
by an API-surface gate; 8 experimental subpaths may change before 1.0, and
18 deprecated compatibility subpaths have explicit removal versions. See
[`config/support-manifest.v1.json`](./config/support-manifest.v1.json) for the versioned support truth,
[`config/public-surface.json`](./config/public-surface.json) for its generated package projection,
[`support/projections/sdk-support.v1.json`](./support/projections/sdk-support.v1.json) for the generic
site/sample consumer contract, and
[the scope decision](./docs/decisions/scope-split-and-1.0.md).
<!-- support-manifest:release:end -->

📚 **Hosted docs:** [honua-io.github.io/honua-sdk-js](https://honua-io.github.io/honua-sdk-js/) —
quickstart, the full guide corpus, the [TypeDoc API reference](https://honua-io.github.io/honua-sdk-js/api/),
and the [demo gallery](https://honua-io.github.io/honua-sdk-js/gallery.html).

## Pick your path

| | 🗺️ **Building on MapLibre** | 🚦 **Leaving ArcGIS** |
| --- | --- | --- |
| **You are…** | adding typed data access, styling, and interactions to a MapLibre (or brand-new) app | facing the classic-widget removal at ArcGIS JS 6.0 (planned Q1 2027) |
| **Start** | [Standalone quickstart](./docs/standalone-quickstart.md) — the SDK against any public endpoint, no Honua server | `npm run scan:arcgis:widgets -- ./src` — per-file 6.0 readiness report from the migration scanner |
| **Then** | [Data-to-map bridge cookbook](./docs/data-to-map-bridge.md) — `connect()` → `mountSource()` strategies, styling, filters | [Widget survival guide](./docs/widget-survival-guide.md) — all 38 deprecated widgets mapped to automated / assisted / manual dispositions |
| **Go deeper** | [MapLibre runtime](./docs/maplibre-runtime.md) · [React bindings](./docs/react.md) · [geometry ops](./docs/geometry.md) · [geocoding & routing providers](./docs/geocoding-routing-providers.md) | [`esri-compat`](./docs/migration-honua-maplibre.md) drop-ins + the `honua-migrate` codemod · [migration punch list](./docs/migration-punch-list.md) |
| **Runnable proof** | [`examples/endpoint-to-map/`](./examples/endpoint-to-map/README.md) — the headline above, live | [`migration-workbench`](./docs/migration-honua-maplibre.md) (`npm run demo:migration-workbench`) — scan → codemod → run, end to end |

## Where it fits

The rendering war is settled — MapLibre is the open 2D engine of record and Cesium owns
open 3D. What the open stack has been missing is the layer *above* the renderer: service
clients, styling, interactions, editing, geocoding, migration tooling — the glue every
team hand-rolls. That integration layer is what `@honua/sdk-js` owns:

- **Protocol-neutral data access.** One `Source.query(...)` call works against
  GeoServices, OGC, WFS, OData and friends. Capability misses throw
  `HonuaCapabilityNotSupportedError` instead of returning empty results.
- **Data to map in one call.** `connect()` + `mountSource()` turn a bare endpoint into a
  styled, interactive MapLibre layer; `loadMapPackage(...)` + `HonuaMapRuntime` render
  server-authored `MapPackage`s. Cesium, kepler.gl, and OGC web-map sources are first-class.
- **TypeScript first.** `strict` + `verbatimModuleSyntax`, exported types for every public
  symbol, declaration maps, and JSDoc on the public client surface.
- **Migrate, don't rewrite.** `FeatureLayerCompat`, `MapImageLayerCompat`, `MapViewCompat`,
  `SceneViewCompat`, `WebMapCompat`, and a safe codemod (`honua-migrate`) keep existing ArcGIS
  code running while you cut over.
- **No provider lock-in for the extras.** Geocoding and routing are provider-pluggable
  interfaces with open-source adapters, not a facade for one vendor's API
  ([`docs/geocoding-routing-providers.md`](./docs/geocoding-routing-providers.md)).

The honest comparisons are the service-client libraries, not the renderers:

- vs **`@esri/arcgis-rest-js`** — that's Esri's own client for Esri services only. Honua speaks
  GeoServices *plus* OGC API / WFS / WMS / WMTS / STAC / OData under one typed contract, with a
  capability model that throws instead of returning silently-empty results.
- vs **`esri-leaflet`** — dormant (no release since September 2025) and Leaflet-bound. Honua's
  esri-compat + `honua-migrate` codemod is an actively maintained migration path that targets
  MapLibre.
- vs **`openlayers` / `maplibre-gl` directly** — pick those when you need a renderer and are
  happy hand-rolling service calls; pick Honua *on top of* MapLibre when you want the typed
  client, the ArcGIS migration path, or the server-authored `MapPackage` runtime.

The numbers behind those claims — generated bundle sizes, a protocol-coverage matrix against
raw MapLibre / `@esri/arcgis-rest-js` / OpenLayers, and a scripted time-to-first-map benchmark
with a runnable repro (`npm run bench:ttfm`) — live in
[`docs/comparison.md`](./docs/comparison.md).

<!-- support-manifest:standalone:start -->
**Honua Server is optional for standards clients.** Supported GeoServices, OGC API
Features, WFS 2.0, STAC, and OData claims work against raw standards-speaking endpoints.
OGC API Tiles (`beta`), Maps (`beta`), and Records
(`beta`) also discover and use raw advertised paths. OGC API Processes
keeps two honest lanes: raw discovery is `experimental`, while typed execution
is `facade-required`.

A [Honua Server](https://github.com/honua-io/honua-server) adds server-authored
`MapPackage`s, realtime, collaboration, MCP/AI execution, compatibility metadata, and
the facade-required execution paths. See the generated
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md) for every
claim, execution mode, and evidence link.
<!-- support-manifest:standalone:end -->

## What Honua does not do

In the spirit of the [migration punch list](./docs/migration-punch-list.md), the
non-goals are explicit rather than implied:

- **It is not a rendering engine, on purpose.** 2D rendering rides
  [MapLibre GL JS](https://maplibre.org/) and 3D rides [CesiumJS](https://cesium.com/platform/cesiumjs/);
  Honua does not fork, wrap-and-hide, or compete with either. If you need renderer
  features (custom shaders, globe projections, visual effects), take them from the
  renderer directly — Honua stays out of the way.
- **No 3D parity with ArcGIS SceneView.** Esri's 3D moat is real and we say so. Honua's
  `SceneViewCompat` covers 2D-safe behavior only, and 3D-only widgets (e.g. `Daylight`)
  are honestly marked `no-equivalent` in the
  [widget survival guide](./docs/widget-survival-guide.md). For SceneView-class 3D, use
  [CesiumJS](https://cesium.com/platform/cesiumjs/) or stay on the
  [ArcGIS Maps SDK](https://developers.arcgis.com/javascript/latest/) for that part of
  your app.
- **Offline is experimental.** The `/offline` subpath is a replica-sync specification
  without a production storage engine; it is excluded from the 1.0 narrative until a real
  engine ships.

## Install

```bash
npm install @honua/sdk-js
```

Everything documented here ships in `@honua/sdk-js` as subpath entrypoints
(see [`INSTALL.md`](./INSTALL.md)). Focused standalone packages are also
published from this repository for consumers who only want a subset:

| Package | What it is |
|---------|------------|
| [`@honua/sdk-js`](https://www.npmjs.com/package/@honua/sdk-js) | **The canonical install** — full SDK with all subpath entrypoints + the `honua` CLI |
| [`@honua/mcp-server`](https://www.npmjs.com/package/@honua/mcp-server) | Platform-free geospatial MCP server (`honua-mcp`, `honua-mcp-proxy`) — see [`mcp/`](./mcp/README.md) |
| [`@honua/react`](https://www.npmjs.com/package/@honua/react) | React provider, hooks, and map components ([`docs/react.md`](./docs/react.md)) |
| [`@honua/geometry`](https://www.npmjs.com/package/@honua/geometry) | Curated turf/proj4 geometry ops + reprojection ([`docs/geometry.md`](./docs/geometry.md)) |
| [`@honua/sdk`](https://www.npmjs.com/package/@honua/sdk) | Core client + contract only (split build) |
| [`@honua/sdk-esri-compat`](https://www.npmjs.com/package/@honua/sdk-esri-compat) | ArcGIS JS compatibility layer (split build) |
| [`@honua/honua-migrate`](https://www.npmjs.com/package/@honua/honua-migrate) | Migration codemod + scanner (split build) |
| [`@honua/app-platform`](https://www.npmjs.com/package/@honua/app-platform) | Application-platform surfaces extracted from the SDK (own pre-1.0 cadence) |

The split builds exist for packaging workflows and subset consumers; details in
[`docs/split-packages.md`](./docs/split-packages.md).

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
| `@honua/sdk-js/style` | 8.4 KiB |
| `@honua/sdk-js/map` | 31.2 KiB |
| `@honua/sdk-js` (root) | 94.9 KiB |
| `{ HonuaClient }` only (tree-shake guard) | 48.6 KiB |

Full per-entrypoint table (min + gzip, generated, not hand-written):
[`docs/bundle-sizes.md`](./docs/bundle-sizes.md). Refresh it with
`npm run report:bundle-sizes`. For how these sizes stack up against
`@arcgis/core` and friends, see the generated
[comparison page](./docs/comparison.md).

## 60-second quickstart

**No Honua server required.** The first block below runs against a *public* Esri
GeoServices endpoint — no API key, no account, no infrastructure. The canonical
surface is protocol-neutral: build a `Dataset` over one or more `Source`s, then
call `queryAll()` (or `query()` / `stream()`).

```ts doc-test=compile
import { createDataset, HonuaClient, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js";

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

```ts doc-test=skip reason="partial excerpt requires application host context"
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

A [Honua Server](https://github.com/honua-io/honua-server) unlocks
server-authored `MapPackage`s (`loadMapPackage()`), realtime subscriptions,
collaboration / saved maps, and the MCP + AI surfaces. Point the same code at a
local server (`docker compose up` in a honua-server checkout), and gate
production reads on the compatibility check:

```ts doc-test=skip reason="partial excerpt requires application host context"
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

For support-safe interoperability evidence, `honua doctor` emits a local,
schema-validated diagnostic bundle with explicit classification/consent,
credential and PII redaction, bounded previews, and original-byte SHA-256
metadata. `honua doctor --replay` permits only one bounded, abortable
`GET`/`HEAD` and fails closed before network access for mutations,
subscriptions, unsafe paths, credentials, malformed schemas, or hash drift. It
never uploads. See [`docs/diagnostic-bundles.md`](./docs/diagnostic-bundles.md).

## What you can build

<!-- sample-catalog:start -->
The versioned [SDK sample catalog](./docs/generated/sample-catalog.md) tracks all 34 executable examples: 0 qualified golden samples, 15 recipes, 17 labs, and 2 fixtures. Seven journey IDs are reserved; 7 remain explicitly planned candidates. The catalog is the source of truth for track, support, lifecycle, fixture/live evidence, quality profiles, and the honua.io projection.
<!-- sample-catalog:end -->

Linking to Honua from a plugin directory or ecosystem list? Point at the
[server-optional standalone quickstart](./docs/standalone-quickstart.md)
([hosted walkthrough](https://honua-io.github.io/honua-sdk-js/guides/standalone-quickstart.html),
[source](./examples/standalone-quickstart/README.md)) — CI keeps it green with a Playwright
browser smoke on every PR. Prepared directory entries live in
[`docs/listings/maplibre-plugin-directory.md`](./docs/listings/maplibre-plugin-directory.md).

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

- [`docs/generated/learning-paths.md`](./docs/generated/learning-paths.md) — task-oriented progression backed by runnable examples and checked SDK imports
- [`docs/quickstart.md`](./docs/quickstart.md) — guided quickstart walkthrough
- [`docs/guide.md`](./docs/guide.md) — long-form reference (server compatibility, subpath
  entrypoints, OGC / WFS / OData cookbooks, MapLibre runtime, migration CLI, request/auth bridge)
- [`docs/errors.md`](./docs/errors.md) — error class reference + retry policy
- [`docs/shared-client-contract.md`](./docs/shared-client-contract.md) — `Dataset` / `Source` / `Query` / `Result` design
- [`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md) — what each protocol supports
- [`docs/sdk-surface-alignment.md`](./docs/sdk-surface-alignment.md) — cross-language naming & semver policy
- [`docs/maplibre-runtime.md`](./docs/maplibre-runtime.md) — `loadMapPackage()` / `HonuaMapRuntime`
- [`docs/data-to-map-bridge.md`](./docs/data-to-map-bridge.md) — `connect()` → `mountSource()` standalone bridge cookbook
- [`docs/react.md`](./docs/react.md) — React bindings (`@honua/react`): provider, hooks, and map components
- [`docs/geometry.md`](./docs/geometry.md) — `@honua/sdk-js/geometry` curated turf/proj4 ops (buffer/area/measure/simplify/reproject) + the `geometryEngine` compat shim
- [`docs/geocoding-routing-providers.md`](./docs/geocoding-routing-providers.md) — provider-pluggable geocoding & routing adapters
- [`docs/studio-package-contracts.md`](./docs/studio-package-contracts.md) — Studio package-family projections, validation envelope, capability manifest (`@honua/app-platform/studio`)
- [`docs/features/README.md`](./docs/features/README.md) — capability snapshot
- [`docs/docs-samples-ownership.md`](./docs/docs-samples-ownership.md) — SDK/site ownership boundary for versioned docs and executable samples
- [`docs/documentation-snippets.md`](./docs/documentation-snippets.md) — supported code-fence validation and explicit pseudocode directives
- [`INSTALL.md`](./INSTALL.md) — install + subpath entrypoint table

Platform-wide documentation (server concepts, deployment, Esri migration) lives
at [honua.gitbook.io/honuaio](https://honua.gitbook.io/honuaio/).

Run `npm run docs:learning:verify` from a fresh checkout to build the SDK and
validate learning-path metadata, internal links, generated Markdown, and runtime
imports. CI reuses its existing build with the internal
`npm run docs:learning:check` command, then separately compiles every selected
example through `npm run docs:learning:typecheck`.
Run `npm run docs:snippets:verify` to build the public declarations and validate
all supported JavaScript and TypeScript documentation fences.

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
- **MCP server** — [`@honua/mcp-server`](./mcp/README.md) is the **platform-free**
  geospatial MCP server: point `honua-mcp` at **any** public ArcGIS FeatureServer
  or OGC API endpoint (no Honua server required) and it exposes discovery, query,
  and analysis tools to assistants over the Model Context Protocol. Tools that need
  a Honua-only surface degrade gracefully with a structured "not available on this
  target" result. A Honua deployment's richer `/mcp` catalog is the upgrade path
  via `honua-mcp-proxy`.
- **NL map control** — [`@honua/sdk-js/nl-map-control`](./docs/nl-map-control.md)
  compiles natural-language instructions into serializable, inspectable plans
  (query-planner IR plus agent-tool invocations) through a **caller-provided LLM
  callback** — no model-vendor SDK. Execution accepts plans only: read-only
  plans may auto-execute under policy, anything mutating or viewport-changing
  requires a signed agent-safety approval envelope, and every execution emits a
  receipt. The same tool surface is published in MCP and OpenAI function
  formats.
- **Context7** — [`context7.json`](./context7.json) registers the library so
  [Context7](https://context7.com) serves current docs to coding agents; the
  submission steps are in [`skills/README.md`](./skills/README.md).
- **Coding-agent evals** — a scheduled harness measures whether coding agents
  can use the SDK correctly on the first try: a 16-task golden-workflow corpus
  scored objectively (typecheck + runtime against deterministic fixtures +
  expected-output assertions). Methodology in
  [`docs/coding-agent-evals.md`](./docs/coding-agent-evals.md); latest results
  in [`docs/generated/coding-agent-scorecard.md`](./docs/generated/coding-agent-scorecard.md).

## Stability and versioning

- The package root is intentionally the small, reviewed
  `connect → query → explain → mount` workflow. Protocol-specific clients,
  renderers, app state, styling, migration, realtime, offline, and analytics
  APIs remain supported from focused subpaths; no advanced API was deleted. The
  exact root inventory and every former-root replacement are published in
  [`config/root-surface.json`](./config/root-surface.json) and the generated
  [`root import migration table`](./docs/root-surface-migration.md).
- Hosted guides and API pages display their exact release and expose validated
  current/archived navigation. See
  [documentation versions and compatibility](./docs/documentation-versions.md);
  the selector is generated from package, release-manifest, and changelog data.
- The SDK follows [Semantic Versioning](https://semver.org/). The public contract is the set
  of symbols reachable from the documented subpath entrypoints in [`INSTALL.md`](./INSTALL.md).
- Symbols marked `@experimental` in JSDoc may change in any minor release. The full table of
  stable and experimental subpaths lives in [`INSTALL.md`](./INSTALL.md). The short version:
  - **Stable** (semver-protected): `@honua/sdk-js`, `@honua/sdk-js/browser`,
    `@honua/sdk-js/honua`, `@honua/sdk-js/auth`, `@honua/sdk-js/contract`,
    `@honua/sdk-js/esri-compat`, `@honua/sdk-js/migration`,
    `@honua/sdk-js/runtime`, `@honua/sdk-js/expr`, `@honua/sdk-js/webmap`,
    `@honua/sdk-js/geocoding`, `@honua/sdk-js/exploration`, `@honua/sdk-js/interactions`,
    `@honua/sdk-js/filter-registry`, `@honua/sdk-js/style`, `@honua/sdk-js/map`,
    `@honua/sdk-js/realtime`, `@honua/sdk-js/react`, `@honua/sdk-js/geometry`,
    `@honua/sdk-js/cli`, `@honua/sdk-js/agent-tools`, `@honua/sdk-js/agent-safety`.
    The agent surface's security posture is documented in the
    [agent-safety threat model](./docs/agent-safety-threat-model.md).
  - **Experimental subpath-only APIs** (not re-exported from the root barrels):
    `/nl-map-control`, `/geoparquet`, `/plugin`, `/deckgl`, `/offline`,
    `/diagnostics`, `/routing` — with `/query-planner` below, 8 experimental subpaths in total.
  - The complete `/query-planner` subpath remains **experimental**. The stable root promotes a
    reviewed query-planner subset: `explainQuery`, `executeQueryPlan`, `hashQueryPlan`, the plan
    errors/version constants, and the types required to name the common explain/mount workflow.
  - **Application-platform surfaces** (`/app`, `/app-controller`, `/app-workspace`,
    `/scene-workspace`, `/collaboration`, `/control-plane`, `/replica-sync`, `/share`,
    `/operate`, `/generated-app`, `/studio`, `/controls`, `/web-components`, `/operator`,
    `/operator/*`) have **moved to the separate `@honua/app-platform` package**; the old
    18 deprecated compatibility subpaths remain through `0.1.x` and are removed in
    `0.2.0`. The `/console` entrypoint was removed outright (no shim).

## Support and lifecycle

We publish a lifecycle because a library you build on should tell you what it promises.
`esri-leaflet` never did, and "will this break under me?" is the question that decides adoption.

- **Today (pre-1.0, `0.x`).** The **stable tier** — the subpath entrypoints listed under
  "Stable subpath entrypoints" in [`INSTALL.md`](./INSTALL.md) — is where we invest
  compatibility effort, and it is guarded in CI by a public-API report
  (`npm run verify:api-report`): no symbol leaves or changes shape by accident. While we are
  on `0.x` a minor _may_ still change a stable symbol, but only as a reviewed, called-out
  change — never silently. Symbols marked `@experimental` in JSDoc may change in any minor.
- **At 1.0.** The stable tier freezes under [Semantic Versioning](https://semver.org/):
  breaking or removing a stable symbol requires a major version; minors are additive. Major
  versions are coordinated across the Honua SDK family (JavaScript, Python, .NET) so one semver
  line describes the contract on every platform.
- **Application-platform surfaces move separately.** App-shell, builder, and hosted-product
  entrypoints are being extracted to a separate `@honua/app-platform` package that versions at
  its own pre-1.0 cadence, so the client SDK can reach a frozen 1.0 without waiting on them.
  Their old `@honua/sdk-js/*` subpaths remain as `@deprecated` re-export shims through
  `0.1.x` and are removed in `0.2.0`. See
  [`docs/decisions/scope-split-and-1.0.md`](./docs/decisions/scope-split-and-1.0.md).
- **What we don't promise.** No security-backport window or LTS branch pre-1.0; fixes land on
  the current line. We will publish that policy when we cut 1.0.

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
[`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md),
[`docs/migration-punch-list.md`](./docs/migration-punch-list.md), and
[`docs/widget-survival-guide.md`](./docs/widget-survival-guide.md) (every ArcGIS widget
deprecated at 5.0 mapped to its Honua/MapLibre disposition ahead of the 6.0 removal — run
`npm run scan:arcgis:widgets -- ./src` for a per-file readiness report).

## Related Honua repositories

| Repo | What it is |
|------|------------|
| [honua-server](https://github.com/honua-io/honua-server) | Flagship multi-protocol geospatial server (ELv2 open core) |
| [honua-console](https://github.com/honua-io/honua-console) | Unified web console — Studio, Catalog, Operate, Share |
| [honua-sdk-python](https://github.com/honua-io/honua-sdk-python) | Python SDK (same `Dataset`/`Source`/`Query`/`Result` contract) |
| [honua-sdk-dotnet](https://github.com/honua-io/honua-sdk-dotnet) | .NET SDKs (same contract) |
| [honua-esri-assess](https://github.com/honua-io/honua-esri-assess) | Esri footprint assessment CLI for migration discovery |
| [geospatial-mcp](https://github.com/honua-io/geospatial-mcp) | Open, vendor-neutral geospatial MCP standard |

## Contributing

This SDK ships from a single repository: the canonical package is
`@honua/sdk-js` (all subpath entrypoints in [`INSTALL.md`](./INSTALL.md) live
under that name), with the standalone packages in the table above built from
the same source tree. The MCP server lives in [`mcp/`](./mcp/README.md).
See [`AGENTS.md`](./AGENTS.md) for contributor instructions and the Specifica
issue format used for backlog items.

## Security

Report vulnerabilities to [security@honua.io](mailto:security@honua.io) — see the
[org security policy](https://github.com/honua-io/.github/blob/main/SECURITY.md).
Please do not open public issues for security reports.

## License

[Apache 2.0](./LICENSE)
