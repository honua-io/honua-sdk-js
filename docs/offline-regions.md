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

## Planning a snapshot and reading it back (experimental)

`planOfflineRegionSnapshot()` is the producer between the protocol-neutral
contract and the region store: it turns a source identity, a canonical `Query`,
a bounded extent, and the payloads an application already holds into a manifest
whose resource identities are deterministic functions of that selection. An
identity is derived from contract inputs — source id, normalized credential-free
endpoint, authorization-scope digest, source / schema / plan versions, extent,
canonical query, resource kind and selector — and never from a signed or
token-bearing request URL.

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  createMemoryOfflineRegionStore,
  createOfflineRegionFeatureBatch,
  createOfflineRegionSnapshotLoader,
  downloadOfflineRegion,
  encodeOfflineRegionFeatureBatch,
  planOfflineRegionSnapshot,
  readOfflineRegionQuery,
} from "@honua/sdk-js/offline";

const query = { outFields: ["id", "status"], returnGeometry: true };
const batch = createOfflineRegionFeatureBatch(await source.query(query), {
  pagination: { offset: 0 },
});

const snapshot = await planOfflineRegionSnapshot({
  name: "Field area",
  sourceId: source.descriptor.id,
  endpoint: source.descriptor.locator.url,
  authorizationScopeFingerprint: currentAclFingerprint,
  bounds: { minX: -158.3, minY: 21.4, maxX: -157.6, maxY: 21.8, crs: "EPSG:4326" },
  sourceVersion: "source-v3",
  schemaVersion: "schema-v7",
  planVersion: "plan-v2",
  observation: { state: "live", observedAt: new Date().toISOString() },
  attribution: { noaa: "Data: NOAA" },
  query,
  contents: [
    {
      kind: "features",
      bytes: encodeOfflineRegionFeatureBatch(batch),
      contentType: "application/json",
      attributionIds: ["noaa"],
    },
  ],
});

await downloadOfflineRegion(snapshot.manifest, {
  store: applicationStore,
  load: createOfflineRegionSnapshotLoader(snapshot),
  logicalQuotaBytes: budget.logicalBudgetBytes,
});

// Later, with no network at all.
const read = await readOfflineRegionQuery(snapshot.manifest, {
  store: applicationStore,
  authorizationScopeFingerprint: currentAclFingerprint,
  query,
  bounds: snapshot.manifest.bounds,
});
render(read.result.features, read.attribution, read.provenance.observation);
```

The read path answers only what the region actually holds:

- **Scope first.** The caller's current authorization-scope digest must equal the
  region's, or the read fails with `scope-mismatch`. A scope change can never
  serve another principal's cached bytes.
- **Fail closed, never narrow.** A version the region was not captured at, or an
  extent it does not cover, raises `out-of-region`; a selection it never stored
  raises `cache-miss`. Both classify as `offline.region.miss`.
- **Refuse rather than approximate.** A sub-extent of the region, an
  `aggregation`, or a `Query` member the read path does not understand raises
  `HonuaCapabilityNotSupportedError` naming the construct and the
  `offline-region` protocol, because answering any of them would require
  evaluating a predicate the snapshot never ran.
- **Pagination is a window, not an identity.** A stored batch records the window
  it captured, so a later page is sliced from it exactly. A page outside that
  window is a miss, never a short answer.
- **Freshness is reported, never repaired.** A stale region answers with an
  explicit `stale` decision, because revalidation implies a network the caller
  may not have.
- **Nothing is presented as live.** Every result carries a `Result.degraded`
  entry naming the region, its observation time, and its freshness.

`read.cache` reports the persistent-cache decision — region identity, query
fingerprint, authorization-scope digest, freshness, completeness, and exactly
which stored resources answered — and `read.planCache` feeds `explainQuery()` so
the query plan reports it too. A fresh region carries its manifest identity as
the plan's `fingerprint` validator, which binds the plan's own fingerprint to the
region that answered it; a stale region deliberately carries no validator.

## Tiles, assets, and metadata (experimental)

A region has always stored `tile`, `asset`, and `metadata` resources; those kinds
read back under exactly the same gate a feature batch does. Address them with the
typed selector builders so a snapshot and a later read agree without persisting
any URL:

```ts doc-test=skip reason="partial excerpt requires application host context"
import {
  offlineRegionAssetSelector,
  offlineRegionMetadataSelector,
  offlineRegionTileSelector,
  planOfflineRegionSnapshot,
  readOfflineRegionAsset,
  readOfflineRegionMetadata,
  readOfflineRegionTile,
} from "@honua/sdk-js/offline";

const snapshot = await planOfflineRegionSnapshot({
  ...selection,
  contents: [
    {
      kind: "tile",
      bytes: tileBytes,
      contentType: "application/vnd.mapbox-vector-tile",
      selector: offlineRegionTileSelector({ z: 12, x: 671, y: 1042 }),
    },
    { kind: "asset", bytes: spriteBytes, contentType: "image/png", selector: offlineRegionAssetSelector("sprite-2x") },
    {
      kind: "metadata",
      bytes: landingPageBytes,
      contentType: "application/json",
      selector: offlineRegionMetadataSelector("landing-page"),
    },
  ],
});

const tile = await readOfflineRegionTile(snapshot.manifest, {
  store: applicationStore,
  authorizationScopeFingerprint: currentAclFingerprint,
  tile: { z: 12, x: 671, y: 1042 },
});
render(tile.bytes, tile.contentType, tile.attribution);

const landing = await readOfflineRegionMetadata(snapshot.manifest, {
  store: applicationStore,
  authorizationScopeFingerprint: currentAclFingerprint,
  document: "landing-page",
});
console.log(landing.document); // parsed, because the stored media type is JSON
```

What these reads add to the shared discipline:

- **Tile coordinates are canonical, not clamped.** `normalizeOfflineRegionTileKey`
  reuses the contract's `QueryTileKey` vocabulary and folds a `tms` row onto its
  XYZ row, so the same geographic tile has one identity. Longitude wrapping is
  kept because a wrapped column is the same tile; an out-of-range row or zoom is
  refused, because the renderer's clamping would quietly address a *different*
  tile's bytes.
- **Coverage is answered before storage is touched.** A zoom outside the region's
  `minZoom`/`maxZoom`, or — when the region's CRS is provably WGS84 lon/lat — a
  tile whose envelope does not meet the region's bounds, is `out-of-region`. An
  unrecognized CRS makes no geometric claim at all; identity alone gates it and an
  uncovered tile is an honest `cache-miss`.
- **Bytes are opaque.** Tiles and assets are returned exactly as stored, with
  their declared media type. The SDK never re-encodes or transcodes one.
- **Media types are honoured, not guessed.** A metadata document is parsed only
  when it declares a JSON media type; bytes that verified against their digest but
  cannot be that media type are an `integrity-mismatch`, not a document.
- **Nothing is presented as live.** Each read carries the same `DegradedReason`
  vocabulary a `Result` does, on a `degraded` field, naming the capability the
  cached bytes stand in for — `tiles`, `render`, or `query`.

### Binding tiles to the map runtime

Offline tiles reach MapLibre through the protocol seam the runtime already uses
for other custom schemes, rather than a second tile pipeline. A style names
`offline-region://` tiles and the handler answers each one from the region.

The simplest binding is to hand `loadMapPackage` a handler and the style sources
that should come from storage. It rewrites those sources' tile templates and
registers the protocol before `map.setStyle`:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { createOfflineRegionTileProtocol } from "@honua/sdk-js/offline";
import { loadMapPackage } from "@honua/sdk-js/runtime";

const runtime = await loadMapPackage(pkg, map, {
  client,
  offlineRegion: {
    tileHandler: createOfflineRegionTileProtocol({
      manifest,
      store: applicationStore,
      authorizationScopeFingerprint: currentAclFingerprint,
    }),
    sourceIds: ["incidents"],
  },
});
```

Registration is driven by evidence, never by import. `@honua/sdk-js/runtime`
never imports `@honua/sdk-js/offline`: a handler is bound to one manifest, one
store, and one authorization scope, none of which the runtime can invent, so the
caller supplies it and the runtime decides only *when* it must be registered.
`ensureOfflineRegionProtocol()` is idempotent per scheme, exactly like the
PMTiles registration it shares a registry with, and a style that addresses the
scheme with no handler supplied **fails the load** — a missing handler would
render blank tiles rather than an error. The same check guards
`maplibreRenderer` for an owned map.

`rewriteStyleTilesForOfflineRegion()` is available on its own, and is
deliberately narrow:

- It rewrites `sources[id].tiles[0]` and nothing else, only for `vector`,
  `raster`, and `raster-dem` sources. TileJSON `url` members, GeoJSON `data`,
  sprites, glyphs, and layer paint are never touched.
- It is reversible: the result carries every replacement, and
  `revertOfflineRegionStyleRewrite()` restores the original style exactly.
- It refuses rather than guesses. A source that addresses tiles only through a
  TileJSON `url` (`tilejson-url-only`), carries both `url` and `tiles`
  (`ambiguous-tile-source`), declares more than one template
  (`multiple-tile-templates`), uses a placeholder a region cannot address such as
  `{quadkey}` or `{ratio}` (`unsupported-tile-template`), is not a tile source at
  all (`not-a-tile-source`), or has already been rewritten
  (`already-rewritten`) is reported with a reason and left untouched.
- `loadMapPackage` treats any refusal for a source the caller *named* as fatal,
  because leaving one on its network template would render live tiles while the
  application believed it was reading from storage.

A tile the region does not hold rejects with its typed reason instead of falling
back to the network or rendering nothing, and the handler declares `no-store` so
freshness, eviction, and provenance stay answerable from the region alone.

The same identities also plug into the existing service-worker seam.
`resolveOfflineRegionResourceId()` turns a selection into the resource id an
`OfflineRegionResourceMatcher` hands to `createOfflineRegionFetchHandler()`, so a
host that already matches its own tile URLs keeps doing exactly that.

`createMemoryOfflineRegionStore()` is a non-durable twin of the IndexedDB store
for Node, workers, and tests. Both pass one shared suite:

```ts doc-test=skip reason="partial excerpt requires application host context"
import { runOfflineRegionStoreConformance } from "@honua/sdk-js/offline";

const report = await runOfflineRegionStoreConformance({
  createStore: () => createMemoryOfflineRegionStore(),
  label: "memory",
});
console.log(report.failed === 0);
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

## Replay conflicts in the sync-conflict vocabulary

A conflicted acknowledgement records an opaque `conflictId` on the queued edit.
The SDK separately ships a conflict-review vocabulary — `SyncConflictDetail`,
`SyncConflictId`, `SyncConflictKind`, `ServerGenerationCursor`. Without a
projection an application holds two disjoint vocabularies for the same event.

`projectOfflineReplaySyncConflict()` is that projection, and only that: a pure
function with no I/O, no clock, and no runtime dependency on the replica-sync
module. Pass a replica binding to `replayOfflineEditPass()` or
`createLocalFirstStatus()` and the projection is applied to the conflicts those
surfaces already report — it is not a second channel.

```ts doc-test=skip reason="partial excerpt requires application replay transport"
import { projectOfflineReplaySyncConflict, replayOfflineEditPass } from "@honua/sdk-js/offline";

// The SDK cannot derive a replica from a queue partition, so the binding is an
// explicit application input. Omit it and no projection is produced; nothing is
// guessed.
const replica = { replicaId: registeredReplicaId, datasetId: registeredDatasetId };

const receipt = await replayOfflineEditPass(queue, transport, {
  authorizationScopeDigest: manifest.source.authorizationScopeDigest,
  sourceId: manifest.source.id,
  workerId: replayWorkerId,
  limit: 10,
  leaseDurationMs: 30_000,
  replica,
});

for (const outcome of receipt.outcomes) {
  if (outcome.syncConflict?.outcome !== "projected") continue;
  console.log(outcome.syncConflict.conflict.id); // a SyncConflictId
  console.log(outcome.syncConflict.conflict.kind); // "replica-sync"
  console.log(outcome.syncConflict.conflict.serverGen); // a ServerGenerationCursor
}

// The same projection is available directly for a record already in the queue.
const projection = projectOfflineReplaySyncConflict({ edit: conflictedQueuedEdit, replica });
```

Three rules make the projection safe to consume:

- **It never invents server semantics.** `SyncConflictDetail` members that only
  a live server can observe or adjudicate — `base`, `serverState`,
  `serverOperation`, `fieldConflicts`, `fieldConflictCount`,
  `hasGeometryConflict`, `geometryConflict`, `resolutionOptions`, `resolution` —
  are absent from the projected conflict and enumerated in
  `projection.unavailable` with the reason `server-owned`. Members the queue
  simply does not record (`layerId`, `client`, `device`, `metadata`, and
  `serverGen` when the acknowledgement carried none) are listed as
  `not-recorded`. An empty `resolutionOptions` array would read as "the server
  offers nothing", so the member is omitted instead.
- **It is payload-free.** `clientState` carries the operation, the delete
  marker, and the local authoring time, never the edit's attributes or geometry.
  Those two are listed as `payload-free` in `projection.unavailable`. The
  authorization-scope digest, request fingerprint, and idempotency key stay in
  the queue. `OFFLINE_REPLAY_SYNC_CONFLICT_FIELD_MAP` is the full ledger: every
  field of a durable queued edit, and where it lands or why it does not.
- **It fails closed.** A record this build cannot map yields
  `{ outcome: "refused", reason, path }`, never a partially guessed conflict.
  The reasons are `not-conflicted` (the edit is in another state),
  `missing-conflict-record` (`conflicted` with no durable outcome),
  `unidentified-feature` (a local create names no feature, and
  `SyncConflictSummary.featureId` is required), and `unreadable-edit`. A
  malformed replica binding is the caller's own argument, so it throws
  `HonuaOfflineEditQueueError` instead.

This makes the two vocabularies agree; it does not make the SDK a replica-sync
client. The replay transport is still application-owned, end-to-end
exactly-once delivery and hosted replica synchronization remain server
properties, and validating a projected conflict against live server conflict
semantics stays gated on that server work.

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
// Empty unless `replica` was supplied; see "Replay conflicts in the
// sync-conflict vocabulary" above.
console.log(status.writes.syncConflicts.length);
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

## Schema versions, migration, and an unreadable store

Two versions govern the persistent stores, and they are deliberately separate.

- The **IndexedDB database version** governs object stores and indexes. It moves
  when a store or index is added, and its `versionchange` upgrade is where
  structural work such as the legacy staging-timestamp backfill runs.
- The **persisted record-layout version** governs the shape of the values inside
  those stores. For the region store it is
  `HONUA_OFFLINE_REGION_SCHEMA_VERSION` (currently `3`), written into the
  `schema` store and **read back on every open**; for the edit queue it is
  `HONUA_OFFLINE_EDIT_QUEUE_VERSION`, stamped on every record and checked before
  any other field on every read.

### The region store's forward ladder

`OFFLINE_REGION_SCHEMA_MIGRATIONS` is an ordered registry of
`fromVersion` → `toVersion` steps, each a pure structural rewrite of one stored
record. On open the store reads the persisted version and resolves a plan before
touching anything:

- **Current version** — no steps, nothing rewritten.
- **A recognized older version** — the resolved chain is applied to every region
  record inside one transaction, then the new version is stamped. The applied
  chain is reported as `appliedMigrations` (for example `["2->3"]`).
- **An unknown, future, or unreachable version** — the store fails closed with
  `HonuaOfflineRegionError` code `store-unreadable`, naming the stored and
  expected versions. **Nothing is deleted.**

`planOfflineRegionSchemaMigration(version)` answers "can this store still be
read?" without opening it, and `readableOfflineRegionSchemaVersions()` lists the
versions this build accepts. The walk is bounded and cycle-safe, so a malformed
registry refuses rather than spinning.

A migrated record keeps exactly the identity it was stored under. Every step's
output is checked before the next one runs: a step that rewrote a region id, a
resource id, or the authorization-scope digest fails the record and aborts the
whole transaction, leaving the prior database version readable. Re-deriving the
scope digest would silently repartition another principal's cached bytes, so it
is treated as a defect rather than a migration.

The shipped `2 → 3` step is deliberately the identity on region records: that
database-version change altered only staging rows. It exists so the ladder, its
bounds, its identity invariants, and its refusal are exercised *before* the first
real layout change, rather than being written under the pressure of one.

### What an application should do when its store is unreadable

`store-unreadable` means the cached bytes are intact but this build declines to
interpret their layout — most often a version rollback, occasionally a
hand-modified database. It is not retryable and it is not corruption.

1. Report it. The regions are still on disk and still belong to the user.
2. Offer an explicit re-download, or a newer build that can read the layout.
3. Only then reset the store deliberately, with
   `indexedDB.deleteDatabase(name)`. The SDK will not do that for you, because
   cached region bytes are expensive to re-acquire — often over a metered or
   absent network — and a silent bulk delete is the worst available outcome.

Pass `onRecovery` to `createIndexedDbOfflineRegionStore` to observe every open.
The report separates the two failure modes on purpose:
`discardedCorruptRecords` counts records this build proved unusable and removed,
while `unsupportedRegions` counts regions left untouched because their schema
version has no path forward.

### The edit queue's recovery posture

The queue is the durable source of retry, lease, dependency, conflict, and audit
state, so a silently accepted malformed record there becomes a *wrong write*
rather than a lost read. Nothing persisted is trusted on the way back in.

- One bounded startup pass validates every edit, metadata, and tombstone row.
  Records past the record or byte ceiling fail with a typed
  `queue-limit-exceeded` instead of being scanned.
- Every read path revalidates, so a record written between passes — by another
  tab, or by a partially applied write — cannot be leased unvalidated.
- A record whose `version` is not `HONUA_OFFLINE_EDIT_QUEUE_VERSION` is
  discarded, never returned as though it were current.
- The metadata relationship is repaired in both directions: an index row whose
  edit is gone is deleted, and an edit whose index row is missing or disagrees
  has it re-derived from the edit itself. A damaged record no longer stalls a
  whole claim.
- Valid tombstones are always preserved — they are what stops a completed
  identity from being re-enqueued.

`onRecovery` reports counts and stable reason codes (`foreign-version`,
`corrupt-record`, `credential-screened`, `orphaned-metadata`, and the
`restored-metadata` repair) through the same offline error envelope every other
queue failure uses. Validation reads identity, state, and timing fields only; it
never reads an `edit.attributes` or `edit.geometry` value, and no report echoes
one. A discarded record is a lost local write, so recovery discards only what it
can prove is unusable, and it always says how many.

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
- The IndexedDB adapter uses a versioned schema, and the persisted version is
  read rather than only written. Startup resolves the record-layout version
  against an ordered forward migration ladder, migrates recognized older layouts
  atomically, and fails closed with `store-unreadable` — deleting nothing — for a
  layout it cannot reach. It then upgrades legacy staging records and performs
  one bounded atomic recovery pass. Malformed region metadata, orphaned or
  malformed resources, and invalid staging rows are removed while valid regions
  remain available; an invalid inventory revision is reset to the empty
  baseline. Corrupt-record discards and unsupported-version outcomes are
  reported as separate counts. Recovery and migration each scan at most 100,000
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
- Persisted queue records are validated, not trusted. One bounded startup pass
  plus per-read validation gate the record version, identity, state, timing,
  outcome, and audit fields before a record can be leased, transitioned, or
  replayed, and reconcile the metadata index in both directions. A
  foreign-version, corrupt, or credential-shaped record is discarded with a
  stable reason code and a count, never returned as though it were current.
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
