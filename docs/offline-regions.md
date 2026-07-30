# Downloadable offline regions (experimental)

`@honua/sdk-js/offline` is the first bounded slice of issue
[#396](https://github.com/honua-io/honua-sdk-js/issues/396). It defines a
versioned manifest and a storage-neutral download coordinator. It does not make
the broader local-first feature complete.

```ts doc-test=skip reason="partial excerpt requires application host context"
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
  logicalQuotaBytes: 512 * 1024 * 1024,
  signal: abortController.signal,
  onProgress: renderProgress,
});
```

## Contract guarantees

- Manifest identity is deterministic over normalized content. Resource ids,
  attribution ids, and object keys use locale-independent code-unit ordering.
- URL credentials and recognized signed/auth query parameters are removed.
  Only a domain-separated SHA-256 digest of the caller's authorization scope
  fingerprint is persisted.
- Every resource has an exact logical byte length and required SHA-256 digest.
  Loader output is copied into coordinator-owned memory before hashing, progress,
  or writing, so later loader mutation cannot alter committed bytes. Each resource also carries
  source, schema, plan, and attribution identities inherited from the manifest
  unless the planner supplies more specific versions. Snapshot observation,
  validity, expiration, and HTTP validators remain explicit instead of making
  cached bytes appear live.
- Untrusted manifests are synchronously normalized into an owned snapshot before
  any hash or adapter await. Plain shapes, dense arrays, resource/attribution/
  metadata counts, logical bytes, and incremental UTF-8 string bytes are bounded
  before copying, sorting, or canonical JSON construction.
- Quota is explicitly **logical payload-byte quota**: it sums declared resource
  payload lengths and does not claim physical disk occupancy, unique backing
  bytes, compression, deduplication, or store overhead. Admission is deterministic:
  expired regions, then least-recently-used regions, then code-unit id order.
  Pinned regions are never automatically evicted.
- The injected transaction stages evictions and writes, then publishes them
  atomically with the manifest and receipt. Commit compares the inventory
  revision used for planning and independently enforces logical quota in the
  same atomic mutation; a concurrent winner makes the loser return typed
  `inventory-changed` and roll back. Storage implementations must copy bytes
  before `write()` resolves and satisfy this CAS/atomicity contract.
- Progress is explicit across planning, download, write, commit, and completion.
  A successful receipt reports `integrity: "verified"` and
  `quotaAccounting: "logical-payload-bytes"`.
- The IndexedDB adapter uses a versioned schema. Startup upgrades legacy
  staging records, then performs one bounded atomic recovery pass. Malformed
  region metadata, orphaned or malformed resources, and invalid staging rows
  are removed while valid regions remain available; an invalid inventory
  revision is reset to the empty baseline. Recovery scans at most 100,000
  records and 64 MiB of persisted payloads, failing closed if those bounds are
  exceeded.
- IndexedDB staging is resumable by manifest identity. If a download is
  cancelled or its loader fails, verified staged resources are retained for a
  bounded period and the next attempt re-hashes them before loading only the
  missing resources. Staging contains resource bytes and ids only; credentials,
  URLs, and loader state are never persisted.

The manifest contains logical resource ids, not request URLs. The injected
loader may resolve short-lived signed URLs or authorization at download time;
those values never cross the persistent-store boundary.

## Non-goals and remaining work

This slice intentionally provides no service-worker adapter, network
 reachability policy, resumable partial transaction, encryption policy, storage
 schema migration, cached
query/read integration, or local edit queue/replica conflict replay. Those
remain required before issue #396 can satisfy its GA acceptance criteria. This
entrypoint is `@experimental` and subpath-only so the root and browser bundles
do not absorb it.
