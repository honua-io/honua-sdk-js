# Coding-agent evaluation harness

A growing share of integration code is written by coding agents, and "agents
use this SDK correctly on the first try" is a measurable, winnable property.
This repo already ships the inputs — [`llms.txt`](../llms.txt) /
[`llms-full.txt`](../llms-full.txt), agent skills, Context7 registration, the
MCP server — and this harness measures whether they work, with the same
discipline the MCP package applies through its certification/eval kits
(`mcp/src/certification/`, `mcp/src/eval/`).

Latest published results: [docs/generated/coding-agent-scorecard.md](./generated/coding-agent-scorecard.md).

## What is measured

For each task in the corpus an agent (or a committed fixture standing in for
one) produces a **standalone TypeScript program** from the task prompt with
the repo's published agent-facing docs as the only context. The program is
then scored **objectively — no string similarity anywhere**:

1. **Typecheck** — one `tsc` pass over the generated program against the
   *built* SDK (`dist/`), resolved through a real `node_modules` link exactly
   the way a consumer would import `@honua/sdk-js`.
2. **Runtime** — the emitted JS runs under Node against a deterministic
   multi-protocol fixture server (no network, no live services).
3. **Assertions** — the program's single JSON output line is compared against
   committed expected values (exact equality / bounded comparisons).

A task passes only when all three stages pass. Scoring is per-task pass/fail;
the scorecard records the failing stage.

## Task corpus (REQ-001)

Sixteen stable-tier golden-workflow tasks live under
[`eval/coding-agents/tasks/`](../eval/coding-agents/tasks/), one JSON document
each: prompt text, allowed docs context (pointers to `llms.txt` and specific
docs), expected artifact type (`ts`/`tsx`), execution budget, and the
objective assertions. Covered workflows: FeatureServer connect + count, where
/ outFields query, `connect()` auto-classification, OGC API Features, WFS 2.0,
STAC search, OData v4, stream/pagination, query-plan explain, MapLibre
geojson-source mounting (mock lane), geocoding, esri-compat migration snippet,
WebMap conversion, CLI usage, capability-error handling, and React hook
composition.

## Fixture endpoints

`scripts/lib/coding-agent-eval/fixture-server.mjs` serves every protocol the
corpus touches from one ephemeral port: an inline 5-feature GeoServices
FeatureServer + GeocodeServer, an OGC API Features facade, and recorded
real-server fixtures from `test/fixtures/backend-agnostic/` for WFS
(GeoServer), STAC (Earth Search) and OData (TripPin), with upstream hosts
rewritten to the local server. Responses are a pure function of committed
fixtures — runs are reproducible byte-for-byte.

## Adapters (REQ-003)

Generation is pluggable behind a tiny interface
(`scripts/lib/coding-agent-eval/adapters.mjs`):

- **`fixture`** — replays committed generations from
  `eval/coding-agents/fixtures/generations/`. `known-good/` holds one verified
  solution per task and is the deterministic control CI runs on a schedule;
  `known-bad/` holds deliberately wrong generations (hallucinated result
  shapes, wrong endpoints, wrong filters) used by the test-of-the-test.
- **`claude-cli`** — shells out to Claude Code headless (`claude -p`) with the
  task's docs context inlined into the prompt. Strictly opt-in: it only
  constructs when `HONUA_EVAL_AGENTS=1` and `claude` is on PATH, so the
  deterministic lanes can never accidentally spend model tokens. Model
  (`HONUA_EVAL_CLAUDE_MODEL`) and CLI version are recorded in the scorecard.

## Scorecard (REQ-004)

Every run writes `scorecard.json` (validated against
[`eval/coding-agents/scorecard.schema.json`](../eval/coding-agents/scorecard.schema.json))
and `scorecard.md` under `test-results/coding-agent-eval/<lane>/`. Runs with
`--publish` also refresh the committed, history-friendly page at
[`docs/generated/coding-agent-scorecard.md`](./generated/coding-agent-scorecard.md)
(date, adapter, model, per-task results, aggregate pass rate, append-only
history table). The JSON records the commit SHA and pinned model/version
metadata so llms.txt/docs regressions are traceable to score drops.

## Test-of-the-test

`test/coding-agent-eval-harness.test.ts` (part of `npm test`) proves the
harness catches bad code instead of rubber-stamping it:

- the **known-good** lane must pass every task, and
- every **known-bad** generation must fail at exactly the stage the fixture
  manifest records (`typecheck` for hallucinated APIs such as `result.items`,
  `runtime` for wrong endpoints, `assertions` for wrong values).

The spec also unit-tests the corpus validator, assertion evaluator, scorecard
schema, and fixture-server routes without needing a build.

## Running it

```bash
npm run eval:coding-agents            # build + fixture known-good lane (gate)
npm run eval:coding-agents:self-test  # build + known-bad lane (must all fail)

# subset / custom output
node scripts/eval-coding-agents.mjs --tasks wfs-query,stac-search --output test-results/tmp

# live agent lane (opt-in; spends model tokens)
HONUA_EVAL_AGENTS=1 node scripts/eval-coding-agents.mjs --adapter claude-cli

# refresh the committed scorecard page
node scripts/eval-coding-agents.mjs --publish
```

## CI lane (NFR-001)

[`.github/workflows/coding-agent-eval.yml`](../.github/workflows/coding-agent-eval.yml)
runs weekly (cron) and on demand. The fixture lanes are the scheduled gate;
the live `claude-cli` lane runs only on `workflow_dispatch` with
`live_agent: true` and the `ANTHROPIC_API_KEY` secret configured. The workflow
is deliberately **not** part of PR CI: a failure notifies through the
workflow-failure signal instead of blocking PRs (the harness logic itself is
still covered by `npm test` on every PR via the self-test spec).
