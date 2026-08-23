# `node_modules` install reuse in SDK Verification

Issue [#1336](https://github.com/honua-io/honua-sdk-js/issues/1336), raised while
implementing [#1286](https://github.com/honua-io/honua-sdk-js/issues/1286). #1286
made the SDK **build** reusable across the verification graph; the **install**
was left repeated, one `npm ci` per job, and #1336 asked whether reusing a
downloaded `node_modules` tree is worth the integrity surface it adds.

**Decision: no. Do not adopt install reuse.** The premise the question rested on
does not survive measurement.

## What the issue assumed, and what the runners actually do

#1336 estimated *"roughly 1.6 minutes per job of setup x 9 jobs"*, and projected a
fully green graph at 66.1 billed minutes against the monolith's 39.6.

Measured over these eight `SDK Verification` runs (workflow 335749058), summing
every `Install dependencies` and `Install JS SDK dependencies` step. The run IDs
are pinned so the figures below can be re-derived rather than re-sampled:

| run | created (UTC) | result | billed | saved if installs were free |
|---|---|---|---:|---:|
| 32659751859 | 2026-08-23T18:58:41 | success | 57 m | 1 m |
| 32659540648 | 2026-08-23T18:54:41 | failure | 56 m | 1 m |
| 32657626299 | 2026-08-23T18:18:35 | failure | 54 m | 1 m |
| 32607176648 | 2026-08-23T00:10:42 | failure | 55 m | 1 m |
| 32606989166 | 2026-08-23T00:06:16 | failure | 51 m | 0 m |
| 32606986743 | 2026-08-23T00:06:13 | failure | 36 m | 2 m |
| 32606422513 | 2026-08-22T23:53:27 | cancelled | 49 m | 1 m |
| 32606420503 | 2026-08-22T23:53:24 | failure | 34 m | 0 m |

Most of these runs are red — at the time of sampling every PR was failing on a
lapsed Kepler audit exception (#1407), unrelated to install cost. That shortens
some jobs and so lowers the billed totals, but it does not touch the per-install
figure, which is what the decision rests on. The two green-run totals are 57 and
51 billed minutes.

**Units matter here, because the issue's estimate was per job.** Across 96 jobs
there are 96 install *steps*, but only **88 jobs install at all**: `verified`
runs none, and `mcp` runs two (a root `npm ci` and an MCP-directory `npm ci`).
The two counts coincide; they are not the same measurement.

| | |
|---|---|
| install steps observed | 96 (over 96 jobs, 88 of which install) |
| install seconds, total | 734 s |
| **per install step** | **7.6 s** |
| **per job that installs** | **8.3 s** |
| billed minutes, as measured | 392 |
| billed minutes if every install were **free** | 385 |
| **saving** | **7 min across 8 runs — 0.88 min per run, 1.8%** |

Against #1336's per-job estimate the comparable figure is **8.3 seconds, not 1.6
minutes** — off by a factor of about twelve, and no framing of the units gets
within an order of magnitude of the estimate. `actions/setup-node`'s npm cache
already removed this cost; what remains is linking a mostly-cached tree.

Per job, the spread is flat: 7.6–8.6 s everywhere except `Verify: MCP` at 11.2 s,
which is the job running two installs.

## Why 1.8% is an upper bound, not a target

That figure assumes install becomes **free**. It cannot. A reused tree still has
to be downloaded, verified against its admission contract, and extracted, and the
tree is far larger than `dist/`. Realistically the change trades ~8 s of install
for a comparable or greater artifact download and digest verification, so the
true saving rounds to zero.

Billing makes it worse. GitHub bills per **started minute per job**, so shaving
about 8 s off a job removes a billed minute only when that job's wall time sits
within those 8 s of a minute boundary. In the sample that happened on roughly one
job per run — the "saved" column is 0–2 minutes, and it is 0 for two of the eight
runs.

## What it would have cost

`scripts/lib/sdk-build-evidence.mjs` sets the bar for reusing an artifact:
lockfile digest, Node/npm version, platform/arch, expiry, and a tree digest that
catches a mutated or partial extraction, all fail-closed with no prefix or
cross-head fallback. A `node_modules` tree would need the same contract over a
harder subject — it contains **platform-specific binaries and the output of
lifecycle scripts**, which is why #1286 deliberately left it out of scope.

That is a new, permanently maintained trust boundary on the path every
verification job takes, to recover under 2% of billed minutes, with the
downside being a silently wrong dependency tree rather than a slow build.

## What to do instead

If the graph's cost is worth attacking, the sample says where the time actually
is. `Verify: core, types, styles` alone bills 15–17 minutes, dominated by one
Vitest invocation — that is
[#1335](https://github.com/honua-io/honua-sdk-js/issues/1335), and it is roughly
an order of magnitude more billed time than every `npm ci` in the graph combined.

## Standing constraint, whatever is decided later

`quickstart-budget` must **never** consume a shared `node_modules` tree. Its
five-minute clock covers `npm ci`, browser provisioning, the fixture build, and
the first usable map — a new user's *clean install*. Handing it an already-linked
tree would delete the `npm ci` leg of the promise it exists to enforce and let
the lane report success without having measured that leg at all.

To be precise about what "clean" means here, since it is easy to overclaim:
`setup-node` runs with `cache: npm` **before** the clock starts
(`.github/workflows/sdk-verification.yml`), so the npm *download* cache is warm.
The lane measures a clean install, not a cold cache. That is the enforced
contract, and it is unaffected by this decision either way.

It is excluded today by construction, since nothing is shared. Any future reuse
proposal has to exclude it explicitly.

## Reopening this

Worth revisiting only if the per-job install cost changes by an order of
magnitude — a much larger dependency tree, the loss of `setup-node` caching, or a
registry slow enough that `npm ci` stops being cache-dominated. Re-run the
measurement above against fresh runs before reopening; the argument here is
entirely a consequence
of the ~8 s figure, not of the integrity concern on its own.
