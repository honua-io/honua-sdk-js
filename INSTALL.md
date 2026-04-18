# Installing the Honua JavaScript SDK

## Packages

| Package | Description |
|---------|-------------|
| `@honua/sdk` | Core client — feature queries, web mapping, expressions |
| `@honua/sdk-esri-compat` | Esri ArcGIS JS compatibility layer for migration |
| `@honua/honua-migrate` | CLI and library for migrating Esri apps to Honua |

## Prerequisites

- Node.js 20 or later
- A running Honua Server instance (for runtime queries)

## Install via npm

```bash
# Core SDK
npm install @honua/sdk

# Esri compatibility (if migrating from ArcGIS)
npm install @honua/sdk-esri-compat

# Migration CLI
npm install -g @honua/honua-migrate
```

## Quick Start

```typescript
import { HonuaClient } from "@honua/sdk";

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

`checkCompatibility()` reads the parsed `data.compatibility` contract from `GET /api/v1/admin/capabilities`.
For a runnable browser example from this repo, including the renderable-geometry checks used by the committed
MapLibre quickstart, use [`examples/maplibre-quickstart/README.md`](./examples/maplibre-quickstart/README.md).

## Canonical Contract And Exploration

The SDK exposes a protocol-neutral client contract and exploration state module that wrap the existing
`HonuaFeatureLayer` / `HonuaMapService` / `HonuaOgcFeatureCollection` classes. These ship from the root
`@honua/sdk-js` package as the `@honua/sdk-js/contract` and `@honua/sdk-js/exploration` subpath entrypoints:

- [`docs/shared-client-contract.md`](./docs/shared-client-contract.md) — `Dataset`, `Source`, `Capabilities`,
  `Query`, `Result`, `MapBinding`, and `createDataset(...)`.
- [`docs/exploration-context.md`](./docs/exploration-context.md) — `createExplorationContext(...)` with
  linked-view presets (`globalLinked`, `mapDriven`, `gridDriven`, `chartDriven`, `decoupled`).
- [`docs/protocol-capability-matrix.md`](./docs/protocol-capability-matrix.md) — capability coverage per
  protocol (`geoservices-feature-service`, `geoservices-map-service`, `ogc-features`, `wfs`, `wms`, `odata`).
- [`docs/source-binding-alignment.md`](./docs/source-binding-alignment.md) — round-trip mapping between
  `SourceDescriptor` and the server `SourceBinding` document.

## Esri Migration

```bash
# Scan an existing ArcGIS JS app
npx @honua/honua-migrate scan --input ./src

# Generate a migration report
npx @honua/honua-migrate codemod --input ./src --output ./migrated
```

## Version Policy

- **Pre-release** (`-alpha.*`, `-beta.*`): Published to npm with `@alpha` / `@beta` dist-tags
- **Stable** (`1.0.0+`): Published to npm as `@latest`

All packages follow [Semantic Versioning](https://semver.org/). Major versions are coordinated across all Honua SDKs.
