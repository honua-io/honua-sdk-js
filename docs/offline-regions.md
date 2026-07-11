# Downloadable offline regions (experimental)

`@honua/sdk-js/offline` is the first bounded slice of issue
[#396](https://github.com/honua-io/honua-sdk-js/issues/396). It defines a
versioned manifest and a storage-neutral download coordinator. It does not make
the broader local-first feature complete.

```ts
import {
  createOfflineRegionManifest,
  downloadOfflineRegion,
} from "@honua/sdk-js/offline";

const manifest = await createOfflineRegionManifest({
  name: "Field area",
  sourceId: "incidents",
  endpoint: "https://example.test/FeatureServer/0",
  authorizationScopeFingerprint: currentAclFingerprint,
  bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
  minZoom: 8,
  maxZoom: 14,
  sourceVersion: "source-v3",
  schemaVersion: "schema-v7",
  planVersion: "plan-v2",
  observation: { state: "live", observedAt: "2026-07-10T10:00:00Z" },
  resources: plannedResources,
});

const receipt = await downloadOfflineRegion(manifest, {
  store: applicationStore,
  load: applicationResourceLoader,
  quotaBytes: 512 * 1024 * 1024,
  signal: abortController.signal,
  onProgress: renderProgress,
});
```

## Contract guarantees

- Manifest identity is deterministic over normalized content. Resource and
  attribution maps are sorted before hashing.
- URL credentials and recognized signed/auth query parameters are removed.
  Only a domain-separated SHA-256 digest of the caller's authorization scope
  fingerprint is persisted.
- Every resource has an exact byte length and required SHA-256 digest. The
  coordinator validates both before writing it. Each resource also carries
  source, schema, plan, and attribution identities inherited from the manifest
  unless the planner supplies more specific versions. Snapshot observation,
  validity, expiration, and HTTP validators remain explicit instead of making
  cached bytes appear live.
- Manifest allocation is bounded by resource count, total bytes, and
  descriptor-string bytes. Quota admission is deterministic: expired regions,
  then least-recently-used regions, then lexical id. Pinned regions are never
  automatically evicted.
- The injected transaction stages evictions and writes, then publishes them
  atomically with the manifest and receipt. Cancellation or failure requires a
  rollback. Storage implementations must satisfy that atomicity contract.
- Progress is explicit across planning, download, write, commit, and completion.
  A successful receipt always reports `integrity: "verified"`.

The manifest contains logical resource ids, not request URLs. The injected
loader may resolve short-lived signed URLs or authorization at download time;
those values never cross the persistent-store boundary.

## Non-goals and remaining work

This slice intentionally provides no IndexedDB or service-worker adapter, no
network reachability policy, no resumable partial transaction, no encryption
policy, no storage schema migration, no cached query/read integration, and no
local edit queue or replica conflict replay. Those remain required before issue
#396 can satisfy its GA acceptance criteria. This entrypoint is `@experimental`
and subpath-only so the root and browser bundles do not absorb it.
