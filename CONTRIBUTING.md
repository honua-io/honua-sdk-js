# Contributing to `@honua/sdk-js`

## What a feature PR should contain

A feature PR commits **only**:

- your **source** changes (`src/`, `examples/*/src`, `docs/examples/*`,
  `samples/scenarios`, `samples/fixtures`, catalog/config, etc.);
- your **own tests** (unit / e2e / smoke covering the change);
- **bundle-budget resets** when your change legitimately grows a shipped
  entrypoint (edit `bundle-budgets.json`; see below).

A feature PR should **not** regenerate or reseal the shared derived-artifact
set. That set is regenerated automatically on trunk after your PR merges.

### Derived artifacts are regenerated on trunk, not in your PR

Historically every PR had to reseal ~17 generated files (sample evidence
receipts + runs, `samples/dist/*`, `samples/contract/v2/consumer-fixtures/*`,
`bench/cross-sdk/corpus.json`, `docs/bundle-sizes.md`, `llms.txt` /
`llms-full.txt`, `docs/comparison.md`, `docs/errors.md`, `api-report/`,
`examples/migration-workbench/public/artifacts/*`). Because those outputs were
bound to a whole-tree source digest, any change invalidated them, they conflicted
across concurrent PRs, and merges serialized. (honua-io/honua-sdk-js#677.)

Now:

- **PR CI runs in relaxed mode** (`HONUA_DERIVED_ARTIFACTS_RELAX=1`). The
  sample-publication contract and the llms / comparison / api-report / bench /
  migration-workbench freshness gates still validate schema, freshness, artifact
  digests, and catalog/dist coherence, but they do **not** require the derived
  artifacts to have been regenerated against your tree.
- **The functional gates are unchanged.** `typecheck`, `check`, `build`, unit /
  e2e tests, the Playwright smoke suite, and — importantly — kit qualification
  from source and packed SDK (`samples:run -- verify --kit --sdk-mode
  source|packed`) all run at PR time. **A PR that genuinely breaks a sample
  still fails.**
- **After merge**, `.github/workflows/regenerate-derived-artifacts.yml`
  (trunk-only, serialized) rebuilds every derived artifact, reseals sample
  evidence **strictly bound to the trunk source digest**, and commits the result
  back to trunk. Reproducibility is enforced there.

So: do not run `samples:run -- evidence ...`, `samples:generate`, `docs:llms`,
`docs:comparison`, `report:bundle-sizes`, `report:api`, `docs:error-codes`,
`bench:references:source-tree:write`, or
`demo:migration-workbench:artifacts:write` just to make CI green. If you commit
stale derived artifacts by habit, it is harmless — trunk overwrites them.

### If the sample publication contract fails on evidence freshness

Golden-visual evidence carries a seven-day freshness window and is renewed by
the six-hourly `regenerate-derived-artifacts` run. If that renewal stops, the
windows expire on the calendar and the sample-publication contract fails on
every branch at once, with a message naming the window, when it lapsed, and the
fix (honua-io/honua-sdk-js#1266). This is **not** a defect in your PR:

- renew it with `npm run samples:generate` (or
  `gh workflow run regenerate-derived-artifacts.yml --repo honua-io/honua-sdk-js`,
  which is the authority that reseals against the trunk source digest);
- a `note: … inside the 24h renewal horizon` line in the gate output means the
  renewal path has already stopped working — fix it before it expires.

Two things follow from #1266 and should stay true: the contract gate is
**reported early and enforced last** in the `JS SDK` job (`Enforce sample
publication contract`), and the PR-fast tier runs all of its steps, so the test
suites always run and report even when the contract gate is red. Never "fix" a
freshness lapse by widening a window or deleting evidence.

### Bundle budgets stay a PR-time gate

`verify:bundle-budgets` (`report-bundle-sizes.mjs --check`) still runs on your
PR and only enforces the ceilings in `bundle-budgets.json` — it never writes the
`docs/bundle-sizes.md` doc. If your change grows an entrypoint past budget:

1. run `npm run report:bundle-sizes` locally to see the measured sizes;
2. set the exceeded `bundle-budgets.json` entrypoint ceiling(s) to
   `ceil(measured * 1.1)` and add a `$comment` noting why + the issue number;
3. commit **`bundle-budgets.json`** (the budget reset is real PR content). The
   regenerated `docs/bundle-sizes.md` doc lands on trunk automatically.

## Target every PR at `trunk`

**Open your PR against `trunk`, not against another PR's branch.** Stacked PRs
are discouraged here because GitHub makes their failure mode invisible: a PR
merged into a stack base that itself never merges is still reported **MERGED**,
with green CI and often a closed tracking issue, while its payload is simply not
in the product. That is not hypothetical — it cost
[#863](https://github.com/honua-io/honua-sdk-js/pull/863) here and three PRs
(~3,800 insertions) in `honua-server`; see #1317 and honua-server#3248.

If you cannot avoid stacking, you own the re-target: the moment the base PR
merges, change the stacked PR's base to `trunk` and rebase. Do not merge it into
a base branch that has already landed.

The check is mechanical and runs weekly (`.github/workflows/stranded-merge-detector.yml`):

```bash
npm run stranded-merges:sweep -- --repo honua-io/honua-sdk-js --default-branch trunk
```

It sweeps recently merged PRs, and it decides by **content**, not by commit
identity. `git merge-base --is-ancestor <mergeCommit> origin/trunk` only
nominates a candidate; each candidate's payload is then adjudicated against
`trunk` by patch identity, blob equality, and added-line presence, because a
squash, a cherry-pick, or an independent re-land all put the content on `trunk`
under a different SHA. #863 is exactly that case -- its merge commit is off
`trunk` and its payload is on `trunk` via #921 -- and the first version of this
job, which stopped at ancestry, reported it lost every week until people stopped
reading the job.

So read the output by classification:

| Classification | What it means | What to do |
|---|---|---|
| `stranded` | The payload's files are not on `trunk` at all | Recover it, or abandon the branch with a note on the issue |
| `edits-missing` | The files are there, the added lines are not | Diff before acting; a re-land may have re-worded them |
| `indeterminate` | Could not be adjudicated (deleted or force-pushed base) | Investigate; never assume it landed |
| `superseded` / `landed` | Stranded merge commit, content present | Nothing. Recorded so it is not re-investigated |
| `needs-retarget` (open PR) | Base has already merged or been deleted | `gh pr edit <N> --base trunk` |

The job fails only on the first three plus `needs-retarget`. It also names open
PRs whose base has already merged or been deleted, so they can be re-targeted
before they strand. Verify a landing with that command rather than with the
MERGED badge.

The same mechanism exists in `honua-server` as
`scripts/ci/detect-stranded-merges.py`, with the same schema-version-2
vocabulary; the two implementations publish one contract.

## Commit hygiene

Author commits as the repo owner (`Mike McDougall <mike@honua.io>`). Do not add
agent/tool attribution (`Co-Authored-By`, "Generated with …", emoji trailers).

## Existing open PRs (migration)

Open PRs that already committed resealed evidence / regenerated artifacts do not
need to be redone — those files are simply overwritten on the next trunk
regeneration. When rebasing an in-flight PR onto trunk, prefer resolving any
`samples/evidence`, `samples/dist`, or other derived-artifact conflicts by taking
trunk's side; you no longer need to reseal to land.
