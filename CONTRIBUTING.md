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

## Release-lineage, drift and network gates

Reference for the gates `AGENTS.md` lists by name. Read the entry before changing the
code or data it guards.

- **Contract conformance:** `npm run test:conformance` (`vitest.conformance.config.ts`) — round-trips the shared, versioned geospatial-grpc fixtures through the real `HonuaClient` against a pinned `honua-server:nightly` and fails on `Dataset`/`Source`/`Query`/`Result` drift. Double-gated on `HONUA_INTEGRATION_BASE_URL` + `HONUA_CONFORMANCE_FIXTURES_DIR`; explicit no-op otherwise. Pull fixtures with `conformance/fetch-fixtures.sh --version <X.Y.Z>`. See `conformance/README.md`.
- **Generated MCP client pin:** `npm run verify:mcp-pin` proves the `@honua/mcp-server` version written into generated `.mcp.json` / `claude_desktop_config.json` files belongs to this repo's release lineage, never runs ahead of `mcp/package.json`, and declares a `@honua/sdk-js` peer range that npm's default resolver accepts for the SDK version beside it; `HONUA_MCP_PIN_LIVE_ENABLED=true npm run verify:mcp-pin:live` additionally resolves it against the public npm registry and compares the recorded tarball integrity (network lane; never in PR CI). `test/verify-mcp-pin.test.ts` covers both offline.
- **Pinned client pair co-install:** `npm run verify:client-pair` packs this tree and really installs it beside the pinned `@honua/mcp-server` in a throwaway consumer under **default** peer resolution -- no `--legacy-peer-deps`, no `--force` -- so a cut whose pair only installs with a workaround fails before publish. `npm run verify:client-pair:registry` asks the same question of the two published artifacts (scheduled `mcp-pin-live.yml`). Releases are stable `0.x` versions (from 0.1.12; "beta" is the documented maturity label, not part of the version string), so `@honua/mcp-server`'s caret peer on `@honua/sdk-js` (for example `^0.1.12`) admits later SDK patches and an SDK-only patch co-installs with the MCP release already pinned. The earlier `-beta.N` prereleases could not do that: a caret range over a prerelease admits exactly one `major.minor.patch` tuple (#1529).
- **Advancing the generated-config MCP pin:** the pin in `src/local-install.ts` must name a version the registry serves *and* declare a peer range that admits this SDK's version -- so it is deliberately not a release-please `extra-files` bump (release-please would advance it before either half is published, and cannot compute the recorded tarball integrity). After the coordinated `@honua/mcp-server` publish, run `npm run sync:mcp-pin` to advance the version and its integrity together. The pin has two homes -- `src/local-install.ts` and the shipped `mcp/release/zero-to-map/configs/*.json`, which `verify:mcp-pin` requires to name the identical pin -- and the sync moves both in one run, so advancing one alone can never leave the tree failing its own gate. `npm run sync:mcp-pin -- --check` reports drift at every one of those sites without writing. Between a release bump and that publish the pin legitimately lags: PR CI stays green and `verify:client-pair` is what refuses to ship it.
- **Scaffold + playgrounds (`packages/create-honua-app`):** `npm run create-app:verify`, `npm run create-app:test`, `npm run create-app:templates:typecheck`, `npm run create-app:verify:package` (packs the scaffold and scaffolds from the tarball), `npm run playgrounds:check` (regenerate the page with `npm run playgrounds:generate`); the registry lane is `HONUA_CREATE_APP_LIVE_ENABLED=true npm run create-app:time-to-map`. See `docs/create-honua-app.md`.
- **Gallery sample playgrounds (`playgrounds/`):** generated standalone projects for the samples that qualify — `npm run samples:playgrounds:generate` writes them plus the catalog overlay's `playground` links (follow with `npm run samples:migrate:v1`) and the managed `sample-playground` block in each qualifying sample's own `examples/<id>/README.md`, `npm run samples:playgrounds:check` fails on drift in any of the three, `npm run samples:playgrounds:typecheck` compiles them against SDK source, `npm run samples:playgrounds:test` covers the eligibility rules. The scheduled registry lane is `HONUA_PLAYGROUND_LIVE_ENABLED=true npm run samples:playgrounds:smoke` (weekly `sample-playground-live.yml`; never in PR CI): it installs a generated playground from the real npm registry, builds it, serves the production build, and drives it headless. A sample whose data comes from a repository fixture server gets that origin generated too — declare it in `PLAYGROUND_FIXTURE_ORIGINS` (`scripts/sample-playgrounds.mjs`) and the project ships byte-identical copies of the reviewed fixture pack plus a Vite plugin serving the sample's audited same-origin routes. Never edit `playgrounds/` by hand: change the sample under `examples/` and regenerate. See `docs/playgrounds.md`.
- **Documented executable commands:** `npm run docs:commands:check` proves every `npx` command in a fenced block can actually resolve an executable, by reimplementing npm's own bin derivation against the `bin` maps on disk. `npx` takes a *package*, not a command, so `npx @honua/sdk-js honua <cmd>` cannot run (two bins, neither named `sdk-js`) and `npx honua-js-migrate` 404s (a bin, not a package) unless the same block installed `@honua/honua-migrate` first — both fail only for the reader, never for the author, who already has the bin on PATH (#1596). It reads trailing `#` comments too, so a code-block comment cannot quote a broken command to warn against it; put that warning in the prose. The network lane is `npm run docs:commands:registry` (weekly `documented-packages.yml`; never in PR CI): it installs the pinned candidate from the registry into a throwaway consumer under **default** resolution and runs each documented invocation there, passing only on positive evidence — exit 0 and the resolved executable naming itself — plus a control that the #1596 form is still unresolvable.
- **Canonical capability keys / coverage snapshot:** `npm run samples:verify` validates `samples/catalog.v2.json`'s `capabilityKeys` against `config/capability-crosswalk.v1.json`; `npm run sdk-coverage:generate` / `npm run sdk-coverage:check` produce and drift-gate `config/sdk-coverage.v1.json` from `config/support-manifest.v1.json` + `config/sdk-coverage-crosswalk.v1.json`. See `docs/capability-keys.md`.
- **Sample-contract look-ahead clock lane:** `npm run samples:contract:lookahead` re-runs `test/sample-contract.test.ts` against a forward-shifted validation clock (+35d and +95d, clearing the 31-day executed and 90-day non-executed evidence windows) so a fixture whose validity silently depends on the wall-clock date fails weeks before it wedges trunk; on failure it bisects the offset and names the date the fixture tips. `HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS` shifts that one suite's clock and nothing else. See the header of `test/sample-contract.test.ts`.

## PR issue disposition footer (CI-enforced)

Every PR body must end with a contiguous block of disposition lines. The
required `PR Issue Disposition` check runs `scripts/check-pr-issue-disposition.mjs`
and **fails the PR** on any deviation, so get it right when you open the PR
rather than after a red check.

Each line is exactly one of:

```
Closes #N
Refs #N (explanation)
```

**Use `Closes` when every acceptance criterion on the issue is met.** Do not
downgrade finished work to `Refs` out of caution — a closed issue is the point
of the work, and leaving a satisfied issue open is its own kind of drift.

**Use `Refs` only when the issue genuinely still has open acceptance
criteria** after this PR merges, and say in the parenthetical what remains.
Typical honest reasons: the rest needs a live candidate server, published
registry bytes, a real release cut, a change in another repository, or a
blocking issue. If you are using `Refs`, you should be able to name the
specific unmet criterion.

The explanation is not free-form. It must:

- be 1–160 characters, trimmed, with no parentheses or newlines inside it;
- contain at least one progress marker — `S<number>`, `slice`, `partial`,
  `remain` / `remains` / `remaining`, `follow-up`, `blocked`, or `handoff`.

Further rules the validator enforces:

- The block may declare several issues (at most 20), one per line, with no
  issue repeated.
- No `Refs #N` may appear anywhere above the block — a stray one in the prose
  fails as `misplaced-reference`.
- No closing keyword tied to an issue (`close`/`closes`/`closed`,
  `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved` followed by `#N`) may
  appear above the block. Write neutral prose and keep closure intent only in
  the footer. "This does not close #123" fails; say "this PR is not sufficient
  on its own" instead.

Valid examples:

```
Closes #1421
```

```
Refs #1397 (server-discovered routing; family/view metadata remains, blocked on honua-server#3428)
Refs #1398 (proposal status client; draft enumeration remains, blocked on honua-server#3003)
```

Syntax-check a body before pushing instead of guessing at the grammar:

```bash
node --input-type=module -e '
import { parsePullRequestDisposition } from "./scripts/lib/pr-issue-disposition.mjs";
import { readFileSync } from "node:fs";
console.log(parsePullRequestDisposition(readFileSync("/tmp/body.md", "utf8")));'
```

This covers the footer grammar only. The required check calls
`validatePullRequestDisposition`, which additionally resolves each declared
issue against the GitHub API — so a footer that is syntactically perfect still
fails the gate when it names an issue that does not exist, is already closed,
lives in another repository, or is actually a pull request, or when GitHub does
not recognise a declared `Closes` reference. A clean parse means the grammar is
right, not that the PR will pass.

## Keeping a PR mergeable

- Trunk protection requires conversation resolution: every review thread must
  be resolved before merge. Judge automated review findings on the evidence —
  fix the real ones, and reject a false positive with concrete proof rather
  than making a no-op change to silence it.
- CI runs **trunk's** workflow against your branch. When a merged PR adds a new
  gate, older branches fail with `Missing script: "<name>"` until they merge
  trunk. Merge or rebase onto `origin/trunk` before diagnosing such a failure
  as a defect in your own work.
- `docs/bundle-sizes.md` is regenerated on trunk by automation and conflicts
  often. Never hand-merge it: take trunk's copy and regenerate.

  ```bash
  git checkout origin/trunk -- docs/bundle-sizes.md
  npm run report:bundle-sizes
  npm run verify:bundle-budgets
  ```

- A ceiling that appears in more than one file must be changed in all of them.
  The `/web-components` gzip ceiling, for example, lives in
  `bundle-budgets.json`, `config/app-platform-reference-evidence.v1.json`, and
  the generated `config/app-platform-reference-qualification.v1.json`
  (regenerate with `npm run qualification:app-platform`).

## Release metadata files

### `release/component-versions.json`

`release/component-versions.json` declares this package's contract and schema versions
(`honua.component-versions/v1`). The honua-release nightly resolver reads it at the published
source commit of the npm package and refuses `honua-sdk-js` when it is missing or invalid. Any PR
that bumps a contract version (for example `connect-parity`) or a schema version (for example the
diagnostic bundle `schemaVersion` in `src/diagnostics/schema.ts`) must update this file in the same PR.

### `release/sdk-capability-baseline.json`

`release/sdk-capability-baseline.json` (`honua.sdk-capability-baseline/v1`, defined by honua-release `schemas/sdk-capability-baseline.v1.schema.json` and `docs/SDK-SERVER-BASELINE-RULE.md`) declares the honua-server capabilities this repository requires and the `minimumServerVersion` derived from them. The honua-release nightly resolver reads it at the source revision of every published npm package (`@honua/sdk-js` and its companion `@honua/mcp-server`), and refuses the component when it is missing, invalid, or when those revisions declare different `minimumServerVersion` values. It takes effect only after a release-please publication contains it. Every required capability must be a key in honua-server `docs/gis/data/capability-keys.v1.json`, and `capabilities` must hold exactly one introduction entry per required capability. Add or remove a required capability in the same PR that starts or stops depending on it.

## Filing issues

When the user asks for a ticket, backlog item, epic, workstream, or GitHub issue:

- Create the issue with `gh issue create` in the owning repository. Do not leave the work only in chat or a temporary docs file unless the user explicitly asks for a draft.
- Search existing open and closed issues before filing to avoid duplicates.
- For work that primarily demonstrates or exercises the JavaScript SDK, examples, MCP package, or migration tooling, default to `honua-io/honua-sdk-js`.
- For work that spans the Honua platform, create an umbrella issue in the coordinating repo and child issues in implementation repos when the scope is concrete enough. If only one issue is requested, include an `Affected repos` section.
- Use existing labels when practical: `enhancement`, `area/sdk`, `area/mcp`, `area/server`, `area/infrastructure`, `phase/MVP`, `phase/Beta`, `priority/P*`, and `effort/*`.

### Specifica requirement format

Product backlog issues, epics, and cross-repo workstreams use the Specifica
format: requirement-first and traceable, not a loose idea note. Every
workstream must be in Specifica.

- Issue bodies marked as Specifica projections are generated from
  `honua-io/agent-delivery-spec`: edit the markdown there and resync rather
  than hand-editing GitHub, which gets overwritten.
- Otherwise create the issue directly from the canonical templates in
  `honua-io/agent-delivery-spec`: `templates/specifica-epic-issue.md` and
  `templates/specifica-feature-issue.md`. Never file workstreams, demo
  backlogs, platform contracts, or epics as free-form notes.
- Split a broad roadmap item into child Specifica feature issues before work
  starts; for app backlogs prefer one epic carrying the workstream context
  plus one child issue per sample application.
- The incident operations dashboard is realtime by default; never describe it
  as a static dashboard unless the user explicitly changes that requirement.

## Commit hygiene

Author commits as the repo owner (`Mike McDougall <mike@honua.io>`). Do not add
agent/tool attribution (`Co-Authored-By`, "Generated with …", emoji trailers).

## Existing open PRs (migration)

Open PRs that already committed resealed evidence / regenerated artifacts do not
need to be redone — those files are simply overwritten on the next trunk
regeneration. When rebasing an in-flight PR onto trunk, prefer resolving any
`samples/evidence`, `samples/dist`, or other derived-artifact conflicts by taking
trunk's side; you no longer need to reseal to land.
