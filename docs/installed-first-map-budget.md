# Installed First Map bundle regression

The bounded installed JavaScript client journey must stay below the canonical
First Map chunk budget: 1,990,000 JavaScript bytes and 524,000 gzip bytes.

Run `npm run test:installed-quickstart` to install the manifest-pinned public SDK
and peers into a fresh consumer, check its npm integrity, build the canonical
quickstart through public package entrypoints, and measure the written chunks.
The receipt is `test-results/installed-quickstart-budget.json`. It includes the
package identity, dependency versions and integrities, lock digest, SDK module
count, MapLibre module origins, and actual byte measurements. The existing
budget counts Rollup/Vite chunks; worker assets stay in the sample's final-byte
inventory and are not silently added to or removed from that budget's scope.

`npm run test:installed-quickstart -- --prove-regression` additionally removes
only the runtime-peer alias from the loaded configuration and requires the
historical failure: two MapLibre runtime modules and an over-budget build. The
corrected build must then use exactly one runtime and satisfy both ceilings.
No SDK source or local package build may enter either installed graph.

The defect is a split resolver graph: the example's MapLibre import resolves
beside the repository while the installed SDK's runtime import resolves beside
the clean consumer. Both runtimes survive tree shaking. Resolve the example's
declared runtime peer beside the SDK too. MapLibre 5's legacy entry fields and
MapLibre 6's export map are both supported; exact aliases leave CSS subpaths
under ordinary package resolution.

The retained reproduction on `@honua/sdk-js@0.1.9-beta.0` measured 2,953,782 /
773,645 written chunk bytes before the fix and 1,979,893 / 523,372 after it.
The source-mode build measured 1,953,828 / 516,171. No ceiling changed.

This is a bundle regression receipt, not a live-server certification receipt.
The historical #39 installed-example receipt still records #1584 as failed.
The issue's corrected coordinated-candidate publication and certification rerun
remain outstanding; a successful harness repair must not rewrite historical
failed candidate evidence or certify an unpublished replacement package.
