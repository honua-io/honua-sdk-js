---
type: reference
title: "Disconnected replica sync"
description: "Disconnected replica metadata and sync-conflict review over the GeoServices replica dialect: endpoints, capability gating, drift handling, and applyEdits conflict classification."
resource: "honua://capability/fieldops.offline-sync"
---
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

Every transport call maps to one server endpoint:

| Transport call       | Server endpoint                                                                 |
| -------------------- | ------------------------------------------------------------------------------- |
| `capabilities`       | `GET /rest/services/{serviceId}/FeatureServer[/{layerId}]?f=json`                 |
| `listReplicas`       | `GET /api/v1/admin/services/{serviceId}/replicas`                                 |
| `getReplica`         | `GET /api/v1/admin/services/{serviceId}/replicas/{replicaId}`                     |
| `listConflicts`      | `GET /api/v1/admin/services/{serviceId}/replicas/{replicaId}/conflicts[?status=]` |
| `getConflict`        | `GET …/conflicts/{conflictId}`                                                    |
| `resolveConflict`    | `POST …/conflicts/{conflictId}/resolve`                                           |
| `createReplica`      | `POST /rest/services/{serviceId}/FeatureServer/createReplica`                     |
| `synchronizeReplica` | `POST /rest/services/{serviceId}/FeatureServer/synchronizeReplica`               |
| `unregisterReplica`  | `POST /rest/services/{serviceId}/FeatureServer/unRegisterReplica`                 |
| `applyEdits`         | `POST /rest/services/{serviceId}/FeatureServer/{layerId}/applyEdits`             |

## Capability gating

Nothing is attempted before the service advertises it.

- **Sync not advertised.** `capabilities()` reads the FeatureServer metadata
  resource. If neither `syncEnabled: true` nor a `Sync` token in `capabilities`
  is present, it throws `HonuaCapabilityNotSupportedError` naming `Sync`.
- **`sync.offline` disabled.** The **admin** replica routes — and only those —
  sit behind the server's `sync.offline` experimental capability gate, which
  answers a disabled deployment with **HTTP 404** and an
  `application/problem+json` body whose `type` is
  `honua:capability-experimental-disabled`. The transport recognizes that body
  and raises `HonuaCapabilityNotSupportedError` naming `sync.offline`. A
  disabled capability is a configuration state; surfacing it as "replica not
  found" would report configuration as data loss.

  The FeatureServer replica endpoints (`createReplica`, `synchronizeReplica`,
  `unRegisterReplica`, `applyEdits`) are **not** behind that gate. A deployment
  with the capability disabled still creates and synchronizes replicas, so
  `capabilities()` reports `sync` / `createReplica` / `synchronizeReplica` as
  available with `conflictReview: false`, rather than failing the whole
  capability read. `listReplicas`, `listConflicts`, `getConflict`, and
  `resolveConflict` still raise the capability refusal — that is where a caller
  needs to see it.
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

The server surface is gated experimental (`sync.offline`) and its GA hardening may move it. Every member this transport
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
`error.code` is the stable classification. The transport maps
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
