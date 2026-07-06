# MCP Cross-Model Workflow Eval

**Result (deterministic control):** ✅ PASS

- Generated: `2026-07-05T22:55:20.729Z`
- MCP surface: `live` (transport: `streamable-http`, remote: `https://demo.honua.io/mcp`)
- Auth mode: `api-key`
- Corpus: 8 GIS workflows
- Live models evaluated: 1
- Catalog coverage: all 9 required tools resolve against the live catalog (15 advertised)

## Per-model scorecard

| Model | Vendor | Avail | Pass | Fail | Clarified | Error | Success | Clarify | Edit |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deterministic` | deterministic | yes | 8 | 0 | 0 | 0 | 100% | 0% | 13% |
| `us.anthropic.claude-opus-4-6-v1` | bedrock | yes | 8 | 0 | 0 | 0 | 100% | 0% | 13% |

> Live cross-model runs (Claude + GPT) are tracked under honua-io/honua-server#1956.

