# MCP Cross-Model Workflow Eval

**Result (deterministic control):** ✅ PASS

- Generated: `2026-07-07T17:56:32.548Z`
- MCP surface: `live` (transport: `streamable-http`, remote: `https://demo.honua.io/mcp`)
- Auth mode: `api-key`
- Negotiated protocol: `2025-06-18`
- Suite git SHA: `a09735af8725be65461a329d33cd4aae45b938fd` (git)
- Corpus: 8 GIS workflows
- Live models evaluated: 1
- Catalog coverage: all 9 required tools resolve against the live catalog (20 advertised)

## Per-model scorecard

| Model | Vendor | Avail | Pass | Fail | Clarified | Error | Success | Clarify | Edit |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deterministic` | deterministic | yes | 8 | 0 | 0 | 0 | 100% | 0% | 13% |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | bedrock | yes | 8 | 0 | 0 | 0 | 100% | 0% | 13% |

> Live cross-model runs (Claude + GPT) are tracked under honua-io/honua-server#1956.

