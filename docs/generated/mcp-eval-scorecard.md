<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run docs:mcp-scorecard -->
<!-- Inputs: mcp/evals/runs/**/*.json (committed run artifacts), mcp/evals/admin-family.v1.json, mcp/src/eval/corpus.ts, mcp/src/eval/operator-corpus.ts, mcp/src/eval/northstar-corpus.ts, mcp/src/eval/standalone-corpus.ts. -->
<!-- Freshness is enforced by npm run docs:mcp-scorecard:check. -->

# Cross-model MCP eval scorecard

How well do different client models actually drive Honua's MCP surface? This page is the
answer, published rather than asserted. Every observed result below is rendered from a committed run
artifact under [`mcp/evals/runs/`](https://github.com/honua-io/honua-sdk-js/tree/trunk/mcp/evals/runs) — the same JSON the eval harness wrote,
admin release-readiness is read from [`mcp/evals/admin-family.v1.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/admin-family.v1.json) and stays blocked
until a live candidate receipt exists. Run artifacts carry the surface they ran against, how they
authenticated, and (where the artifact is new
enough to record it) the negotiated MCP protocol version and the git SHA of the suite that
produced it. Nothing here is hand-typed, and the generator recomputes every rate from the
per-scenario rows before publishing it, so a summary that disagreed with its own graded
evidence would fail the build instead of reaching this page.

**Observation window:** 2026-07-05 → 2026-08-31
(6 distinct observation dates,
3 cross-model eval artifacts,
9 certification artifacts).

> This is a small, honest corpus, not a benchmark leaderboard. Read
> [What this does and does not measure](#what-this-does-and-does-not-measure) before citing a
> number from it.

## Cross-model leaderboard

One row per model per distinct observed result. The deterministic control is listed first: it
makes **no model calls**, runs the identical corpus through the identical catalog, and is the
CI gate — it is the ceiling the models are measured against, not a competitor.

| Model | Runtime | Corpus | Surface | Scenarios | Passed | Clarified | Errored | Pass rate | Tool-error scenarios | Observed | Runs | Suite SHA |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| `deterministic` _(control)_ | deterministic | operator | https://demo.honua.io/mcp | 8 | 8 | 0 | 0 | 100% | 1/8 | 2026-07-05, 2026-07-07 | 3 | `a09735af8725` · 2 not recorded |
| `us.anthropic.claude-opus-4-6-v1` | bedrock | operator | https://demo.honua.io/mcp | 8 | 8 | 0 | 0 | 100% | 1/8 | 2026-07-05 | 1 | not recorded |
| `us.anthropic.claude-sonnet-4-5-20250929-v1:0` | bedrock | operator | https://demo.honua.io/mcp | 8 | 8 | 0 | 0 | 100% | 1/8 | 2026-07-07 | 1 | `a09735af8725` |
| `us.amazon.nova-2-lite-v1:0` | bedrock | operator | https://demo.honua.io/mcp | 8 | 5 | 2 | 1 | 62.5% | 2/8 | 2026-07-05 | 1 | not recorded |

Column definitions, because these words are used loosely elsewhere:

- **Runtime** — how the model was invoked. `bedrock` means the run went through AWS Bedrock;
  `deterministic` is the scripted zero-LLM control.
- **Passed** — the graded workflow met every criterion: required tools called, expected tool
  order respected, forbidden (mutating) tools avoided, and any asserted answer content present.
- **Clarified** — the driver ended the run by asking a clarifying question instead of
  completing the graded workflow; the grader records the violation
  `driver requested clarification`. Tracked separately from a failure, and not counted as a
  pass. The corpus deliberately contains a scenario that *requires* a clarification round-trip
  and passes when the model completes it, so asking is a non-pass only where the workflow was
  meant to continue.
- **Errored** — the run did not finish; for example, a driver that exceeded its tool-use
  iteration budget. Also not a pass.
- **Tool-error scenarios** — scenarios in which at least one `tools/call` returned an error,
  whether or not the workflow ultimately passed. In the raw artifacts this ratio is stored
  under the historical field name `editRate`; it counts erroring tool calls, not edits.
- **Runs** — how many committed artifacts recorded this identical result. A model whose result
  changed between runs appears as more than one row.
- **Suite SHA** — the commit of the eval suite that produced the artifact, so a row can be
  re-run. `not recorded` means the artifact predates the provenance block (see
  [Provenance](#provenance-and-reproducibility)).

## Per-scenario matrix

Legend: ✅ pass · ❌ fail · ❓ clarified · ⚠️ error · · not run

### operator corpus

Surface: `https://demo.honua.io/mcp` · observed 2026-07-05, 2026-07-07

| Scenario | Category | deterministic | us.amazon.nova-2-lite-v1:0 | us.anthropic.claude-opus-4-6-v1 | us.anthropic.claude-sonnet-4-5-20250929-v1:0 |
| --- | --- | :--: | :--: | :--: | :--: |
| `operator-clarify-loop`<br />Ground then answer the clarification to refine intent | multi-step | ✅ | ✅ | ✅ | ✅ |
| `operator-discover-then-query`<br />Discover a layer, then query features from it | query | ✅ | ✅ | ✅ | ✅ |
| `operator-dry-run`<br />Estimate a plan with a dry run before executing | analysis | ✅ | ❓ | ✅ | ✅ |
| `operator-geocode-gap`<br />Route an address task to geocoding (entitlement-gated) | capability-gap | ✅ | ✅ | ✅ | ✅ |
| `operator-ground-intent`<br />Ground an ambiguous analysis goal to a workflow | grounding | ✅ | ❓ | ✅ | ✅ |
| `operator-list-layers`<br />Discover the published layers on the operator surface | discovery | ✅ | ✅ | ✅ | ✅ |
| `operator-plan-validate`<br />End-to-end read-only planning: ground → plan → validate | multi-step | ✅ | ⚠️ | ✅ | ✅ |
| `operator-validate-package`<br />Validate a query package against the governance contract | governance | ✅ | ✅ | ✅ | ✅ |

## Every non-passing run

A wins-only scoreboard is marketing. Every non-passing graded run in the committed corpus is
listed here, with the grader's own violation text.

| Observed | Model | Scenario | Outcome | Why it did not pass | Tool calls | Erroring calls |
| --- | --- | --- | --- | --- | ---: | ---: |
| 2026-07-05 | `us.amazon.nova-2-lite-v1:0` | `operator-dry-run`<br />Estimate a plan with a dry run before executing | ❓ clarified | driver requested clarification | 4 | 0 |
| 2026-07-05 | `us.amazon.nova-2-lite-v1:0` | `operator-ground-intent`<br />Ground an ambiguous analysis goal to a workflow | ❓ clarified | driver requested clarification | 6 | 1 |
| 2026-07-05 | `us.amazon.nova-2-lite-v1:0` | `operator-plan-validate`<br />End-to-end read-only planning: ground → plan → validate | ⚠️ error | exceeded 8 tool-use iterations without finishing | 8 | 0 |

Read these as capability signals, not bugs in the surface: the eval grades whether a client
*composed the right workflow*, so a smaller model that asked for clarification it did not need,
or looped past its iteration budget, is exactly what the corpus is designed to expose.

## Admin operation family

The generated Admin REST client covers **396 operations**: **385** are published as Admin MCP tools and **11** one-time-secret/session operations are explicitly excluded. The default server roster is **432 tools** = **47 static** + **385 Admin MCP**. The row stays blocked until that exact paginated roster is certified against the same release candidate through both HTTP and the proxy.

| Family | REST | Published | Excluded | Static | Default total | HTTP/proxy parity | Approval outcomes | Secret handling | Candidate status |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| `honua_admin_*` | 396 | 385 | 11 | 47 | 432 | implemented-awaiting-live-candidate | fixture-covered-awaiting-server-catalog | coverage-roster-and-schema-covered-awaiting-live-candidate | blocked-server-pin-regresses-admin-contract (`4a7903c2ef764ffeaa60083689f73b9e42bbc6a3`, 395 REST operations) |

Evidence definition: [`mcp/test/certification/admin-parity.test.ts`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/test/certification/admin-parity.test.ts). REST source: `f897700159e2791c9468c6ca85bb4e2a3a8d8433` / `edbbef2c19d2730f2c87c0641e189ae9fa83c49f38e29eb40057789ade11555a`. MCP coverage: [`config/admin-mcp-coverage.v1.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/config/admin-mcp-coverage.v1.json) / `0b24f61feefe18177e0abc76c491b2c86827b30a5dd45092a595cd595376f088`; exclusion roster `d93bdf6c31e6c532d5483b08315fed5decdd8f5cc56900e59e45be2eddb2fb6f`. Reviewed server head: `c810ef3df29269527d4eceb26151921c8c5d5eab`. Final server contract head: review-head-validated-awaiting-merged-trunk-pin. This is a readiness row, not a fabricated live pass receipt.

## Protocol certification (zero-LLM control)

Separate from the model eval, a deterministic certifier checks the same live surface against
the vendor-neutral geospatial-MCP standard: tool schemas, structured output, error shape,
pagination, and the standard tool families. It makes no model calls, so it is free to run on a
schedule and it fails loudly.

| Observed | Surface | Mode | Tools | Schema-conformant | Contracts passed | Failed | Skipped | Known gaps | Result | Suite SHA |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | --- |
| 2026-07-05 | live honua /mcp (https://demo.honua.io/mcp) | `remote` | 15 | 15/15 | 2/3 | 1 | 0 | 12 | ❌ fail | not recorded |
| 2026-07-06 | live honua /mcp (https://demo.honua.io/mcp) | `remote` | 20 | 20/20 | 11/13 | 2 | 5 | 7 | ❌ fail | `60dc44091089` |
| 2026-07-07 | live honua /mcp (https://demo.honua.io/mcp) | `remote` | 20 | 20/20 | 11/13 | 2 | 5 | 10 | ❌ fail | `a09735af8725` |
| 2026-08-18 | live honua /mcp (https://demo.honua.io/mcp) | `remote` | 47 | 25/25 | 2/3 | 1 | 6 | 33 | ❌ fail | `9dd5a707e2eb` |
| 2026-08-18 | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) | `standalone` | 10 | 3/3 | 1/1 | 0 | 8 | 39 | ❌ fail | `9dd5a707e2eb` |
| 2026-08-24 | live honua /mcp (https://demo.honua.io/mcp) | `remote` | 52 | 25/25 | 3/4 | 1 | 5 | 38 | ❌ fail | `53a13832554c` |
| 2026-08-24 | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) | `standalone` | 10 | 3/3 | 1/1 | 0 | 8 | 39 | ❌ fail | `53a13832554c` |
| 2026-08-31 | live honua /mcp (https://demo.honua.io/mcp) | `remote` | 52 | 25/25 | 3/4 | 1 | 5 | 38 | ❌ fail | `0c9bdb7ec073` |
| 2026-08-31 | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) | `standalone` | 11 | 3/3 | 1/1 | 0 | 8 | 40 | ❌ fail | `0c9bdb7ec073` |

### Certification failures and skips — 2026-08-31

From [`mcp/evals/runs/2026-08-31/cert-standalone.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-31/cert-standalone.json). Failures are real conformance defects in the
certified surface, published unedited; skips name the reason they could not be checked.

| Contract | Target | Status | Detail |
| --- | --- | --- | --- |
| `list-pagination` | `tools` | skipped | tools list is a single page (no nextCursor advertised) |
| `list-pagination` | `resources` | skipped | resources list is a single page (no nextCursor advertised) |
| `auth-unauthenticated` | `tools/call` | skipped | target does not support an unauthenticated pass |
| `auth-unauthenticated` | `resources/read` | skipped | target does not support an unauthenticated pass |
| `mutating-round-trip` | `honua_edit_features` | skipped | honua_edit_features/honua_query_features not advertised by this surface (pre-P1 or read-only) |
| `mutating-permission-denied` | `honua_edit_features` | skipped | honua_edit_features not advertised by this surface (pre-P1) |
| `async-job-lifecycle` | `honua_execute_plan` | skipped | honua_execute_plan not advertised by this surface (pre-P1) |
| `query-pagination` | `honua_query_features` | skipped | surface returned a single page with no nextCursor (pagination not exercised — pre-P1 surface or fewer than 2 features) |

The same run recorded **40 known standard gaps** — tool families in the
geospatial-MCP standard the certified surface does not yet advertise (Analysis and geoprocessing (reference shape), Analysis verbs, App composition, Composition review (reference shape), Control-plane proposal (reference shape), Discovery and grounding (Honua extension), Discovery and query (reference shape), Execution, Execution (reference shape), Feature editing, Intent and planning, Map composition, Publishing, unclassified).
They are enumerated in [`mcp/evals/runs/2026-08-31/cert-standalone.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-31/cert-standalone.json) under `knownGaps`.

## What this does and does not measure

**It measures** whether a client model, given a plain-language GIS goal and nothing but the
MCP catalog the surface advertises, composes the right workflow: discovers layers before
querying them, grounds an ambiguous goal before planning it, validates a plan before a dry run,
and — critically — stays read-only when the task is read-only. Mutating lifecycle tools are
*forbidden* by the grader on the read-only scenarios, so "did the agent stay inside its
authority?" is a scored criterion rather than a hope.

**It does not measure** general model quality, latency, cost, or output prose. It is not a
head-to-head model benchmark: the rows above were observed on different dates against a live surface that changed underneath them (the advertised tool count across these artifacts ranges from 15 to 20).
Treat a one-scenario difference as noise; the deterministic control is the only row whose
meaning is stable across dates.

Other honest limits:

- **Corpus size.** The published corpus is 8 operator scenarios. That is enough to surface gross
  workflow failures and nowhere near enough for a confidence interval. No statistical claim is
  made or implied.
- **Single run per (model, date).** Rates are not averaged over repeated sampling, so a rate
  describes the recorded runs and is not an expectation.
- **Surfaces covered.** Every published row targets `https://demo.honua.io/mcp`.
  The platform-free standalone corpus (a plain public FeatureServer, semantically graded) has no
  committed cross-model artifact yet, so it is absent from this page rather than summarised from
  memory.
- **Paid lane.** Live cross-model runs bill real model usage, so they are dispatched manually
  rather than on every commit. That is why observation dates are sparse.

## Provenance and reproducibility

Every artifact behind this page, with the surface it targeted and the suite that produced it.

| Artifact | Observed | Kind | Surface | Transport | Protocol | Tools advertised | Auth | Suite SHA |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- |
| [`eval-operator-nova-2-lite.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-07-05/eval-operator-nova-2-lite.json) | 2026-07-05 | cross-model eval | https://demo.honua.io/mcp | `streamable-http` | not recorded | 15 | `api-key` | not recorded |
| [`eval-operator-opus-4-6.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-07-05/eval-operator-opus-4-6.json) | 2026-07-05 | cross-model eval | https://demo.honua.io/mcp | `streamable-http` | not recorded | 15 | `api-key` | not recorded |
| [`eval-operator-sonnet-4-5.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-07-07/eval-operator-sonnet-4-5.json) | 2026-07-07 | cross-model eval | https://demo.honua.io/mcp | `streamable-http` | `2025-06-18` | 20 | `api-key` | `a09735af8725` |
| [`cert-demo.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-07-05/cert-demo.json) | 2026-07-05 | certification | live honua /mcp (https://demo.honua.io/mcp) | — | not recorded | 15 | `unknown` | not recorded |
| [`cert-demo.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-07-06/cert-demo.json) | 2026-07-06 | certification | live honua /mcp (https://demo.honua.io/mcp) | — | `2025-06-18` | 20 | `api-key` | `60dc44091089` |
| [`cert-demo.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-07-07/cert-demo.json) | 2026-07-07 | certification | live honua /mcp (https://demo.honua.io/mcp) | — | `2025-06-18` | 20 | `api-key` | `a09735af8725` |
| [`cert-demo.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-18/cert-demo.json) | 2026-08-18 | certification | live honua /mcp (https://demo.honua.io/mcp) | — | `2025-06-18` | 47 | `anonymous` | `9dd5a707e2eb` |
| [`cert-standalone.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-18/cert-standalone.json) | 2026-08-18 | certification | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) | — | not recorded | 10 | `anonymous` | `9dd5a707e2eb` |
| [`cert-demo.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-24/cert-demo.json) | 2026-08-24 | certification | live honua /mcp (https://demo.honua.io/mcp) | — | `2025-06-18` | 52 | `anonymous` | `53a13832554c` |
| [`cert-standalone.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-24/cert-standalone.json) | 2026-08-24 | certification | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) | — | not recorded | 10 | `anonymous` | `53a13832554c` |
| [`cert-demo.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-31/cert-demo.json) | 2026-08-31 | certification | live honua /mcp (https://demo.honua.io/mcp) | — | `2025-06-18` | 52 | `anonymous` | `0c9bdb7ec073` |
| [`cert-standalone.json`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/runs/2026-08-31/cert-standalone.json) | 2026-08-31 | certification | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) | — | not recorded | 11 | `anonymous` | `0c9bdb7ec073` |

3 of the artifacts above predate the self-proving provenance
block and therefore carry no suite SHA or negotiated protocol version. They are published
as-is, labelled `not recorded`, rather than back-filled — a provenance field that was never
observed is not a field this repo will invent.

An unresolved required tool would mean a scenario failed because the surface never advertised
the tool, not because the model chose wrongly. The eval records that separately, per artifact,
as `catalog.unresolvedRequiredTools`.

Across every published artifact that list is empty, so every non-pass above is a genuine
workflow-composition result rather than a missing tool.

## How to reproduce, and how this page stays honest

Run the deterministic control locally — free, offline, no credentials, no model calls:

```bash
npm ci && npm run build            # build the SDK the MCP package consumes
npm ci --prefix mcp
npm run --prefix mcp eval:offline  # deterministic control over the fixture surface
```

Be precise about what that reproduces: it grades the control against the **offline fixture**
surface, not the live operator surface the rows above targeted. The published control rows ran
against the live `/mcp` — still with zero model calls — so reproducing one needs the live lane
below with `--driver` left at the control.

Re-run a live cross-model row (billable; needs credentials and a reachable `/mcp`):

```bash
HONUA_MCP_REMOTE_URL="https://demo.honua.io/mcp" \
HONUA_API_KEY="$HONUA_DEMO_API_KEY" \
HONUA_EVAL_REQUIRE_AUTH=1 \
HONUA_EVAL_BEDROCK=1 AWS_REGION=us-west-2 \
HONUA_EVAL_BEDROCK_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0" \
  npm run --prefix mcp eval:live -- --driver bedrock
```

Then commit the artifact under `mcp/evals/runs/<YYYY-MM-DD>/` and regenerate:

```bash
npm run docs:mcp-scorecard         # rewrite this page from the committed artifacts
npm run docs:mcp-scorecard:check   # the CI gate: fails if the page drifts from them
```

The `check` mode runs in the docs-site pipeline next to `npm run verify:llms` and
`npm run docs:comparison:check`, and mirrors their derived-artifact policy: strict on trunk,
relaxed on pull requests (where it still proves the page is *producible* from the committed
evidence). The workflows that commit a new run artifact — the scheduled certification and the
manual live cross-model lane — regenerate this page in the same commit, so trunk stays fresh
without wedging open PRs. Because the renderer reads no clock and no network, the strict check
has exactly one failure mode worth having: the committed artifacts and the published page
disagree. Adding a run without republishing, or editing a figure on this page by hand, both
fail it.

The relaxed mode is not a hole. It still loads and validates every artifact and re-renders the
page, so an artifact whose model summary contradicts its own graded rows, whose schema version
is unsupported, or that grades a scenario absent from its declared corpus, fails CI everywhere,
on every branch. Only the *committed-freshness* comparison is deferred.

## Related evidence

- [`mcp/evals/README.md`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/evals/README.md) — the evidence corpus, grading taxonomy, and how runs land in the repo.
- [`mcp/README.md`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/README.md) — the MCP server itself, the eval CLI, and the live-lane environment contract.
- [`mcp/src/eval/operator-corpus.ts`](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/src/eval/operator-corpus.ts) — every scenario prompt and grading criterion in the operator corpus.
- [Coding-agent evaluation scorecard](./coding-agent-scorecard.md) — the sibling measurement: can a coding agent write correct SDK code on the first try?
- [How Honua compares](../comparison.md) — the same generated-evidence discipline applied to bundle size, protocol coverage, and time-to-first-map.
