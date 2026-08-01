# Downloadable offline regions (experimental)

`@honua/sdk-js/offline` contains bounded, independently usable slices of issue
[#396](https://github.com/honua-io/honua-sdk-js/issues/396). It defines a
versioned manifest, storage-neutral download coordinator, persistent browser
store, and durable edit queue. It does not make the broader local-first feature
complete.

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createOfflineRegionDiagnostic,
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

const diagnostic = await createOfflineRegionDiagnostic(
  manifest,
  await applicationStore.inventory(),
  {
    logicalQuotaBytes: 512 * 1024 * 1024,
    now: new Date(),
    staleAfterMs: 15 * 60 * 1000,
  },
);
```

## Durable edit queue

The same subpath exposes a storage-neutral queue contract, a deterministic
in-memory implementation, and a persistent IndexedDB implementation. Queue
identity is partitioned by the already-digested authorization scope, source,
and an opaque application idempotency key.

```ts doc-test=skip reason="partial excerpt requires application replay transport"
import { createIndexedDbOfflineEditQueue } from "@honua/sdk-js/offline";

const queue = createIndexedDbOfflineEditQueue();
const enqueued = await queue.enqueue({
  authorizationScopeDigest: manifest.source.authorizationScopeDigest,
  sourceId: manifest.source.id,
  idempotencyKey: localMutationId,
  edit: {
    operation: "update",
    featureId: incidentId,
    attributes: { status: "contained" },
  },
});

const [leased] = await queue.claimReady({
  authorizationScopeDigest: manifest.source.authorizationScopeDigest,
  sourceId: manifest.source.id,
  workerId: replayWorkerId,
  limit: 1,
  leaseDurationMs: 30_000,
});

if (leased) {
  // The application sends leased.edit and leased.idempotencyKey through its
  // established hosted replica-sync transport, then persists the outcome.
  await queue.markApplied(leased.id, leased.lease.token, {
    serverOperationId,
    serverGeneration,
  });
}

console.log(enqueued.status); // "enqueued" or "duplicate"
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
- `createOfflineRegionDiagnostic()` produces a versioned, immutable explanation
  without reading payloads or mutating the store. It reports cache presence,
  freshness, atomic completeness, provenance, attribution, and the exact quota
  admission/eviction plan. Endpoint and ETag values are represented only by
  domain-separated SHA-256 fingerprints; the authorization scope was already
  reduced to its persisted digest when the manifest was created.
- Edit enqueue is atomic and idempotent within an authorization-scope/source
  partition. Reusing an idempotency key for different content is a typed error.
  Dependencies must already exist in the same partition, and every list or
  claim names that partition explicitly, so a replay worker cannot lease edits
  belonging to another authorization context.
- IndexedDB claims serialize their read/modify/write transaction across tabs.
  A compact indexed metadata store scans only the named partition and loads full
  payloads only for the bounded winning claim set. Active leases exclude
  competing workers, expired leases are recoverable, and applied, retryable,
  and conflicted outcomes are durable. A partition-scoped cancellation
  transition lets applications retire pending or retryable work that cannot
  proceed, including dependents of conflicted edits. Bounded terminal pruning
  preserves any record still required by active dependent work. Payload size,
  queue length, dependency count, list/claim/prune size, lease duration, and
  per-edit audit history are explicitly bounded. Audit history uses rolling
  retention with monotonic sequence numbers so its bound cannot prevent a
  progress-critical state transition. The persisted schema accepts no request
  headers, tokens, URLs, or raw authorization scope.

The manifest contains logical resource ids, not request URLs. The injected
loader may resolve short-lived signed URLs or authorization at download time;
those values never cross the persistent-store boundary.

## Non-goals and remaining work

The storage-backed fetch handler can be installed in a service worker or other
fetch integration, but the host still owns request matching and network
reachability policy. This slice does not provide encryption policy, a complete
application-level query/read cache, or an edit replay coordinator. The queue's
atomic deduplication and leases are local durability primitives; they do **not**
claim end-to-end exactly-once synchronization. Replay must integrate with the
established Honua Server replica-sync, upload-cursor, and conflict-review
contracts exposed to hosted applications through `@honua/app-platform`; this
offline storage subpath does not duplicate that client. That integration and
server-acknowledgement proof remain required before issue #396 can satisfy its
Beta acceptance criteria. This entrypoint is `@experimental` and subpath-only
so the root and browser bundles do not absorb it.
