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
state SHA-256. Multiple executed transports must agree on all three fields or
all otherwise successful observations fail with
`cross-transport-state-divergence`.

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
HONUA_REALTIME_LIVE_SERVER_REVISION=<full-server-commit-sha-or-sha256-image-digest> \
npm run evidence:realtime:live
```

`HONUA_REALTIME_LIVE_SERVER_REVISION` is an expected-identity constraint. The
lane compares it with a revision observed from server metadata; it never
substitutes the configured value when the deployment publishes no immutable
revision.
`HONUA_REALTIME_LIVE_SERVER_VERSION` may record a release label when the server
does not publish one. It does not satisfy the immutable revision requirement.
The dedicated snapshot/sequence/controlled-mutation server contract needed for
an executed scheduled lane is tracked in
[`honua-server#3038`](https://github.com/honua-io/honua-server/issues/3038).

Strict exit codes are `0` for executed/explicitly unsupported capability, `1`
for semantic failure, and `2` for degraded availability. `--allow-degraded`
preserves the degraded evidence but changes exit code `2` to `0`.
