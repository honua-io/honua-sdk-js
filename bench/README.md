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

These measurements are only a same-Honua regression gate. They are not an Esri,
Mapbox, CARTO, MapLibre, or deck.gl comparison: the applications, data paths,
renderer configuration, licensing constraints, and host/service conditions are
not equivalent. A chart, README, website, or sales claim must not rank vendors
from this report or combine it with separately collected competitor numbers.

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
features/second. The `test/columnar-million-feature-bench.test.ts` unit test
enforces these budgets in CI. Like the other harnesses this measures SDK
columnar → GPU-binary projection overhead only: there is no live server or real
renderer, and it is not a cross-SDK comparison.

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
