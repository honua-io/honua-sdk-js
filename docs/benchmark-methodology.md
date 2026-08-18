# SDK benchmark methodology

The benchmark program has four deliberately separate lanes. Keeping them
separate prevents a fast local regression check from being confused with a live
service SLA or a competitor comparison.

## Offline regression lab

`npm run bench:lab` executes the committed [`bench/corpus.json`](../bench/corpus.json)
against in-process fixtures. It makes no network requests. Each scenario has at
least one warm-up and five measured repetitions. Reports include raw samples,
median, p95, mean, range, coefficient of variation, the corpus SHA-256, Git SHA,
and runtime/host metadata.

Alongside stream pagination, the corpus includes two resilience scenarios:

- offline reload writes deterministic resources through the supported offline
  store/transaction contract, reloads a serialized credential-free manifest,
  rechecks every resource digest, and evaluates freshness against a fixed clock;
- realtime reconnect restores a compatible durable checkpoint, records one
  synthetic retry, rejects replay duplicates, and applies following events in
  contiguous sequence order.

Their report invariants record freshness status/age, cursor presence, retry
count, ordering status, ignored/applied duplicate counts, and the absence of
credential material. Opaque cursor values and authorization-scope inputs are
never copied into the report. Deliberate stale, corrupt, sequence-gap, and
duplicate-application fixtures prove these checks fail closed.
The report-level `artifactSafety` gate is derived from the complete final
projection, including corpus, methodology, environment, scenarios, and
evaluation fields; a top-level or scenario leak fails the benchmark check.

This expanded contract is benchmark report and corpus `schemaVersion: 2`.
Version 1 reports contain only the original stream shape; they remain readable
as historical artifacts but are never eligible for relative comparison with a
version 2 candidate. Consumers must branch on the schema version before reading
the scenario union.

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

## Browser rendering and interaction lane

`npm run bench:browser` runs credential-free Chromium journeys against only
local deterministic fixtures. The MapLibre scenario exercises the shipped
flagship through first visible WebGL output and linked popup selection. The
deck.gl scenario sends 10,000 binary points through the supported Honua adapter,
asserts zero SDK attribute-buffer copies, waits for a rendered frame, and proves
picking resolves the expected stable feature identity. Console/page errors,
visible state, PNG hashes, raw timings, browser/WebGL/host metadata, and repeated
sample variance are retained in the CI artifact.

The absolute warning/failure values in `bench/browser/budgets.json` are broad
regression-safety bounds for the pinned headless environment. They detect hangs,
lost output, broken interaction, and severe instability; they are not latency
SLAs. The initial interaction bounds include the next visible animation frame,
which is materially slower under software-rendered SwiftShader than an event
handler alone. Budget changes require a reviewed diff with old and candidate
artifacts.

The browser report always declares `crossSdkComparable: false`. In particular:

- do not compare these results with numbers from vendor marketing, different
  examples, different data, or a separately timed live service;
- do not label the Honua MapLibre scenario as a Mapbox comparison merely because
  both use related style or rendering concepts;
- do not label the Honua deck.gl adapter scenario as a CARTO comparison merely
  because CARTO applications may use deck.gl;
- do not publish a vendor ranking until equivalent, license-compliant reference
  applications, one fixture, one interaction definition, one host, and a
  reviewed statistical protocol exist in this repository.

Until those conditions are met, the only valid statement is that a candidate
Honua commit stayed within or exceeded Honua's own reviewed regression budget.

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

- passed, failed, or skipped status, with a reason and a typed
  `skipReasonCode` for skips
- sanitized endpoint and provider identity
- endpoint/protocol version when advertised
- observation time, response date, source timestamp, ETag, and Last-Modified
- authentication mode (`anonymous` or `api-key`), never the credential
- requested-URL provenance, latency, and result-shape checks
- journey time to the first successful query and its visible data outcome

### Skip taxonomy

A skip must be a positive finding, never a swallowed error. A target may only
report `skipped` when the probe established that the live environment cannot
demonstrate the journey, and it must publish the reason code that says which
condition applied:

| `skipReasonCode` | Condition | Incident `realtime.reconnectOutcome` |
| --- | --- | --- |
| `live-probes-disabled` | The lane was not enabled, so nothing was contacted | `not-attempted-live-probes-disabled` |
| `operator-requested-skip` | An operator supplied an explicit skip reason for the target | `not-attempted-operator-skip` |
| `realtime-capability-probe-unavailable` | The realtime capability endpoint answered 403 or 404 | `not-attempted-capability-unavailable` |
| `realtime-capability-disabled` | The capability probe succeeded and reported the stream as not enabled | `not-attempted-capability-unavailable` |
| `incident-demo-dataset-empty` | The capability is enabled, but the demo incident feature service returned a well-formed, zero-feature snapshot | `not-attempted-demo-dataset-empty` |
| `incident-demo-service-missing` | The capability is enabled, but the demo does not publish the incident feature service at all: the query answered with a GeoServices `404` error payload | `not-attempted-demo-service-missing` |

The schema requires `skipReasonCode` on every skipped target and forbids it on
any other status, so an untyped skip cannot be published.

Every other outcome stays `failed`: a transport error, a non-2xx status, a
timeout, a GeoServices error payload behind HTTP 200 that reports anything other
than `404`, or a response whose shape does not match the protocol. In particular,
an empty incident snapshot is a skip only when the response was authenticated and
schema-valid and simply carried no features; a snapshot-plus-delta journey cannot
be demonstrated against an empty dataset, so claiming an execution would be
dishonest.

A GeoServices `404` payload is the one error payload that is a skip rather than a
failure, and only because it establishes the same fact one step earlier: the
deployment does not publish the incident feature service at all, so there is no
journey to demonstrate. Any other error code describes a service that *is*
published and answering wrongly, which is a genuine failure. Deploying and seeding
the demo incident service is tracked in
[honua-demo#14](https://github.com/honua-io/honua-demo/issues/14) (which
superseded [honua-sdk-js#812](https://github.com/honua-io/honua-sdk-js/issues/812));
until it lands, the skip is the truthful attestation, and it is published in the
evidence envelope and the run's step summary rather than swallowed.

The sample evidence envelope has no free-form code field, so the reason code is
republished there as an additional `degradation.reasons` entry, and the incident
target's `realtime.reconnectOutcome` carries a distinct value per condition, as
above. A condition never borrows another's outcome: an operator skip reports
`not-attempted-operator-skip` rather than implying a capability finding it never
made.

These HTTP probes explicitly mark browser console and accessibility evidence as
not applicable. Browser rendering and interaction evidence is recorded only by
the separate deterministic lane above; an HTTP probe must never imply that a
page was rendered or interacted with.

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

### Reference corpus and license preflight

The machine-readable [cross-SDK corpus](../bench/cross-sdk/corpus.json) defines
the future comparison contract without publishing fabricated measurements. Its
public task pins synthetic GeoJSON bytes and digest, EPSG:4326, viewport and
device scale, style intent, center-feature pick semantics, cold/warm cache
states, loopback-only networking, warmups, repetitions, statistics, completion
signals, visual tolerance, and exclusions. `npm run bench:references` validates
those constraints and writes a provenance report; the normal benchmark-lab
report embeds the corpus digest and availability counts while retaining its
same-Honua-only declaration.

License review is evidence, not legal advice. Each entry records an exact
package version/integrity, retrieval date, primary-source license/terms links,
review decision, publication state, and next review date. The validator fails
closed on expired evidence, unknown properties, missing vendor states, unlocked
eligible packages, changed fixture bytes, credentials, unequal tasks, or an
attempt to promote a reference whose publication state is not approved.

| Reference | Corpus state | Primary evidence | Why |
| --- | --- | --- | --- |
| Honua SDK | Eligible | [Apache-2.0 repository license](https://github.com/honua-io/honua-sdk-js/blob/trunk/LICENSE) | Local package and authored fixture. |
| MapLibre GL JS | Eligible | [BSD-3-Clause license](https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt) | Locked OSS package; no post-fork Mapbox code. |
| deck.gl | Eligible | [MIT license](https://github.com/visgl/deck.gl/blob/master/LICENSE) | Standalone local layer path only. |
| CesiumJS | Eligible | [Apache-2.0 license](https://github.com/CesiumGS/cesium/blob/main/LICENSE.md) | Local ellipsoid/entities; no ion service or assets. |
| ArcGIS Maps SDK for JavaScript | Unavailable | [Esri licensing and attribution](https://developers.arcgis.com/javascript/latest/licensing/) | Product-specific terms apply; public comparison publication is not cleared. |
| Mapbox GL JS | Unavailable | [current license](https://github.com/mapbox/mapbox-gl-js/blob/main/LICENSE.txt), [token prerequisite](https://docs.mapbox.com/mapbox-gl-js/guides/get-started/use-with-npm/) | Current software uses Mapbox terms/account; credential-free use and publication are not assumed. |
| CARTO for deck.gl | Not comparable | [CARTO authentication methods](https://docs.carto.com/carto-for-developers/key-concepts/authentication-methods), [official deck.gl integration](https://deck.gl/docs/api-reference/carto/overview) | CARTO APIs require credentials; standalone deck.gl is not a CARTO platform benchmark. |

The preflight cannot authorize a ranking. Promotion requires all eligible
references to run from the same revision on the same pinned host/browser using
the exact fixture, with raw samples, environment metadata, screenshots/hashes,
console/page/network evidence, bundle and memory evidence, and reviewed output
equivalence. A skipped or incompatible reference remains visible and cannot be
averaged away or used to promote an unrelated scenario.

Honua provenance is intentionally bound to the exact committed `HEAD:src` Git
tree. After reviewing and committing a source change, the recovery and review
sequence is:

```sh
npm run bench:references:source-tree
npm run bench:references:source-tree:write
git diff -- bench/cross-sdk/corpus.json
npm run bench:references
npm run bench:lab
```

Inspection bypasses only the stale pin check and prints the current
40-character tree offline. The explicit write mode updates only
`honua-sdk-js.package.sourceTree.gitTree` while preserving the rest of the
corpus byte-for-byte. The normal reference and lab gates still fail closed on
source, fixture, package, license, or terms drift. Updating the committed tree
value is an explicit review action, not an automatic claim that a beta npm
version and current trunk are identical. Restricted terms are refreshed
separately with `npm run bench:references:refresh-terms`. That bounded network
command records URL reachability/status/final redirects but does not
redistribute terms text or alter a legal decision; deterministic PR validation
remains offline.
