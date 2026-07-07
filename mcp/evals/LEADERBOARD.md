# Honua MCP Evals — Leaderboard

_Generated 2026-07-07T17:57:02.170Z from 3 eval + 3 certification run artifact(s) in [`runs/`](./runs)._

Every row is reproducible: each source artifact records its target surface, negotiated protocol version, tool count, auth mode, and the git SHA of the suite that produced it. All model calls run through AWS Bedrock; the deterministic control makes no model calls and is the CI gate.

## Cross-model leaderboard

| Model | Vendor | Corpus | Surface | Pass rate | Passed | Clarify | Edit | Date | Suite SHA |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| `deterministic _(control)_` | deterministic | operator | https://demo.honua.io/mcp | 100% | 8/8 | 0% | 13% | 2026-07-05 | `—` |
| `us.anthropic.claude-opus-4-6-v1` | bedrock | operator | https://demo.honua.io/mcp | 100% | 8/8 | 0% | 13% | 2026-07-05 | `—` |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | bedrock | operator | https://demo.honua.io/mcp | 100% | 8/8 | 0% | 13% | 2026-07-07 | `a09735af87` |
| `us.amazon.nova-2-lite-v1:0` | bedrock | operator | https://demo.honua.io/mcp | 63% | 5/8 | 25% | 25% | 2026-07-05 | `—` |

## Per-scenario breakdown

Legend: ✅ pass · ❌ fail · ❓ clarified · ⚠️ error · · not run

### operator — 2026-07-05 (https://demo.honua.io/mcp)

| Scenario | deterministic | us.amazon.nova-2-lite-v1:0 | us.anthropic.claude-opus-4-6-v1 | us.anthropic.claude-sonnet-4-5-20250929-v1:0 |
| --- | :--: | :--: | :--: | :--: |
| `operator-clarify-loop` | ✅ | ✅ | ✅ | ✅ |
| `operator-discover-then-query` | ✅ | ✅ | ✅ | ✅ |
| `operator-dry-run` | ✅ | ❓ | ✅ | ✅ |
| `operator-geocode-gap` | ✅ | ✅ | ✅ | ✅ |
| `operator-ground-intent` | ✅ | ❓ | ✅ | ✅ |
| `operator-list-layers` | ✅ | ✅ | ✅ | ✅ |
| `operator-plan-validate` | ✅ | ⚠️ | ✅ | ✅ |
| `operator-validate-package` | ✅ | ✅ | ✅ | ✅ |

## Certification runs

| Surface | Mode | Tools | Conformant | Contracts | Skipped | Result | Date | Suite SHA |
| --- | --- | ---: | ---: | ---: | ---: | :---: | --- | --- |
| live honua /mcp (https://demo.honua.io/mcp) | `remote` | 15 | 15/15 | 2/3 | 0 | ❌ fail | 2026-07-05 | `—` |
| live honua /mcp (https://demo.honua.io/mcp) | `remote` | 20 | 20/20 | 11/13 | 5 | ❌ fail | 2026-07-06 | `60dc440910` |
| live honua /mcp (https://demo.honua.io/mcp) | `remote` | 20 | 20/20 | 11/13 | 5 | ❌ fail | 2026-07-07 | `a09735af87` |

