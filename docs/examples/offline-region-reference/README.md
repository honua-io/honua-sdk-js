# Network-disabled offline-region reference

This small browser host demonstrates the public `@honua/sdk-js/offline`
contracts without adding an SDK-owned service-worker policy. Its online pass
downloads one integrity-checked feature resource into the IndexedDB region
store. The host-owned worker caches only the reviewed same-origin application
shell, with ceilings of 128 assets, 4 MiB per asset, and 16 MiB total. A later
reload can therefore boot with networking disabled, read the resource through
`createOfflineRegionFetchHandler()`, and show its stale state, version
provenance, and attribution.

`shell-manifest.v1.json` identifies one deployment and pins every document and
transitive SDK module by URL, byte length, and SHA-256. The worker fetches this
manifest fresh and commits nothing unless every response matches, so a rollout
cannot combine a new entry point with an older dependency graph.
Manifest and asset bodies are read incrementally and canceled as soon as their
declared or fixed byte ceiling is exceeded, so the ceilings also bound worker
memory use for a malformed response.
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
An origin-scoped Web Lock serializes replacement across old and newly activated
worker instances, preventing either version from deleting the other's staging
or newly committed generation. A committed-generation marker is written only
after its pointer update, and cleanup re-reads the active pointer immediately
before removing each inactive generation, so overlapping worker lifecycles also
fail safe. Failure receipts read the pointer and retained cache under the same
lock, so they cannot observe a generation halfway through a worker swap.

The Playwright coverage in `test/playwright/offline-indexeddb.spec.mjs` serves
these files from an isolated loopback origin. It also removes the downloaded
region through the public cache-admin contract before a disconnected reload,
proving that a cache miss is visibly unavailable rather than an empty
successful result. It also covers an unreachable origin while
`navigator.onLine` remains true, failed and oversized shell refreshes, and
replacement of an intentionally overfilled prior generation. A hanging refresh
is aborted before the host's response timeout, including while it waits behind
another refresh, so the committed shell remains usable across concurrent tabs.
The host also verifies an existing committed generation before refreshing and
treats a worker replacement, send failure, or late reply as retained only when
that prior shell is present.
Query-bearing launch URLs are replaced in browser history with the
credential-free canonical document URL before the shell is declared ready.

This is a disconnected-read reference only. It does not implement reconnect,
edit replay, replica synchronization, or server acknowledgement semantics.
