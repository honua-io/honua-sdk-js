# Backlog dependency reconciliation

The backlog dependency reconciler reads issue state and proposes readiness-label changes. Dry-run mode never edits an
issue, changes a label, closes work, or interprets pull-request merge state. A dependency is satisfied only when the
exact referenced GitHub issue is closed.

## Dependency grammar

An automatically reconciled issue has one exact second-level section:

```md
## Backlog Dependencies

Mode: automatic
Dependencies:
- #525
- honua-io/honua-site#120
```

Use `#N` only for an issue in the owning repository. Cross-repository dependencies must use `owner/repo#N`. Full
URLs, ranges, prose qualifiers, trailing comments, duplicate references, pull-request numbers, and self-references
are invalid. The dependency list is bounded to 20 entries by default.

An issue with no prerequisites uses this explicit form:

```md
## Backlog Dependencies

Mode: automatic
Dependencies: none
```

Epics and intentionally manual sequencing use a validated opt-out rather than prose dependencies:

```md
## Backlog Dependencies

Mode: manual
Reason: Umbrella epic; executable child issues own readiness.
```

The section allows no extra or blank lines. A manual reason is required and is limited to 240 characters. Specifica
issues in automatic mode must contain exactly one visible `## Specifica` section with exactly one canonical
`Type: Feature` declaration. Epics, missing or ambiguous types, and noncanonical type declarations must use manual
sequencing or be corrected before automation. Dependency headings and type declarations inside valid Markdown
fences, CommonMark raw HTML blocks, or HTML comments are ignored. Manual reasons are validated but never emitted in
human reports, JSON reports, or errors.

## Dry run

Run against current GitHub metadata with a read-only token:

```bash
GITHUB_TOKEN=... npm run backlog:dependencies:dry-run -- --repository honua-io/honua-sdk-js
```

Add `--json` for the versioned machine-readable report. Bounds can only be positive integers:

```bash
npm run backlog:dependencies:dry-run -- \
  --repository honua-io/honua-sdk-js \
  --max-pages 2 \
  --max-issues 200 \
  --max-dependencies 20 \
  --concurrency 4 \
  --json
```

The reader loads a bounded open-issue inventory, follows only exact dependencies, and then re-reads every accessible
issue before planning. Body, labels, state, `updated_at`, or accessibility drift produces a fail-closed `drift`
disposition. Drift, missing sections, malformed bodies, and manual opt-outs never propose a label change. A valid
automatic issue that is marked `ready-to-start` is proposed for demotion to `blocked` when an exact dependency is
inaccessible, resolves to a pull request, or participates in a dependency cycle. Those unsafe dispositions never
propose promotion to `ready-to-start`.

Token-bearing requests are origin- and path-locked to the configured HTTPS GitHub API root, use `GET` with redirect
refusal and a 15-second request timeout, require JSON, and apply fixed byte and chunk-count bounds while streaming at
most 16 MiB per response. Plain HTTP is accepted only for a loopback test server. The total readable plus inaccessible
graph is bounded by `--max-issues`; labels, bodies, pages, dependency fan-out, and concurrency have hard ceilings.
Response bodies, request failures, manual reasons, unavailable reasons, labels, tokens, and filesystem paths are never
copied into reports or errors.

For deterministic offline inspection, pass a stabilized JSON snapshot:

```bash
npm run backlog:dependencies:dry-run -- \
  --repository honua-io/honua-sdk-js \
  --metadata test/fixtures/backlog-dependencies/stable-snapshot.json \
  --json
```

The report always says `mutationsPerformed: false`. An offline snapshot must be a non-symlink regular UTF-8 file no
larger than 16 MiB, and the reader rejects size or identity drift while reading it.

## Trusted apply

Apply mode accepts live GitHub metadata only:

```bash
GITHUB_TOKEN=... npm run backlog:dependencies:apply -- --repository honua-io/honua-sdk-js --json
```

The apply path consumes the same pure planner as dry-run mode. Before the first write, it loads and double-reads each
candidate's exact transitive dependency graph and requires the targeted plan, issue body, labels, and dependency
states to match the stabilized inventory. Immediately before each write it repeats that targeted double-read. Any
drift, ambiguous labels, unreadable metadata, rate limit, degraded response, or changed disposition stops the run.

An admitted transition replaces the issue's label set in one bounded `PATCH`, changing exactly one of `blocked` and
`ready-to-start` while preserving every unrelated label. The returned issue and a post-write double-read must prove
the expected stable postcondition. The command never edits issue bodies, priority, phase, roadmap, effort, parentage,
state, or comments. A second run is a no-op once the planned readiness transition has landed.

The `Backlog dependency reconciliation` workflow runs scheduled applies every six hours and offers explicit manual
`dry-run` and `apply` modes. It checks out only the repository default branch into `trusted-policy`, disables checkout
credentials, pins every action by commit, and never runs on pull-request events. The dry-run job has `contents: read`
and `issues: read`; only the apply job receives `issues: write`. Both jobs write the bounded JSON report to the Actions
log and job summary without adding issue comments.
