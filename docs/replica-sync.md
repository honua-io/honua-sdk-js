# Disconnected replica sync

`@honua/app-platform/replica-sync` (the deprecated `@honua/sdk-js/replica-sync`
shim remains through 0.1.x) ships one product-level contract for disconnected
replica metadata and sync-conflict review — `ReplicaSyncTransport` — plus two
implementations of it:

| Transport                          | What it is                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `FixtureReplicaSyncTransport`      | In-memory reference semantics. No server, no network. Powers prototypes.    |
| `GeoServicesReplicaSyncTransport`  | The real HTTP transport, speaking honua-server's GeoServices replica dialect. |

Both pass the same suite, `runReplicaSyncTransportConformance`. That is the
point: a fixture that agrees with a real server only in TypeScript shape is not
a reference implementation.

```ts doc-test=skip reason="partial excerpt requires an application host and a running server"
const client = new HonuaClient({ baseUrl: "https://gis.example.com", apiKey });
const sync = createHonuaReplicaSync({
  transport: createGeoServicesReplicaSyncTransport({ client, serviceId: "parcels" }),
});

const capabilities = await sync.capabilities("parcels");
if (capabilities.conflictReview) {
  const conflicts = await sync.listConflicts({ datasetId: "parcels", statuses: ["pending"] });
}
```

Authentication rides the `HonuaClient` you pass in — API key, bearer token, or
an auth provider. The transport never reads, stores, or re-derives credentials,
and never places one on a URL.

## Endpoint contract

Every response shape below is pinned to a test in the `honua-io/honua-server`
repository. Those tests, not this document, are the contract; if one changes,
this transport must change with it.

| Transport call       | Server endpoint                                                                 | Server test that documents the shape |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| `capabilities`       | `GET /rest/services/{serviceId}/FeatureServer[/{layerId}]?f=json`                 | `FeatureServerReplicaSyncTests.ServiceMetadata_SyncEnabled_AdvertisesSyncCapabilities` |
| `listReplicas`       | `GET /api/v1/admin/services/{serviceId}/replicas`                                 | `ReplicaManagementEndpointTests.ListReplicas_AfterCreate_ReturnsRegisteredReplica` |
| `getReplica`         | `GET /api/v1/admin/services/{serviceId}/replicas/{replicaId}`                     | `ReplicaManagementEndpointTests.GetReplica_ForRegisteredReplica_ReturnsDetail`; `ReplicaConflictReviewEndpointTests.GetReplica_AfterRecentSync_ReportsActiveStatus` / `GetReplica_WhenLastSyncIsStale_ReportsExpiredStatus` |
| `listConflicts`      | `GET /api/v1/admin/services/{serviceId}/replicas/{replicaId}/conflicts[?status=]` | `ReplicaConflictReviewEndpointTests.ListConflicts_WhenPendingConflictExists_ReturnsConflict` / `ListConflicts_WhenBatchOfConflictsExist_ReturnsAllAndFiltersByStatus` |
| `getConflict`        | `GET …/conflicts/{conflictId}`                                                    | `ReplicaConflictReviewEndpointTests.GetConflict_ForPendingConflict_ReturnsBaseClientServerStates` / `GetConflict_ForResolvedConflict_ReturnsResolutionEvidence` |
| `resolveConflict`    | `POST …/conflicts/{conflictId}/resolve`                                           | `ReplicaConflictReviewEndpointTests.ResolveConflict_WithAcceptClient_CommitsNewServerStateAndMarksResolved` / `ResolveConflict_WithKeepServer_DoesNotCommitNewServerState` / `ResolveConflict_WhenAlreadyResolved_ReturnsConflict` / `ResolveConflict_WithUnknownAction_ReturnsBadRequest` |
| `createReplica`      | `POST /rest/services/{serviceId}/FeatureServer/createReplica`                     | `FeatureServerReplicaSyncTests.SynchronizeReplica_Download_DeliversPostReplicaChangesAndAdvancesServerGen` |
| `synchronizeReplica` | `POST /rest/services/{serviceId}/FeatureServer/synchronizeReplica`               | `FeatureServerReplicaSyncTests.SynchronizeReplica_MultiLayerUpload_AppliesPerLayerEdits`, `…_Bidirectional_AppliesUploadAndDeliversServerDelta`, `…_ConcurrentServerEdit_RecordsConflictAndAppliesLastWriteWins`, `…_GeometryOnlyConflict_ClassifiesAsGeometry` |
| `unregisterReplica`  | `POST /rest/services/{serviceId}/FeatureServer/unRegisterReplica`                 | `FeatureServerReplicaSyncTests.Replicas_AfterCreateAndUnregister_ReflectsLiveRegistryImmediately` |
| `applyEdits`         | `POST /rest/services/{serviceId}/FeatureServer/{layerId}/applyEdits`             | `FeatureServerApplyEditsConflictCodeTests` |

## Capability gating

Nothing is attempted before the service advertises it.

- **Sync not advertised.** `capabilities()` reads the FeatureServer metadata
  resource. If neither `syncEnabled: true` nor a `Sync` token in `capabilities`
  is present, it throws `HonuaCapabilityNotSupportedError` naming `Sync`.
- **`sync.offline` disabled.** The admin replica routes sit behind the server's
  `sync.offline` experimental capability gate, which answers a disabled
  deployment with **HTTP 404** and an `application/problem+json` body whose
  `type` is `honua:capability-experimental-disabled`. The transport recognizes
  that body and raises `HonuaCapabilityNotSupportedError` naming `sync.offline`.
  A disabled capability is a configuration state; surfacing it as "replica not
  found" would report configuration as data loss.
- **No durable conflict records.** A provider that cannot retain conflicts
  answers the conflict routes with HTTP 501; the transport raises
  `HonuaReplicaSyncError` with code `unsupported-conflict-review`, and
  `capabilities()` reports `conflictReview: false`.

`isReplicaSyncCapabilityRefusal(error)` is true for both vocabularies, so a
caller deciding whether to hide manual conflict review does not have to know
which transport it is talking to.

`conflictReview` / `conflictResolution` are *observed*, not assumed: the durable
review route is probed against the first registered replica. A service with no
replica yet gives the provider no chance to answer, so the flags report the
admin surface's reachability — and `listConflicts` / `getConflict` still fail
closed if the provider later denies review.

## Failing closed on dialect drift

The server surface is gated experimental (`sync.offline`,
honua-server#2430) and its GA hardening may move it. Every member this transport
reads is validated, and anything unrecognized raises
`HonuaReplicaSyncError` with code `response-drift` naming the member and the
observed value. There is no fallback mapping and no partially populated contract
object. Specifically refused:

- an unknown conflict classification, as a string (`conflictType: "topology"`)
  or as the sync response's ordinal;
- an unknown conflict lifecycle status or replica status;
- an unknown resolution action;
- an unpublished per-feature `applyEdits` error code — guessing whether a new
  code means "retry" or "stop" is worse than refusing;
- a server generation past `Number.MAX_SAFE_INTEGER`, which has already lost
  precision by the time it is parsed and would order edits wrongly;
- a `{ success, data }` envelope with no `data` member.

### Deliberate, documented losses

| Server value                        | Contract mapping                                                        |
| ----------------------------------- | ----------------------------------------------------------------------- |
| conflict status `deferred`          | `status: "pending"` (still open); raw value kept on `metadata.geoServices.status` |
| resolution action `chooseGeometry`  | `choice: "merge"`; raw action kept on `metadata.geoServices.resolutionAction` |
| resolution action `defer`           | no `resolution` record — a postponement closes nothing                   |
| `attachment` / `relationship` type  | feature-level `update` on both sides; raw type kept on `metadata.geoServices.conflictType` |
| replica sync direction              | always `bidirectional` — GeoServices chooses direction per call, not per replica |
| replica conflict policy             | always `last-writer-wins` — the upload pipeline commits the client edit *and* records a reviewable conflict |
| `sourceId`                          | omitted unless `sourceIdForLayer` is supplied; a service-local layer id is not a Honua `SourceId`, and a multi-layer replica has no single source |

**`merge` cannot be submitted.** The resolve endpoint's request body carries a
single `action` member and no merge payload. Sending `mergeFields` would commit
the *server's* merge, not the caller's, so a `merge` resolution is refused with
`unsupported-conflict-resolution` and every conflict advertises
`{ choice: "merge", available: false, reason: … }`.

## `applyEdits` conflict classification

`applyEdits` answers HTTP 200 even when individual features fail; the per-feature
`error.code` is the stable classification (honua-server#2251). The transport maps
each published code onto the offline replay acknowledgement vocabulary:

| Code | Name                  | Outcome      | Why |
| ---- | --------------------- | ------------ | --- |
| 1000 | `genericFailure`      | `retryable`  | unclassified provider failure during the write |
| 1001 | `invalidObjectId`     | `rejected`   | request shape; the same payload fails identically |
| 1002 | `notFound`            | `conflicted` | the "not-found" class — no row to update |
| 1003 | `deleteNotFound`      | `conflicted` | the "delete-delete" class |
| 1004 | `updateConflict`      | `conflicted` | the "update-update" class (optimistic concurrency) |
| 1005 | `featureLocked`       | `retryable`  | the "lock/locked" class |
| 1006 | `validationFailed`    | `rejected`   | request shape |
| 1007 | `notPermitted`        | `rejected`   | authorization |
| 1008 | `operationRolledBack` | `retryable`  | a sibling failed under `rollbackOnFailure` |

`classifyGeoServicesEditResult` is exported as a pure function so a caller can
classify a result it obtained by other means.

## Testing

`test/replica-sync-geoservices.test.ts` drives the transport against an
in-process `node:http` loopback server whose responses are transcribed from the
server repository's conformance tests (each citation is recorded in
`test/helpers/geoservices-replica-loopback-server.ts`). It runs the full
`runReplicaSyncTransportConformance` suite over both the GeoServices transport
and the fixture transport, exercises every documented `applyEdits`
classification, and covers the fail-closed drift and credential-discipline
cases.

### Live lane

The live lane needs a deployment with the server's `sync.offline` experimental
capability enabled, and it is not a PR gate.

**Deployment prerequisites**

1. **Edition: Pro.** The disconnected-sync surface is Pro-gated.
2. **Capability flag:** `Capabilities:Experimental:sync.offline:Enabled=true`
   (or the global `Capabilities:Experimental:Enabled=true`). Without it every
   admin replica route answers 404 with the capability-gate problem body.
3. **A sync-enabled service.** The FeatureServer metadata must advertise a
   `Sync` capability token / `syncEnabled: true`. Note that the stock
   `client-compat` seed does **not** advertise it (honua-server#2645), so a
   purpose-seeded service is required.
4. **A conflict-retaining provider** (Postgres) if the conflict-review cases are
   to reach a verdict rather than report `conflictReview: false`.

**Running it**

```bash doc-test=skip reason="requires a sync.offline-flagged deployment"
HONUA_REPLICA_SYNC_LIVE_ENABLED=true \
HONUA_REPLICA_SYNC_LIVE_BASE_URL=https://gis.example.com \
HONUA_REPLICA_SYNC_LIVE_SERVICE_ID=parcels \
npm run test:replica-sync:live
```

| Variable | Meaning |
| -------- | ------- |
| `HONUA_REPLICA_SYNC_LIVE_ENABLED` | Opt in to the lane. Off by default. |
| `HONUA_REPLICA_SYNC_LIVE_BASE_URL` | Deployment base URL. |
| `HONUA_REPLICA_SYNC_LIVE_SERVICE_ID` | A sync-enabled service id. |
| `HONUA_REPLICA_SYNC_LIVE_UNSUPPORTED_SERVICE_ID` | A service *without* sync, so the capability-refusal case can reach a verdict. |
| `HONUA_REPLICA_SYNC_LIVE_MUTATE` | Independent consent to run cases that write. Enabling the lane never implies it. |
| `HONUA_REPLICA_SYNC_LIVE_API_KEY` / `…_BEARER_TOKEN` | Credentials, passed to `HonuaClient`. |

Absence of a deployment is recorded as non-execution
(`live-lane-disabled`, `missing-base-url`, `missing-service-id`), never as a
pass, and a case that cannot reach a verdict on a given deployment is reported
`skipped` rather than silently passing.
