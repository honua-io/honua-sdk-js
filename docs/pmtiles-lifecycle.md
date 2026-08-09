# Publish MVT to PMTiles

Use this path when a published Honua vector layer needs one durable PMTiles v3
artifact for CDN or serverless map delivery. Direct archive consumption and
Honua-managed publication are separate maturity lanes: direct reads are
supported; managed jobs and range-proxy descriptors are experimental.

## Capability and lifecycle matrix

| Workflow | Client | Honua Server | Evidence | Cleanup |
| --- | --- | --- | --- | --- |
| Inspect/render a direct archive | supported | not required | deterministic range fixtures | caller owns the object |
| Create a temporary `archive` | experimental | tile operations + cloud storage | SDK fixture only | server TTL, currently 24 hours |
| Create a durable `publish` artifact | experimental | tile operations + cloud storage | SDK fixture only | re-publish overwrites the deterministic key |
| Read through `RangeProxy` | experimental | `GET`/`HEAD /api/v1/tiles/pmtiles/{artifactId}` | SDK fixture only | artifact remains server-owned |
| Delete a managed artifact manually | unsupported | no public DELETE route | not claimable | use retention or operator storage tooling |

No Maui live endpoint is claimed. The focused sample accepts a proxy URL, but
its catalog live state remains `planned` until a versioned evidence manifest
names and probes a deployed artifact.

## Prerequisites

- A published vector layer that already serves MVT.
- Honua Server admin credentials and configured cloud file storage.
- A Node or server-side process. Never put an admin token in a browser bundle.

## 1. Create the authenticated client

```ts
import { HonuaClient } from "@honua/sdk-js/honua";
import { createHonuaPmtilesLifecycle } from "@honua/sdk-js/pmtiles";

const honua = new HonuaClient({
  baseUrl: process.env.HONUA_BASE_URL!,
  auth: { async getCredentials() { return { bearerToken: process.env.HONUA_ADMIN_TOKEN! }; } },
});
const pmtiles = createHonuaPmtilesLifecycle(honua);
```

The lifecycle uses `HonuaClient.pipelineFetch`, retaining authentication,
interceptors, timeout, cancellation, and normalized HTTP behavior. Receipt and
status JSON is capped at 256 KiB.

## 2. Submit durable publication

```ts
const job = await pmtiles.submitPublish({
  serviceId: "Maui",
  layerId: 7,
  minZoom: 0,
  maxZoom: 12,
  tileMatrixSetId: "WebMercatorQuad",
  maxTiles: 250_000,
});
```

Use `submitArchive()` for a 24-hour operator download instead of a durable
browser source.

## 3. Poll typed progress

```ts
const stop = job.watch((status) => console.log(status.currentPhase, status.percentComplete));
const status = await job.wait({
  signal: AbortSignal.timeout(10 * 60_000),
  maxAttempts: 600,
  pollIntervalMs: 1_000,
});
stop();
```

Call `requirePmtilesJobSuccess(status)` before consuming output. Failed and
cancelled states raise typed errors rather than becoming empty success.

## 4. Register the durable source with a direct fallback

```ts
import { requirePmtilesJobSuccess } from "@honua/sdk-js/pmtiles";

const complete = requirePmtilesJobSuccess(status);
const source = pmtiles.registerSource({
  honuaBaseUrl: process.env.HONUA_BASE_URL!,
  publishedArtifact: complete.publishedArtifact,
  directArchiveUrl: "https://cdn.example.com/fallback/maui.pmtiles",
});

console.log(source.maturity);       // honua-range-proxy for RangeProxy
console.log(source.archiveUrl);     // renderer-neutral HTTP(S) URL
console.log(source.maplibreSource); // vector + pmtiles:// URL
```

The direct fallback is selected only when the published descriptor is missing
or a signed access URL is expired. Range-proxy/public URLs are stable; signed
URLs expose their expiry and report `accessStable: false`.

## 5. Use the focused Maui proxy shape

The existing MapLibre sample retains its committed archive by default. Point it
at a reviewed deployed proxy without adding a browser credential:

```bash
VITE_HONUA_MAUI_PMTILES_PROXY_URL=https://your-honua.example/api/v1/tiles/pmtiles/ARTIFACT_ID \
npm run demo:pmtiles-static
```

There is deliberately no default public proxy URL or live-demo claim.

## 6. Cancel and clean up

```ts
await job.cancel({ signal });
```

Cancellation requests a server transition; poll if the final state matters.
`dispose()` only clears client listeners. Current cleanup is intentionally
narrow: archive output expires through the server TTL; durable output is
overwritten by re-publishing the same service/layer/matrix; the server exposes
no manual artifact DELETE route.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `400` on submit | Verify layer, zoom order, bbox order, and cloud storage. |
| Publish fails before upload | Inspect `errorMessage` and `warnings`; the prior artifact remains untouched. |
| Browser gets `416` | Confirm exact byte-range support and stable archive identity. |
| Public/signed object fails in a browser | Allow `GET`/`HEAD` and `Range`; expose range, length, ETag, and last-modified headers. |
| Signed URL expired | Re-publish to rotate it or use the reviewed direct fallback. |

Project: [SDK issue #1118](https://github.com/honua-io/honua-sdk-js/issues/1118).
