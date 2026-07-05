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
| `@honua/sdk-js/honua` | `HonuaClient` (the raw GeoServices/OGC client) |
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
| `@honua/sdk-js/geometry` | Curated turf/proj4 client-side geometry ops (buffer/area/simplify/reproject) |

## Experimental subpath entrypoints

Subpaths marked `@experimental` in JSDoc. Useful today; the shape may change in
any minor release prior to `1.0.0`. **The experimental subpaths are subpath-only
— they are not re-exported from `@honua/sdk-js` or `@honua/sdk-js/honua`** so a
default-barrel import never pulls them in.

| Subpath | What it gives you |
|---------|-------------------|
| `@honua/sdk-js/app` | App bootstrap helper for browser shells |
| `@honua/sdk-js/app-controller` | `HonuaController` — renderer-neutral app controller |
| `@honua/sdk-js/app-workspace` | Framework-neutral workspace state orchestration |
| `@honua/sdk-js/scene-workspace` | 3D scene workspace + MapLibre/Cesium adapters |
| `@honua/sdk-js/collaboration` | Saved-map collaboration client |
| `@honua/sdk-js/control-plane` | Hosted-product / admin client |
| `@honua/sdk-js/controls` | Native UI control kit (`<honua-basemap-switcher>`) for MapLibre maps — no core/`maplibre-gl` imports |
| `@honua/sdk-js/generated-app` | Manifest projection + preview runtime for generated apps |
| `@honua/sdk-js/studio` | Studio package-family projections, validation/preview envelopes, capability manifest, publish/share/embed contracts (MCP/QGIS-safe) |
| `@honua/sdk-js/agent-tools` | Agent-facing JSON Schema tool definitions (MCP/OpenAI compatible) |
| `@honua/sdk-js/realtime` | Realtime transport adapters (SSE, future WS/WebTransport) |
| `@honua/sdk-js/web-components` | Framework-neutral custom elements |
| `@honua/sdk-js/operator` | Operator-native chat/plan-review/approval controllers |
| `@honua/sdk-js/operator/controllers` | Framework-neutral controllers behind `/operator` |
| `@honua/sdk-js/operator/workspace` | Operator workspace state container |
| `@honua/sdk-js/operator/theming` | Operator design-system theme provider + tokens |
| `@honua/sdk-js/operator/i18n` | Operator message catalog + resolution |

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
| Cesium 3D adapters (`@honua/sdk-js/scene-workspace`) | `npm install cesium` |
| gRPC-Web transport (`new HonuaClient({ transport: "grpc-web" })`) | `npm install @connectrpc/connect @connectrpc/connect-web @bufbuild/protobuf` |
| Geometry ops (`@honua/sdk-js/geometry`) | `npm install proj4 @turf/buffer @turf/area …` (only the ops you import) — or use the `@honua/geometry` split package |

If you stay on the default REST transport with no MapLibre/Cesium scene work,
no extra installs are required.

## Quick Start

```typescript
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

```typescript
import { runCodemod, scanProject } from "@honua/sdk-js/migration";

const report = await scanProject({ input: "./src" });
await runCodemod({ input: "./src", output: "./migrated" });
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
