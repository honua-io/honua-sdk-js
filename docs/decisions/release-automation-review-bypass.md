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

The chosen architecture cannot be committed as a file here. Two things are
needed, both outside this repository:

- **An org owner must re-enable ruleset `19494022` with a bypass actor.**
  Ruleset configuration is repository/org settings, not source. Nothing in
  `.github/` can express it.
- **A release identity that can actually author the release PR.** Today
  `release-please.yml:40` uses `secrets.GITHUB_TOKEN`, and no workflow in this
  repository uses `create-github-app-token`. The existing
  `honua-release-dispatch` app holds only `Actions: write` and
  `Metadata: read`, so it cannot author or update a pull request even if it were
  wired in. Minting a token that can requires an org-installed app with
  `Contents: write` and `Pull requests: write`, and its App ID plus private key
  provisioned as repository secrets.

Until that identity exists, wiring `create-github-app-token` into
`release-please.yml` would add a code path that cannot be exercised, so it is
deliberately not done here. When the app is provisioned, the workflow change is
small: mint the token in the release job and pass it where
`secrets.GITHUB_TOKEN` is used at `release-please.yml:40`, keeping
`GITHUB_TOKEN` as the fallback so a missing secret degrades to today's
behaviour rather than breaking the release.

## What closes the issue

The validation on #1093 is behavioural, not a diff: *a fresh release-please PR
merges via auto-merge with green required checks and no admin flag.* That needs
the ruleset re-enabled with the bypass actor and a real release PR to prove it
against. Until then the issue stays open, and the disabled rule stays a recorded
mitigation rather than an accident.
