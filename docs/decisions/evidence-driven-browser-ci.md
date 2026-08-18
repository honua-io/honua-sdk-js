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
through its GitHub-managed check-run association, resolves the source run and
jobs through GitHub's attempt-specific APIs, and binds the run ID, attempt,
conclusion, and event-time base/head. It then confirms the associated
pull-request repository, base branch, and recorded head before reconstructing
the event-time synthetic merge tree from those immutable parents. A pull request
that closes or merges after the source run remains observable and can be
backfilled; a later target-branch advance does not alter that snapshot, while a
moved source head invalidates it. The candidate tree is inert input: the
observer executes no candidate script, action, package hook, or generated
executable. Its retained v2 report records the source head separately from the
synthetic `evaluation_sha` and content addresses the trusted observer workflow,
policy, resolver, and selector in a fixed manifest. Identity and the reconstructed
merge tree are resolved again immediately before evidence upload. Fork runs retain
the full authoritative `JS SDK` job but are explicitly excluded from the shadow
denominator, and non-default-base pull requests are neutral skips rather than
failed observations. A manual backfill accepts only the same completed canonical
run identity and can execute only from trunk. The policy commit is the event-time
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

A failed monolithic `JS SDK` job is also diagnostic-only until retained test
results identify the failed Playwright spec and therefore its owning lane. A
bare failed job conclusion cannot prove that a candidate-skipped lane would
have passed, so it never counts toward promotion.

Enforcement is a separate change with a rollback switch. It will consume one
immutable, content-addressed exact-head SDK build, normalize the offline-shell
manifest before Playwright, run the four domains as independent jobs, and expose
one aggregate required result. Missing, stale, digest-invalid, or incompatible
evidence falls back to a fresh build; it never uses a branch-prefix cache.

After enforcement, 30 additional runs must demonstrate under-15-minute p90
post-review verification and at least 60% fewer billed minutes for review churn
and failed-browser reruns. A failed-only rerun must leave successful job
timestamps unchanged.

## Superseded source runs are skipped, not failed

A workflow run is immutable; the check-run to pull-request association that
names it is not. GitHub recomputes that association from live repository state,
so two ordinary lifecycle events detach it from the run it describes: another
push to the pull request moves the association onto the newer head while the
run stays pinned to the head it actually ran, and merging or closing the pull
request and deleting its head branch withdraws the association entirely. The
run-attempt endpoint reports an empty `pull_requests` array for the same
reason, so the pull request cannot be recovered from immutable data either.

The resolver originally compared the live association against the immutable run
and treated any difference as an integrity failure. Because `workflow_run`
workflows always execute from the default branch, every such failure posted a
red check run against `trunk` — 16 of 40 consecutive observer runs, none of them
describing a real routing problem, all of them masking the next real one.

The resolver now classifies those two states as `SupersededSourceRunError`
rather than failing: the immutable evidence no longer names an observable pull
request, nothing can be compared, and the head that superseded it gets its own
`SDK CI` run and its own observation. Every other inconsistency — an ambiguous
association, a base branch that is not the default branch, a foreign repository
id, an unknown pull-request state — remains a hard failure.

Skipping must never be silent, which is the failure mode this repository has
already been burned by twice. A superseded run emits a warning annotation,
replaces the evidence artifact the observer always uploads with a record under
its own `honua.sdk.browser-impact-superseded/v1` schema carrying
`observed: false` and the reason, and repeats it in the job summary. The record
has no lane or comparison surface at all, so no consumer can mistake a skipped
observation for one that ran and selected nothing. `validateWorkflow` asserts
the classification, the step gating, and the record step are all present, so the
loud path cannot be removed without failing `SDK CI`.
