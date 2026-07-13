# Honua JS SDK

[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/honua-io/honua-sdk-js/badge)](https://scorecard.dev/viewer/?uri=github.com/honua-io/honua-sdk-js)

[![npm](https://img.shields.io/npm/v/@honua/sdk-js?color=2b6cb0&label=%40honua%2Fsdk-js)](https://www.npmjs.com/package/@honua/sdk-js)
[![types](https://img.shields.io/npm/types/@honua/sdk-js?color=3178c6)](https://www.npmjs.com/package/@honua/sdk-js)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![node](https://img.shields.io/node/v/@honua/sdk-js?color=43853d)](./package.json)
[![docs](https://img.shields.io/badge/docs-honua--io.github.io-2b6cb0)](https://honua-io.github.io/honua-sdk-js/)

> One geospatial client for GeoServices, OGC APIs, WMS/WMTS/WFS, STAC, and OData —
> with first-class TypeScript, a MapLibre runtime, and a drop-in ArcGIS migration path.

`@honua/sdk-js` is the JavaScript / TypeScript client for the [Honua](https://github.com/honua-io)
geospatial platform. It speaks the open protocols your data already uses (Esri GeoServices,
OGC API Features / Tiles / Maps / Processes, STAC, WMS, WMTS, WFS 2.0, OData v4), exposes a
single protocol-neutral `Dataset` → `Source` → `Query` → `Result` contract on top of them, and
ships a MapLibre-first map runtime plus an Esri compatibility layer so existing ArcGIS apps
can migrate file-by-file.

**Release status: beta** (`0.1.0-beta`). The 20-entrypoint stable tier is frozen and guarded
by an API-surface gate; remaining pre-1.0 work is hardening, not surface change. See
[`docs/decisions/scope-split-and-1.0.md`](./docs/decisions/scope-split-and-1.0.md) and the
machine-readable surface inventory in [`config/public-surface.json`](./config/public-surface.json).

📚 **Hosted docs:** [honua-io.github.io/honua-sdk-js](https://honua-io.github.io/honua-sdk-js/) —
quickstart, the full guide corpus, the [TypeDoc API reference](https://honua-io.github.io/honua-sdk-js/api/),
and the [demo gallery](https://honua-io.github.io/honua-sdk-js/gallery.html).

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

## Where it fits

`@honua/sdk-js` is a typed geospatial *service client* and migration toolkit — it is
**not a rendering engine**. 2D rendering rides MapLibre GL JS and 3D rides Cesium, so the
honest comparisons are the service-client libraries, not the renderers:

- vs **`@esri/arcgis-rest-js`** — that's Esri's own client for Esri services only. Honua speaks
  GeoServices *plus* OGC API / WFS / WMS / WMTS / STAC / OData under one typed contract, with a
  capability model that throws instead of returning silently-empty results.
- vs **`esri-leaflet`** — dormant (no release since September 2025) and Leaflet-bound. Honua's
  esri-compat + `honua-migrate` codemod is an actively maintained migration path that targets
  MapLibre.
- vs **`openlayers` / `maplibre-gl` directly** — pick those when you need a renderer and are
  happy hand-rolling service calls; pick Honua *on top of* MapLibre when you want the typed
  client, the ArcGIS migration path, or the server-authored `MapPackage` runtime.

**No Honua server required.** The protocol clients work against **any** standards-speaking
server: an existing ArcGIS Server / ArcGIS Online endpoint, any OGC API Features server
(pygeoapi, ldproxy, GeoServer OGC API), a WFS 2.0 server, a STAC API or static catalog, or an
OData v4 service. The OGC API Features and STAC lanes discover the raw endpoint layout from the
landing page; WFS follows the capabilities DCP URLs; set `locator.layout` for non-facade
servers. See the [server-optional quickstart](./docs/standalone-quickstart.md) and the
[backend-agnostic capability matrix](./docs/standalone-capability-matrix.md).

A [Honua Server](https://github.com/honua-io/honua-server) is the upgrade path, not the entry
fee: it adds server-authored `MapPackage`s, realtime, collaboration, MCP/AI surfaces, and the
OGC API Tiles / Maps / Processes / Records families (still facade-bound today).

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
`npm run report:bundle-sizes`.

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
The versioned [SDK sample catalog](./docs/generated/sample-catalog.md) tracks all 30 executable examples: 11 flagship, 6 recipe, 9 advanced, and 4 reference. It is the source of truth for support, fixture/live modes, provenance, validation, and the honua.io projection.
<!-- sample-catalog:end -->

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
- [`docs/react.md`](./docs/react.md) — React bindings (`@honua/react`): provider, hooks, and map components
- [`docs/geometry.md`](./docs/geometry.md) — `@honua/sdk-js/geometry` curated turf/proj4 ops (buffer/area/measure/simplify/reproject) + the `geometryEngine` compat shim
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
    `@honua/sdk-js/cli`.
  - **Experimental subpath-only APIs** (not re-exported from the root barrels): `/agent-tools`,
    `/agent-safety`, `/nl-map-control`, `/geoparquet`, `/plugin`, `/deckgl`, `/offline`,
    `/diagnostics`, `/routing` — with `/query-planner` below, 10 experimental subpaths in total.
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
