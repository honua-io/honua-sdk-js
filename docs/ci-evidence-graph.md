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

## What the graph costs, projected from measured step times

Run `31962372165` is a representative green run: `JS SDK` took 36.8 minutes
across 72 steps, `MCP SDK` 2.8. Assigning each measured step to the job that
owns it in the graph, adding 1.6 minutes of per-job setup (checkout, Node,
`npm ci`, artifact download), and splitting the 6.6-minute browser suite across
shards by test count:

| Job | Projected (min) |
| --- | --- |
| admission | 1.9 |
| build | 2.7 |
| verify-core | 16.4 |
| verify-package | 9.0 |
| verify-examples | 8.2 |
| mcp | 5.0 |
| browser:offline | 5.8 |
| browser:examples | 5.5 |
| browser:map | 4.9 |
| browser:realtime | 4.2 |
| quickstart-budget | 2.6 |

- **Critical path: 36.8 → 20.9 minutes** (admission + build + slowest consumer).
- **Billed minutes on a fully green run: 39.6 → 66.1** — the graph costs *more*,
  not less. Parallel jobs each pay their own runner setup and `npm ci`.
- **Billed minutes on the scenarios #1286 is about** fall sharply: a failed
  browser shard reruns 4.2–5.8 minutes instead of replaying the 36.8-minute
  monolith (−84%), and a superseded head is cancelled instead of finishing.

State both numbers whenever this change is described. A graph that is faster to
wait for and more expensive to run green is a trade, not a free win, and the
promotion decision belongs to whoever is paying.

Two honest gaps against the issue's targets:

- **`verify-core` at ~16 minutes still exceeds the 15-minute p90 target
  (NFR-003).** `Unit tests with coverage` alone is 10.7 minutes and is not yet
  sharded. Splitting it is tracked separately; it is a Vitest-level change, not
  a workflow-level one.
- **`quickstart-budget` and `mcp` re-install dependencies** rather than sharing
  a node_modules artifact. Reusing the *build* was the scope here; reusing the
  *install* is a separate mechanism with its own integrity questions.

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

```bash
gh run rerun <run-id> --failed
gh run view <run-id> --json jobs \
  --jq '.jobs[] | {name, conclusion, startedAt, completedAt}'
```

A rerun after the build's 24-hour expiry fails admission with `expired` rather
than reusing stale bytes. That is intended: rebuild by rerunning the whole run.

## Rollout, promotion, and rollback

The graph is **not authoritative**. `ci.yml` remains the required check.

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
