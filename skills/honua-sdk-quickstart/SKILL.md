---
name: honua-sdk-quickstart
description: Use when writing or reviewing code that uses @honua/sdk-js — installing the SDK, constructing a HonuaClient, building a Dataset/Source and querying features across GeoServices/OGC/WFS/STAC/OData, or handling capability errors. Ensures generated code targets the current Dataset → Source → Query → Result contract instead of guessed or outdated APIs.
---

# Honua JS SDK quickstart

Write correct, current `@honua/sdk-js` code. The canonical surface is
protocol-neutral: build a `Dataset` over one or more `Source`s and query it; the
same code works against Esri GeoServices, OGC API Features, WFS 2.0, OData v4,
and STAC.

## Install

```bash
npm install @honua/sdk-js
```

Installing the package also installs the `honua` CLI (bin `honua`) and exposes a
prebuilt browser bundle for build-less usage (see `docs/browser-bundle.md`).

Public entrypoints are subpath exports; the stable set and stability tiers are
listed in `INSTALL.md`. Import from the named subpath (e.g.
`@honua/sdk-js/honua`, `@honua/sdk-js/contract`) rather than deep paths.

## Client + Dataset/Source/Query/Result contract

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

Contract idioms to keep straight:

- A `Dataset` groups one or more `Source`s. `dataset.source(id)` returns the
  `Source` (it may be `undefined`, hence the `!` or a guard).
- Each `Source` accepts a protocol-neutral `Query` and returns a
  protocol-neutral `Result`. Use `query()` for one page, `queryAll()` to page to
  completion, and `stream()` (an async generator) for streaming pages.
- Method casing is per-language; the JS surface is `queryAll()` / `query()` /
  `stream()`. Semantics match the .NET / Python SDKs.
- For raw protocol operations the canonical surface does not cover, drop to the
  typed escape hatch `source.protocol(...)`.

Prefer the raw GeoServices shape (for example during an ArcGIS migration)?
`HonuaClient` ships the protocol-specific call directly:

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

## Gate on server compatibility

For production code, verify the server meets the SDK's tested floor:

```ts
const { supported, reasons } = await client.checkCompatibility();
if (!supported) throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
```

## Capability-error handling

Capability misses throw `HonuaCapabilityNotSupportedError` under the default
`capabilityPolicy: "strict"` rather than silently returning empty results. Use
the `isHonuaError` guard so unrelated exceptions propagate:

```ts
import { HonuaCapabilityNotSupportedError, isHonuaError } from "@honua/sdk-js";

try {
  await dataset.source("parcels-fs")!.queryAll({ where: "1=1" });
} catch (error) {
  if (!isHonuaError(error)) throw error;
  if (error instanceof HonuaCapabilityNotSupportedError) {
    // Expected for capability misses: narrow the query, drop the unsupported
    // clause, fall back to source.protocol(...), or opt into best-effort
    // behavior with capabilityPolicy: "degraded" on createDataset.
    return;
  }
  throw error;
}
```

The full error hierarchy, catch-narrowing, and retry policy are in
`docs/errors.md`.

## Run a complete app locally

```bash
npm run demo:quickstart:mock
```

This serves `examples/maplibre-quickstart` against a deterministic fixture and
prints `quickstartMockUrl=http://127.0.0.1:PORT`; open that URL to see the same
code rendering on MapLibre.

## Verify before writing

Before emitting an API idiom you are unsure about, confirm it against the repo:

- `docs/quickstart.md` — guided quickstart walkthrough.
- `docs/shared-client-contract.md` — Dataset / Source / Query / Result design.
- `docs/protocol-capability-matrix.md` — which protocols support which operations.
- `docs/errors.md` — error classes and recovery.
- `INSTALL.md` — subpath entrypoint table and stability tiers.

Do not invent methods or options. If a symbol is not exported from a documented
subpath, it is not part of the public contract.
