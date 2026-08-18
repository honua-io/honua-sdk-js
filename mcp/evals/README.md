# Honua MCP Evals — committed evidence corpus

This directory is the **published, verifiable evidence** behind Honua's MCP
"any client → any workflow" claim. It is evals-as-marketing: real run artifacts,
committed to the repo, rendered into a leaderboard anyone can audit.

**Public page:** these artifacts are also rendered into the
[cross-model MCP eval scorecard](../../docs/generated/mcp-eval-scorecard.md) on
the docs site — the same numbers plus the methodology, the candor sections, and
the reproduction commands. The workflows below regenerate it in the same commit
that lands a new run, so it never trails this directory; regenerate it by hand
from the repo root with `npm run docs:mcp-scorecard`. Freshness is gated on
trunk by `npm run docs:mcp-scorecard:check` (relaxed on PRs, like `verify:llms`).

## Layout

```
evals/
  runs/<YYYY-MM-DD>/          committed run artifacts (JSON + Markdown)
    eval-<corpus>-<model>.json   cross-model eval report (schemaVersion 4)
    cert-demo.json               certification report (schemaVersion 2)
  LEADERBOARD.md             generated — model × corpus × pass-rate + breakdown
  leaderboard.html           generated — self-contained static page
  README.md                  this file
```

## Regenerating the leaderboard

```bash
node mcp/scripts/render-leaderboard.mjs
```

The generator scans every `*.json` under `runs/`, classifies each as an eval or a
certification report, and rewrites `LEADERBOARD.md` + `leaderboard.html`. It has
no dependencies, so CI and a dev box produce byte-identical output.

## Corpus design + grading taxonomy

Five corpora feed the eval, selected by `HONUA_EVAL_CORPUS` / `--corpus`:

| Corpus | Source | Surface | Grading |
| --- | --- | --- | --- |
| `analyst` (default) | `src/eval/corpus.ts` | Honua fixture | structural |
| `operator` | `src/eval/operator-corpus.ts` | live operator `/mcp` | structural |
| `northstar` | `src/eval/northstar-corpus.ts` | live P1 `/mcp` | structural (gate) |
| `standalone` | `src/eval/standalone-corpus.ts` | **plain public FeatureServer fixture** | **semantic** |
| `ogc` | `src/eval/ogc-corpus.ts` | **plain OGC API Features fixture** | **semantic** |

The **standalone** corpus (50+ scenarios, issue #369) is the platform-free proof:
it runs against a recorded public census FeatureServer (`services.arcgis.com`, no
Honua surfaces) and grades the **meaning** of answers, not just the tool
trajectory. Its grading taxonomy:

- **Structural** — `requiredTools`, `expectedToolSequence`, `forbiddenTools`: was
  the right workflow used?
- **Semantic value** (`answerMustMatch`, regex) — is the *number* right? Grounded
  against real recorded data (rows = 52, sum(pop) = 335,085,841, House seats = 435,
  states with ≥20 seats = 4).
- **Geographic reasoning** (`answerMustInclude` + `answerMustNotInclude`) — is the
  right *place* named? (California is most populous; Wyoming least.)
- **Tool selection** — ambiguous asks that must pick count vs. query vs. statistics
  vs. extent (`requiredTools` + `forbiddenTools`).
- **Refusal / clarification** (`expectClarification`) — ambiguous or unsupported
  requests must ask a clarifying question or refuse, not guess.
- **Anti-hallucination** (`answerMustNotInclude`) — wrong facts/numbers fail.
- **Capability degradation** — Honua-only tools (styling) must return a structured
  "not available on this target" result on a plain FeatureServer.

The **ogc** corpus (25 scenarios, issue #1005) is the *non-GeoServices* half of
that proof. Passing every census scenario says the surface works against Esri; it
says nothing about vendor neutrality, because a GeoServices-shaped contract would
pass them all. So the identical catalog runs against a recorded public **OGC API
Features** endpoint (`demo.pygeoapi.io`, the pinned `ogc-features` conformance
target) where no `serviceId`/`layerId` exists at all — sources are addressed as
`ogc-features:<collectionId>`, filters are the typed semantic filter compiled to
CQL2, geometry is GeoJSON/bbox, and time is the canonical temporal predicate. A
test asserts no scenario in that corpus uses Esri addressing.

Its per-protocol honesty scenarios are the interesting ones: OGC API Features has
no server-side aggregation and no server-side extent operation, so those answers
must arrive carrying an explicit degradation reason, and a CQL2 spatial predicate
the endpoint does not publish must return a structured capability refusal rather
than an empty feature list. Anchors: 5 observations and 31 Utah cities,
`avg(value)=96.14`, `sum(POP_2000)=354212`, `stn_id=2147 ⇒ 2 rows`, the
2001–2004 interval ⇒ 3 rows.

The deterministic offline control must pass every standalone AND every ogc
scenario; the evaluators that back both fixtures are asserted against the live
recordings (`test/certification/census-fixture-client.test.ts`,
`test/certification/ogc-fixture-client.test.ts`).

## What makes a run trustworthy

Every artifact carries a self-proving `provenance` block — target URL, negotiated
MCP protocol version, advertised tool count, auth mode, the git SHA of the
certification/eval suite, and a timestamp. A published row is therefore
reproducible evidence, not a claim: you can re-run the exact suite SHA against the
named surface and expect the same numbers.

## How runs get here

- **Scheduled free certification** (`.github/workflows/mcp-cert-scheduled.yml`) —
  weekly + on-demand, runs the deterministic (zero-LLM, free) certifier against
  the live demo `/mcp`, then publishes `cert-demo.json`, the regenerated
  leaderboard, and the docs-site scorecard through an automation pull request
  that merges once trunk's required checks pass. It cannot push at trunk
  directly: the branch ruleset rejects that, so every run used to certify the
  surface and then discard the report (honua-sdk-js#1351). The raw certification
  JSON and Markdown are also attached to every run as the `mcp-scheduled-cert`
  artifact, whether or not the corpus changed.
- **Paid cross-model eval** (`.github/workflows/mcp-eval-live.yml`) — manual only.
  Runs the corpus through Bedrock models (`us.anthropic.claude-opus-4-6-v1`,
  `us.amazon.nova-2-lite-v1:0`) against a live surface, then appends the artifacts
  and regenerates the leaderboard. All model usage goes through AWS Bedrock.

Seed data under `runs/2026-07-05/` is the first real cross-model run: Claude Opus
4.6 8/8 and Nova 2 Lite 5/8 on the operator corpus against the authenticated live
demo `/mcp`, with the deterministic control at 8/8.
