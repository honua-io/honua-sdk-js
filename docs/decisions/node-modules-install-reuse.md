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

Measured across the eight most recent completed `SDK Verification` runs
(workflow 335749058), summing every `Install dependencies` and `Install JS SDK
dependencies` step:

| | |
|---|---|
| jobs sampled | 96 (12 per run) |
| `npm ci` total | 734 s |
| **`npm ci` per job** | **7.6 s** |
| billed minutes, as measured | 392 |
| billed minutes if every `npm ci` were **free** | 385 |
| **saving** | **7 min across 8 runs — 0.88 min per run, 1.8%** |

The per-job install is **7.6 seconds, not 1.6 minutes** — off by a factor of
about sixteen. `actions/setup-node`'s npm cache already removed this cost; the
step that remains is linking a mostly-cached tree.

Measured green-run totals were 51–57 billed minutes, not the projected 66.1.

## Why 1.8% is an upper bound, not a target

That figure assumes install becomes **free**. It cannot. A reused tree still has
to be downloaded, verified against its admission contract, and extracted, and the
tree is far larger than `dist/`. Realistically the change trades ~7.6 s of `npm
ci` for a comparable or greater artifact download and digest verification, so the
true saving rounds to zero.

Billing makes it worse. GitHub bills per **started minute per job**, so shaving
7.6 s off a job removes a billed minute only when that job's wall time sits
within 7.6 s above a minute boundary. In the sample that happened on roughly one
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

`quickstart-budget` must **never** consume a shared install. It measures a clean
install from a cold cache; feeding it a warm tree would make it measure nothing
and report success. It is excluded here by construction, since nothing is shared,
and any future reuse proposal has to exclude it explicitly.

## Reopening this

Worth revisiting only if the per-job install cost changes by an order of
magnitude — a much larger dependency tree, the loss of `setup-node` caching, or a
registry slow enough that `npm ci` stops being cache-dominated. Re-run the
measurement above before reopening; the argument here is entirely a consequence
of the 7.6 s figure, not of the integrity concern on its own.
