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

For a runnable browser example from this repo, use [`examples/maplibre-quickstart/README.md`](./examples/maplibre-quickstart/README.md).

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
