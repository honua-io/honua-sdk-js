# `@honua/mcp-server`

The **platform-free** Model Context Protocol (MCP) server for geospatial feature
services. Point it at **any** public Esri FeatureServer or OGC API endpoint and it
exposes discovery, query, and analysis workflows to any MCP client — with **zero**
platform lock-in and no metering. Mapbox, CARTO, and Esri each ship an MCP server
bound to their own platform; this one is bound to none.

**Release status: beta.** Tool contracts are certified against live and fixture
targets on every release; remaining pre-1.0 work is hardening, not surface change.

Two modes:

- **Standalone (platform-free) — the front door.** The `honua-mcp` bin runs the
  direct-SDK surface against any public FeatureServer/OGC endpoint. No Honua
  server, no admin API, no `/mcp` catalog required.
- **Honua-enhanced — the upgrade path.** The `honua-mcp-proxy` bin bridges a
  Honua deployment's full `/mcp` operator catalog (planning, async jobs,
  publishing) to stdio. Honua does **not** expose an AI/MCP feature-mutation tool
  — AI operational data editing is not supported (honua-server ADR-0028).

## Requirements

- Node.js `>=20`
- Any reachable FeatureServer/OGC endpoint (public or Honua)

## Platform-free mode (any ArcGIS / OGC endpoint)

Point `HONUA_BASE_URL` at any origin/folder that serves the standard GeoServices
REST paths (`/rest/services`, `/FeatureServer/{id}/query`). Example — the public
US Census 2020 apportionment FeatureServer on `services.arcgis.com`:

```bash
npm install
npm run build
HONUA_BASE_URL="https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis" \
  HONUA_TRANSPORT="rest" node dist/src/index.js
```

Tools that require a Honua-only surface (server-side styling via OGC API – Styles,
a `/rest/services` catalog) **degrade gracefully** on a plain endpoint: they
return a structured result

```json
{ "available": false, "surface": "OGC API - Styles", "reason": "…", "guidance": "…" }
```

instead of crashing, hanging, or returning misleading empty data. This is the
same skip-with-reason honesty the certification suite uses.

## Environment Variables

- `HONUA_BASE_URL` (required): absolute base URL — a public ArcGIS folder
  (`https://services.arcgis.com/<org>/arcgis`) or a Honua deployment
  (`https://honua.example.com`).
- `HONUA_TRANSPORT` (optional): `grpc-web` (default, Honua deployments) or `rest`.
  Use `rest` for plain public ArcGIS/OGC endpoints.
- `HONUA_API_KEY` (optional): API key when your deployment requires it. Public
  endpoints need none.
- `HONUA_TIMEOUT_MS` (optional): request timeout in milliseconds (default `30000`)
- `HONUA_RETRY_MAX_RETRIES` (optional): retry attempts for transient failures (default `2`)

When `HONUA_API_KEY` is configured, use `https://` for non-localhost servers.

## MCP Tools

All read-only:

- `honua_list_services` — discover services (degrades if the target has no catalog)
- `honua_describe_layer`
- `honua_query_features`
- `honua_count_features`
- `honua_get_extent`
- `honua_statistics`
- `honua_explain_capability_gap`
- `honua_get_style`, `honua_apply_style_preset` — structured-unavailable on a plain FeatureServer

Hosts that use signed safe-agent plans can import
`@honua/mcp-server/agent-execution`. Its `createReadOnlyMcpAgentExecutor` binds
one named read tool to `@honua/sdk-js/agent-safety`'s exact approved-operation,
durable-audit, and signed-receipt path. It never enables wildcard dispatch or
mutation on the standalone server. The descriptor requires a bounded exact name
and a deterministic `countRows(result)` callback; missing or invalid row counts
fail instead of being reported as zero.

### Optional natural-language map-plan tools

Embedded hosts with a map runtime, BYO-LLM callback, approval verifier, and
atomic approval-use store can opt into two additional tools:

- `proposeMapPlan` — compiles an instruction into an inspectable, content-addressed plan and never executes it.
- `executeMapPlan` — accepts that plan plus a signed approval envelope and executes only after scope, signature,
  expiry, single-use, cancellation, and plan-identity checks.

```ts
import { createNlMapControlMcpHost, createServer } from "@honua/mcp-server";

const nlMapControl = createNlMapControlMcpHost({
  control: {
    tools: { runtime },
    llm: callYourModel,
    approvalVerifier,
    receiptSigner,
  },
  approvalUseConsumer, // host-owned atomic consume + verify callbacks
  resolveAuthorizationScopes: (transportScopes) => transportScopes,
});

const server = createServer(honuaClient, { nlMapControl });
```

The callbacks are deliberately not inferred from environment variables: model
transport, map authority, signing keys, and replay storage remain host-owned.
The MCP response omits raw tool results and the original instruction from its
execution receipt. Plans containing credential, cursor, or endpoint material
are refused instead of returning a redacted plan that could no longer match its
approval fingerprint.

## MCP Resources

- `honua://services`
- `honua://services/{encodedServiceId}/layers/{layerId}`
- `honua://styles`, `honua://styles/{styleId}` — structured-unavailable on a plain FeatureServer

## Certification

The package ships a **deterministic MCP certification harness** that proves the
advertised MCP surface is well-formed and conformant to the open
[`geospatial-mcp`](https://github.com/honua-io/geospatial-mcp) standard. It is
fully offline — no model/API calls, no network in the default path — and is the
evidence document for the WS-H "Provability" workstream.

For each tool the server advertises (over an in-memory MCP transport) it:

1. Enumerates `tools/list`, `resources/list`, and `prompts/list`.
2. Validates each `inputSchema` (and any `structuredContent` output schema) is
   well-formed JSON Schema, accepting both the draft-07 dialect emitted by
   zod-to-json-schema and the draft 2020-12 dialect of the standard.
3. Where a vendored standard schema matches the advertised tool (by the
   standard's `referenceToolName`), checks **conformance** — every standard
   `required` property must be accepted with a compatible type. Standard tools
   that are not advertised, and advertised tools outside the standard, are
   recorded as **known gaps**, not failures.
4. **Round-trips** every read-only tool (`tools/call` with a fixture input),
   validating the response. Write/destructive tools are never called.

It emits a stable machine-readable JSON report plus a human-readable Markdown
summary, and exits non-zero on any conformance/round-trip failure.

```bash
# Run the certifier against the offline fixture backend and write artifacts:
npm run certify

# CI entry points (also runnable locally):
npm run test:certification            # gate: runs harness tests + certifier, exits non-zero on failure
npm run test:certification:artifact   # evidence: writes artifacts, always exits 0
```

The certification test lane also hosts the optional NL tools over an in-memory
MCP transport with a deterministic fixture completion and mock map runtime. It proves
propose→approve→execute plus missing, expired, replayed, wrong-scope, tampered,
cancelled, deterministic-receipt, and redaction cases without a model, API key,
network service, or wall-clock dependency.

### Platform-free certification lane

A dedicated **standalone** target (`HONUA_MCP_CERT_TARGET=standalone`, or
`--target standalone`) certifies the platform-free surface against an in-process
fixture of a **plain public FeatureServer** — the recorded US Census 2020
apportionment layer from `services.arcgis.com`, with **no** Honua surfaces. It
proves the tools certify **green with honest skips** against a non-Honua endpoint:
the data tools round-trip against real recorded data, the Honua-only style tools
degrade to structured "not available" results, and the auth/mutation/job contracts
skip-with-reason. Fixture-backed and deterministic — no network.

```bash
npm run certify:standalone            # platform-free cert (plain FeatureServer fixture)
npm run test:certification:standalone # CI gate variant
```

The fixture is recorded by `scripts/record-census-fixtures.mjs` into
`src/certification/census-data.ts`; the evaluator that replays it is verified for
parity against the live recordings in `test/certification/census-fixture-client.test.ts`.

Artifacts are written to the package root as
`mcp-certification-results.json` and `mcp-certification-results.md` (gitignored;
uploaded by CI). To certify against a **live** honua-server, set `HONUA_BASE_URL`
(and `HONUA_TRANSPORT`, `HONUA_MCP_SERVICE_ID`, `HONUA_MCP_LAYER_ID`); the
harness then drives a real `HonuaClient` instead of the fixture.

The standard schemas are vendored under
`certification/geospatial-mcp-schemas/` (see that directory's `PROVENANCE.md`
for the pinned source revision).

## Transport-symmetric stdio proxy

The honua server exposes one MCP catalog over streamable-HTTP/SSE at `/mcp`.
Claude-Desktop-style clients speak **stdio**. Rather than reimplement that
catalog (which is how the HTTP and stdio surfaces historically drifted apart),
this package ships a **stdio proxy** (`honua-mcp-proxy`) that bridges a local
stdio MCP client to the remote HTTP-SSE MCP server. It connects upstream as an
MCP client and re-exposes the *same* catalog downstream over stdio — identical
tools, identical input/output schemas, identical resources and prompts, and live
`tools/list_changed` notifications. There is one source-of-truth catalog (the
server's `/mcp`); the SDK proxies it, so the two transports are symmetric by
construction. (Cross-repo: honua-io/honua-server#1950.)

```bash
# Bridge a stdio MCP client to a remote honua /mcp surface:
HONUA_MCP_REMOTE_URL="https://demo.honua.io/mcp" honua-mcp-proxy
```

Environment variables:

- `HONUA_MCP_REMOTE_URL` (required; alias `HONUA_MCP_URL`): the remote honua
  `/mcp` endpoint to proxy.
- `HONUA_MCP_AUTH_TOKEN` (optional): sent as `Authorization: Bearer <token>`.
- `HONUA_API_KEY` (optional): sent as `x-api-key`.

A parity test (`test/proxy.test.ts`) asserts the tool/resource/template catalog
the downstream client sees is byte-identical to the upstream surface, that
`tools/call` and resource reads round-trip identically, and that `list_changed`
notifications are forwarded.

## Cross-model workflow eval (provability)

The package ships a **cross-model workflow eval** that proves the "any client →
any workflow" claim: a held-out corpus of GIS workflows (`src/eval/corpus.ts`)
is driven through the MCP surface by different client LLMs and graded for
end-to-end success / clarification / edit rates per model. (Cross-repo:
honua-io/honua-server#1956.)

- **Deterministic control (offline, CI):** a scripted "ideal client" runs every
  workflow's real `tools/call` round-trips against the offline fixture surface —
  no model/API calls — and is graded identically to the live models. This is the
  reproducible CI gate.
- **Live cross-model (Claude + GPT):** when `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` are set, the Claude driver (latest Opus, `claude-opus-4-8`)
  and the GPT driver (GA flagship, `gpt-5.5`, override with `OPENAI_MODEL`) run
  the corpus through a real agentic tool-use loop over the identical catalog. The
  `@anthropic-ai/sdk` / `openai` packages are imported dynamically (not
  dependencies); keys come from the environment and are never hardcoded. Set
  `HONUA_MCP_REMOTE_URL` to drive a live remote `/mcp` instead of the fixture.

```bash
npm run eval            # run the eval (live models join if their keys are set)
npm run eval:offline    # force the deterministic control + fixture surface
npm run test:eval       # gate: harness tests + offline eval, exits non-zero on failure
npm run test:eval:artifact   # evidence: writes artifacts, always exits 0
```

Artifacts (`mcp-eval-results.json` / `mcp-eval-results.md`, gitignored, uploaded
by CI) record the per-model scorecard. The CI gate asserts the deterministic
control passes every scenario; live cross-model runs are recorded but
informational.

### Platform-free semantic corpus (`src/eval/standalone-corpus.ts`)

The **standalone** corpus is 50+ scenarios run against the plain public
FeatureServer fixture (the census layer) with **semantic** grading — not just tool
trajectory. Each scenario asserts the *meaning* of the answer: correct feature
counts (52 rows, 4 states with ≥20 seats), correct geographic facts (California is
the most populous; Wyoming the least; the House totals 435 seats), correct tool
selection for ambiguous asks (count vs. query vs. statistics), refusal /
clarification behavior on ambiguous or unsupported requests, and anti-hallucination
guards. Because the fixture replays real recorded data, a wrong number or a
hallucinated place name fails. The grading taxonomy is documented in
[`evals/README.md`](evals/README.md).

```bash
npm run eval:standalone       # deterministic control over the census fixture (offline)
```

### Live lane (paid, manual only)

The **operator corpus** (`src/eval/operator-corpus.ts`, 8 harder scenarios) is
meant to run against a live honua-server **operator** `/mcp` surface with real
models. This is a **billable** lane: it makes real Anthropic / OpenAI (or AWS
Bedrock) calls. It never runs on push/PR — locally via `npm run eval:live`, or in
CI via the manual **`MCP Live Cross-Model Eval`** workflow
(`.github/workflows/mcp-eval-live.yml`, `workflow_dispatch`-only). The live model
SDKs are not package dependencies; install them first for a live run:

```bash
npm install --no-save @anthropic-ai/sdk openai   # only needed for live runs
```

`eval:live` runs the operator corpus (`--corpus operator`) against the remote
`/mcp` and always writes artifacts (`--artifact-only`). Authentication uses the
same headers as the stdio proxy — **no dev-auth bypass**; the resolved auth mode
(`bearer` / `api-key` / `anonymous`) is recorded in the artifact so the run
proves it was authenticated. Set `HONUA_EVAL_REQUIRE_AUTH=1` to refuse an
anonymous run outright.

Shared env for every live run:

- `HONUA_MCP_REMOTE_URL` (required): the operator `/mcp` endpoint, e.g. `https://demo.honua.io/mcp`.
- `HONUA_MCP_AUTH_TOKEN`: sent as `Authorization: Bearer <token>` (preferred; ⇒ auth mode `bearer`).
- `HONUA_API_KEY`: sent as `x-api-key` (⇒ auth mode `api-key`) when the deployment uses key auth instead.
- `HONUA_EVAL_REQUIRE_AUTH=1` (recommended): fail fast if neither credential is present.

```bash
# Anthropic Claude (default claude-opus-4-8; override with HONUA_EVAL_ANTHROPIC_MODEL):
HONUA_MCP_REMOTE_URL="https://demo.honua.io/mcp" \
HONUA_MCP_AUTH_TOKEN="$HONUA_TOKEN" \
HONUA_EVAL_REQUIRE_AUTH=1 \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
npm run eval:live -- --driver anthropic

# OpenAI GPT (default gpt-5.5; override with OPENAI_MODEL, e.g. gpt-5.6-sol once you have access):
HONUA_MCP_REMOTE_URL="https://demo.honua.io/mcp" \
HONUA_MCP_AUTH_TOKEN="$HONUA_TOKEN" \
HONUA_EVAL_REQUIRE_AUTH=1 \
OPENAI_API_KEY="$OPENAI_API_KEY" \
npm run eval:live -- --driver openai

# Claude via Amazon Bedrock (AWS credential chain; default Sonnet 4.5,
# override with HONUA_EVAL_BEDROCK_MODEL — most ids need a us.* inference profile):
HONUA_MCP_REMOTE_URL="https://demo.honua.io/mcp" \
HONUA_MCP_AUTH_TOKEN="$HONUA_TOKEN" \
HONUA_EVAL_REQUIRE_AUTH=1 \
HONUA_EVAL_BEDROCK=1 AWS_REGION=us-west-2 \
HONUA_EVAL_BEDROCK_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0" \
npm run eval:live -- --driver bedrock
```

Pass multiple drivers to compare them in one artifact:
`npm run eval:live -- --driver anthropic,openai`. Every driver is graded against
the **identical** operator corpus and catalog, and the artifact's
`catalog.unresolvedRequiredTools` names any required tool the live surface did
not advertise — so a scenario that fails does so for a real capability gap, not a
silent tool name-resolution bug (the runner resolves required tools against the
live `tools/list`, never against the vendored certification index).
