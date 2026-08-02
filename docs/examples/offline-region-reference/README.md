# Network-disabled offline-region reference

This small browser host demonstrates the public `@honua/sdk-js/offline`
contracts without adding an SDK-owned service-worker policy. Its online pass
downloads one integrity-checked feature resource into the IndexedDB region
store. The host-owned worker caches only the reviewed same-origin application
shell, with ceilings of 128 assets, 4 MiB per asset, and 16 MiB total. A later
reload can therefore boot with networking disabled, read the resource through
`createOfflineRegionFetchHandler()`, and show its stale state, version
provenance, and attribution.

The Playwright coverage in `test/playwright/offline-indexeddb.spec.mjs` serves
these files from an isolated loopback origin. It also removes the downloaded
region through the public cache-admin contract before a disconnected reload,
proving that a cache miss is visibly unavailable rather than an empty
successful result.

This is a disconnected-read reference only. It does not implement reconnect,
edit replay, replica synchronization, or server acknowledgement semantics.
