---
type: reference
title: "Installed First Map bundle regression"
description: "Measure public installed SDK bundles against the canonical First Map byte limits."
---
# Installed First Map bundle regression

The bounded installed JavaScript client journey must stay below the canonical
First Map chunk budget: 1,990,000 JavaScript bytes and 525,000 gzip bytes.

The gzip ceiling was explicitly raised by 1,000 bytes in PR #2010 after renderer
tree-shaking reduced the installed bundle. CI's fresh consumer resolved MapLibre
6.14.0 and measured 1,968,771 raw / 524,289 gzip bytes; the fixed-dependency
comparison on 6.13.0 measured 1,969,286 / 523,861. The raw-byte ceiling, peer
identity checks, measurement scope, and CPU limits remain unchanged. The
[basemap receipts](evidence/basemap-1717/README.md) retain both measurements and
the passing calibrated CPU result. Historical receipts below retain their
then-current ceilings.

Run `npm run test:installed-quickstart` to install the manifest-pinned public SDK
and peers into a fresh consumer, check its npm integrity, build the canonical
quickstart through public package entrypoints, and measure the written chunks.
The receipt is `test-results/installed-quickstart-budget.json`. It includes the
package identity, dependency versions and integrities, lock digest, SDK module
count, MapLibre module origins, and actual byte measurements. The existing
budget counts Rollup/Vite chunks; worker assets stay in the sample's final-byte
inventory and are not silently added to or removed from that budget's scope.

`npm run test:installed-quickstart -- --measure-execution` additionally runs the
installed production bundle with the canonical fixture build environment in
three cold Chromium contexts. The ordinary public-endpoint byte measurement
remains the top-level verdict; the separately built fixture graph and its bytes
are recorded under `execution.bundle`. It disables the network cache, blocks external HTTP
requests, applies a fixed 4× CPU throttle, and requires the first usable map frame
before recording costs. The receipt records page main-thread script CPU time separately from
parse/compile trace spans, including browser, CPU, operating system, Node, source
input hashes and whether the checkout was dirty. Parse/compile spans are merged
per thread to avoid nested-event double counting; they are elapsed spans, while
script duration uses Chromium thread CPU ticks and excludes worker script CPU.
With `--measure-execution`, costs have status `measured`. The CI lane uses
`--enforce-execution-budget` to additionally require the calibrated runner profile
and explicit median ceilings described below. Any execution failure also fails
the top-level receipt. Existing chunk and peer-identity limits still apply.
The module inventory also reports the largest rendered SDK modules to guide
actual graph reductions.

The default registry lane measures the declared legacy `0.1.9-beta.0` candidate
in the certification config; it is not the current `0.1.14` distribution baseline.
Compare current-source optimizations using packed-development runs under one lock.

`--local-tarball` packs the current prepared SDK build, verifies archive integrity,
and really installs it under default peer resolution. It refuses stale or missing
prepared-build provenance; run `npm run build`, `npm run build:browser`, and
`npm run prepare:test-sdk:adopt` first. Its receipt explicitly says
`inputMode: "packed-development"` and binds the source SHA, dirty status, source
input digest, dist digest and tarball integrity. This is development evidence,
not a registry or candidate-certification result.

Each run saves its consumer lock beside the receipt as `*.consumer-lock.json`.
Pass `--consumer-lock <path>` to reuse that resolution for before/after comparisons;
the runner fails if the installed renderer version or integrity changes. The SDK
input can change while the exact MapLibre peer remains fixed.

`npm run test:installed-quickstart -- --prove-regression` additionally removes
only the runtime-peer alias from the loaded configuration and requires the
historical failure: two MapLibre runtime modules and an over-budget build. The
corrected build must then use exactly one runtime and satisfy both ceilings.
A second injected defect keeps that runtime fix but removes the worker/style
resolution fix; it passes the byte ceiling and must fail the new peer-identity
check. The corrected runtime, worker, shared module and CSS must all resolve
from the installed peer.
No SDK source or local package build may enter either installed graph.

The defect is a split resolver graph: the example's MapLibre import resolves
beside the repository while the installed SDK's runtime import resolves beside
the clean consumer. Both runtimes survive tree shaking. Resolve the example's
declared runtime peer beside the SDK too. MapLibre 5's legacy entry fields and
MapLibre 6's export map are both supported. Worker and stylesheet subpaths
resolve from the same installed peer, with its public export map enforced.

The retained reproduction on `@honua/sdk-js@0.1.9-beta.0` measured 2,953,782 /
773,645 written chunk bytes before the fix and 1,979,893 / 523,377 after it.
The source-mode build measured 1,953,828 / 516,171. No ceiling changed.

This is a bundle regression receipt, not a live-server certification receipt.
The historical #39 installed-example receipt still records #1584 as failed.
The issue's corrected coordinated-candidate publication and certification rerun
remain outstanding; a successful harness repair must not rewrite historical
failed candidate evidence or certify an unpublished replacement package.

## Windows replay, 2026-09-13

The saved `fix/1584-installed-quickstart-budget` work was rebased onto trunk;
the peer, worker and stylesheet fixes and both defect injections are retained.
The runner now uses the native npm launcher and normalized module paths, with
its isolated consumer inside the worktree's `test-results` directory.

`test-results/installed-quickstart-budget.windows.json` retains the public
`0.1.9-beta.0` integrity and full dependency resolution, including MapLibre
`6.9.0`. Removing the peer fix reproduces two renderer copies and measures
3,108,365 JavaScript / 831,838 gzip bytes. The corrected graph contains one
renderer, and its worker and CSS share the installed peer, but it still measures
2,050,733 / 550,795 bytes. **The frozen 1,990,000 / 524,000 limits fail.**

Trunk's separate source-example ceiling was raised by the MapLibre security
upgrade. A successful Vite build under that ceiling cannot certify this issue:
the receipt now independently checks both frozen ceilings before choosing its
verdict. Regression tests exercise each one-byte overage, missing/invalid
measurements, and failed build/peer checks. Both PR verification workflows run
them through `test:installed-package-certification`.

The clean-consumer run exits nonzero and writes `status: "failed"`; the #39
historical failed row remains unchanged. Compatible corrected published bytes
and a passing rerun under the original limits remain required to close #1584.

### Measured packed-development comparison (2026-10-11)

[Recorded receipts and consumer locks](./evidence/distribution-1413/) bind this
comparison to source `5aac8654325f20845dc37a386f0f8999d683bb83` and its admitted
SDK Verification producer artifact from run `38128568010`. Both installs used
identical dependency versions and integrities, including MapLibre 6.13.0, and
identical packed SDK integrity. The lockfile hashes differ because each local
archive has its own temporary file URL. These are development measurements;
they do not replace the declared legacy registry candidate or certify a release.

| Minifier | Public-path JavaScript | Public-path gzip | Median script CPU | Median parse/compile spans |
| --- | ---: | ---: | ---: | ---: |
| Vite 8 default Oxc | 1,887,373 bytes | 503,941 bytes | 864.0 ms | 648.1 ms |
| Safe Terser, two passes | 1,883,654 bytes | 504,620 bytes | 772.6 ms | 322.4 ms |

CPU measurements used the separate canonical fixture build, Chromium
145.0.7632.6 on Linux x64 / Intel Core Ultra 7 165H, three cold browser contexts
and fourfold CPU throttling. Terser parse/compile samples ranged from 264.6 to
868.7 ms, so the median does not establish a stable performance improvement.
Its public and fixture builds took 122.6 and 130.6 seconds. Terser was rejected:
gzip grew by 679 bytes and build cost rose substantially. The canonical
configuration therefore retains Vite's default minifier. Both measured public
bundles passed the unchanged installed byte ceilings; both fixture executions
reached the first usable map without page errors.

To reproduce the historical experiment, use that source commit, admit its exact
producer artifact, build the browser artifacts, and run the packed-development
command with `--baseline-default --measure-execution`. Then repeat without
`--baseline-default`, passing the first receipt's saved `--consumer-lock`.
That experimental flag and Terser dependency exist at the recorded commit;
they are deliberately absent from the current configuration. The current execution gate uses the subsequent controlled CI calibration below.

The package-verification CI job measures the packed generic First Map on its
provisioned Chromium runner and uploads `packed-first-map-execution` receipts
(with a `-graph` suffix in SDK Verification), including the exact consumer lock.
The execution gate requires Ubuntu 24.04 x64, Chromium major 145, three cold
contexts and 4× CPU throttling. It enforces median script CPU ≤175 ms and median
parse/compile spans ≤110 ms. The first controlled CI calibration, run
`38130548203` at source `8b5b0a0580c9bc95561a2eee4709fc94be0775ca`, measured
134.518 ms and 80.796 ms respectively on an AMD EPYC 7763. The ceilings give
approximately 30% and 36% headroom over those observed medians. CPU models are
recorded rather than promised by GitHub's runner label; this initial CI regression
gate is not a universal device-performance guarantee. A second run (`38130548207`,
GitHub test-merge source `b304bef78d2d14be3242bbe51c308775e699da48`) recorded
105.291 ms script and 47.329 ms parse medians on an AMD EPYC 9V45; the raw
merge receipt is recorded separately from the exact-head producer receipt. A changed runner image,
browser major, throttle, missing sample or exceeded ceiling fails admission and
requires fresh calibration. Local machines can still use measurement-only mode.

[The calibration receipt and consumer lock](./evidence/distribution-1413/)
preserve the packed identity and dependency resolution. The live/default graph
passed the unchanged 1,990,000 JavaScript / 524,000 gzip byte ceilings at
1,887,373 / 503,941 bytes. The separate fixture graph is used for execution,
never substituted for the ordinary byte verdict. Current trace aggregation
excludes named waiting spans; historical receipts retain their original events.
