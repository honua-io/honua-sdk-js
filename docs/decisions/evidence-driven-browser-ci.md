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
lanes. Shared application modules may name multiple consumer lanes, while each
browser spec still has one execution owner. More precise ownership is promoted
only from measured evidence. The observer runs from the default branch after
the canonical `SDK CI` workflow completes. It resolves the exact `JS SDK` job
through its GitHub-managed check-run association, binds the source run ID,
attempt, conclusion, event-time base/head, and current unchanged pull request,
then reconstructs the exact GitHub synthetic merge used by that job. Both merge
parents must match the immutable association. The candidate tree is inert
input: the observer executes no candidate script, action, package hook, or
generated executable. Its retained v2 report records the source head separately
from the synthetic `evaluation_sha` and content addresses the trusted observer
workflow, policy, resolver, and selector in a fixed manifest. Identity and merge
parents are resolved again immediately before evidence upload. Fork runs retain
the full authoritative `JS SDK` job but are explicitly excluded from the shadow
denominator; a manual backfill accepts only the same completed canonical run
identity and can execute only from trunk. The policy commit is the event-time
default-branch snapshot: a concurrently advanced trunk remains valid only when
that snapshot is still an ancestor of the fetched default-branch tip.
Rename observations evaluate both the removed and added path, preventing a move
into an ignored tree from hiding the dependency that was removed. Policy
validation also extracts contiguous example paths and split
`path.join(projectRoot, "docs", "examples", ...)` roots from every browser spec,
walks each fixture's local example graph, resolves its direct SDK package entry
points back to source, and proves those dependencies select the spec's owning
lane. SDK-internal barrels are not expanded as if every re-export were executed;
shared compiler and bundler inputs remain global.

The four domains are:

- `offline-service-worker`
- `realtime-collaboration`
- `heavy-map-kepler`
- `examples-general`

Every current `test/playwright/*.spec.mjs` file has exactly one owner. A new spec
falls into `examples-general`; a changed unowned input selects all lanes. The
workflow has an exact read-only actions/checks/contents/pull-request permission
allowlist, does not execute Playwright, and cannot publish status, cancel,
dispatch, push, or merge.

## Promotion contract

Routing remains observation-only until at least 20 representative pull-request
runs show all of the following:

1. every current and newly added Playwright spec has one stable owner;
2. no authoritative failure occurs in a lane the candidate would have skipped;
3. shared and generated inputs select every transitively affected lane;
4. unknown inputs continue to select all lanes;
5. the projected latency and billed-minute reduction is material.

A receipt is not counted when the `JS SDK` job was skipped/canceled, when the
source PR changed the authoritative `ci.yml`, or when it changed the observer's
own workflow, policy, resolver, or selector. Those runs still fail closed to the
appropriate lanes and remain useful diagnostics, but they cannot prove parity
for promotion.

Enforcement is a separate change with a rollback switch. It will consume one
immutable, content-addressed exact-head SDK build, normalize the offline-shell
manifest before Playwright, run the four domains as independent jobs, and expose
one aggregate required result. Missing, stale, digest-invalid, or incompatible
evidence falls back to a fresh build; it never uses a branch-prefix cache.

After enforcement, 30 additional runs must demonstrate under-15-minute p90
post-review verification and at least 60% fewer billed minutes for review churn
and failed-browser reruns. A failed-only rerun must leave successful job
timestamps unchanged.
