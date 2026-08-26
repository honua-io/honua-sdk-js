# Review policy for bot-authored release PRs

Issue [#1093](https://github.com/honua-io/honua-sdk-js/issues/1093). The trunk
ruleset's `copilot_code_review` rule made Release Please PRs unmergeable: the
rule requires a Copilot review, Copilot does not review bot-authored PRs, and
the reviewer cannot be requested through the API either (the REST request is a
no-op and GraphQL cannot resolve the login). Release PR #1092 sat fully green —
`JS SDK`, `MCP SDK`, and `PR Issue Disposition` all `SUCCESS` on the exact head
via the trusted release CI dispatch — and still reported
`mergeable_state=blocked`. Cutting `0.1.4-beta.0` took an admin-bypass squash.
Reseal PR #1091 merged only because a `github-code-quality` review thread
happened to exist, which is luck, not policy.

This records what the requirement actually is, what shipped, what the repository
looks like today, and which architecture we are committing to for the part that
is not ours to land.

## The requirement, restated

Two things have to be true at once:

- bot-authored automation PRs (`release-please--branches--trunk`,
  `automation/derived-artifacts-*`) merge without an admin flag;
- human-authored PRs keep the Copilot review requirement.

A change that delivers only the first is a mitigation, not the requirement. The
distinction matters because the cheapest way to unblock the release flow —
turning the rule off — silently drops the review gate for every human PR too.

## What shipped

The runbook half (REQ-002) landed in
[#1449](https://github.com/honua-io/honua-sdk-js/pull/1449): `docs/guide.md`,
"Re-running trusted CI for an existing Release Please PR". The operative detail
is that `release-please-ci` only fires when Release Please creates or refreshes
its PR, and only `release-please-disposition` can publish the required `JS SDK`
and `MCP SDK` checks. So a release PR that already existed before that path ran
must be recovered by re-dispatching `release-please.yml` on `trunk` — **not** by
dispatching `ci.yml` directly, because a bare `ci.yml` run cannot publish the
required checks and leaves the PR blocked in a way that looks like a review
problem but is not one.

That failure mode is live right now: PR #1321 (`chore: release trunk`) reports
`mergeable_state=blocked` with only the CodeQL contexts present. Its required
checks were never published. The runbook, not the review rule, is what applies.

## What the repository looks like today

The `copilot_code_review` ruleset (id `19494022`, "Code Quality Copilot review
for default branch") is **`enforcement: disabled`, with an empty
`bypass_actors` list**. The deadlock is therefore not currently biting — because
the rule is off for everyone.

That is the mitigation, not the requirement. While it stands, human PRs get no
Copilot review gate either, and nothing in the repository records that this is a
deliberate temporary state rather than a configuration someone forgot. This
document is that record.

## The architecture we are committing to

REQ-001 lists three admissible shapes. We choose the first, and reject the other
two rather than keeping them as fallbacks:

1. **A ruleset bypass actor scoped to the release automation identity.**
   *Chosen.* The rule stays `active`, so human PRs keep the gate. The exemption
   attaches to a named identity, so it is auditable — the bypass shows up
   against a principal rather than a branch pattern. It is also the only one of
   the three that cannot be inherited by a human who happens to push to the
   right ref.

2. A branch-scoped exemption on `release-please--branches--trunk` and
   `automation/derived-artifacts-*`. *Rejected.* Branch names are not an
   identity. Anyone who can create a branch with that name gets the exemption,
   which converts a review policy into a naming convention.

3. Excluding bot authors from the rule generally. *Rejected.* Too broad: it
   exempts every current and future bot, including ones added later for
   unrelated reasons, with no per-case review.

## Why this is not landed in this repository

Only half of the chosen architecture can be committed as a file here.

- **An org owner must re-enable ruleset `19494022` with a bypass actor.**
  Ruleset configuration is repository/org settings, not source. Nothing in
  `.github/` can express it. This is still the open half.
- **A release identity that can actually author the release PR.** *Provisioned.*
  The org bot App `honua-io-bot` holds `Contents: write`, `Pull requests: write`,
  `Actions: write`, `Issues: write`, `Workflows: write`, `Checks: read`, and
  `Metadata: read`, and reaches this repository through the org Actions secrets
  `BOT_APP_ID` / `BOT_APP_PRIVATE_KEY`. The older `honua-release-dispatch` app
  holds only `Actions: write` and `Metadata: read`, so it could never have
  authored or updated a pull request and is not the identity used here.

### The workflow half, as landed

Every lane in this repository that authors or merges an automation pull request
now mints a `honua-io-bot` installation token with
`actions/create-github-app-token` and uses it for exactly the operations the
ruleset judges — the branch push, the pull request, and (where the lane merges
itself) the merge:

| Lane | Workflow | What now runs as `honua-io-bot` |
| --- | --- | --- |
| Release Please | `.github/workflows/release-please.yml` | the action's `token:`, so the release branch push and `chore: release trunk` pull request; plus the `PUT /pulls/{n}/update-branch` base refresh |
| Derived artifacts | `.github/workflows/regenerate-derived-artifacts.yml` | checkout token for the `automation/derived-artifacts-*` push, `gh pr create`, `gh pr merge` |
| MCP certification | `.github/workflows/mcp-cert-scheduled.yml` | checkout token for the `automation/mcp-certification-*` push, `gh pr create`, `gh pr merge` |
| Kepler audit renewal | `.github/workflows/kepler-audit-renewal.yml` | `gh auth setup-git` push of `automation/kepler-audit-renewal-*` and `gh pr create` |

Each lane detects `BOT_APP_ID` first and mints only when it is present, so a
fork or a rotated secret degrades to the previous `GITHUB_TOKEN` behaviour
instead of hard-failing. Everything that is *not* an authorship operation stays
on `github.token` on purpose: dispatching workflows, approving held check runs,
watching checks, and publishing the release-please disposition check runs (which
`publishReleasePleaseDispositionCheck()` verifies were created by the GitHub
Actions integration).

**The remaining work is org settings**: re-enable ruleset `19494022` with
`honua-io-bot` as a bypass actor and set it Active, then prove it with a real
release pull request. No further code change is a prerequisite.

### Swapping the token is not a one-line change

Two things have to move with it, and missing either breaks the release flow the
moment the first App-authored PR appears.

**The disposition gate recognised exactly one bot login. Fixed.**
`automationExemption()` in `scripts/lib/pr-issue-disposition.mjs` used to grant
the Release Please exemption only when the actor login was `github-actions`,
`github-actions[bot]`, or `app/github-actions`, so a PR authored by the bot App —
`honua-io-bot[bot]` — matched none of the login forms and the required
`PR Issue Disposition` check would have rejected the very first release PR the
new identity opened.

The accepted logins are now derived from `RELEASE_AUTOMATION_APP_SLUGS`, an
exported array of GitHub App slugs (`github-actions`, `honua-io-bot`), each
accepted in the three forms GitHub reports an App actor under — `slug`,
`slug[bot]`, and `app/slug`. `github-actions` stays listed because every lane
keeps the `GITHUB_TOKEN` fallback above, and that fallback must not fail the
required check. Adding a future identity is one array entry rather than three
literals repeated per lane, and if the App is ever re-slugged that array is the
single place to change.

Only the login set widened. Same-repository origin, base `trunk`, the exact
head branch, both full-SHA shapes, and the exact title are unchanged, and
`test/scripts/pr-issue-disposition.test.mjs` pins that for all four lanes:
every accepted login form, an arbitrary bot login (`octocat[bot]`,
`honua-release-dispatch[bot]`, `honua-io-bot-impostor`) still refused, and each
other condition still refused under the new login.

The set is source-bound on purpose — no environment-variable override. The
disposition gate executes from the pull request's own checkout, so reading the
accepted logins from the environment would let a pull request widen the
identity set it is being judged by.

**The exemption covers more than release-please. Also fixed.** The requirement
names `automation/derived-artifacts-*` alongside
`release-please--branches--trunk`, and those PRs are real: PR #1451 on that
branch pattern merged into trunk while this record was being written. The
derived-artifact lane carried the same hardcoded logins and now shares
`RELEASE_AUTOMATION_APP_SLUGS`, so it does not inherit the deadlock this issue
is about. Whatever bypass actor is provisioned still has to cover that workflow
on the org side.

The two scheduled report lanes — `automation/mcp-certification-*` and
`automation/kepler-audit-renewal-*` — were originally left pinned to the GitHub
Actions logins, because they published on the workflow's own `GITHUB_TOKEN`.
They no longer do: a re-enabled ruleset would deadlock them exactly as it
deadlocked the release lane, since Copilot does not review their pull requests
either and the MCP lane merges its own. They now mint the same `honua-io-bot`
token, and their accepted logins come from a second exported array,
`SCHEDULED_AUTOMATION_APP_SLUGS`. It names the same two slugs today; it stays a
separate array so a future identity split has somewhere to land without
widening the release lanes by accident.

Nothing else in the repository needs the wider set.
`publishReleasePleaseDispositionCheck()` verifies `GITHUB_ACTIONS_APP_ID` on the
check run it *creates*, which is the workflow's own token regardless of who
authored the PR, so it is unaffected by the identity switch.

With those in place the `release-please.yml` edit itself is small: mint the
token in the release job and pass it where `secrets.GITHUB_TOKEN` is used at
line 40, keeping `GITHUB_TOKEN` as the fallback so a missing secret degrades to
today's behaviour rather than breaking the release.

## What closes the issue

The validation on #1093 is behavioural, not a diff: *a fresh release-please PR
merges via auto-merge with green required checks and no admin flag.* That needs
the ruleset re-enabled with `honua-io-bot` as its bypass actor and a real
release PR to prove it against. Until then the issue stays open, and the
disabled rule stays a recorded mitigation rather than an accident.
