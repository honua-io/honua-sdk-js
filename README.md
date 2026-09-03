# Honua JS SDK

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/honua-io/honua-sdk-js/badge)](https://scorecard.dev/viewer/?uri=github.com/honua-io/honua-sdk-js)

[![npm](https://img.shields.io/npm/v/@honua/sdk-js?color=2b6cb0&label=%40honua%2Fsdk-js)](https://www.npmjs.com/package/@honua/sdk-js)
[![types](https://img.shields.io/npm/types/@honua/sdk-js?color=3178c6)](https://www.npmjs.com/package/@honua/sdk-js)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@honua/sdk-js?color=43853d)](./package.json)
[![docs](https://img.shields.io/badge/docs-honua--io.github.io-2b6cb0)](https://honua-io.github.io/honua-sdk-js/)

> **MapLibre renders the map. Honua connects, queries, explains, and mounts the data.**

`@honua/sdk-js` is the integration layer for the open map stack: typed clients for the
protocols your data already speaks (Esri GeoServices, OGC API Features / Tiles / Maps /
Processes, STAC, WMS, WMTS, WFS 2.0, OData v4), a one-call data→map bridge and MapLibre
runtime, provider-pluggable geocoding and routing, and a drop-in ArcGIS compatibility
layer with a codemod. MapLibre is the stable renderer path; the optional Cesium scene
surface is beta on `@honua/app-platform`, and Kepler.gl integration is experimental.

**Leaving ArcGIS?** Every classic Esri widget was deprecated at ArcGIS JS SDK 5.0 and
removal begins with 6.0 — **as early as Q1 2027**. If your app constructs one, that code stops
compiling and running when you take the 6.0 upgrade. Run
`npm run scan:arcgis:widgets -- ./src` for a per-file readiness report, then read the
[widget-removal survival guide](./docs/widget-survival-guide.md) — every deprecated
widget mapped to its Honua/MapLibre disposition.

## A public endpoint to a styled map

Ten application lines. No Honua server, no API key, no account — one lifecycle owner takes a
public Esri Living Atlas FeatureServer through inspection, a bounded query, an explainable plan,
and a styled MapLibre map:

```ts doc-test=compile
import { createHonua } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";
const endpoint = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0";
await using honua = createHonua();
const data = await honua.connect(endpoint);
const info = await data.inspect();
const plan = await data.explain({ returnGeometry: true, pagination: { limit: 100 } }, { sourceId: info.defaultSourceId });
const result = await data.query(plan);
const map = await data.mount("#map", { renderer: maplibreRenderer(maplibregl), query: plan, sourceId: info.defaultSourceId });
await map.ready;
```

For those ten lines the kernel owns discovery, the connection, cancellation, and the mounted
map. `result` contains bounded execution evidence, while `plan` explains the accepted query.
Leaving the `await using` scope disposes the map and connection; every operation also accepts
an `AbortSignal` for caller cancellation.
Run the canonical inspected workflow with `npm run demo:quickstart:mock`
([`examples/maplibre-quickstart/`](./examples/maplibre-quickstart/README.md)); the focused lower-level cookbook
is [`docs/data-to-map-bridge.md`](./docs/data-to-map-bridge.md).

For an application that opens more than one source, keep the same instance-scoped owner:

```ts doc-test=compile
import { createHonua } from "@honua/sdk-js";

const honua = createHonua({ discoveryCacheMaxEntries: 128 });
try {
  const data = await honua.connect(
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0",
  );
  const inspection = await data.inspect();
  const source = data.source<{ NAME: string; Seats_2020: number }>();

  console.log(inspection.cacheStatus, source.descriptor.id);
} finally {
  await honua.dispose();
}
```

`inspect()` reuses the immutable snapshot established by `connect()`;
`inspect({ refresh: true, signal })` revalidates it. Service roots with more
than one source require an explicit `sourceId` in the locator/options or in
`source(id)`—the kernel never chooses the first advertised source silently.

<!-- support-manifest:release:start -->
**Release status: beta** (`0.1.10-beta.0`). The 22-entrypoint stable tier is guarded <!-- x-release-please-version -->
by an API-surface gate; 26 experimental subpaths may change before 1.0, and
18 deprecated compatibility subpaths have explicit removal versions. See
[`config/support-manifest.v1.json`](./config/support-manifest.v1.json) for the versioned support truth,
[`config/public-surface.json`](./config/public-surface.json) for its generated package projection,
[`support/projections/sdk-support.v1.json`](./support/projections/sdk-support.v1.json) for the generic
site/sample consumer contract, and
[the scope decision](./docs/decisions/scope-split-and-1.0.md).

This README tracks the current development branch. The version above is its
package baseline, not a claim that every capability described here is already
present in the npm artifact with that version. For published behavior, use the
[tagged release documentation](./docs/documentation-versions.md).
<!-- support-manifest:release:end -->

📚 **Hosted docs:** [honua-io.github.io/honua-sdk-js](https://honua-io.github.io/honua-sdk-js/) —
quickstart, the full guide corpus, the [TypeDoc API reference](https://honua-io.github.io/honua-sdk-js/api/),
and the [demo gallery](https://honua-io.github.io/honua-sdk-js/gallery.html).

## Pick your path

| | 🗺️ **Building on MapLibre** | 🚦 **Leaving ArcGIS** | 🤖 **Connecting an AI assistant** |
| --- | --- | --- | --- |
| **You are…** | adding typed data access, styling, and interactions to a MapLibre (or brand-new) app | facing the classic-widget removal at ArcGIS JS 6.0 (as early as Q1 2027) | wiring a coding agent or assistant to live geospatial data |
| **Start** | [First Map](./docs/quickstart.md) — paste a public GeoServices or OGC Features endpoint, no account required | `npm run scan:arcgis:widgets -- ./src` — per-file 6.0 readiness report from the migration scanner | point [`honua-mcp`](./mcp/README.md) at any public FeatureServer/OGC endpoint — no Honua server |
| **Then** | [Data-to-map bridge cookbook](./docs/data-to-map-bridge.md) — `connect()` → `mountSource()` strategies, styling, filters | [Widget survival guide](./docs/widget-survival-guide.md) — all 38 deprecated widgets mapped to automated / assisted / manual dispositions | the [protocol-neutral tool contract](./mcp/README.md) + [agent skills](./skills/README.md) for Claude Code and compatible agents |
| **Go deeper** | [MapLibre runtime](./docs/maplibre-runtime.md) · [React bindings](./docs/react.md) · [geometry ops](./docs/geometry.md) · [geocoding & routing providers](./docs/geocoding-routing-providers.md) | [`esri-compat`](./docs/migration-honua-maplibre.md) drop-ins + the `honua-migrate` codemod · [migration punch list](./docs/migration-punch-list.md) | [NL map control](./docs/nl-map-control.md) · [agent-safety threat model](./docs/agent-safety-threat-model.md) · [coding-agent evals](./docs/coding-agent-evals.md) |
| **Runnable proof** | [`examples/maplibre-quickstart/`](./examples/maplibre-quickstart/README.md) — deterministic fixture plus separately gated anonymous-live evidence | [`migration-workbench`](./docs/migration-honua-maplibre.md) (`npm run demo:migration-workbench`) — scan → codemod → run, end to end | [cross-model MCP eval scorecard](./docs/generated/mcp-eval-scorecard.md) — dated runs, failures and the zero-LLM control included |

## Where it fits

The rendering war is settled — MapLibre is the open 2D engine of record and Cesium owns
open 3D. What the open stack has been missing is the layer *above* the renderer: service
clients, styling, interactions, editing, geocoding, migration tooling — the glue every
team hand-rolls. That integration layer is what `@honua/sdk-js` owns:

- **Protocol-neutral data access.** One `Source.query(...)` call works against
  GeoServices, OGC, WFS, OData and friends. Geoprocessing uses one `IJobRun`
  lifecycle across raw OGC API Processes and Esri-compatible GPServer tasks.
  Capability misses throw
  `HonuaCapabilityNotSupportedError` instead of returning empty results. Large
  results ride an experimental columnar data plane (GeoArrow batches, streaming
  backpressure, worker-side aggregation —
  [`docs/columnar-data-plane.md`](./docs/columnar-data-plane.md)).
- **Data to map in one call.** `connect()` + `mountSource()` turn a bare endpoint into a
  styled, interactive MapLibre layer; `loadMapPackage(...)` + `HonuaMapRuntime` render
  server-authored `MapPackage`s; `createTemporalPlayback` and the
  `<honua-time-slider>` control animate time-enabled sources. This is the stable renderer path. OGC web-map support
  follows the generated capability matrix; Cesium integration lives on the `beta`
  `@honua/app-platform/scene-workspace` path — see the
  [surface tiers table](./docs/standalone-capability-matrix.md#surface-tiers) for the
  exports it covers and the ones still experimental — and `@honua/sdk-js/kepler` is
  experimental.
- **TypeScript first.** `strict` + `verbatimModuleSyntax`, exported types for every public
  symbol, declaration maps, and JSDoc on the public client surface.
- **Migrate, don't rewrite.** `FeatureLayerCompat`, `MapImageLayerCompat`, `MapViewCompat`,
  `SceneViewCompat`, `WebMapCompat`, `LocatorCompat` (provider-pluggable geocoding, no
  server required), and a safe codemod (`honua-migrate`) keep existing ArcGIS
  code running while you cut over.
- **No provider lock-in for the extras.** Geocoding and routing are provider-pluggable
  interfaces with open-source adapters, not a facade for one vendor's API
  ([`docs/geocoding-routing-providers.md`](./docs/geocoding-routing-providers.md)).
  That candor is applied to Honua itself: every capability carries a generated
  `open-endpoint` or `server-attach` tier, and each server-attach capability names a
  roadmap issue for an open-endpoint path or why the dependency is inherent
  ([capability tiers](./docs/standalone-capability-matrix.md#capability-tiers)).

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

The numbers behind those claims — generated bundle sizes, a protocol-coverage matrix and an
operation-level behaviour table against raw MapLibre / `@esri/arcgis-rest-js` / OpenLayers, and
a scripted time-to-first-map benchmark with a runnable repro (`npm run bench:ttfm`) — live in
[`docs/comparison.md`](./docs/comparison.md). That page names the category boundary behind
every column (headless client vs renderer vs all-in-one SDK) and backs each external figure
with a dated, primary-sourced evidence record; a measurement of a superseded release line is
labelled historical and is barred, in code, from supporting a current claim.

<!-- support-manifest:standalone:start -->
**Two deployment tiers, named up front.** 28 of the 35 generated support
claims are `open-endpoint`: they run against standards-speaking endpoints you already
have, or entirely in the client and build — no Honua account, no Honua Server.
7 are `server-attach` and execute only after attaching to a Honua Server facade;
1 of those link a roadmap issue for an open-endpoint path and the rest state why the
server dependency is inherent, in the generated
[capability tiers table](./docs/standalone-capability-matrix.md#capability-tiers).

**Honua Server is optional for standards clients.** Supported GeoServices, OGC API
Features, WFS 2.0, WMS 1.3, WMTS 1.0, STAC, and OData claims work against raw standards-speaking endpoints.
OGC API Tiles (`beta`), Maps (`beta`), and Records
(`beta`) also discover and use raw advertised paths. OGC API Processes
keeps two honest lanes against a raw server:
discovery (`supported`, `standalone`) and
typed execution (`experimental`, `standalone`).

A [Honua Server](https://github.com/honua-io/honua-server) adds server-authored
`MapPackage`s, realtime, collaboration, compatibility metadata, a richer hosted
`/mcp` operator catalog, and the facade-required execution paths. See the generated
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md) for every
claim's tier, execution mode, and evidence link.
<!-- support-manifest:standalone:end -->

## What Honua does not do

In the spirit of the [migration punch list](./docs/migration-punch-list.md), the
non-goals are explicit rather than implied:

- **It is not a rendering engine, on purpose.** The stable 2D runtime rides
  [MapLibre GL JS](https://maplibre.org/); the optional `beta` 3D scene surface rides
  [CesiumJS](https://cesium.com/platform/cesiumjs/) as a lazily imported peer.
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
- **Offline is experimental.** The `/offline` subpath now ships a real browser
  engine — an IndexedDB region store, a durable edit queue with proven
  offline-capture / reload / replay, region tile and asset serving, and quota
  admission ([`docs/offline-regions.md`](./docs/offline-regions.md),
  [`docs/examples/offline-region-reference`](./docs/examples/offline-region-reference/README.md)) —
  but it is still an experimental subpath, hosted replica sync does not exist,
  and it stays outside the 1.0 narrative until both change.

## Install

```bash
npm install @honua/sdk-js
```

Runtime support, stated up front:

| Peer / runtime | Supported range |
|----------------|-----------------|
| Node.js | `>=20.19` |
| `maplibre-gl` (optional peer) | **5 and 6** (`^5.0.0 \|\| ^6.0.0`) — the 6.x half ships with the next release; the current published beta declares `^5.0.0`. MapLibre 6 is ESM-only and requires WebGL2 |
| `cesium` (optional peer, scene surface) | `^1.139.0` |
| `react` / `react-dom` (optional peer, `/react`) | `^18.2.0 \|\| ^19.0.0` |

Starting from scratch? `create-honua-app` scaffolds a working app instead of
assembling peers — a Vite + TypeScript (or React) starter that already connects
to an endpoint and mounts a source, pinned to a published SDK version and
rendering a committed fixture on the first `npm run dev`. The package is
published on npm, so `npm create honua-app` is the shortest supported path;
both starters also open in a browser playground with no install at all — see
[`docs/playgrounds.md`](./docs/playgrounds.md) and
[`docs/create-honua-app.md`](./docs/create-honua-app.md).

Everything documented here ships in `@honua/sdk-js` as subpath entrypoints
(see [`INSTALL.md`](./INSTALL.md)). Focused standalone packages are also
published from this repository for consumers who only want a subset:

| Package | What it is |
|---------|------------|
| [`@honua/sdk-js`](https://www.npmjs.com/package/@honua/sdk-js) | **The canonical install** — full SDK with all subpath entrypoints + the `honua` CLI |
| [`@honua/mcp-server`](https://www.npmjs.com/package/@honua/mcp-server) | Platform-free geospatial MCP server (`honua-mcp`, `honua-mcp-proxy`) — see [`mcp/`](./mcp/README.md) |
| [`@honua/react`](https://www.npmjs.com/package/@honua/react) | React provider, hooks, and map components (split build; [`docs/react.md`](./docs/react.md)) |
| [`@honua/geometry`](https://www.npmjs.com/package/@honua/geometry) | Curated turf/proj4 geometry ops + reprojection (split build; [`docs/geometry.md`](./docs/geometry.md)) |
| [`@honua/sdk`](https://www.npmjs.com/package/@honua/sdk) | Core client + contract only (split build) |
| [`@honua/sdk-esri-compat`](https://www.npmjs.com/package/@honua/sdk-esri-compat) | ArcGIS JS compatibility layer (split build) |
| [`@honua/honua-migrate`](https://www.npmjs.com/package/@honua/honua-migrate) | Migration codemod + scanner, owned by the [`honua-migrate`](https://github.com/honua-io/honua-migrate) repository |
| [`@honua/app-platform`](https://www.npmjs.com/package/@honua/app-platform) | Application-platform surfaces extracted from the SDK (split build; own pre-1.0 cadence) |

The SDK split builds exist for packaging workflows and subset consumers;
details in [`docs/split-packages.md`](./docs/split-packages.md). Existing
`@honua/sdk-js/migration` imports follow the
[migration-tool transition policy](./docs/migration-tool-transition.md).

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

Honest about size: every subpath entrypoint carries a min+gzip byte budget that
CI enforces on every PR (`npm run verify:bundle-budgets`), so drift fails the
build instead of shipping. Sizes are measured the way a consumer builds —
esbuild `--bundle --minify`, runtime peers external. The excerpt below is
generated from that measurement, tree-shake guards included:

<!-- bundle-sizes:readme:start -->
| Entrypoint (gzip) | Size |
| --- | ---: |
| `@honua/sdk-js/expr` | 2.4 KiB |
| `@honua/sdk-js/geocoding` | 7.9 KiB |
| `@honua/sdk-js/webmap` | 7.6 KiB |
| `@honua/sdk-js/style` | 16.2 KiB |
| `@honua/sdk-js/map` | 51.7 KiB |
| `@honua/sdk-js` (root) | 208.7 KiB |
| `{ HonuaClient }` from the root (tree-shake guard) | 67.7 KiB |
| `{ connect }` from the root (tree-shake guard) | 169.9 KiB |
| `{ createHonua }` from the root (tree-shake guard) | 198.8 KiB |

The root is the whole reviewed kernel and the guards price its verbs honestly: importing `{ connect }`
alone costs 169.9 KiB gzip and `{ createHonua }` 198.8 KiB against the 208.7 KiB root, so size-sensitive
apps should import the focused subpaths rather than the root. Full per-entrypoint
table (min + gzip, generated): [`docs/bundle-sizes.md`](./docs/bundle-sizes.md);
refresh the table and this excerpt together with `npm run report:bundle-sizes`.
<!-- bundle-sizes:readme:end -->

For how these sizes sit against `@arcgis/core` and friends — at a named category
boundary, with every external figure dated and primary-sourced — see the
generated [comparison page](./docs/comparison.md).

## 60-second quickstart

**No Honua server required.** This runs against a *public* Esri GeoServices
endpoint — no API key, no account, no infrastructure — and walks the kernel's
verbs in order: **connect → query → explain** (the fourth verb, **mount**, is
the hero at the top of this page).

```ts doc-test=compile
import { connect, explainQuery, envelope, queryFilter, type Query } from "@honua/sdk-js";

// 1. connect — a public Esri Living Atlas FeatureServer; nothing of Honua's is running.
const data = await connect({
  endpoint:
    "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/2020_Census_State_Apportionment/FeatureServer/0",
  protocol: "auto",
  authorizationScopeFingerprint: "public",
});
const states = data.source<{ NAME: string; Total_Pop_2020: number }>();

// 2. query — one typed, protocol-neutral filter expression.
const query: Query = {
  filter: queryFilter.and(
    queryFilter.gt("Total_Pop_2020", 1_000_000),
    queryFilter.spatial("intersects", envelope(-125, 24, -66, 50)),
  ),
  outFields: ["NAME", "Total_Pop_2020"],
  pagination: { limit: 100 },
};

// 3. explain — the serializable plan, inspectable before anything executes.
const plan = explainQuery({ descriptor: states.descriptor, query });
console.log(plan.fingerprint, plan.steps.map((step) => `${step.engine}:${step.operation}`));

const result = await states.queryAll(query);
console.log(`Loaded ${result.features.length} states`);
```

`Query.filter` compiles to GeoServices SQL-92, CQL2, FES 2.0, OData `$filter`,
or DuckDB SQL, and `Query.temporalFilter` compiles to the protocol's own time
parameter (`time=`, `datetime=`) or an exact predicate on a named field. A
construct the target cannot express throws `HonuaCapabilityNotSupportedError`
naming the construct and the protocol — it is never silently dropped or
widened. `explainQuery` returns the same plan surface agents and the
`honua explain` CLI command use: compiled predicates, bounds, cache and
fidelity decisions, all serializable. Assembling a `Dataset` by hand — explicit
protocol, locator, and capabilities, no discovery — is covered in
[`docs/guide.md`](./docs/guide.md).

The deprecated `Query.where` member remains operational only as source-native
v1 migration compatibility; its grammar changes with the adapter, so new code
should use `Query.filter`. The experimental
[`@honua/sdk-js/query-planner`](./docs/query-planner.md) adds a schema-verified
builder and explain plans over the same filter shape.

The same query envelope works against any GeoServices, OGC API
Features, WFS, OData, or STAC endpoint. Migrating from `esri-leaflet`? The raw
GeoServices API remains available, but its `where` member below is explicitly
GeoServices SQL rather than the deprecated protocol-neutral `Query.where`:

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js";

const geoServicesClient = new HonuaClient({
  baseUrl: "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis",
});
const { features } = await geoServicesClient.queryFeatures({
  serviceId: "2020_Census_State_Apportionment",
  layerId: 0,
  where: "1=1",
  outFields: ["*"],
  returnGeometry: true,
  resultRecordCount: 25,
});
```

Run the complete First Map app locally — public endpoint in, inspected MapLibre map out:

```bash
npm install
npm run demo:quickstart:mock   # deterministic fixture lane (what CI runs)
npm run demo:quickstart        # paste or configure an anonymous public endpoint
```

See [`docs/quickstart.md`](./docs/quickstart.md) for the canonical
guided server-optional walkthrough,
[`docs/standalone-capability-matrix.md`](./docs/standalone-capability-matrix.md)
for the backend-agnostic vs server-enhanced breakdown, and
[`examples/maplibre-quickstart/`](./examples/maplibre-quickstart/README.md)
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
honua explain maui-parcels/1 --bbox -156.7,20.7,-156.3,21.0 --json   # the plan, no server call
honua stac collections
honua geocode "1 Honolulu Pl, HI"
honua map export maui-parcels --bbox -156.7,20.7,-156.3,21.0 --size 800x600 -o maui.png
honua tiles maui-parcels 12/912/1809 -o tile.png
```

The CLI's `--where` takes the *source-native* filter grammar by design (SQL for
GeoServices, CQL2 for OGC) — it is a command-line convenience, not the
deprecated protocol-neutral `Query.where`; `honua explain` shows exactly what
any query compiles to before it runs. Authentication resolves from
`--api-key`, `HONUA_API_KEY`, or a saved `honua login`. Run `honua --help` for
the full command surface. This is the recommended command surface for docs and
demos.

For support-safe interoperability evidence, `honua doctor` emits a local,
schema-validated diagnostic bundle with explicit classification/consent,
credential and PII redaction, bounded previews, and original-byte SHA-256
metadata. `honua doctor --replay` permits only one bounded, abortable
`GET`/`HEAD` and fails closed before network access for mutations,
subscriptions, unsafe paths, credentials, malformed schemas, or hash drift. It
never uploads. See [`docs/diagnostic-bundles.md`](./docs/diagnostic-bundles.md).

## What you can build

<!-- sample-catalog:start -->
The versioned [SDK sample catalog](./docs/generated/sample-catalog.md) tracks all 35 executable examples: 4 qualified golden samples, 13 recipes, 15 labs, and 3 fixtures. Seven journey IDs are reserved; 3 remain explicitly planned candidates. The catalog is the source of truth for track, support, lifecycle, fixture/live evidence, quality profiles, and the honua.io projection.
<!-- sample-catalog:end -->

Linking to Honua from a plugin directory or ecosystem list? Point at
[First Map](./docs/quickstart.md)
([hosted walkthrough](https://honua-io.github.io/honua-sdk-js/guides/quickstart.html),
[source](./examples/maplibre-quickstart/README.md)) — CI keeps its fixture lane externally network-blocked and its
release smoke green across Chromium, Firefox, and WebKit. Reusable directory entries — and the
ledger of which ecosystem submissions were filed and accepted — live in
[`docs/listings/maplibre-plugin-directory.md`](./docs/listings/maplibre-plugin-directory.md).

Whether any of that actually makes the packages findable is measured, not assumed:
[`docs/listings/npm-search-verification.md`](./docs/listings/npm-search-verification.md) records
where every published `@honua/*` package ranks in npm registry search for its declared discovery
terms, including the queries where it does not rank at all.

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
- [`docs/geoprocessing.md`](./docs/geoprocessing.md) — one job lifecycle across OGC API Processes, Esri GPServer compatibility, and AI-selected operations
- [`docs/zero-to-map-release-journey.md`](./docs/zero-to-map-release-journey.md) — contract-first 2026.1 install → admin/GP → Studio → human Console gate walkthrough
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
  and analysis tools to assistants over the Model Context Protocol. Its tool
  contract is the SDK's own protocol-neutral one — sources are addressed as
  `<protocol>:<address>` (`ogc-features:hotels`, `stac:sentinel-2-l2a`,
  `wfs:topp:states`, `odata:People`, `geoservices-feature-service:Parks/0`),
  filters are the typed semantic filter, and geometry is GeoJSON, so **no tool
  schema requires an Esri-only field**. Tools that need a Honua-only surface
  degrade gracefully with a structured "not available on this target" result, and
  a request the backing protocol cannot express returns a structured capability
  error rather than an empty result. A Honua deployment's richer `/mcp` catalog is
  the upgrade path via `honua-mcp-proxy`.
- **Cross-model MCP eval scorecard** — how well *different client models* actually
  drive that MCP surface, published rather than asserted:
  [`docs/generated/mcp-eval-scorecard.md`](./docs/generated/mcp-eval-scorecard.md).
  Every figure is generated from the committed, dated run artifacts under
  [`mcp/evals/runs/`](./mcp/evals) — with the zero-LLM deterministic control row,
  every non-passing run, and the protocol-certification failures included, because
  a wins-only scoreboard is marketing.
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
    `/nl-map-control`, `/studio-agent`, `/interactions/declarative`, `/geoparquet`, `/source-schema`, `/source-capabilities`, `/source-capability-discovery`, `/cloud-native-discovery`, `/plugin`, `/deckgl`,
    `/offline`, `/diagnostics`, `/routing`, `/cog`, `/pmtiles`, `/stac`, `/raster`, `/coverages`, `/columnar-workflow`, `/kepler`, `/analytics`, `/analytics/uplot`, `/zarr`,
    `/pmtiles-protocol-plugin.js`, `/local-install` — with `/query-planner` below, 26 experimental subpaths in total.
  - The complete `/query-planner` subpath remains **experimental**. The stable root promotes a
    reviewed query-planner subset: `explainQuery`, `executeQueryPlan`, `hashQueryPlan`, the plan
    errors/version constants, and the types required to name the common explain/mount workflow.
  - **Application-platform surfaces** (`/app`, `/app-controller`, `/app-workspace`,
    `/scene-workspace`, `/collaboration`, `/control-plane`, `/replica-sync`, `/share`,
    `/operate`, `/generated-app`, `/studio`, `/controls`, `/web-components`, `/operator`,
    `/operator/*`) have **moved to the separate `@honua/app-platform` package**; the old
    18 deprecated compatibility subpaths remain through `0.1.x` and are removed in
    `0.2.0`. The `/console` entrypoint was removed outright (no shim).
    `@honua/app-platform/scene-workspace` is the first of those replacements promoted to
    **`beta`**: the renderer-neutral workspace state, the scene primitive contract, and
    the Cesium primitive adapter carry a shape commitment through `0.1.x`, while Honua
    Server scene discovery, `SceneView`, the analysis widgets, and the bounded
    `Source`-to-Cesium-entity slice stay experimental. The split is enumerated export by
    export in the generated
    [surface tiers table](./docs/standalone-capability-matrix.md#surface-tiers).

## Support and lifecycle

We publish a lifecycle because a library you build on should tell you what it promises.
`esri-leaflet` never did, and "will this break under me?" is the question that decides adoption.

- **Today (pre-1.0, `0.x`).** The **stable tier** — the subpath entrypoints listed under
  "Stable subpath entrypoints" in [`INSTALL.md`](./INSTALL.md) — is where we invest
  compatibility effort, and it is guarded in CI by a public-API report
  (`npm run verify:api-report`): no symbol leaves or changes shape by accident. While we are
  on `0.x` a minor _may_ still change a stable symbol, but only as a reviewed, called-out
  change — never silently. Symbols marked `@experimental` in JSDoc may change in any minor.
  Symbols marked `@beta` sit between the two: they carry a named shape commitment for the
  stated range and grow additively, and breaking one is a called-out change. A barrel that
  mixes tiers enumerates every export in the generated
  [surface tiers table](./docs/standalone-capability-matrix.md#surface-tiers), so no symbol
  inherits a tier from its neighbours.
- **At 1.0.** The stable tier freezes under [Semantic Versioning](https://semver.org/):
  breaking or removing a stable symbol requires a major version; minors are additive. Major
  versions are coordinated across the Honua SDK family (JavaScript, Python, .NET) so one semver
  line describes the contract on every platform.
- **Application-platform surfaces move separately.** App-shell, builder, and hosted-product
  entrypoints are being extracted to a separate `@honua/app-platform` package that versions at
  its own pre-1.0 cadence, so the client SDK can reach a frozen 1.0 without waiting on them.
  Their old `@honua/sdk-js/*` subpaths remain as `@deprecated` re-export shims through
  `0.1.x` and are removed in `0.2.0` — promoting a replacement (the Cesium scene surface is
  now `beta`) does not extend or shorten a forwarder's removal window. See
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
