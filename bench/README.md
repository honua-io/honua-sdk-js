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

Relative budgets are not evaluated when the corpus hash, SDK implementation,
OS/kernel release, architecture, Node major, CPU model, CI/local mode, or
available GitHub runner-image identifier differs. Two local reports may both
omit a runner-image identifier; a report with one present is never compared to
one without it. A skipped comparison is reported as `not-compared`; it is never
presented as a pass. Review the complete baseline diff before committing or
publishing a replacement.

The current corpus measures SDK stream/decode overhead. It does **not** measure
network, server, first map render, renderer frame rate, or another SDK. See
[`docs/benchmark-methodology.md`](../docs/benchmark-methodology.md) for the
comparison and live-evidence rules.

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
