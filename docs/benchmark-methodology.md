# SDK benchmark methodology

The benchmark program has three deliberately separate lanes. Keeping them
separate prevents a fast local regression check from being confused with a live
service SLA or a competitor comparison.

## Offline regression lab

`npm run bench:lab` executes the committed [`bench/corpus.json`](../bench/corpus.json)
against an in-process transport. It makes no network requests. Each scenario has
at least one warm-up and five measured repetitions. Reports include raw samples,
median, p95, mean, range, coefficient of variation, the corpus SHA-256, Git SHA,
and runtime/host metadata.

The gate checks result invariants and repeated-run stability. Relative timing
and throughput budgets apply only when `--baseline` identifies a report with an
identical corpus and compatible environment. Hardware-dependent absolute
timings are not committed as universal SLAs.

Compatibility requires identical platform and kernel release, architecture,
Node major, CPU model, and CI/local mode. GitHub runner-image identifiers must
match when present. Two like-mode local or self-hosted reports may both omit the
identifier, but a report that has one is never compared with a report that does
not. A rejected supplied baseline makes the overall result `not-compared`
unless an independent correctness gate fails.

Baseline changes are intentional code-review events:

1. Run the old and candidate commits on the same pinned runner class.
2. Retain both raw JSON artifacts and inspect sample variance.
3. Explain the expected regression or improvement in the pull request.
4. Change the corpus or budget only in the same reviewed pull request.

## Pull-request feedback topology

The `PR Fast (under 2 minutes)` job starts its clock before Node setup and
dependency installation. It runs the full TypeScript and Biome checks plus a
representative parallel Vitest tier, then uploads `pr-fast.json`. The two-minute
budget excludes GitHub queue/VM provisioning and checkout action overhead.

This is an early feedback tier, not a replacement for coverage. The existing
full SDK job still runs the complete unit suite with coverage, builds, examples,
migration harness, browser smoke, bundle/API gates, and split-package checks.
The MCP, integration/conformance, security, staging, and scheduled workflows are
unchanged.

## Scheduled live evidence

`.github/workflows/benchmark-live.yml` is schedule/manual only. It probes the
canonical `demo.honua.io` OGC path and AWS-hosted Earth Search STAC path, then
uploads `live-benchmark-evidence.json`. It never runs for a pull request or
push. Locally, `npm run bench:live` produces a `skipped` report unless
`HONUA_BENCH_LIVE_ENABLED=true` is explicitly set.

The artifact contract is
`honua.sdk.benchmark-live-evidence.v1`; its JSON Schema is
[`bench/live-evidence.schema.json`](../bench/live-evidence.schema.json). Every
target also embeds `honua.sdk.sample-evidence.v1`, the same envelope used by
deterministic fixture lanes, so site consumers do not infer a second freshness,
provenance, degradation, or result-semantics model from benchmark-only fields.
The shared schema is published at
[`samples/contract/v1/schemas/sample-evidence.schema.json`](../samples/contract/v1/schemas/sample-evidence.schema.json).
Every target records:

- passed, failed, or skipped status, with a reason for skips
- sanitized endpoint and provider identity
- endpoint/protocol version when advertised
- observation time, response date, source timestamp, ETag, and Last-Modified
- authentication mode (`anonymous` or `api-key`), never the credential
- requested-URL provenance, latency, and result-shape checks
- journey time to the first successful query and its visible data outcome

These HTTP probes explicitly mark browser console and accessibility evidence as
not applicable. The future browser journey corpus should record time to the
first successful interaction, visible map/application outcome, console errors,
accessibility results, and user-facing performance as distinct metrics. It may
fully rework the current sample portfolio; existing pages are not benchmark
preservation constraints.

`honua-site` may consume the uploaded artifact for its public samples/gallery,
but must preserve the status and freshness fields. Missing, stale, failed, or
skipped evidence must not be rendered as a successful live sample. This repo
does not write into or deploy `honua-site`. The broader producer contract is
tracked in [honua-sdk-js#401](https://github.com/honua-io/honua-sdk-js/issues/401)
under the samples/docs modernization epic
[honua-sdk-js#398](https://github.com/honua-io/honua-sdk-js/issues/398); gallery
consumption is tracked in
[honua-site#120](https://github.com/honua-io/honua-site/issues/120), and the
broader site redesign is tracked in
[honua-site#121](https://github.com/honua-io/honua-site/issues/121).

## Cross-SDK comparison rules

The current report explicitly declares `crossSdkComparable: false`. Honua,
Esri, Mapbox/MapLibre, and CARTO/deck.gl results may only be compared after a
reviewed corpus defines equivalent inputs and outputs for all implementations,
including:

- identical fixture bytes, feature counts, geometry, CRS, and style intent
- identical cold/warm cache state and network/service exclusion rules
- equivalent browser, viewport, pixel ratio, interaction, and completion signal
- the same machine, runtime, renderer mode, warm-ups, repetitions, and statistics
- separately reported SDK overhead, network/server time, and renderer time
- public dependency versions and license-compliant reference implementations

Until those conditions exist, benchmark artifacts support Honua regression
analysis only. They must not be used to claim that one SDK is faster than
another.
