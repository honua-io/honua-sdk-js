# Evidence-driven browser CI rollout

Issue [#1286](https://github.com/honua-io/honua-sdk-js/issues/1286) applies the
cross-repository CI architecture to the SDK's late browser evidence. The current
`JS SDK` job remains authoritative during this phase: it builds once inside the
job and executes every Playwright spec. The new browser-impact workflow only
records what four independently rerunnable browser domains would have selected.

## Why observation comes first

Direct file matching is not enough. A change to
`src/core/error-classifications.ts` changes compiled output pinned by the
offline-shell manifest, even though neither the changed path nor its name says
"offline". The policy therefore treats shared build, contract, core, runtime,
and configuration inputs as global. Unknown inputs also fail closed to all four
lanes. More precise ownership is promoted only from measured evidence.

The four domains are:

- `offline-service-worker`
- `realtime-collaboration`
- `heavy-map-kepler`
- `examples-general`

Every current `test/playwright/*.spec.mjs` file has exactly one owner. A new spec
falls into `examples-general`; a changed unowned input selects all lanes. The
workflow has read-only repository permissions, does not execute Playwright, and
cannot cancel or dispatch another workflow.

## Promotion contract

Routing remains observation-only until at least 20 representative pull-request
runs show all of the following:

1. every current and newly added Playwright spec has one stable owner;
2. no authoritative failure occurs in a lane the candidate would have skipped;
3. shared and generated inputs select every transitively affected lane;
4. unknown inputs continue to select all lanes;
5. the projected latency and billed-minute reduction is material.

Enforcement is a separate change with a rollback switch. It will consume one
immutable, content-addressed exact-head SDK build, normalize the offline-shell
manifest before Playwright, run the four domains as independent jobs, and expose
one aggregate required result. Missing, stale, digest-invalid, or incompatible
evidence falls back to a fresh build; it never uses a branch-prefix cache.

After enforcement, 30 additional runs must demonstrate under-15-minute p90
post-review verification and at least 60% fewer billed minutes for review churn
and failed-browser reruns. A failed-only rerun must leave successful job
timestamps unchanged.
