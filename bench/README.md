# SDK benchmark lab

The default benchmark lab is deterministic, offline, and machine-readable. It
runs the scenarios in [`corpus.json`](./corpus.json), applies the reviewed rules
in [`budgets.json`](./budgets.json), and writes a versioned JSON report with the
fixture hash, Git commit, Node/OS/CPU metadata, repeated samples, summary
statistics, and budget outcomes.

```sh
npm run bench:lab
```

The report is written to `test-results/benchmark-lab.json`. CI uploads it as the
`sdk-benchmark-lab` artifact. To compare a candidate with an intentionally
captured baseline on the same runner class:

```sh
npm run build
node dist/bench/lab.js --check \
  --baseline path/to/benchmark-lab.json \
  --output test-results/benchmark-lab.json
```

The expanded resilience corpus and report use `schemaVersion: 2`. Version 1
readers must reject or upgrade before consuming the new scenario/sample unions;
the lab marks a version 1 baseline `not-compared` rather than silently treating
it as compatible.

`budgets.json` uses `schemaVersion: 2`, which adds the `absolute` section
alongside `variability` and `relativeRegression`. Absolute budgets are keyed by
scenario id and then metric name, declare a `direction` plus a required
`failure` and an optional `warning` threshold, and are evaluated on **every**
run with no baseline required — see the columnar data-plane scenario below for
the first set. They fail closed: a budget naming a scenario the corpus did not
produce, or a metric the scenario does not report, is a failure.

Relative budgets are not evaluated when the corpus hash, SDK implementation,
OS/kernel release, architecture, Node major, CPU model, CI/local mode, or
available GitHub runner-image identifier differs. Two local reports may both
omit a runner-image identifier; a report with one present is never compared to
one without it. A skipped comparison is reported as `not-compared`; it is never
presented as a pass. Review the complete baseline diff before committing or
publishing a replacement.

The current corpus measures SDK stream/decode overhead, opaque GeoParquet
planning/resolution, deterministic offline-region reload, and resumable realtime
reconnect semantics. The opaque-resource scenario repeatedly plans, serializes,
keys, rotates, and resolves an execution-time locator entirely in process. It
checks that rotation preserves cache identity, authorization partitions do not,
and no private locator marker reaches the report. The offline
scenario downloads verified fixture resources through the supported storage
boundary, serializes the credential-free manifest, reloads it repeatedly, and
checks integrity and a fixed freshness window. The realtime scenario restores a
durable checkpoint, performs one synthetic retry, replays duplicates, and
checks cursor presence, sequence order, and deduplication. Reports expose only
cursor presence, never the opaque value. Both scenarios use fixed clocks and
in-memory adapters and make no network requests.

The report records semantic checks next to timing samples. A stale/corrupt
offline reload, sequence gap, applied duplicate, or missing cursor makes
`--check` fail even when timing variance is acceptable. These scenarios do
not trust a declared secrecy flag: the v2 report derives `artifactSafety` from
the complete final projection and fails if any scenario or top-level field
contains credential-shaped or opaque cursor material. These scenarios do
**not** measure network, server, first map render, renderer frame rate, or
another SDK. See
[`docs/benchmark-methodology.md`](../docs/benchmark-methodology.md) for the
comparison and live-evidence rules.

## Cross-SDK reference preflight

`npm run bench:references` validates the separate, versioned
[`cross-sdk/corpus.json`](./cross-sdk/corpus.json), its synthetic fixture digest,
locked package identities, and primary-source license/terms decisions. It emits
`test-results/cross-sdk-reference-corpus.json`. This is a reproducibility and
legal-equivalence preflight, not a performance report: every task remains
`not-measured`, `crossSdkComparable: false`, and `rankingPermitted: false` until
one future same-run result artifact passes the reviewed output/environment
validators.

Eligible open-source references are Honua, MapLibre GL JS, standalone deck.gl,
and local-ellipsoid CesiumJS. Esri and current Mapbox GL JS remain unavailable
pending explicit legal approval for public comparative publication. The CARTO
platform path is not comparable in the credential-free lane because CARTO APIs
require authentication; standalone deck.gl is represented separately and is
never mislabeled as a CARTO result. No third-party implementation or hosted
data is copied into the corpus.

The Honua entry binds the exact committed `HEAD:src` Git tree, not an npm
release with the same version string. Any source change intentionally
invalidates the normal preflight. After reviewing and committing the `src/`
delta, use this offline recovery workflow exactly as written:

```sh
npm run bench:references:source-tree
npm run bench:references:source-tree:write
git diff -- bench/cross-sdk/corpus.json
npm run bench:references
npm run bench:lab
```

The inspection command prints the current 40-character tree even when the
checked-in pin is stale. The explicit write command preserves every other byte
and changes only `honua-sdk-js.package.sourceTree.gitTree`; stop if the review
diff shows anything else. Neither command refreshes terms or contacts a third
party. The subsequent reference and lab commands remain the fail-closed gates
for source-tree drift, fixture digests, package identities, license evidence,
and terms decisions. Eligible license files are bound by local SHA-256 and
contained to `LICENSE` or locked `node_modules` package roots (realpath
containment also rejects symlink escapes).

Terms reachability is refreshed explicitly, never during deterministic PR
gates. `npm run bench:references:refresh-terms` performs bounded eight-second
HEAD requests against only the committed primary URLs and records status/final
URL metadata in `test-results/cross-sdk-terms-refresh.json`; it stores no
third-party terms content. A maintainer reviews that artifact before advancing
`reviewedAt`/`reviewExpiresAt`. Reachability alone never changes a legal
decision.

## Deterministic browser rendering corpus

`npm run bench:browser` builds the fixture-backed flagship and runs two real
Chromium/WebGL journeys: Honua's MapLibre path renders the quickstart and opens
a linked feature popup, while Honua's deck.gl adapter projects 10,000 binary
points without copying their attribute buffers, renders them, and resolves a
stable picked feature. Each journey has one warm-up and three measured runs.
Install the repository's pinned Chromium once with
`npx playwright install chromium` when the normal Playwright setup has not
already done so; the benchmark itself never downloads a browser or reaches a
data service. The runner blocks and records any non-loopback browser request so
an accidental external basemap or API dependency fails the journey invariant.

The report and PNG evidence are written beneath
`test-results/browser-benchmark/`. The JSON records raw samples, median, p95,
coefficient of variation, browser/OS/CPU/viewport/WebGL metadata, screenshot
hashes, fixture and Git hashes, console and page errors, visible outcomes, and
budget decisions. The
committed [`browser/budgets.json`](./browser/budgets.json) bounds hangs, extreme
latency, variance, and broken rendering/interaction invariants. CI uploads the
complete directory as `sdk-browser-benchmark`.

`report.corpus.sha256` identifies only the benchmark's own scenario/data
definitions (`BROWSER_CORPUS_SOURCE_FILES` + the versioned fixture pack) — it
deliberately does **not** include the deck.gl adapter (or any other SDK
implementation) under test, so an ordinary adapter-only code change never
looks like a different benchmark corpus. That implementation's provenance is
still reported, just kept separate: `report.gitCommit` is the authoritative
whole-tree identity, and `report.codeUnderTest.{files,sha256}`
(`CODE_UNDER_TEST_SOURCE_FILES` / `codeUnderTestFingerprint` in
[`browser/run.mjs`](./browser/run.mjs)) is a convenience subset scoped to the
`src/deckgl/*.ts` files the deck.gl scenarios actually exercise.

These measurements are only a same-Honua regression gate. They are not an Esri,
Mapbox, CARTO, MapLibre, or deck.gl comparison: the applications, data paths,
renderer configuration, licensing constraints, and host/service conditions are
not equivalent. A chart, README, website, or sales claim must not rank vendors
from this report or combine it with separately collected competitor numbers.

### deck.gl scale, capability/fallback, and lifecycle evidence (#562)

`schemaVersion: 2` extends the browser corpus with the evidence the bounded
deck.gl adapter (#388/#561) needs before promotion beyond `experimental`, and
publishes it in a machine-readable shape for the #547 analytics golden
journey to consume:

- **Scale tiers.** `deckgl.scale-render-100k` (always on) and
  `deckgl.scale-render-1m` (opt-in — see below) run the same binary
  scatterplot journey as `deckgl.binary-render-interact` at 100,000 and
  1,000,000 rows (`bench/browser/scale.html` / `scale-main.ts`, row count via
  `?rows=`). Instead of one combined `firstVisibleMs`, each scenario's
  `stagesSummary` separates **conversion** (SDK typed-array + `adapter.project`
  cost), **transfer** (`projection.mount` hand-off), **GPU upload + first
  frame**, **steady-state frame rate** (forced `deck.redraw()` over N frames),
  **picking**, and **disposal**. `bench/browser/fixture.ts` builds every
  scale tier's point grid from `index` alone (never `Math.random()`), so a
  given row count is byte-identical across runs.
- **Capability/fallback matrix.** `deckgl.capability-supported` and
  `deckgl.capability-fallback` (`bench/browser/capability.html` /
  `capability-main.ts`) classify the current browser/device with the pure,
  unit-tested policy in
  [`browser/capability-policy.mjs`](./browser/capability-policy.mjs) into one
  of three tiers — `supported`, `fallback-maplibre`, or `unsupported` — and
  only attempt a deck.gl mount when `supported`. The fallback scenario
  deterministically simulates a no-WebGL device by overriding
  `HTMLCanvasElement.getContext` before any page script runs (portable across
  Chromium/Firefox/WebKit, not a Chromium-only launch flag). The report's
  top-level `capabilityMatrix` field carries the reviewed policy plus the
  facts/decision from both runs.
- **Repeated mount/unmount leak evidence.** `deckgl.lifecycle-repeated-mount-unmount`
  (`bench/browser/lifecycle.html` / `lifecycle-main.ts`) cycles
  create-project-mount-dispose 25 times (5 warm-up) against one long-lived
  `Deck`, sampling `performance.memory.usedJSHeapSize` and the live layer
  count after each cycle. `budgets.json`'s `lifecycle.repeatedMountUnmount.maxHeapGrowthBytes`
  bounds heap growth across the post-warm-up cycles; when the memory API is
  unavailable (non-Chromium) the report records `not-measured` rather than a
  silent pass.
- **WebGL context-loss recovery.** `deckgl.context-loss-recovery` uses the
  standard `WEBGL_lose_context` extension to force a deterministic context
  loss, exercising `bindDeckGlContextLossRecovery` (`src/deckgl/lifecycle.ts`)
  — the SDK's only new surface for this issue: a thin
  `webglcontextlost`/`webglcontextrestored` binding, not a recovery
  implementation. The harness's own recovery strategy rebuilds on a **fresh
  canvas** rather than reusing the lost one in place: a real run reproducibly
  showed deck.gl/luma.gl reusing stale GPU resource state (`"object does not
  belong to this context"`, `"no valid shader program in use"`) when a second
  `Deck` is bound to the same canvas after a synthetic restore — the same
  canvas-swap mitigation real deck.gl apps use. `budgets.json`'s
  `lifecycle.contextLossRecovery.maxRecoveryMs` bounds the swap-and-remount
  latency.

Both scale tiers (`deckgl.scale-render-100k` and `deckgl.scale-render-1m`) are
opt-in, not part of the routine `npm run bench:browser` PR gate — the default
deterministic lane runs only the 10k `deckgl.binary-render-interact`
scenario, the capability scenarios, and the lifecycle scenarios:

```sh
HONUA_BROWSER_BENCH_SCALE=full npm run bench:browser   # or:
npm run bench:browser:full-scale
```

They started as locally calibrated placeholders, which a real CI run proved
was not portable across SwiftShader runner classes. The dedicated `deck.gl
Full-Scale Evidence` workflow now runs the tiers serially on `ubuntu24` and
retains each report. The committed thresholds were reviewed from three runs on
the same `a0b3aecd` implementation/corpus commit:

- [run 30716684349](https://github.com/honua-io/honua-sdk-js/actions/runs/30716684349)
- [run 30717019856](https://github.com/honua-io/honua-sdk-js/actions/runs/30717019856)
- [run 30717020832](https://github.com/honua-io/honua-sdk-js/actions/runs/30717020832)

For 100k rows, median first frame ranged 2.12-2.65 seconds, picking 0.55-0.66
seconds, GPU upload 0.78-0.99 seconds, and steady frame rate 1.30-1.68 FPS. For
one million rows, the ranges were 17.39-20.35 seconds, 5.41-6.43 seconds,
5.90-6.98 seconds, and 0.186-0.218 FPS. Across-run coefficient of variation was
7.2-12.0% for those metrics and conversion time. All runs passed journey
invariants, copied zero payload bytes, and reported 37.3 MB heap after the 1M
first frame. Warning thresholds leave runner-noise headroom; failures identify
material regressions or hangs. These are still regression-safety budgets for
the pinned software renderer, not product or real-device SLAs.

The scheduled workflow enforces the reviewed thresholds with
`bench:browser:full-scale`; `bench:browser:full-scale:capture` remains available
for an intentional future recalibration. `report.corpus`
`.includesOptInScaleTiers` and `.activeScaleTierIds` record whether a report
included them.

## Million-feature columnar rendering budget

[`columnar-bench.ts`](./columnar-bench.ts) validates the #387 large-data
(columnar path) memory and throughput budgets. It builds a deterministic
million-feature fixture ([`columnar-fixture.ts`](./columnar-fixture.ts)) as four
contiguous typed-array columns — position, radius, fill color, and id — never
per-feature JavaScript objects or GeoJSON, then binds it directly to deck.gl
GPU-binary attributes with `bindColumnarBatchToDeckGl(...)` and projects it
through `createDeckGlAdapter(...)`.

```sh
npm run build
node dist/bench/columnar-bench.js 1000000
```

The fixture is generated with a fixed-parameter integer hash (no `Math.random`),
so the same feature count is byte-for-byte reproducible. The harness proves the
projected attribute buffers alias the batch's own backing allocations
(`zeroCopyVerified`, `copiedBytes: 0`), that memory stays bounded to the packed
columns (20 bytes/feature, independent of feature count — no per-feature object
materialization), and reports sustained projection throughput in
features/second. Like the other harnesses this measures SDK columnar →
GPU-binary projection overhead only: there is no live server or real renderer,
and it is not a cross-SDK comparison.

This harness covers the **renderer projection stage only**, and its budgets are
hardcoded constants asserted by `test/columnar-million-feature-bench.test.ts`.
That test runs in CI because the whole Vitest suite does, but the harness
produces no benchmark report, uploads no artifact, and has no baseline. For the
budgeted end-to-end path, see the columnar data-plane scenario below.

## Million-feature columnar data-plane scenario

[`columnar-data-plane-bench.ts`](./columnar-data-plane-bench.ts) is the
benchmark-lab scenario (`columnar.data-plane.million-feature`) that walks the
whole #394 data plane for one batch rather than a single stage:

1. **build** — the same deterministic packed fixture, plus `createColumnarBatch`
   validation.
2. **worker** — a one-owner lease, a structured-clone transfer across a real
   `MessageChannel` worker boundary, a registered columnar worker operation that
   scans the packed geometry column without materializing a row, and ownership
   returned to the caller.
3. **render** — `bindColumnarBatchToDeckGl(...)` plus `DeckGlAdapter.project`.

It runs as part of `npm run bench:lab`, so it is reported in
`test-results/benchmark-lab.json`, uploaded by the `benchmark-lab` CI job, and
gated by `--check`.

Seven invariants gate every repetition. Six are machine independent: zero
payload copies across transfer *and* projection, sender backing buffers detached
after transfer, renderer attributes aliasing the batch's own `ArrayBuffer`s,
monotonic worker progress terminating at 1, a preserved row count, and an
operation that observed every row. The seventh, `collectedBaseline`, records
that a collector was available — see the note on retained memory below.

The performance numbers carry **absolute budgets**, declared per scenario in
[`budgets.json`](./budgets.json). Absolute budgets need no baseline, which
matters because CI runs the lab without `--baseline` and a baseline is discarded
whenever the corpus hash or host identity differs — so the absolute class is the
only one that actually gates a pull request. They fail closed: a budget naming a
scenario the corpus did not produce, or a metric the scenario does not report,
is a failure rather than a silent skip.

| Metric | Warning | Failure | Measured |
| --- | ---: | ---: | --- |
| `backingBytesPerFeature` | 20 | 24 | exactly 20.00 (deterministic: 8 + 4 + 4 + 4 bytes/row) |
| `peakRetainedBytesPerFeature` | 64 | 160 | 20.0–35.8 |
| `featuresPerSecond` | 2,000,000 | 500,000 | 2,154,706–8,776,756 |

The measured ranges were taken on a shared host while two other build agents
ran, deliberately including the heaviest contention observed, so the thresholds
sit 1.2x, 4.5x, and 4.3x clear of the worst reading and cannot flake under load.
They still catch real regressions: reintroducing per-feature object
materialization costs 300+ bytes/feature and an order of magnitude of
throughput, and any payload copy fails the zero-copy invariant outright.

`peakRetainedBytesPerFeature` samples `heapUsed + arrayBuffers` at each stage
boundary and takes the peak relative to a **collected** baseline. Both halves of
that are load-bearing:

- The baseline follows a forced collection, so it holds live bytes only. An
  uncollected baseline would carry unreachable objects from the warm-up run and
  the five preceding scenarios; a collection landing inside this scenario's
  window would then offset the very allocations being measured, and a regression
  materializing hundreds of bytes per feature could still report under the
  ceiling. `npm run bench:lab` therefore runs Node with `--expose-gc`, and the
  `collectedBaseline` invariant **fails the scenario** when no collector is
  available rather than publishing an unsound number.
- The value is a peak rather than a start-to-end delta, because a delta goes
  negative whenever a collection lands in the window. From a collected baseline
  the peak can only rise: garbage may be created during the run, but none is
  carried into it.

Running `node dist/bench/lab.js` directly without `--expose-gc` will fail this
scenario by design. `vitest.config.ts` passes the same flag so
`test/columnar-data-plane-bench.test.ts` exercises the enforced path.

## Million-row columnar reduction scenario

[`columnar-aggregate-bench.ts`](./columnar-aggregate-bench.ts) is the
benchmark-lab scenario (`columnar.aggregate.million-row`) for the one columnar
operation that *shrinks* a batch. `createGeoArrowAggregateOperation` scans
1,000,000 packed GeoArrow rows and emits a group-keyed result batch of 1,024
rows carrying a count and a sum, and issue #939 requires that to happen without
materializing a single input row. The fixture is built once outside every
measured region: the floor below is on reduction throughput, not on GeoArrow
encoding throughput.

Each repetition runs the same reduction three times, and the split is the point:

1. **timed** — no memory instrumentation inside the window at all. Reading
   process memory during the run would price the meter into the measurement.
2. **retention** — untimed, forcing a collection at each of four scan
   checkpoints plus completion. A raw `heapUsed` peak measures the *allocation
   rate* of everything the operation touches — on this scenario the transient
   young-generation garbage from batch payload validation alone runs to 12–16
   bytes per input row while the reduction's own live footprint is under a
   quarter of a byte. Collecting at each checkpoint is what turns the reading
   into retention, and it is also what makes the clock meaningless, hence the
   separate run.
3. **cadence twin** — the same reduction with a different `yieldIntervalRows`,
   whose result batch must be byte-identical to the timed run's.

Seven invariants gate every repetition: `collectedBaseline`,
`monotonicProgress`, `groupsExact` (the emitted groups are the fixture's, in
ascending key order), `metricsExact`, `inputBatchUnmutated`, `repeatable`, and
`yieldCadenceIndependent`. The last two are the determinism gate — the yield
cadence is the only scheduling knob the operation exposes, so an output that
survives changing it cannot be moved by a worker scheduling decision either.

`metricsExact` is bit-exact rather than approximate. Every fixture longitude is
a multiple of `1/8` and every per-group total stays below 2^28, so each group's
exact sum is representable in a double; the harness accumulates the reference as
integers and the reduction must reproduce it exactly.

| Metric | Warning | Failure | Measured |
| --- | ---: | ---: | --- |
| `retainedBytesPerInputRow` | 2 | 8 | 0.2246–0.2434 |
| `inputRowsPerSecond` | 4,000,000 | 2,000,000 | 9,002,553–14,196,335 |
| `outputBackingBytesPerGroup` | 40 | 64 | exactly 32.25 (a utf8 key plus two float64 metric columns) |

The two failure thresholds are the numbers #939 itself names, and they sit 33x
and 4.5x clear of the worst reading, so contention cannot flake them. They still
catch the regression they exist for: decoding rows into objects before reducing
them costs hundreds of bytes per input row and would hold those objects live at
exactly the checkpoints the retention run samples. `outputBackingBytesPerGroup`
is fully deterministic and states the property the issue turns on — the result
is sized by the group count, never by the input row count.

## Bounded columnar-to-`Result` conversion scenario

[`columnar-result-bench.ts`](./columnar-result-bench.ts) is the benchmark-lab
scenario (`columnar.result.bounded-window`) for the one columnar operation that
materializes rows on purpose. The data-plane scenario above walks a batch to the
renderer without ever building a feature, and the reduction scenario shrinks one
without building a feature either; `columnarBatchToResult` cuts a 1,000-row
window out of a 1,000,000-row batch and builds real objects from it, which is
what issue #942 exists to make affordable.

The claim under test is that this cost is proportional to the **window** and not
to the batch. The window is one thousandth of the batch, so an implementation
that reverted to scanning or validating every row per conversion would still
return the correct thousand features and would still hold the memory ceiling —
it would simply miss the throughput floor by orders of magnitude. That is why
the floor is the load-bearing gate here rather than a nice-to-have.

The fixture carries all four columns a normative GeoArrow batch can hold — point
geometry, a timestamp, a dictionary-encoded category, and feature ids — so the
floor covers a whole realistic row rather than only the point geometry NFR-002
names. Every third row has a null timestamp and every fourth a null category, so
explicit-null attribute handling is on the measured path. The window is cut from
the **middle** of the batch: a conversion that quietly started reading at the
beginning of a buffer would pass a window anchored at row zero and fail this one.
The fixture is built once outside every measured region — the floor is on
conversion throughput, not on GeoArrow encoding throughput.

Each repetition runs two measured regions:

1. **timed** — twenty-five consecutive distinct windows, with no memory
   instrumentation inside the region. Two choices here are deliberate. It is
   *not* preceded by a forced collection, because a bounded conversion is
   milliseconds of work and a full collection immediately before it would
   measure the allocator warming back up rather than steady-state conversion.
   And it times a run of windows rather than one, because a single conversion is
   short enough that one collection landing inside it swings the reading by tens
   of percent and trips the lab's repeated-run variability check on noise.
   Timing *consecutive distinct* windows costs no honesty — that is the paging
   workload an application performs — whereas converting one window repeatedly
   would have flattered the number out of warm cache.
2. **retention** — exactly one window, untimed, collected before the baseline
   and again with the converted window still held live. The batch's own backings
   are already live at the baseline, so the difference is what the window retains
   *beyond* the batch it was cut from, which is the quantity NFR-001 bounds.

A third untimed pass walks the same range through `columnarBatchToResultPages`
and requires the concatenation to equal the single-window conversion exactly,
and a fourth aborts a traversal after its first page. Paging is the only
scheduling knob the conversion exposes, so an output that survives being cut
into pages and yielded across task boundaries cannot be moved by a consumer's
pacing either.

Seven invariants gate every repetition: `collectedBaseline`, `windowExact`
(every converted feature matches the exactly computed reference for its row),
`orderingExact`, `inputBatchUnmutated`, `repeatable`, `pagingMatchesWindow`, and
`cancellable`.

| Metric | Warning | Failure | Measured |
| --- | ---: | ---: | --- |
| `retainedBytesPerFeature` | 512 | 1,024 | 219.0–258.6 |
| `featuresPerSecond` | 400,000 | 200,000 | 748,842–1,517,304 (per-run medians) |

Both failure thresholds are the numbers #942 itself names: NFR-001's 1 MB per
1,000 converted features is exactly 1,024 retained bytes/feature, and NFR-002
sets the 200,000 features/second floor. The measured ranges span a quiet shared
linux host and the same host running three other build agents, so the ceiling
sits 4.0x and the floor 3.7x clear of the worst median, and the advisory warning
sits below the loaded-host median so contention alone cannot raise it.

## Stream / pagination scenario

A deterministic, server-free harness that measures throughput and latency of
draining large paginated feature streams through the **stable** contract surface
(`@honua/sdk-js/contract` → `createDataset(...).source(id).stream(query)`).

The examples in this repo show how to *page* through features; this harness
quantifies how fast that paging is and how memory behaves as page size changes.

## What it measures

For each page size in the sweep, the harness drains the full fixture through
`Source.stream(...)` and records:

| Metric                | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `featuresPerSecond`   | Sustained throughput: total features drained / wall-clock time.    |
| `timeToFirstPageMs`   | Latency from starting the drain until the first page is yielded.   |
| `totalDurationMs`     | Wall-clock time to drain the entire stream.                        |
| `pageCount`           | Number of pages the stream yielded.                                |
| `heapUsedDeltaBytes`  | `process.memoryUsage().heapUsed` growth across the drain.          |
| `heapUsedPeakBytes`   | Peak `heapUsed` sampled once per page during the drain.            |

## How it stays deterministic

There is **no live server**. `bench/mock-transport.ts` provides a
`fetch`-compatible function injected via `new HonuaClient({ fetchFn })`. It
answers GeoServices FeatureServer `/query` requests by slicing an in-memory
fixture (`bench/feature-fixture.ts`) according to the `resultOffset` /
`resultRecordCount` parameters the SDK's paginating stream emits, and sets
`exceededTransferLimit` until the last page. Two runs over the same fixture are
directly comparable; the harness exercises the SDK's stream/decode path, not the
network.

You can model server round-trips with `--latency <ms>` (artificial per-page
delay) to see how time-to-first-page and throughput shift with fewer, larger
pages vs. many small ones.

## Running the legacy stream sweep

The benchmark is compiled by the normal build (`tsconfig.json` includes
`bench/`), emitting to `dist/bench/`.

```sh
npm run build
node dist/bench/run.js
```

Flags:

```
--features <n>     fixture size (default 50000)
--pages <csv>      comma-separated page sizes to sweep (default 500,2000,10000)
--latency <ms>     artificial per-page transport latency (default 0)
--no-geometry      drop geometry from the drained pages
--json             emit the raw metrics report as JSON instead of a table
```

Examples:

```sh
node dist/bench/run.js --features 100000 --pages 1000,5000,20000
node dist/bench/run.js --latency 2 --json
```

You can also import the harness programmatically. The `bench/` harness is an
in-repo dev tool — it is not part of the published package (`files` only ships
`dist/src`, and there is no `./bench/*` export), so import it by relative path
from within this repo:

```ts
// from within this repo (e.g. a script under bench/ or test/)
import { runStreamBench, formatReport } from "./stream-bench.js";
const report = await runStreamBench({ featureCount: 50_000, pageSizes: [500, 2000, 10_000] });
console.log(formatReport(report));
```

## Interpreting results

- **Throughput vs. page size.** Larger pages mean fewer round-trips and fewer
  generator hops, so `featuresPerSecond` usually climbs with page size until the
  per-page payload dominates. With `--latency 0` the curve isolates client-side
  decode/iteration cost; with latency, it shows the round-trip amortization.
- **Time-to-first-page.** Smaller pages yield the first batch sooner — relevant
  for progressive UIs. Larger pages trade first-paint latency for total
  throughput. Compare `timeToFirstPageMs` against `totalDurationMs` to judge the
  tradeoff for your UX.
- **Memory profile.** `heapUsedDeltaBytes` and `heapUsedPeakBytes` should stay
  roughly flat across page sizes if the stream is truly incremental — features
  are consumed page-by-page rather than buffered. A delta that scales with the
  fixture size indicates accidental retention. For stable memory numbers, run
  node with `--expose-gc` is not required, but avoid running other heavy work in
  the same process and treat absolute byte values as indicative, not exact.

Memory and timing numbers depend on the host, Node version, and GC timing, so
use them for **relative** comparisons (page size A vs. B on the same machine)
rather than as absolute SLAs.
