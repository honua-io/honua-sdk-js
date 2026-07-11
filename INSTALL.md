# Installing the Honua JavaScript SDK

The Honua JavaScript SDK ships as a single npm package — **`@honua/sdk-js`** — with multiple
subpath entrypoints. The core client, the Esri compatibility layer, the migration helpers,
and the protocol-neutral contract are all reachable from this one install.


## Stable subpath entrypoints

Subpaths covered by the SDK's semver contract. Symbols reachable from these
entrypoints are stable across minor versions.

| Subpath | What it gives you |
|---------|-------------------|
| `@honua/sdk-js` | Default barrel — re-exports the most common stable symbols |
| `@honua/sdk-js/browser` | Prebuilt browser ESM build of the default barrel (same API as `@honua/sdk-js`) |
| `@honua/sdk-js/honua` | `HonuaClient` (the raw GeoServices/OGC client) |
| `@honua/sdk-js/auth` | OAuth2/PKCE, client credentials, static providers, and credential stores |
| `@honua/sdk-js/contract` | Protocol-neutral `Dataset` / `Source` / `Query` / `Result` + `createDataset` |
| `@honua/sdk-js/esri-compat` | Esri ArcGIS JS-API compatibility layer for migration |
| `@honua/sdk-js/migration` | Programmatic migration helpers (codemod runner, scan reports) |
| `@honua/sdk-js/runtime` | MapLibre `MapPackage` runtime (`loadMapPackage`, `HonuaMapRuntime`) |
| `@honua/sdk-js/expr` | Honua expression builder |
| `@honua/sdk-js/webmap` | WebMap JSON load/save helpers |
| `@honua/sdk-js/geocoding` | Geocoding adapters |
| `@honua/sdk-js/exploration` | Linked-view exploration state + presets |
| `@honua/sdk-js/interactions` | Hit-test + pointer normalization + chart/map bindings |
| `@honua/sdk-js/filter-registry` | Shared filter clause registry + projections |
| `@honua/sdk-js/style` | Honua style spec + source parsers/validators |
| `@honua/sdk-js/map` | `HonuaMap` programmatic map container |
| `@honua/sdk-js/realtime` | Realtime transport adapters (SSE) — a client-transport primitive |
| `@honua/sdk-js/react` | React provider, hooks, and map components (optional `react` / `react-dom` peers; published standalone as `@honua/react`) |
| `@honua/sdk-js/geometry` | Curated turf/proj4 client-side geometry ops (buffer/area/simplify/reproject) |
| `@honua/sdk-js/cli` | Programmatic `run()` entrypoint for the `honua` command-line client |

## Experimental subpath entrypoints

Subpaths marked `@experimental` in JSDoc. Useful today; the shape may change in
any minor release prior to `1.0.0`. **The experimental subpaths are subpath-only
— they are not re-exported from `@honua/sdk-js` or `@honua/sdk-js/honua`** so a
default-barrel import never pulls them in.

| Subpath | What it gives you |
|---------|-------------------|
| `@honua/sdk-js/agent-tools` | Agent-facing JSON Schema tool definitions (MCP/OpenAI compatible). Stays in the stable package (the in-repo `@honua/mcp-server` depends on it) but its symbols remain `@experimental` — not semver-frozen — while the AI surface settles. |
| `@honua/sdk-js/agent-safety` | Bounded runtime validation, effect budgets, signed approval envelopes, authenticated single-use consumption, context revalidation, and deterministic execution-receipt verification for JSON-compatible plans. |
| `@honua/sdk-js/geoparquet` | GeoParquet / DuckDB-WASM–backed protocol-neutral `Source`; the optional DuckDB peer loads lazily. |
| `@honua/sdk-js/query-planner` | Deterministic query IR, side-effect-free explain plans, GeoServices compilation, and explicitly bounded local execution. |
| `@honua/sdk-js/plugin` | Versioned, data-only plugin manifests plus deterministic compatibility and authority-boundary certification reports. |
| `@honua/sdk-js/deckgl` | Bounded, zero-copy typed-array projection into an optional deck.gl peer, with stable picking identity and deterministic disposal. |
| `@honua/sdk-js/offline` | [Versioned downloadable-region manifests](./docs/offline-regions.md) plus storage-neutral quota, integrity, cancellation, and atomic commit contracts. |

## Deprecated compatibility entrypoints

These temporary `@honua/sdk-js` shims were introduced in `0.1.0-beta.0` when
the application platform moved. They remain available throughout `0.1.x` and
are removed in `0.2.0`; new code must import the replacement directly.

| Deprecated subpath | Replacement | Remove in |
|--------------------|-------------|-----------|
| `@honua/sdk-js/app` | `@honua/app-platform/app` | `0.2.0` |
| `@honua/sdk-js/app-controller` | `@honua/app-platform/app-controller` | `0.2.0` |
| `@honua/sdk-js/app-workspace` | `@honua/app-platform/app-workspace` | `0.2.0` |
| `@honua/sdk-js/scene-workspace` | `@honua/app-platform/scene-workspace` | `0.2.0` |
| `@honua/sdk-js/collaboration` | `@honua/app-platform/collaboration` | `0.2.0` |
| `@honua/sdk-js/control-plane` | `@honua/app-platform/control-plane` | `0.2.0` |
| `@honua/sdk-js/replica-sync` | `@honua/app-platform/replica-sync` | `0.2.0` |
| `@honua/sdk-js/share` | `@honua/app-platform/share` | `0.2.0` |
| `@honua/sdk-js/operate` | `@honua/app-platform/operate` | `0.2.0` |
| `@honua/sdk-js/generated-app` | `@honua/app-platform/generated-app` | `0.2.0` |
| `@honua/sdk-js/studio` | `@honua/app-platform/studio` | `0.2.0` |
| `@honua/sdk-js/operator` | `@honua/app-platform/operator` | `0.2.0` |
| `@honua/sdk-js/operator/controllers` | `@honua/app-platform/operator/controllers` | `0.2.0` |
| `@honua/sdk-js/operator/workspace` | `@honua/app-platform/operator/workspace` | `0.2.0` |
| `@honua/sdk-js/operator/theming` | `@honua/app-platform/operator/theming` | `0.2.0` |
| `@honua/sdk-js/operator/i18n` | `@honua/app-platform/operator/i18n` | `0.2.0` |
| `@honua/sdk-js/controls` | `@honua/app-platform/controls` | `0.2.0` |
| `@honua/sdk-js/web-components` | `@honua/app-platform/web-components` | `0.2.0` |

## Application-platform entrypoints (`@honua/app-platform`)

App-shell, app-builder, and hosted-product surfaces have moved out of the client
SDK into the separate **`@honua/app-platform`** package, which versions at its
own pre-1.0 cadence so `@honua/sdk-js` can reach a frozen 1.0 without waiting on
them (see [`docs/decisions/scope-split-and-1.0.md`](./docs/decisions/scope-split-and-1.0.md)).

| `@honua/app-platform` subpath | What it gives you |
|-------------------------------|-------------------|
| `@honua/app-platform/app` | App bootstrap helper for browser shells |
| `@honua/app-platform/app-controller` | `HonuaController` — renderer-neutral app controller |
| `@honua/app-platform/app-workspace` | Framework-neutral workspace state orchestration |
| `@honua/app-platform/scene-workspace` | 3D scene workspace + MapLibre/Cesium adapters (optional `cesium` peer) |
| `@honua/app-platform/collaboration` | Saved-map collaboration client |
| `@honua/app-platform/control-plane` | Hosted-product / admin client |
| `@honua/app-platform/replica-sync` | Offline-replica sync client |
| `@honua/app-platform/share` | Embed-token + DCAT sharing helpers |
| `@honua/app-platform/operate` | Operations/observability client |
| `@honua/app-platform/generated-app` | Manifest projection + preview runtime for generated apps |
| `@honua/app-platform/studio` | Studio package-family projections, validation/preview envelopes, capability manifest, publish/share/embed contracts (MCP/QGIS-safe) |
| `@honua/app-platform/controls` | Native UI control kit (`<honua-basemap-switcher>`) for MapLibre maps |
| `@honua/app-platform/web-components` | Framework-neutral custom elements |
| `@honua/app-platform/operator` | Operator-native chat/plan-review/approval controllers |
| `@honua/app-platform/operator/controllers` | Framework-neutral controllers behind `/operator` |
| `@honua/app-platform/operator/workspace` | Operator workspace state container |
| `@honua/app-platform/operator/theming` | Operator design-system theme provider + tokens |
| `@honua/app-platform/operator/i18n` | Operator message catalog + resolution |

During the transition, the deprecated imports listed above keep working through
`0.1.x`; they are removed in `0.2.0`. Update imports to
`@honua/app-platform/<subpath>`. The `@honua/sdk-js/console`
entrypoint was removed outright (its projection helpers are owned by the
`@honua/console` application) and has no shim.

## Prerequisites

- Node.js 20 or later
- A running Honua Server instance (for runtime queries)

## Install

```bash
npm install @honua/sdk-js
```

### Optional peer dependencies

A few integration paths are gated behind **optional peer dependencies** so a
Node-only or REST-only consumer never pays the install cost:

| Integration | Peer to install |
|-------------|-----------------|
| MapLibre `MapPackage` runtime (`@honua/sdk-js/runtime`) | `npm install maplibre-gl` |
| deck.gl binary projection (`@honua/sdk-js/deckgl`) | `npm install @deck.gl/layers` |
| Cesium 3D adapters (`@honua/app-platform/scene-workspace`) | `npm install cesium` |
| gRPC-Web transport (`new HonuaClient({ transport: "grpc-web" })`) | `npm install @connectrpc/connect @connectrpc/connect-web @bufbuild/protobuf` |
| Geometry ops (`@honua/sdk-js/geometry`) | `npm install proj4 @turf/buffer @turf/area …` (only the ops you import) — or use the `@honua/geometry` split package |
| Migration API (`@honua/sdk-js/migration`) | `npm install typescript` |

If you stay on the default REST transport with no MapLibre/Cesium scene work,
no extra installs are required.

## Quick Start

```typescript doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({
  baseUrl: "https://your-honua-server.com",
});

const compatibility = await client.checkCompatibility();
if (!compatibility.supported) {
  throw new Error(
    `Unsupported Honua server. Minimum supported version: ${HonuaClient.minimumSupportedServerVersion}. ` +
      `Reasons: ${compatibility.reasons.join("; ")}`,
  );
}

const result = await client.queryFeatures({
  serviceId: "natural-earth",
  layerId: 0,
  where: "1=1",
  returnGeometry: true,
  outFields: ["*"],
  outSr: 4326,
  resultRecordCount: 25,
});

const featureCount = result.features?.length ?? 0;
console.log(`Found ${featureCount} feature(s)`);
```

`checkCompatibility()` reads the parsed `data.compatibility` contract from
`GET /api/v1/admin/capabilities`. For a runnable browser example from this repo,
including the renderable-geometry checks used by the committed MapLibre quickstart,
see [`examples/maplibre-quickstart/README.md`](./examples/maplibre-quickstart/README.md).

## Canonical Contract And Exploration

The SDK exposes a protocol-neutral client contract and exploration state module that
wrap the existing `HonuaFeatureLayer` / `HonuaMapService` / `HonuaOgcFeatureCollection`
classes. These are reachable via the `@honua/sdk-js/contract` and
`@honua/sdk-js/exploration` subpaths:

- [`docs/shared-client-contract.md`](./docs/shared-client-contract.md) — `Dataset`, `Source`, `Capabilities`,
  `Query`, `Result`, `MapBinding`, and `createDataset(...)`.
- [`docs/exploration-context.md`](./docs/exploration-context.md) — `createExplorationContext(...)` with
  linked-view presets (`globalLinked`, `mapDriven`, `gridDriven`, `chartDriven`, `decoupled`).
- [`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md) — capability coverage per
  protocol (`geoservices-feature-service`, `geoservices-map-service`, `geoservices-image-service`,
  `geoservices-geometry-service`, `geoservices-gp-service`, `ogc-features`, `ogc-tiles`, `ogc-maps`,
  `stac`, `wfs`, `wms`, `odata`).
- [`docs/wfs.md`](./docs/wfs.md) — first-party WFS 2.0 adapter, FES filter translation,
  content-type negotiation, transactions, stored queries, and the `Source.protocol("wfs")`
  escape hatch.
- [`docs/source-binding-alignment.md`](./docs/source-binding-alignment.md) — round-trip mapping between
  `SourceDescriptor` and the server `SourceBinding` document.
- [`docs/maplibre-runtime.md`](./docs/maplibre-runtime.md) — `loadMapPackage(...)` and `HonuaMapRuntime`
  for the MapLibre GL JS-first `MapPackage` runtime.

## Esri Migration

The migration helpers live behind the `@honua/sdk-js/migration` subpath. They
power the same codemod that the standalone CLI runs:

```typescript doc-test=compile
import { runEsriCompatCodemod, scanArcGisUsage } from "@honua/sdk-js/migration";

const report = scanArcGisUsage("./src");
const migration = runEsriCompatCodemod({ rootDir: "./src", write: true });
```

## Version Policy

- **Pre-release** (`-alpha.*`, `-beta.*`): Published to npm with `@alpha` / `@beta` dist-tags.
- **Stable** (`1.0.0+`): Published to npm as `@latest`.
- **Semver:** All releases follow [Semantic Versioning](https://semver.org/). Public symbols
  reachable from the documented subpaths above are covered by the contract; symbols marked
  `@experimental` in JSDoc may change in any minor release.
- **Cross-language alignment:** Major versions are coordinated across the Honua SDK family
  (JavaScript, Python, .NET) so a single semver line tells you what the contract is on every
  platform.

> **Advanced packaging.** Downstream packagers can also produce a three-package
> split (`@honua/sdk` / `@honua/sdk-esri-compat` / `@honua/honua-migrate`) via
> `npm run build:split-packages`. This is an opt-in build target, not the default
> consumer install. See [`docs/split-packages.md`](./docs/split-packages.md) if you
> are integrating with a downstream registry that needs the smaller surfaces.

Maintainers can verify the artifact consumers actually install with
`npm run verify:packed-sdk` after the library and browser builds. The gate packs
the root package, installs it offline into an isolated ESM project, imports every
stable and experimental subpath, typechecks every shipped declaration target,
and runs the packaged `honua --help` command. Temporary package and consumer
directories are removed after both successful and failed runs.
