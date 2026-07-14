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

The scenario catalog includes happy, empty, unsupported, paginated, throttled,
abort, schema-drift, reconnect, duplicate-event, stale-cursor, range,
edit-conflict, cache-hit, cache-stale, cache-revalidate, and auth-scope lanes.
Throttle and abort outcomes are immediate deterministic responses; tests never
sleep to trigger either condition.
