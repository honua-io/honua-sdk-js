# Network-disabled offline-region reference

This small browser host demonstrates the public `@honua/sdk-js/offline`
contracts without adding an SDK-owned service-worker policy. Its online pass
downloads one integrity-checked feature resource into the IndexedDB region
store. The host-owned worker caches only the reviewed same-origin application
shell, with ceilings of 128 assets, 4 MiB per asset, and 16 MiB total. A later
reload can therefore boot with networking disabled, read the resource through
`createOfflineRegionFetchHandler()`, and show its stale state, version
provenance, and attribution.

A disconnected pass also records one field edit in the durable IndexedDB edit
queue under a stable idempotency key, so a repeated disconnected launch returns
the existing edit rather than queueing a second copy. A connected launch runs
one bounded `replayOfflineEditPass()` over that same partition. The page then composes the
region diagnostic, the queued edits, and its own connectivity decision through
`createLocalFirstStatus()` and renders the single resulting state. Connectivity
is the host's decision here — derived from the shell's retained-generation
result and `navigator.onLine` — because the SDK deliberately refuses to infer
endpoint reachability. The composed state shows the documented precedence in
practice: with a readable region the disconnected pass reports `pending` rather
than `stale`, and after the region is removed it reports `partial` /
`missing-regions`, so a queued edit can never mask a missing cache.

The replay transport stays application-owned. This host binds it to
`/offline-edit-replay`, a **loopback fixture endpoint** that mirrors the
documented acknowledgement shape and keeps no replica, upload cursor, or
conflict store. That boundary is enough to prove the local transitions and
nothing more: an applied acknowledgement retires the edit once, so a second
pass claims nothing and the endpoint is never invoked again; a conflicted
acknowledgement leaves a durable typed conflict that is terminal rather than
retried; an acknowledgement naming a different operation identity records an
`unacknowledged` / `identity-mismatch` outcome and leaves the lease recoverable
once it expires; and a retryable acknowledgement schedules a durable backoff
instead of re-invoking the endpoint on the next launch. The request carries the
edit, its operation identity, and its source id — never the authorization
scope, lease, or audit state — and the fixture records only identities. **This
is not evidence of hosted replica synchronization.** End-to-end exactly-once
delivery is a server property; the fixture neither implements it nor stands in
for it.

Because the page supplies a replica binding, `createLocalFirstStatus()` also
publishes each conflicted edit projected onto the SDK's shipped sync-conflict
vocabulary as `localFirst.syncConflicts` — a `SyncConflictId`, the
`replica-sync` kind, the client operation, the feature, and the server
generation cursor when the acknowledgement carried one. The replica and dataset
identifiers are fixture constants owned by this page, because the SDK cannot
derive a replica from a queue partition and refuses to guess one. Every member
of `SyncConflictDetail` that only a live server can observe or adjudicate is
listed under `unavailable` rather than filled in, so the projection widens the
vocabulary without widening the claim.

`shell-manifest.v1.json` identifies one deployment and pins every document and
transitive SDK module by URL, byte length, SHA-256, and media type. The worker
fetches this manifest fresh and commits nothing unless every response matches,
so a rollout cannot combine a new entry point with an older dependency graph.
The media-type pin is checked before any body is staged: a deployment that
returns the pinned bytes under a `Content-Type` the browser refuses for that
role — a module served as `text/plain` — is rejected instead of replacing a
generation that still boots, because `fetch` itself enforces no module MIME
rule and the failure would otherwise surface only on the next offline reload.
Manifest and asset bodies are read incrementally and canceled as soon as their
declared or fixed byte ceiling is exceeded, so the ceilings also bound worker
memory use for a malformed response. `Content-Length` is used as an early check
only for identity encoding; compressed responses are bounded by their decoded
stream so valid small resources are not rejected by a larger wire size.
The same streaming ceiling is applied to the declared offline data resource
before the SDK receives any bytes for persistence.

Shell refresh is best effort once a complete generation exists. The worker
stages and validates the complete replacement under a new cache name, commits
it by changing one persistent active-generation pointer, and then removes the
previous generation. A failed request or budget check deletes the staging
cache and retains the prior shell. Replacing the whole generation also prevents
obsolete URLs from accumulating past the entry or total-byte ceilings across
deployments.
Only a generation named by the persistent commit pointer qualifies as retained;
unpointed or legacy caches are cleaned up but never trusted as a complete shell.
The normalized worker scope is part of every cache and lock name, so sibling
copies on one origin cannot delete each other's generations. A scope-specific
update lock serializes replacement across old and newly activated worker
instances, preventing either version from deleting the other's staging or newly
committed generation. A committed-generation marker is written only after its
pointer update, and cleanup re-reads the active pointer immediately before
removing each inactive generation, so overlapping worker lifecycles also fail
safe. Per-generation reader locks keep a selected immutable generation alive
through page probes and fetch matches. Readers acquire those locks without
queueing and retry the current pointer if cleanup already owns one, so a stalled
refresh cannot block an offline read of the prior committed shell.

The Playwright coverage in `test/playwright/offline-indexeddb.spec.mjs` serves
these files from an isolated loopback origin. It captures the edit with browser
networking disabled, reloads with networking still disabled, and observes the
same durable record — identity, payload, and audit history — before restoring
networking and observing one bounded pass apply it exactly once. It also
removes the downloaded
region through the public cache-admin contract before a disconnected reload,
proving that a cache miss is visibly unavailable rather than an empty
successful result. It also covers an unreachable origin while
`navigator.onLine` remains true, failed and oversized shell refreshes, and
replacement of an intentionally overfilled prior generation. A hanging refresh
is aborted before the host's response timeout, including while it waits behind
another refresh, so the committed shell remains usable across concurrent tabs.
The host also verifies an existing committed generation before refreshing and
treats a worker replacement, send failure, or late reply as retained only when
that prior shell is present. The worker's receipt deadline races the complete
replacement task, including non-abortable digest and Cache API work.
Query-bearing launch URLs are replaced in browser history with the
credential-free canonical document URL before the shell is declared ready.

This remains a bounded reference. "Reconnect" here means only that the loopback
fixture endpoint became reachable again: the workflow does not resume a
realtime cursor, reconcile a snapshot, implement replica synchronization, or
review conflict content, and its fixture acknowledgements are not server
semantics.
