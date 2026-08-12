# Publish MVT to PMTiles

`@honua/sdk-js/pmtiles` separates workflows with different trust and maturity boundaries:

| Workflow | Client | Server | Evidence | Cleanup |
| --- | --- | --- | --- | --- |
| Inspect and render a direct archive | `supported` | `not-applicable` | deterministic range fixture | caller owns the object |
| Create a temporary `archive` | `experimental` | `supported` | contract-only fixture | server retention, currently 24 hours |
| Create a durable `publish` artifact | `experimental` | `supported` | contract-only fixture | republish replaces the deterministic key |
| Read a durable `RangeProxy` | `experimental` | `supported` | contract-only fixture | artifact remains server-owned |
| Delete a managed artifact | `unavailable` | `unavailable` | contract-only | use retention or operator storage tooling |

No managed end-to-end claim is made: a versioned public deployment manifest and pinned live publish canary do not exist yet. The client fails closed rather than promoting fixture evidence to a live claim.

## Inspect a direct archive

```ts doc-test=compile
import { inspectPmtilesArchive } from "@honua/sdk-js/pmtiles";

const inspection = await inspectPmtilesArchive({
  endpoint: "https://cdn.example.com/maps/maui.pmtiles",
  authorizationScopeFingerprint: "public",
});

console.log(inspection.metadata.bounds);
console.log(inspection.metadata.vectorLayers);
console.log(inspection.rendererSource?.maplibreSource);
```

Inspection uses the focused PMTiles discovery runner and the same pure validation primitives as generic `connect({ protocol: "pmtiles" })`; it does not retain or dispatch through the generic connector. It accepts exact bounded `206` responses only, binds cache replay to the authorization-scope digest and byte validator, and retains the complete range/decompression ledger. The existing [`pmtiles-static`](../examples/pmtiles-static/README.md) example remains the minimal server-optional renderer.

## Publish from a server-side process

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import { createHonuaPmtilesLifecycle, requirePmtilesJobSuccess } from "@honua/sdk-js/pmtiles";

const client = new HonuaClient({
  baseUrl: process.env.HONUA_BASE_URL!,
  auth: async () => ({ bearerToken: process.env.HONUA_ADMIN_TOKEN! }),
});
const pmtiles = createHonuaPmtilesLifecycle(client);
const job = await pmtiles.submitPublish({
  serviceId: "Maui",
  layerId: 7,
  minZoom: 0,
  maxZoom: 12,
  tileMatrixSetId: "WebMercatorQuad",
  maxTiles: 250_000,
});

const stop = job.watch((status) => console.log(status.currentPhase, status.percentComplete));
try {
  const complete = requirePmtilesJobSuccess(
    await job.wait({ signal: AbortSignal.timeout(10 * 60_000), maxAttempts: 600 }),
  );
  const source = pmtiles.registerSource({ publishedArtifact: complete.publishedArtifact });
  console.log(source.delivery, source.access, source.maplibreSource);
} finally {
  stop();
  job.dispose();
}
```

The lifecycle uses `HonuaClient.pipelineFetch`, so authentication, request interceptors, cancellation, timeouts, and HTTP normalization remain intact. Receipt and status bodies are capped at 256 KiB. Status/cancel URLs, job IDs, progress counters, enum encodings, artifact fields, and range-proxy paths are validated before use.

## Access and cache semantics

| Delivery | URL stability | Cache strategy | Signed URL behavior |
| --- | --- | --- | --- |
| direct archive | caller controlled | HTTP validator | optional caller-declared expiry |
| temporary archive | temporary | HTTP validator | server retention governs lifetime |
| public artifact | stable | HTTP validator | expiry is rejected |
| signed artifact | expires | signed URL | expiry is required and expired descriptors are rejected or use an explicit direct fallback |
| Honua range proxy | stable | Honua range proxy | path must match the artifact ID and server origin |

All renderer descriptors state that byte ranges are required. `archiveUrl` is renderer-neutral; `maplibreUrl` and `maplibreSource` are MapLibre-ready.

## Cancellation and cleanup

`job.cancel()` requests a server transition. `job.dispose()` only clears client listeners and does not claim to cancel or delete server work. Temporary archives expire under server retention. Durable artifacts are replaced by publishing the same service/layer/matrix key. Because Honua exposes no artifact DELETE route, `assertPmtilesManualCleanupSupported()` fails for every managed descriptor.

The complete server-side project, expected receipt, and troubleshooting steps are in the contract-only [`docs/examples/pmtiles-managed-lifecycle`](examples/pmtiles-managed-lifecycle/README.md) Walkthrough.
