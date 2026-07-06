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
