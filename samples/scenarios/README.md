# Deterministic sample scenario harness

The harness binds to an ephemeral (`port: 0`) IPv4 loopback port and exposes a
readiness endpoint instead of requiring startup sleeps. Its declared CI budgets
are 2 seconds for startup and 100 milliseconds for reset. Fixture pages receive
a restrictive CSP (`connect-src 'self'`) and immutable loopback-only response
policy; absolute-form, forwarded, foreign Host/Origin, traversal, and proxy
requests are rejected.

Each run has a validated id, frozen clock, seeded id stream, authorization
scope, cursor/edit/event state, bounded sanitized request log, and serialized
mutation queue. A registry holds at most 16 runs by default, expires non-default
runs after five minutes, and closes bounded SSE subscriber queues during reset,
delete, TTL cleanup, or server shutdown.

Create a named scenario run:

```sh
curl -X POST http://127.0.0.1:PORT/__fixture__/runs \
  -H 'content-type: application/json' \
  -d '{"id":"worker-1","scenario":"paginated","authScope":"test-a"}'
```

Select it with `x-honua-fixture-run: worker-1` and the matching
`x-honua-fixture-auth-scope: test-a`. Reset it with
`POST /__fixture__/runs/worker-1/reset`; reset is idempotent and restores the
same clock, ids, data, cursor generation, and request-log baseline.
Generated OGC links retain a named run as the declared `run` query extension,
but never embed authorization scope or credentials. A protected run still
requires its scope header when a link is followed.

The scenario catalog includes happy, empty, unsupported, overflow, paginated,
throttled, abort, schema-drift, reconnect, duplicate-event, stale-cursor, range,
edit-conflict, cache-hit, cache-stale, cache-revalidate, and auth-scope lanes.
Throttle and abort outcomes are immediate deterministic responses; tests never
sleep to trigger either condition.

For First Map, `unsupported` removes Query from the GeoServices layer metadata,
removes OGC Features Core conformance and the collection items link, and rejects
a forced query with 405. The `overflow` lane serves at most two of the three
canonical records in one query page and emits protocol-native continuation
evidence (`exceededTransferLimit` or `numberMatched`/`next`).

The First Map OGC projection advertises only Features Core and GeoJSON. Its
checked-in service description declares `limit`, `bbox`, `datetime`, and the
deterministic `offset`/`run` fixture extensions; handlers reject undeclared or
duplicate query names. The GeoServices projection is read-only (`Query`). The
fixture's deliberately custom mutation contract lives at
`POST /__fixture__/runs/<run>/actions/edit`, outside the protocol surface.
