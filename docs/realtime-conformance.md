# Realtime cross-transport conformance

The SDK proves its snapshot-plus-delta contract with one versioned corpus:
[`test/fixtures/realtime/cross-transport-conformance.v1.json`](../test/fixtures/realtime/cross-transport-conformance.v1.json).
The corpus is not adapter-specific. Every scenario runs through the public
`@honua/sdk-js/realtime` SSE, WebSocket, and OData delta factories and the same
resumable delivery gate.

## Deterministic fixture matrix

The ten scenarios cover steady-state snapshot/create/update/delete delivery,
transport duplicates, reordered events, sequence gaps, forced disconnect,
bounded-buffer overflow under a slow consumer, cursor expiry, explicit
resnapshot, cancellation, and terminal failure with repeated disposal.
Together they also assert:

- identical publicly observed event ids, sequences, records, tombstones, and
  diagnostics, including an overflow event observed before replacement-snapshot
  recovery;
- successful same-scope persisted checkpoint replay after a subscription
  restart, plus authorization-scope rejection for a mismatched checkpoint;
- replacement-snapshot recovery with no silently accepted gap event;
- bounded pending work and explicit overflow diagnostics;
- hashed checkpoint positions in telemetry, with no raw cursor or delta token;
- exactly one terminal callback and no remaining socket, request, callback,
  checkpoint, or inspected timer resource after repeated disposal;
- push freshness for SSE/WebSocket and poll cadence for OData, while server
  event time, client receipt time, and measured lag remain separate fields.

Source tests use fake timers and event-driven latches; they contain no fixed
sleeps and make no network requests.

The cancellation row holds the first checkpoint write open, queues the next
streaming mutation, and, for OData, starts a delta request whose fixture
deliberately ignores abort. It aborts while those owners are active, verifies
their signals, disposes repeatedly, releases the hostile work, and rejects any
late callback or state change. Socket handlers, request promises, callback
owners, checkpoint writes, and timers are counted independently; the evidence
reports zero only after every measured owner reaches zero.

```sh
npm run test:realtime:conformance
```

The installed-entrypoint lane builds the package and writes revision-bearing
evidence after all 30 scenario/transport executions pass:

```sh
npm run evidence:realtime:fixture
```

`npm run verify:packed-sdk` also installs the generated tarball into an empty
consumer project and runs the complete matrix against the package's
`@honua/sdk-js/realtime` export.

## Scheduled honua-server evidence

`.github/workflows/realtime-live-conformance.yml` first reruns the deterministic
matrix, then probes
`/api/v1/streaming/features/capabilities` on the reviewed server origin. It
executes each advertised SSE, WebSocket, or OData endpoint through the public
production wrapper. A server without the capability contract does not receive
fixture fallback.

An explicit `transports` array is authoritative. In particular,
`{"enabled":true,"transports":["websocket"]}` advertises WebSocket only;
`enabled: true` implies the legacy SSE endpoint only when `transports` is
absent.

### Discovering the deployment revision

The reviewed deployment identifies itself; the lane does not have to be told.
`deploymentRevision` — the field honua-server#3038 shipped on both
`/api/v1/streaming/features/capabilities` and `/api/v1/capabilities/manifest`,
alongside a `deploymentRevisionSource` of `commit-sha` or `image-digest` — is
read first, with `serverRevision`, `gitRevision`, `commitSha`, `imageDigest`,
and `revision` still accepted so an older deployment stays bindable. The
capability response is consulted first; the public manifest is probed only when
it leaves the revision or the release version unset.

Retained evidence records which document supplied it in `server.revisionSource`
(`capabilities`, `manifest`, or `fixture`). A revision and its provenance stand
or fall together: neither may appear without the other, and any document with
an `executed` transport requires both. When no immutable revision exists, the
`server-revision-missing` diagnostic names which probe came up empty —
`manifest-revision-absent` for a reachable but revision-less manifest,
`manifest-unreachable` for one that could not be read — because those are
different deployment problems.

### Absent inputs versus invalid ones

GitHub Actions renders an unset `workflow_dispatch` input or an undefined
repository variable as the empty string, so a scheduled run arrives with
`HONUA_REALTIME_LIVE_SERVER_REVISION=""` rather than with the variable absent.
Blank environment values are dropped at the boundary and treated as absent, not
as supplied-and-invalid. This is not cosmetic: before it was fixed, every
scheduled run rejected the blank revision, exited non-zero before opening a
single transport, and retained no live document at all — the lane whose entire
product is evidence produced none.

For the same reason a collector crash is itself a classified result. If the
live or fixture collector throws before it can classify anything, the lane
still writes a schema-valid document with all three transports `failed`, a
`collector-failed` diagnostic carrying the reason, and exit code `1` that
`--allow-degraded` cannot forgive. An operator reads the cause out of the
retained artifact rather than out of expiring workflow logs.

### Driving the mutation (controlled conformance)

A snapshot-plus-delta contract cannot be proved by watching a deployment and
hoping somebody edits a feature. The lane causes the mutation itself through
honua-server's controlled-conformance surface
([`honua-server#3038`](https://github.com/honua-io/honua-server/issues/3038)),
which is off by default and fails closed:

1. `POST /api/v1/streaming/conformance/runs` leases an isolated run and returns
   a run id, a one-time run token, an ownership marker, the dedicated
   service/layer, the bound immutable `deploymentRevision`, and a
   `baselineDigest` over every record no run owns.
2. Exactly **one** `insert` is applied **before any transport opens**, so every
   transport's baseline already contains the record.
3. Each transport then gets **one `touch`** of that same record, driven the
   moment its own baseline lands. `touch` rewrites a record with the values it
   already has: the state does not change but the write path still publishes an
   event. That is what lets transports the lane can only open sequentially
   reduce to one identical accepted history and one identical normalized final
   state. An `insert` per transport cannot converge, because the object ids
   differ.
4. `DELETE /api/v1/streaming/conformance/runs/{runId}` runs in the lane's
   `finally` block. The cleanup digest must equal the lease digest; equal
   digests are the proof that the run left the source exactly as it found it,
   and the comparison is retained in the evidence.

Every mutating request carries the per-run token in
`X-Honua-Conformance-Run-Token`. The token is held only in the run client's
closure, is never a property of any returned object, and never reaches a
retained document — evidence records the run id and the digests, and validation
rejects any document containing the token or its header name.

The controlled record must carry a geometry. honua-server's batched baseline
always writes `geometry` (even when null) while its delta envelope drops a null
one, and the SDK's honua-server decoder rejects an insert/update whose
after-image has no geometry member. The lane therefore checks the baseline
before spending a mutation on it and fails with the named
`conformance-record-geometry-missing` rather than an unexplained
`invalid-event`.

Deployment prerequisites for an executed controlled run — none of which this
repository can satisfy:

| Requirement | Why |
| --- | --- |
| `FeatureStreaming__Conformance__Enabled=true` | The surface is off by default; while off, no caller reaches it however authorized. Lease answers `403`. |
| `FeatureStreaming__Conformance__ServiceId` / `LayerId` pointing at a **dedicated** source | Every write targets the configured source and no request parameter can redirect it. It is deliberately not auto-created. |
| That source's schema carries `RunIdField` (default `conformance_run_id`) **and a geometry column** | Ownership is re-read from the stored marker on every mutation; a geometry-less record cannot survive the delta envelope. |
| `Deployment__ImageDigest` (preferred) or `Deployment__Revision` | Evidence is bound to an immutable revision. Without one, leasing fails closed with `503`. |
| WebSocket reachable over `wss:` off loopback | Advertised WebSocket URLs must use WSS unless the reviewed origin is loopback. |

The controlled run reports its own status, separate from the transports:

| Status | Meaning |
| --- | --- |
| `executed` | A run was leased, one insert and at least one per-transport `touch` were applied, and the baseline digest reversed. |
| `skipped` | Not attempted, and why: the write opt-in is off, the deployment publishes no `conformance` block, or it publishes `{"enabled": false}`. |
| `degraded` | The mutation surface was unavailable (`503`, timeout, network). No semantic conclusion is drawn. |
| `failed` | A run was driven but the contract was violated — a refused mutation, a lease bound to another revision, a baseline that did not reverse, or a source whose records no transport could accept. |

A `failed` run downgrades every otherwise-executed transport, because an
observation whose driven mutation cannot be trusted is not evidence. A
`skipped` or `degraded` run leaves the transports to their existing passive
classification; nothing is ever recorded as a pass that was not observed.

Each transport receives one explicit status:

| Status | Meaning |
| --- | --- |
| `executed` | The advertised endpoint produced accepted snapshot-plus-delta history and durable, redacted checkpoint evidence. |
| `unsupported` | The capability endpoint explicitly returns `404`/`405`, or a valid capability contract does not advertise the transport. This is recorded, never counted as execution. |
| `degraded` | Availability prevented a semantic conclusion, such as timeout, network failure, rate limiting, or server error. |
| `failed` | An advertised capability or transport violated the common contract. |

Fixture and live documents conform to
[`schemas/realtime-conformance-evidence.v1.json`](../schemas/realtime-conformance-evidence.v1.json).
They include the full SDK revision, the server's mutable release version,
immutable deployment revision, advertised capabilities, corpus digest, scenario
counts, result, freshness kind, and typed diagnostics. The immutable server
revision must be either a full 40-character commit SHA or a
`sha256:<64 lowercase hex characters>` image digest. It is never inferred from
the mutable release version. Any document containing an `executed` transport
requires that exact immutable identity; advertised transports fail closed when
it is missing or conflicts with the configured reviewed revision.

Live response admission is also bounded: capability JSON is limited to
1,048,576 bytes, and both an individual SSE event and the incomplete SSE parse
buffer are limited to 262,144 bytes. SSE limits count the raw wire bytes before
CRLF normalization, including raw line endings inside an event but excluding
the blank-line event delimiter. The evidence client cancels the response body
and fails an advertised transport closed when a ceiling is exceeded.
Capability authorization failures, oversized responses, and malformed HTTP-200
capability documents are `failed`, while timeout, network, rate-limit, and 5xx
availability failures are `degraded`.

The fixture corpus carries non-empty cursor, watermark, and delta-token
positions at every checkpoint. Telemetry evidence is accepted only when each
sample matches a durable checkpoint by `sequence` and `savedAt`, and each opaque
field equals
`sha256("honua-realtime-checkpoint-redaction:v1:<field>:<raw-value>")`.
Every successfully observed live transport also retains a structured accepted
event count, normalized state-transition-history SHA-256, and normalized final
state SHA-256. In the mutating snapshot-plus-delta lane, multiple executed
transports must agree on all three fields or all otherwise successful
observations fail with `cross-transport-state-divergence`. The read-only
baseline lane opens transports sequentially, so each transport reports its own
point-in-time baseline without asserting equality across observations.

Those hashes pass through one transport-neutral semantic boundary after the
public adapters decode their wire contracts. GeoJSON features from current
Honua feature-change envelopes and raw OData entities both become a stable
feature identity plus geometry and properties; string/integer forms of the same
safe-integer id compare equally. Snapshot replacement, mutation/delete kind,
tombstones, source attributes, geometry, and cross-event order remain
hash-visible. Routing source ids, cursor/watermark/delta-token wrappers, wire
event ids/sequences, and envelope timestamp/version fields are excluded.
Source-semantic update/version attributes remain properties and therefore
remain hash-visible.

For raw OData entities, the certified geometry shape is a property named
`geometry` (matched case-insensitively) whose value is the GeoJSON geometry
object. A missing geometry property means `null`; any differently named
attribute remains an ordinary hash-visible property instead of being guessed as
geometry, and multiple case variants fail closed as ambiguous.

The semantic model fails closed above 64 accepted events, 10,000 features per
event, 10,000 records or tombstones, depth 16, 500,000 visited nodes, 512 keys
per object, 100,000 items per array, 65,536 UTF-8 bytes per string, 25,000
geometry positions, or 16 MiB of canonical transition history. Ambiguous
same-event identities, a GeoJSON feature id that conflicts with its patch id,
non-finite values, malformed geometry, and unsupported object values are
semantic failures. Diagnostics remain generic and never retain the rejected
value.

The workflow retains both documents for 90 days.

The scheduled lane is opt-in outside GitHub Actions:

```sh
HONUA_REALTIME_LIVE_CONFORMANCE_ENABLED=true \
HONUA_REALTIME_LIVE_BASE_URL=https://demo.honua.io \
HONUA_REALTIME_LIVE_SOURCE_ID=maui-parcels \
HONUA_REALTIME_LIVE_LAYER_ID=1 \
npm run evidence:realtime:live
```

Add `HONUA_REALTIME_LIVE_SERVER_REVISION=<full-commit-sha-or-sha256-digest>`
only to assert that the deployment answering is the one you reviewed.

Driving the controlled mutation is a second, separate opt-in — enabling the
live lane is consent to observe a deployment, never consent to write to it:

```sh
HONUA_REALTIME_LIVE_CONFORMANCE_MUTATE=true \
HONUA_REALTIME_LIVE_CONFORMANCE_LABEL=nightly \
HONUA_REALTIME_LIVE_CONFORMANCE_TTL_SECONDS=300 \
... npm run evidence:realtime:live
```

`HONUA_REALTIME_LIVE_CONFORMANCE_MUTATE` is off unless explicitly true. When a
run is leased, its dedicated `serviceId`/`layerId` replace
`HONUA_REALTIME_LIVE_SOURCE_ID`/`HONUA_REALTIME_LIVE_LAYER_ID` as the
observation target — an insert into the conformance source is only observable
on a subscription scoped to that source. `HONUA_REALTIME_LIVE_CONFORMANCE_LABEL`
is recorded on the lease and on controlled records;
`HONUA_REALTIME_LIVE_CONFORMANCE_TTL_SECONDS` requests a lease TTL that the
server clamps to its configured bounds.

The scheduled workflow exposes the same switch as the `drive_controlled_mutation`
dispatch input (default `false`) and the
`HONUA_REALTIME_LIVE_CONFORMANCE_MUTATE` repository variable.

`HONUA_REALTIME_LIVE_SERVER_REVISION` is optional and is an expected-identity
constraint, not a source. The lane discovers the revision from the deployment
and compares the configured value with it, failing every advertised transport
on `server-revision-mismatch` when they disagree; it never substitutes the
configured value when the deployment publishes no immutable revision.
`HONUA_REALTIME_LIVE_SERVER_VERSION` may record a release label when the server
does not publish one. It does not satisfy the immutable revision requirement.
The server contract this lane drives landed in
[`honua-server#3038`](https://github.com/honua-io/honua-server/issues/3038); an
executed scheduled lane additionally needs a demo/staging deployment that
provisions the dedicated conformance source described above.

Strict exit codes are `0` for executed/explicitly unsupported capability, `1`
for semantic failure, and `2` for degraded availability. `--allow-degraded`
preserves the degraded evidence but changes exit code `2` to `0`.
