# Honua MCP Evals — committed evidence corpus

This directory is the **published, verifiable evidence** behind Honua's MCP
"any client → any workflow" claim. It is evals-as-marketing: real run artifacts,
committed to the repo, rendered into a leaderboard anyone can audit.

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

Four corpora feed the eval, selected by `HONUA_EVAL_CORPUS` / `--corpus`:

| Corpus | Source | Surface | Grading |
| --- | --- | --- | --- |
| `analyst` (default) | `src/eval/corpus.ts` | Honua fixture | structural |
| `operator` | `src/eval/operator-corpus.ts` | live operator `/mcp` | structural |
| `northstar` | `src/eval/northstar-corpus.ts` | live P1 `/mcp` | structural (gate) |
| `standalone` | `src/eval/standalone-corpus.ts` | **plain public FeatureServer fixture** | **semantic** |

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

The deterministic offline control must pass every standalone scenario; the
evaluator that backs the fixture is parity-checked against the live recordings
(`test/certification/census-fixture-client.test.ts`).

## What makes a run trustworthy

Every artifact carries a self-proving `provenance` block — target URL, negotiated
MCP protocol version, advertised tool count, auth mode, the git SHA of the
certification/eval suite, and a timestamp. A published row is therefore
reproducible evidence, not a claim: you can re-run the exact suite SHA against the
named surface and expect the same numbers.

## How runs get here

- **Scheduled free certification** (`.github/workflows/mcp-cert-scheduled.yml`) —
  weekly + on-demand, runs the deterministic (zero-LLM, free) certifier against
  the live demo `/mcp`, commits `cert-demo.json`, and regenerates the leaderboard.
- **Paid cross-model eval** (`.github/workflows/mcp-eval-live.yml`) — manual only.
  Runs the corpus through Bedrock models (`us.anthropic.claude-opus-4-6-v1`,
  `us.amazon.nova-2-lite-v1:0`) against a live surface, then appends the artifacts
  and regenerates the leaderboard. All model usage goes through AWS Bedrock.

Seed data under `runs/2026-07-05/` is the first real cross-model run: Claude Opus
4.6 8/8 and Nova 2 Lite 5/8 on the operator corpus against the authenticated live
demo `/mcp`, with the deterministic control at 8/8.
