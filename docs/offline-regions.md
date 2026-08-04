# Downloadable offline regions (experimental)

`@honua/sdk-js/offline` contains bounded, independently usable slices of issue
[#396](https://github.com/honua-io/honua-sdk-js/issues/396). It defines a
versioned manifest, storage-neutral download coordinator, persistent browser
store, durable edit queue, and composed local-first status. It does not make the
broader local-first feature complete.

The checked-in
[network-disabled reference workflow](./examples/offline-region-reference/README.md)
shows the public IndexedDB, diagnostic, fetch-handler, edit-queue, replay, and
status contracts booting through a host-owned application-shell worker when
networking is disabled before reload. It captures a field edit while
disconnected, keeps it across a reload taken with networking still disabled, and
replays it once on reconnect against a loopback fixture transport — which proves
the durable local transitions, not hosted replica synchronization.

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

## Storage budget and quota admission

`logicalQuotaBytes` is an honest accounting of declared payload lengths, but on
its own it has no relationship to the space the browser will grant. Ask the
platform instead of inventing a constant: `probeOfflineStorageBudget()` reads
`navigator.storage.estimate()` through an injectable interface and derives a
conservative logical budget.

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  downloadOfflineRegion,
  probeOfflineStorageBudget,
  requestOfflinePersistentStorage,
} from "@honua/sdk-js/offline";

const budget = await probeOfflineStorageBudget();
if (budget.status === "unavailable") {
  // No StorageManager, or no estimate. The SDK reports that rather than
  // fabricating a number; the application decides what to offer.
  showUnknownCapacity(budget.reason, budget.persistence);
} else if (budget.logicalBudgetBytes < manifest.totalLogicalBytes) {
  showTooLarge(budget.remainingBytes, budget.reserveBytes);
} else {
  await downloadOfflineRegion(manifest, {
    store: applicationStore,
    load: applicationResourceLoader,
    logicalQuotaBytes: budget.logicalBudgetBytes,
  });
}

// Only ever on an explicit user action: this can prompt.
if (budget.persistence === "best-effort" && userAskedToKeepData) {
  const persistence = await requestOfflinePersistentStorage();
  console.log(persistence.status); // "granted" | "denied" | "unavailable"
}
```

Derivation is deterministic integer arithmetic over the reported values:

```text
remaining = max(0, quota - usage)
reserve   = min(remaining, max(minimumReserveBytes, floor(remaining * headroomRatio)))
budget    = remaining - reserve
```

so the derived budget can never exceed the platform-reported remaining quota,
and an origin with less free space than the reserve floor (16 MiB by default) is
offered `0` rather than a number that cannot be honoured. The estimate is
deliberately imprecise and origin-scoped, so the result is **advisory, never a
guarantee** — which is exactly why a reserve exists and why physical occupancy,
deduplication, and index overhead stay outside the contract.

A device can still refuse a write the budget admitted. When it does, the
platform `QuotaExceededError` raised while staging, writing, or committing is
classified as `quota-exceeded` / `offline.region.quota` rather than the internal
`store-failed` / `offline.storage.failure` class, and the error carries the
admission plan that was attempted:

```ts doc-test=skip reason="partial excerpt requires application host context"
try {
  await downloadOfflineRegion(manifest, downloadOptions);
} catch (error) {
  if (isHonuaError(error, "offline.region.quota")) {
    // Required, evicted, and projected logical bytes, without recomputing them.
    showEvictionPrompt(error.admission);
  }
}
```

A refused plan is a proposal, not a record of what happened: a region refused
before the download starts evicts nothing, and no region outside
`admission.evictRegionIds` is ever removed. Pinned regions are never proposed.
`isStorageQuotaPressureError()` is exported so a host-supplied
`OfflineRegionStore` can classify the same condition the same way instead of
hiding a full device inside its own wrapper.

Persisted state changes the eviction risk for every cached region, so it is
observed rather than inferred: the probe reports
`persistence: "persisted" | "best-effort" | "unknown"`, and
`createOfflineRegionDiagnostic()` accepts the probe result and republishes it as
`diagnostic.storage`. The diagnostic never probes on its own, and
`navigator.storage.persist()` is reached only through
`requestOfflinePersistentStorage()` — a download is not consent to prompt.

## Durable edit queue

The same subpath exposes a storage-neutral queue contract, a deterministic
in-memory implementation, and a persistent IndexedDB implementation. Queue
identity is partitioned by the already-digested authorization scope, source,
and an opaque application idempotency key.

```ts doc-test=skip reason="partial excerpt requires application replay transport"
import { createIndexedDbOfflineEditQueue, replayOfflineEditPass } from "@honua/sdk-js/offline";

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

const receipt = await replayOfflineEditPass(queue, async (request, { signal }) => {
  const serverAcknowledgement = await sendThroughHostedMutationTransport(request, { signal });
  return {
    kind: "applied",
    editId: request.editId,
    requestFingerprint: request.requestFingerprint,
    idempotencyKey: request.idempotencyKey,
    serverOperationId: serverAcknowledgement.operationId,
    serverGeneration: serverAcknowledgement.generation,
  };
}, {
  authorizationScopeDigest: manifest.source.authorizationScopeDigest,
  sourceId: manifest.source.id,
  workerId: replayWorkerId,
  limit: 10,
  leaseDurationMs: 30_000,
});

console.log(enqueued.status); // "enqueued" or "duplicate"
console.log(receipt.appliedCount);
```

## Composed local-first status

Cache diagnostics answer "what is in the store", and the queue answers "what
have I not delivered". `createLocalFirstStatus` composes both, plus a
host-supplied connectivity signal, into one versioned, payload-free snapshot
that names a single state.

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createLocalFirstStatus } from "@honua/sdk-js/offline";

const partition = {
  authorizationScopeDigest: manifest.source.authorizationScopeDigest,
  sourceId: manifest.source.id,
};

const status = createLocalFirstStatus({
  // Reachability is host policy. The SDK never reads navigator.onLine, because
  // link state is not endpoint reachability.
  connectivity: endpointReachable ? "online" : "offline",
  now: new Date(),
  regions: [diagnostic],
  // A bounded detail sample for conflicted identities and timing...
  edits: await queue.list({ ...partition, limit: 100 }),
  // ...and the authoritative totals, because list() is capped at 100 records
  // and has no cursor.
  editCounts: await queue.countByState(partition),
});

console.log(status.state); // "pending"
console.log(status.reason); // "undelivered-edits"
console.log(status.reads.availability, status.reads.freshness);
console.log(status.writes.coverage); // "complete"
console.log(status.writes.undeliveredCount, status.writes.conflictedCount);
```

`OfflineEditQueue.list()` returns at most 100 records in created order and has
no cursor, so it can never be counted. Pass `editCounts` from
`countByState()`, which reads the partition/state index without materializing
any edit payload; the returned totals are authoritative and drive both
`writes.counts` and the headline state. Without it, `writes.coverage` is
`sampled` and the counts are only a lower bound, so a partition whose first 100
records are terminal would read as `idle` while later work is still
undelivered. A sample that disagrees with its own totals is rejected rather
than published.

The headline `state` is resolved by a total, deterministic precedence. Data
problems outrank undelivered work, which outranks mere staleness, which
outranks being disconnected:

| Precedence | `state` | `reason` | Condition |
| --- | --- | --- | --- |
| 1 | `conflicted` | `conflicted-edits` | Any queued edit is in the `conflicted` state. |
| 2 | `expired` | `expired-regions` | Any stored region is expired. |
| 3 | `partial` | `partial-regions` / `missing-regions` | Regions were supplied and worst-case completeness is not `complete`. |
| 4 | `pending` | `undelivered-edits` | Any edit is `pending`, `leased`, or `retryable`. |
| 5 | `stale` | `stale-regions` | Any stored region is stale. |
| 6 | `offline` | `disconnected` | Connectivity is `offline` and nothing above applies. |
| 7 | `online` | `connected` | Connectivity is `online` and nothing above applies. |

Aggregation is worst-case, so one expired or partial region cannot be hidden by
fresher siblings. Freshness aggregates over *stored* regions only: a cache miss
has no stored observation to age. `reads.availability` is `live` when the host
reports connectivity, `cached` when it does not but a region is readable, and
`unavailable` when it is neither. The status is deeply frozen, JSON
serializable, deterministic for identical inputs regardless of supplied order,
and never reads `edit.attributes` or `edit.geometry`.

Cache facets are validated together, not independently. A diagnostic is derived
from one stored entry, so `state`, `freshness`, `completeness`, `reason`, and
`readable` cannot vary freely; a tampered or hand-built combination that the
diagnostic could never have produced is rejected instead of resolving to a
confidently wrong headline.

## Contract guarantees

- Manifest identity is deterministic over normalized content. Resource ids,
  attribution ids, and object keys use locale-independent code-unit ordering.
- URL credentials and recognized signed/auth query parameters are removed.
  Only a domain-separated SHA-256 digest of the caller's authorization scope
  fingerprint is persisted.
- **Persisted identities are non-secret by contract, and the stores enforce it.**
  `name`, `sourceId`, `resource.id`, `contentType`, attribution ids and text, and
  the source/schema/plan versions are screened against the same credential
  denylist that governs endpoint normalization. Machine identities are also
  refused when they are shaped like a request reference — an absolute URL
  carrying userinfo, a query, or a fragment, or a relative reference containing
  `?`, `#`, or `@` — so an ArcGIS `?token=` or S3 `?X-Amz-Signature=` URL cannot
  become a stored identity by way of an `OfflineRegionResourceMatcher`. Human
  prose (`name`, attribution text) is held only to the embedded-assignment and
  absolute-URL rules, so an ordinary label is still persistable. A match fails
  the whole manifest closed with `invalid-manifest` and a structured `path`;
  nothing is silently rewritten, because a rewritten identity would change the
  deterministic region id and the resource primary key, and the rejection names
  the path without echoing the offending value. Screening is defence in depth: it
  is not a licence to pass secrets as identities.
- The enforcement is not a trust assumption about the caller.
  `createIndexedDbOfflineRegionStore`, `beginWrite`, and `commit` are public
  exports, so `beginWrite` and `write` re-screen the region and resource ids they
  key staged rows by, and `commit` re-checks the whole manifest — endpoint
  included — before it opens its IndexedDB transaction. A caller that bypasses
  `downloadOfflineRegion` cannot persist a credential-bearing manifest. The
  durable edit queue applies the same screen to `sourceId` and `idempotencyKey`,
  which are its persisted partition and identity keys.
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
- The ceiling itself can be derived from the origin's real storage estimate.
  `probeOfflineStorageBudget()` performs no network I/O, mutates nothing, never
  requests persistence, returns no credential or request URL, and is
  deterministic for identical inputs. A platform without a `StorageManager` or
  an estimate yields an explicit `unavailable` result instead of a fabricated
  budget. A refusal by the device is typed `quota-exceeded` and carries the
  attempted admission plan.
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
  progress-critical state transition. Pruning removes payload and audit data
  but retains a compact identity/request-fingerprint tombstone for the lifetime
  of the named queue database; a completed identity cannot silently be
  re-enqueued after cleanup, and an applied tombstone continues to satisfy
  future dependency IDs. The persisted schema accepts no request headers,
  tokens, URLs, or raw authorization scope.
- `replayOfflineEditPass()` claims immediately before each sequential
  invocation of an application-owned transport, up to one explicit pass bound.
  Transport requests omit authorization
  scope, lease, and audit state. Applied, retryable, and conflicted responses
  must be plain bounded data whose edit id, request fingerprint, and idempotency
  key all match the leased edit before the queue can transition. Its immutable
  receipt contains edit ids and outcome/reason codes, never payloads or thrown
  transport error text.

The manifest contains logical resource ids, not request URLs. The injected
loader may resolve short-lived signed URLs or authorization at download time;
those values never cross the persistent-store boundary.

## Non-goals and remaining work

The storage-backed fetch handler can be installed in a service worker or other
fetch integration, but the host still owns request matching and network
reachability policy. This slice does not provide encryption policy, a complete
application-level query/read cache, a server transport adapter, or an automatic
connectivity loop. `createLocalFirstStatus` composes state that already exists;
it does not probe reachability, trigger reconnect, or revalidate a stale region.
The queue and one-pass coordinator are local durability
primitives; they do **not** claim end-to-end exactly-once synchronization.
Applications must bind the injected transport to established Honua Server
replica-sync, upload-cursor, and conflict-review contracts exposed through
`@honua/app-platform`; this offline storage subpath does not duplicate that
client or manufacture server acknowledgement. End-to-end integration evidence
remains required before issue #396 can satisfy its Beta acceptance criteria.
This entrypoint is `@experimental` and subpath-only so the root and browser
bundles do not absorb it.
