# Backlog dependency reconciliation

The backlog dependency dry run reads issue state and proposes readiness-label changes. It never edits an issue,
changes a label, closes work, or interprets pull-request merge state. A dependency is satisfied only when the exact
referenced GitHub issue is closed.

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

For deterministic offline inspection, pass a stabilized JSON snapshot:

```bash
npm run backlog:dependencies:dry-run -- \
  --repository honua-io/honua-sdk-js \
  --metadata test/fixtures/backlog-dependencies/stable-snapshot.json \
  --json
```

The report always says `mutationsPerformed: false`. Workflow wiring and the label-only apply path belong to issue
#600 S2 and must consume the reviewed planner without adding a second parser.
