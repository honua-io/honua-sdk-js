---
type: reference
title: "Published documentation qualification for SDK issue 1897"
description: "Immutable command replay evidence and explicit qualification limits for five published SDK documents."
---
# Published documentation qualification for SDK issue 1897

The five SDK-owned documents pass against the reviewed release inputs in
[run 38205709419](https://github.com/honua-io/honua-release/actions/runs/38205709419),
artifact `11727651785`. The raw [document report](corrected/sdk-publication-replay/executable-docs.json)
and [summary](corrected/sdk-publication-replay/executable-docs-summary.md) account for
all 45 blocks: **27 executed command blocks, 8 compiled snippets, 1 saved configuration
file, and 9 not-run blocks**. There are no failed, blocked or needs-input blocks.

| Published document | Immutable source | Passing blocks | Not run |
| --- | --- | ---: | ---: |
| SDK README | `a86b222878939a4c85abd1fe574303b60d81a3b5` | 9 | 3 |
| INSTALL | `a86b222878939a4c85abd1fe574303b60d81a3b5` | 3 | 0 |
| Quickstart | `a86b222878939a4c85abd1fe574303b60d81a3b5` | 5 | 1 |
| MCP README | `46ecd25a32ee2bfb7741ccc14ee5842c8824dd19` | 16 | 4 |
| Scaffold README | `4ded33a5ee77cc3b289f85740f315d5f4a122fae` | 3 | 1 |

The selected public packages are SDK and five companions `0.1.16`, independently
pinned MCP `0.1.16`, and scaffold `0.1.9`. Canonical verification downloaded the
public artifacts and checked their source, SRI and publisher provenance. The
[retained manifest](corrected/sdk-publication-candidate/platform-manifest.yaml)
keeps server source `93cad86ec4fb28fba3ff0b9358059d86aa55dde5` at image digest
`sha256:785de2ae7f72e6277ce62aa1ece4f08ee0425970b71c47f9f4843c0baae2c8db`.
The reviewed platform inputs were merged by honua-release PRs 560 and 563.

## What the original findings now prove

The published install steps provide the MapLibre peer needed by the README
snippet. Source examples explicitly enter a checkout before running repository
scripts; the fixture/dev commands satisfy their readiness checks. CLI query
examples, both scaffold templates and the MCP certification/offline evaluation
commands pass their unchanged published commands and output checks. Typechecked
examples compile after their documented installation steps.

The published MCP credential guidance identifies `HONUA_TOKEN` as the reader's
operator-issued bearer token, and identifies the reader's provider keys or AWS
credential chain. Its offline evaluation control passes. The billable live-model
block is intentionally not executed; this evidence does not claim a live model run.

The nine not-run blocks are six non-executable format examples, two explicitly
partial/browser application excerpts, and that one billable credential-dependent
lane. Their document/index/hash/reason identities match the prior published-cohort
report from run 38188029156 and the failed fresh attempt below. No block was removed
or newly excluded by this qualification or its checker repair.

## Source builds and public default consumers

The source-build runner instruments moving clone instructions with the document's
immutable revision. It executes the documented npm commands with unchanged
lockfiles. Exact source dependency paths, versions, integrity and the MCP `file:..`
link are admitted separately from installed candidate packages. The source Git
revision and lock bytes are checked before and after source execution and later
observations. The three repaired MCP observations are marked `sourceDependencyAudit`;
they are not claims that the source SDK 0.1.15 link is a published SDK 0.1.16 consumer.
Honua-release PR 565 fixes that checker distinction while keeping the candidate
registry strict.

Outside that guard, actual public `npm create honua-app@latest`, default npm install,
production build and the documented dev command passed; readiness returned HTTP 200.
The [actual consumer lock](corrected/sdk-publication-replay/public-consumer/my-map/package-lock.json)
shows scaffold 0.1.9 selected its certified SDK 0.1.14 fallback. Its separate
[candidate binding result](corrected/sdk-publication-replay/public-scaffold-resolution.json)
therefore remains failed. The whole diagnostic job is **failed**, as the raw
[gate statuses](corrected/sdk-publication-replay/gate-exit-status.json) require.
The MCP README's floating commands are confined to the selected MCP 0.1.16 in this
candidate replay; they are not proof that public npm latest resolved that version.

The adjacent [installed-client report](corrected/sdk-publication-replay/installed-clients.json)
contains 33 active passing cells and 8 predeclared blocked cells. Its overall
status remains blocked despite the runner's zero exit. These results do not certify
the entire platform, promote defaults, change customer installer pins, or satisfy
the separate Production four-adapter qualification in issue 1424.

## Preserved attempts and provenance

- Run 38203954406 attempt1 verified eight public artifacts, then received npm HTTP 429
  before consumer/document execution. Its unrelated broad document job was cancelled
  to permit the failed-job retry. [Initial provenance](registry-throttle-attempt/attempt1-provenance.json).
- Attempt2 ran the published commands successfully but misclassified the retained
  MCP source SDK link in three blocks. Four documents passed and one failed.
  [Unchanged raw failure](retained-source-audit-failure/executable-docs.json).
- Run 38205709419 executed the checker repair at `e4f1538a8e36c252f99c8c4e4de7ae82cdb846d1`.
  The current PR 565 head only adds four unrelated release-decision documents; its
  executable input trees match. [Artifact identity and every retained file hash](corrected/provenance.json).

All raw reports remain byte-exact, including failed and blocked statuses.
