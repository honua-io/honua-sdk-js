# MCP Cross-Model Workflow Eval

**Result (deterministic control):** ✅ PASS

- Generated: `2026-07-05T22:57:02.142Z`
- MCP surface: `live` (transport: `streamable-http`, remote: `https://demo.honua.io/mcp`)
- Auth mode: `api-key`
- Corpus: 8 GIS workflows
- Live models evaluated: 1
- Catalog coverage: all 9 required tools resolve against the live catalog (15 advertised)

## Per-model scorecard

| Model | Vendor | Avail | Pass | Fail | Clarified | Error | Success | Clarify | Edit |
| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `deterministic` | deterministic | yes | 8 | 0 | 0 | 0 | 100% | 0% | 13% |
| `us.amazon.nova-2-lite-v1:0` | bedrock | yes | 5 | 0 | 2 | 1 | 63% | 25% | 25% |

## Non-passing results

- `us.amazon.nova-2-lite-v1:0` × `operator-plan-validate` — **error**
  - exceeded 8 tool-use iterations without finishing

> Live cross-model runs (Claude + GPT) are tracked under honua-io/honua-server#1956.

