# SDK CI: the verification evidence graph

How SDK verification is arranged, where each kind of evidence lives, how to
rerun one slice of it, and how to promote or roll back the new arrangement.

Tracking issue: [#1286](https://github.com/honua-io/honua-sdk-js/issues/1286).
Parent: [honua-server#3213](https://github.com/honua-io/honua-server/issues/3213).

## The problem this arrangement solves

`ci.yml` runs SDK verification as one `JS SDK` job. Measured over the last 49
terminal pull-request runs (`docs/evidence/ci-timing-baseline.v1.json`):

| Measure | p50 | p90 | max |
| --- | --- | --- | --- |
| Critical path (min) | 18.4 | 38.5 | 44.3 |
| Billed (min) | 24.5 | 44.7 | 50.5 |

| Job | p50 | p90 |
| --- | --- | --- |
| JS SDK | 18.4 | 38.5 |
| MCP SDK | 2.7 | 2.9 |
| PR Fast (under 2 minutes) | 1.7 | 1.9 |
| Deterministic Benchmark Lab | 1.6 | 1.7 |

One job is the entire wait. Two consequences follow from that shape, and both
have cost real time:

1. **A late failure invalidates early success.** Playwright runs in the last
   few minutes, after roughly forty minutes of type, style, build, package,
   coverage, migration, example, and browser work has already passed. When it
   fails, none of that survives; `gh run rerun --failed` replays the monolith.
2. **Generated evidence is validated too late.** In
   [#1280](https://github.com/honua-io/honua-sdk-js/pull/1280), adding error
   classifications changed the compiled
   `dist/src/core/error-classifications.js` while the committed offline-shell
   manifest still pinned the old length and digest. The service worker refuses
   to commit a shell generation when one pin disagrees with the bytes it
   fetched, so the only symptom was sixteen offline tests reporting
   `shellReady:false`, deep into Playwright, naming nothing near the cause.

Regenerate the numbers above with:

```bash
npm run ci:baseline:collect -- --workflow ci.yml --event pull_request --limit 60
npm run ci:baseline:report
```

`collect` needs an authenticated `gh`. `report` is offline, so anyone can
re-derive the summary from the committed record without credentials.

## What the graph costs, measured

First fully green graph run on hosted CI
([31973409813](https://github.com/honua-io/honua-sdk-js/actions/runs/31973409813)):

| Job | Measured (min) |
| --- | --- |
| Admission | 0.6 |
| Quickstart budget | 1.0 |
| SDK build (producer) | 1.5 |
| MCP SDK | 1.8 |
| Browser (realtime) | 2.5 |
| Browser (offline) | 2.6 |
| Browser (examples) | 5.3 |
| Browser (map) | 6.4 |
| Verify: package | 6.9 |
| Verify: examples | 6.9 |
| Verify: core | 11.6 |
| SDK verified | 0.1 |

- **Wall clock 13.6-17.2 minutes** across four green runs, against a `JS SDK`
  p50 of 18.4 and p90 of 38.5 in the 49-run baseline. Treat it as a range, not a
  figure.
- **Billed ~51 minutes**, against a baseline p50 of 24.5 and p90 of 44.7. Raw
  job-minutes sum to 45.5, but GitHub bills each job rounded up to the whole
  minute, and twelve jobs — six of them under three minutes — lose more to
  rounding than the monolith's four. Quote the rounded number: the raw sum
  understates the graph against what it replaces. The graph costs more when
  everything passes.
- **`verify-core` at 11.6-14.6 minutes clears the 15-minute p90 target
  (NFR-003)**, and it is the critical path — every other consumer finishes
  sooner. The margin is thin enough that #1335 tracks sharding it.
- **A failed browser shard would rerun in 2.2-6.4 minutes** instead of replaying
  the whole monolith. That figure is **projected, not measured**: it reuses the
  shard durations from green first runs. No `gh run rerun --failed` has been
  observed on this graph, and none can be until it runs on trunk — the
  acceptance criterion for it is deliberately still open.

State both directions whenever this change is described. A graph that is faster
to wait for and more expensive to run green is a trade, not a free win, and the
promotion decision belongs to whoever is paying.

One gap remains: `quickstart-budget`, `mcp`, and every consumer re-install
dependencies rather than sharing a node_modules artifact. Reusing the *build*
was the scope here; reusing the *install* is a separate mechanism with its own
integrity questions.

That gap has since been measured and deliberately left open. Per-job `npm ci` is
**7.6 seconds**, not the 1.6 minutes #1336 assumed -- `actions/setup-node`'s npm
cache already removed the cost -- so making install *free* would recover 1.8% of
billed minutes, and a shared tree is not free. The reasoning and figures are in
[`docs/decisions/node-modules-install-reuse.md`](./decisions/node-modules-install-reuse.md).
The billed time worth attacking is `verify-core`, not the installs.

### Prerequisites the monolith supplied by accident

Three cross-job prerequisites were invisible until the jobs were split, and each
one failed on hosted CI before it was found. They are recorded here because the
next person to move a gate will hit the same class of problem:

1. **`verify:public-surface` needs `verify:browser:prepared`.** It resolves
   `dist/browser/honua-sdk.esm.js`, so in a job without the bundle it fails with
   "built-entrypoint target is missing" and reads like a surface regression.
2. **`samples:run -- verify --kit` needs a browser.** It spawns each pilot's own
   `test:playwright:<sample>` gate. `ci.yml` provisions chromium near the top of
   `JS SDK` for the quickstart clock, and every later gate inherited it.
3. **Browser shards need the gallery samples built.** See below.

`test/scripts/sdk-verification-workflow.test.mjs` now enforces the general rule
behind the first: which job a gate lands in is a free choice, but two gates that
land in the *same* job must keep `ci.yml`'s relative order. The second is a
reviewed list of browser-launching commands. The third cannot be inferred from a
spec at all, which is why it is written down.

## The graph

`.github/workflows/sdk-verification.yml`:

```
admission ──┬─ quickstart-budget          (clean install; deliberately no reuse)
            └─ build ──┬─ verify-core
                       ├─ verify-package
                       ├─ verify-examples
                       ├─ mcp
                       └─ browser × {offline, realtime, map, examples}
                                    │
                                  verified   (aggregate gate)
```

- **admission** is cheap and runs first: workflow-policy suites, the build- and
  shard-policy fixtures, and the browser-shard partition audit. It also pins the
  exact head every later job checks out, and resolves the rollout mode.
- **build** is the only job that compiles the SDK. It runs `npm run build`,
  recomputes the offline-shell pins against the dist it just emitted, writes the
  build evidence manifest, and uploads `dist/`, the prepared-artifact manifest,
  and the evidence as one artifact named for its own fingerprint.
- **consumers** download that exact artifact, admit it, and run their gates
  against it. None of them rebuilds.
- **verified** is the one aggregate result a reviewer reads.

### Why the quickstart budget does not reuse the build

`quickstart-budget` enforces a five-minute clean-install-to-first-map promise.
The clock covers `npm ci`, browser provisioning, the fixture build, and the
first usable map. Handing that job a prebuilt SDK would measure a different
thing, so it installs and builds from scratch the way a new user does.

## Build identity: what makes two builds the same build

`scripts/lib/sdk-build-evidence.mjs`. The fingerprint is a SHA-256 over
length-framed, fixed-order values:

| Field | Why it is in the identity |
| --- | --- |
| `contract` | A graph revision that moves a gate between jobs can make a byte-identical build the wrong build to trust. |
| `sourceSha256` | The prepared-artifact digest of every source input `tsc` can reach. |
| `lockfileSha256` | A different dependency tree is a different build. |
| `tsconfigSha256` | Compiler configuration changes the emit. |
| `scriptsSha256` | Consumers execute npm scripts by name against the reused dist. |
| `nodeVersion`, `npmVersion` | Toolchain. |
| `platform`, `arch` | A build produced on another architecture is not evidence about this one. |

The manifest additionally records the dist digest, file count and byte length,
the runner image, the producing repository/run/attempt/head/workflow ref/event,
and `createdAt`/`expiresAt` (24 hours by default).

### Admission is fail-closed

Every consumer recomputes the fingerprint from its own checkout and the dist
digest from the downloaded tree, then calls the verifier. Rejection reasons:

| Reason | Meaning |
| --- | --- |
| `missing` | No manifest was produced or downloaded. |
| `malformed` | Wrong format, bad digest, artifact name that does not name its own fingerprint, expiry at or before creation. |
| `incompatible-contract` | Produced for a different graph shape. |
| `expired` | Past `expiresAt`. |
| `fingerprint-mismatch` | Produced for different inputs than this checkout. |
| `digest-mismatch` | The dist was mutated in transit or in the consumer. |
| `untrusted-producer` | Produced by another repository. |

There is no prefix match, no "closest" artifact, and no cross-head fallback.
The artifact name carries the full 64-character fingerprint, and consumers name
it exactly; a rejected build's only recourse is a fresh one. Artifacts are
scoped to their producing run, so cross-run reuse is not merely disallowed, it
is not reachable.

Exercise it locally:

```bash
npm run build
node scripts/sdk-build-evidence.mjs emit --output .artifacts/sdk-build/evidence.v1.json
node scripts/sdk-build-evidence.mjs verify --evidence .artifacts/sdk-build/evidence.v1.json
```

## Browser shards

`config/browser-shards.v1.json` partitions every Playwright spec into four
owned failure domains:

| Shard | Owns |
| --- | --- |
| `offline` | The offline region reference, its service-worker shell generation, IndexedDB persistence, static/on-disk asset serving. |
| `realtime` | Realtime subscriptions, checkpointing, collaborative and permitted editing, the authenticated session around them. |
| `map` | Kepler, Cesium, 2.5D storytelling, terrain and imagery rasters, large-payload formats, and the rendering benchmark. |
| `examples` | Quickstarts, scaffolded apps, migration browser surfaces, web components, general smoke, and the MapLibre 5.x/6.x peer-major matrix. |

The partition is a **reviewed list, not a glob**. A glob-defined shard silently
absorbs new specs, and — worse — a spec matching no glob silently never runs.
`honua-server` learned that the expensive way: 218 tests matched no CI shard
filter and had never executed
([honua-server#3259](https://github.com/honua-io/honua-server/issues/3259)).

```bash
npm run browser:shards:check          # every spec belongs to exactly one shard
node scripts/browser-shards.mjs files map
HONUA_BROWSER_SHARD=offline npx playwright test --list
```

Adding a spec without claiming it fails `browser:shards:check` in `admission`,
before any expensive job starts. Nothing about the browser contract changes:
one chromium project, one worker, CI retries, same specs.

### What a browser shard needs besides the SDK build

`coverages-wcs-basic.spec.mjs` serves its example through `vite preview`, so an
unbuilt example 404s its own assets and the spec fails as a console-error gate.
The only thing in CI that runs `demo:coverages-wcs:build` is
`scripts/build-sample-bundles.mjs`, which builds every gallery sample through
its own declared build script -- and in the monolith it simply happened to run
earlier in the same job. `demo:examples:build:prepared` does **not** cover it:
that chain builds 27 named demos and coverages-wcs is not one of them.

Each browser shard therefore runs `npm run samples:bundles:build` before its
suite. If you add a spec that previews a built example, check that some step in
the shard builds it; the fixture cannot infer this from the spec.

## Generated offline evidence normalizes before browser execution

`npm run offline:shell-manifest:check` recomputes every pinned byte length and
SHA-256 from the real file on disk. It runs in **build**, immediately after
`npm run build`, and again in each browser shard before its suite. A stale pin
therefore fails in the producer, before a single browser is provisioned, and
names the drifted asset:

```
Application shell manifest pins are stale: 2 drifted values.
  /dist/src/core/error-classifications.js (dist/src/core/error-classifications.js)
    byteLength: 15363 -> 15374
    integrity: sha256:3c85167a… -> sha256:d378f3a1…
```

Refresh with `npm run offline:shell-manifest:generate`. Never hand-edit the
manifest: it is generated evidence tied to exact compiled assets, and editing it
by hand is how a pin gets "fixed" to bytes that do not exist.

## Rerunning one slice

`gh run rerun --failed` reruns only the failed jobs. Because the graph's jobs
are independent and the build is content-addressed, the failed shard downloads
the same immutable build the green shards used, and the green jobs keep their
original timestamps.

**This is the design, not an observation.** No failed-only rerun of this graph
has been performed; the saving quoted above is computed from green first-run
shard durations. The proof needs a deliberate failure on a graph running on
trunk, which is why that acceptance criterion is still open in #1286.

```bash
gh run rerun <run-id> --failed
gh run view <run-id> --json jobs \
  --jq '.jobs[] | {name, conclusion, startedAt, completedAt}'
```

A rerun after the build's 24-hour expiry fails admission with `expired` rather
than reusing stale bytes. That is intended: rebuild by rerunning the whole run.

## Rollout, promotion, and rollback

The graph is **not authoritative**. `ci.yml` remains the required check.

Not-authoritative is a property of **check-run names**, not of intent.
Repository ruleset 18085797 requires the contexts `JS SDK` and `MCP SDK`
*unqualified* — with no `integration_id` — so branch protection matches any
check run with that name, whichever workflow published it. The graph's MCP job
was briefly named `MCP SDK`, which put two check runs under a required context
on the same pull request: the shadow lane could then satisfy the gate `ci.yml`
is supposed to own, or block a pull request on a lane nobody had promoted. It
is now `Verify: MCP`, and
`test/scripts/sdk-verification-workflow.test.mjs` fails if any graph job ever
takes a name `ci.yml` also uses. Check that assertion, not the intent, before
believing the graph cannot gate anything.

`vars.HONUA_SDK_VERIFICATION_MODE` is both the switch and the rollback:

| Value | Effect |
| --- | --- |
| `off` | `admission` reports and every long job skips. No workflow file edit needed. |
| `shadow` (default) | The graph runs beside `ci.yml` and is compared against it. |
| `authoritative` | Set only after parity and cost thresholds pass. |

Promotion is its own pull request: flip the variable, make `SDK verified` the
required check, and retire `ci.yml`'s `JS SDK` and `MCP SDK` jobs there. Do not
retire them in the same change that introduces the graph — a bypassed gate and
a promoted graph look identical from the outside.

`test/scripts/sdk-verification-workflow.test.mjs` compares the commands the
graph executes against the commands `ci.yml`'s `JS SDK` and `MCP SDK` jobs
execute, matched on working directory plus program plus script name, and fails
if the graph drops any of them. Sharding redistributes work; it must never
retire a gate.

### Measuring parity, so promotion is a decision and not a feeling

"Parity and cost thresholds pass" is only actionable if somebody can say what
the current number is. `scripts/ci-shadow-parity.mjs` computes it:

```bash
npm run ci:parity:collect    # needs `gh` with actions:read; rewrites the evidence
npm run ci:parity:report     # offline; re-renders the committed observations
```

`.github/workflows/sdk-shadow-parity.yml` runs `collect` daily and writes the
readout into its job summary. It is **read-only and not a gate**: it publishes
no check run, commits nothing, and cannot make a pull request pass or fail.
Promotion stays an explicit human decision made from the evidence it produces.

The unit of comparison is **one exact head SHA**. Not a pull request — a pull
request accumulates heads, and comparing at that level would pair the graph's
verdict on one commit with `ci.yml`'s verdict on another. That is the mutable-base
defect that closed [#1312](https://github.com/honua-io/honua-sdk-js/issues/1312)
without merge.

A head counts only when **both** workflows reached a terminal verdict on it.
Everything else is excluded by a named reason and stays visible in the document
rather than being dropped:

| Reason | What it means |
| --- | --- |
| `pre-deployment` | The head predates the graph's first default-branch run. |
| `missing-graph-run` / `missing-authoritative-run` | Only one workflow ran that head. |
| `ambiguous-graph-run` / `ambiguous-authoritative-run` | Two distinct runs of one workflow on one head. |
| `graph-not-terminal` / `authoritative-not-terminal` | Cancelled or still running. |
| `graph-gate-missing` / `authoritative-gate-missing` | A gate job the run never published. |

`pre-deployment` is the one worth understanding. Runs produced while the graph
was itself the change under review were produced by a workflow file that moved
between heads, so they say nothing about the deployed graph — in **either**
direction. The first collection found six disagreements, all of them on
[#1334](https://github.com/honua-io/honua-sdk-js/pull/1334)'s own development
heads, where the graph was failing because it was being written. Counting those
as parity findings would be as wrong as counting them as agreement. The window
opens at the graph's earliest default-branch run, resolved from the API rather
than hard-coded, so a rollback and redeploy moves it.

Exclusion is always the cheaper mistake. A wrongly excluded head delays
promotion; a wrongly counted head promotes a graph nobody measured.

Promotion needs **both** conditions, and neither absorbs the other:

- at least `PROMOTION_SAMPLE_THRESHOLD` (20) agreeing heads, and
- **zero** disagreements. One unexplained disagreement blocks promotion no
  matter how large the agreeing sample is, because the disagreement is the
  evidence that the graph and `ci.yml` are not the same gate.

The report prints both sides' cost, because sharding trades billed minutes for
wall clock and reporting one number would let a loss read as a win. On the first
post-deployment observations the graph's critical path is roughly a third of
`ci.yml`'s while its billed total is higher — the whole graph pays eleven runner
setups where the monolith pays two.

## What the graph deliberately does not touch

- **`release:seal:check`** stays a release-time gate in `publish-js-sdk.yml` and
  `first-map-release-smoke.yml`. It re-checks the sealed *git tree* — receipt
  source digests and derived version stamps — not `dist/`, so build reuse
  neither serves nor subverts it. `ci.yml` runs only its unit tests, and so
  does the graph.
- **npm trusted publishing (OIDC)** is unchanged. The verification graph holds a
  read-only token, reads no secret, and never publishes; the fixture asserts all
  three.
- **Forks.** The graph is `pull_request`, never `pull_request_target`, so
  untrusted code never runs with a write token and can never publish evidence
  anything downstream trusts.
- **Manual dispatch.** The graph has no `workflow_dispatch` trigger. Every job
  checks out `needs.admission.outputs.head_sha` and `actions/setup-node` writes
  the npm cache; on `push` and `pull_request` that head is fixed by the event,
  but a manual dispatch lets the actor choose the ref, so a run in the default
  branch's cache scope could check out arbitrary code and populate a cache later
  runs restore. CodeQL's `actions/cache-poisoning/poisonable-step` query flagged
  that combination on every checkout in the workflow. Re-add dispatch only with
  a ref allow-list, or with caching disabled in the dispatched path.
