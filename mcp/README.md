# `@honua/mcp-server`

The **platform-free** Model Context Protocol (MCP) server for geospatial feature
services. Point it at **any** public Esri FeatureServer or OGC API endpoint and it
exposes discovery, query, and analysis workflows to any MCP client — with **zero**
platform lock-in and no metering. Mapbox, CARTO, and Esri each ship an MCP server
bound to their own platform; this one is bound to none.

**Release status: beta.** Tool contracts are certified against live and fixture
targets on every release; remaining pre-1.0 work is hardening, not surface change.

**Scores are published, not claimed.** How well different client models actually
drive this surface — and where they fail — is in the
[cross-model MCP eval scorecard](../docs/generated/mcp-eval-scorecard.md),
generated from the dated run artifacts committed under [`evals/`](evals/README.md).

Two modes:

- **Standalone (platform-free) — the front door.** The `honua-mcp` bin runs the
  direct-SDK surface against any public FeatureServer/OGC endpoint. No Honua
  server, no admin API, no `/mcp` catalog required.
- **Honua-enhanced — the upgrade path.** The `honua-mcp-proxy` bin bridges a
  Honua deployment's full `/mcp` operator catalog (planning, async jobs,
  publishing) to stdio. Honua does **not** expose an AI/MCP feature-mutation tool
  — AI operational data editing is not supported (honua-server ADR-0028).

## Requirements

- Node.js `>=20.19`
- Any reachable FeatureServer/OGC endpoint (public or Honua)

## Install

The server is published as
[`@honua/mcp-server`](https://www.npmjs.com/package/@honua/mcp-server) with two
bins: `honua-mcp` (the platform-free stdio server) and `honua-mcp-proxy` (the
bridge to a Honua deployment's hosted `/mcp` catalog). No checkout, no build:

```bash
# one-off
npx -y -p @honua/mcp-server honua-mcp   # reads HONUA_BASE_URL from the environment

# or keep it installed
npm install -g @honua/mcp-server
```

Claude Desktop, Claude Code, Cursor, and other MCP clients launch it as a stdio
server. Copy-paste client config (`.mcp.json` / `mcp.json` / Claude Desktop's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "honua": {
      "command": "npx",
      "args": ["-y", "-p", "@honua/mcp-server", "honua-mcp"],
      "env": {
        "HONUA_BASE_URL": "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis",
        "HONUA_TRANSPORT": "rest"
      }
    }
  }
}
```

That example points at a public ArcGIS endpoint — swap `HONUA_BASE_URL` for
your own FeatureServer folder, OGC API root, or Honua deployment. Contributors
running from a checkout: `npm install && npm run build`, then
`node dist/src/index.js` with the same environment.

## Platform-free mode (any ArcGIS / OGC endpoint)

Point `HONUA_BASE_URL` at any origin/folder that serves the standard GeoServices
REST paths (`/rest/services`, `/FeatureServer/{id}/query`). Example — the public
US Census 2020 apportionment FeatureServer on `services.arcgis.com`:

```bash
HONUA_BASE_URL="https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis" \
  HONUA_TRANSPORT="rest" npx -y -p @honua/mcp-server honua-mcp
```

The same applies to a bare **OGC API** service root: point `HONUA_BASE_URL` at
the root, address sources with the neutral `<protocol>:<address>` form
(`ogc-features:<collectionId>`), and pass `layout: "ogc-api"` on calls against
a third-party root (see the addressing table below). STAC works the same way
with `layout: "stac-api"` or `"stac-static"`.

Tools that require a Honua-only surface (server-side styling via OGC API – Styles,
a `/rest/services` catalog) **degrade gracefully** on a plain endpoint: they
return a structured result

```json
{ "available": false, "surface": "OGC API - Styles", "reason": "…", "guidance": "…" }
```

instead of crashing, hanging, or returning misleading empty data. This is the
same skip-with-reason honesty the certification suite uses.

### Bootstrap-only local installation

Local installation is deliberately absent from the ordinary `honua-mcp`
catalog. During an explicitly approved laptop bootstrap, start a separate,
single-purpose process that exposes only `honua_admin_install_local`:

```bash
HONUA_MCP_BOOTSTRAP=1 npx -y -p @honua/mcp-server honua-mcp
```

The tool requires `confirm: true`. Stop and remove this bootstrap server from
the MCP client configuration after installation; the normal platform-free
server remains read-only and cannot invoke the installer.

## Environment Variables

- `HONUA_BASE_URL` (required in normal mode): absolute base URL — a public ArcGIS folder
  (`https://services.arcgis.com/<org>/arcgis`) or a Honua deployment
  (`https://honua.example.com`).
- `HONUA_MCP_BOOTSTRAP` (bootstrap only): set to `1` or `true` to start the
  isolated local-install catalog instead of the ordinary read-only server.
- `HONUA_TRANSPORT` (optional): `grpc-web` (default, Honua deployments) or `rest`.
  Use `rest` for plain public ArcGIS/OGC endpoints.
- `HONUA_API_KEY` (optional): API key when your deployment requires it. Public
  endpoints need none.
- `HONUA_TIMEOUT_MS` (optional): request timeout in milliseconds (default `30000`)
- `HONUA_RETRY_MAX_RETRIES` (optional): retry attempts for transient failures (default `2`)

When `HONUA_API_KEY` is configured, use `https://` for non-localhost servers.

## MCP Tools

All read-only:

- `honua_list_sources` — **protocol-neutral discovery.** Returns `<protocol>:<address>` source references plus each source's real capabilities. Every protocol family degrades independently with a reason.
- `honua_list_services` — GeoServices-specific service catalog (prefer `honua_list_sources`)
- `honua_describe_layer` — source schema, protocol, and advertised capabilities
- `honua_query_features`
- `honua_count_features`
- `honua_get_extent`
- `honua_statistics`
- `honua_explain_capability_gap`
- `honua_get_style`, `honua_apply_style_preset` — structured-unavailable on a plain FeatureServer

### Protocol-neutral tool contract

The tool vocabulary is the SDK's `Dataset` → `Source` → `Query` → `Result` contract,
not GeoServices with extra fields. **No tool schema requires an Esri-only field.**

**Addressing.** A source is one string, `<protocol>:<address>`, exactly as
`honua_list_sources` emits it:

| protocol | address | example |
| --- | --- | --- |
| `geoservices-feature-service` (alias `geoservices`) | `<serviceId>/<layerId>` | `geoservices-feature-service:Parks/0` |
| `geoservices-map-service` | `<serviceId>/<layerId>` | `geoservices-map-service:Basemap/2` |
| `ogc-features` (alias `ogc`) | `<collectionId>` | `ogc-features:hotels` |
| `ogc-records` | `<collectionId>` | `ogc-records:catalog` |
| `stac` | `<collectionId>` | `stac:sentinel-2-l2a` |
| `wfs` | `<typeName>` | `wfs:topp:states` |
| `odata` | `<entitySet>` | `odata:People` |

An unrecognized protocol token is **refused with the accepted forms** rather than
guessed at. Pass `layout` (`ogc-api` / `auto` / `stac-api` / `stac-static`) when the
OGC/STAC source lives at a third-party service root rather than the Honua facade.

**Filtering.** `filter` is the SDK's typed semantic filter, which compiles to
GeoServices SQL-92, CQL2, FES 2.0, or OData `$filter` depending on the backend —
one filter, same meaning everywhere:

```jsonc
{
  "source": "ogc-features:obs",
  "filter": {
    "op": "and",
    "args": [
      { "op": "eq", "field": "stn_id", "value": 2147 },
      { "op": "gt", "field": "value", "value": 95 }
    ]
  },
  "orderBy": [{ "field": "value", "direction": "desc" }],
  "limit": 10
}
```

Nodes: `eq`/`ne`/`lt`/`lte`/`gt`/`gte` (`field`, `value`), `in` (`values`),
`between` (`lower`, `upper`), `is-null`/`is-not-null`, `like` (`pattern`,
`caseSensitive`), `and`/`or` (`args`), `not` (`arg`), the spatial predicates
`intersects`/`contains`/`within`/`crosses`/`touches`/`overlaps`/`bbox-intersects`
(`geometry` or `bbox`), and the temporal predicates
`before`/`after`/`during`/`time-intersects` (`field`, `value`).

**Geometry** is GeoJSON (RFC 7946), or a `bbox` as `[minX, minY, maxX, maxY]`.
An envelope tested with `intersects` travels as the portable spatial constraint
(the OGC `bbox` parameter / a GeoServices geometry parameter); a richer geometry
or predicate becomes a typed spatial filter, which compiles where supported and
fails closed where it is not. **Time** is `temporal` — `{ "instant": … }` or
`{ "start": …, "end": … }`, with an optional `field`; without a field it targets
the source's own time dimension (`time=` / `datetime=`).

**Results** carry the neutral source identity, GeoJSON geometry, and — when the
protocol served the request a weaker way — an explicit `degraded` array (e.g. OGC
API Features has no server-side aggregation, so `honua_statistics` says it
aggregated client-side rather than presenting the number as authoritative).

**Capability honesty.** A request the backing protocol cannot express returns an
`isError` result with a structured envelope, never a silently empty feature list:

```json
{
  "code": "capability_not_supported",
  "error": {
    "kind": "ExecutionFailed",
    "message": "Capability \"queryAggregate\" is not supported by protocol \"wmts\"",
    "capability": "queryAggregate",
    "protocol": "wmts",
    "guidance": "…what to do instead…"
  }
}
```

### Deprecated inputs (still accepted)

Nothing was removed. The following remain as **optional** compatibility inputs so
existing MCP clients keep working, and are marked `[DEPRECATED]` in their schema
descriptions:

- `serviceId` + `layerId` — the GeoServices pair. Equivalent to
  `source: "geoservices-feature-service:<serviceId>/<layerId>"`. Passing
  `serviceId` without `layerId` is refused rather than defaulted to layer 0.
- `where` — source-native filter text, whose language depends on the backend. Use
  `filter` for a protocol-neutral one.
- `geometry` as Esri-JSON, with `geometryType` — converted on the way in.

One behavioural note: a source addressed the **deprecated** way keeps the legacy
Esri-JSON geometry output; a source addressed with `source` gets GeoJSON. Set
`geometryFormat` explicitly to override either default.

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
  expiry, single-use, cancellation, and plan-identity checks. The envelope is required for effects and for every
  read step that names a `sourceId`; only non-source inspection may use read-only auto-execution.

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
npm run test:certification:nl-map-control # gate: approval/scope/replay/cancellation/receipt security matrix
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

### Non-GeoServices certification lane

A `standalone`-shaped lane can prove the surface works against Esri and still say
nothing about vendor neutrality. So a second target — **`standalone-ogc`**
(`HONUA_MCP_CERT_TARGET=standalone-ogc`, or `--target standalone-ogc`) — runs the
**same tool catalog** against an in-process fixture of a plain **OGC API Features**
endpoint, replaying collections recorded from the public
[pygeoapi demo](https://demo.pygeoapi.io/master) (the pinned `ogc-features` target
in `config/live-conformance-endpoints.v1.json`). Nothing Esri exists there: the
GeoServices entry points all reject, so a tool that still secretly required
`serviceId`/`layerId` fails loudly instead of passing by accident.

```bash
npm run certify:standalone-ogc            # non-GeoServices cert (OGC API Features fixture)
npm run test:certification:standalone-ogc # CI gate variant
```

The fixture serves the OGC API Features Part 1 parameters (`limit`, `offset`,
`bbox`, `datetime`, `properties`, `sortby`) plus the Part 3 `filter` +
`filter-lang=cql2-text` the neutral contract compiles to — including a CQL2
evaluator that **refuses** a construct it cannot evaluate exactly (`S_*` spatial
predicates) rather than matching every row. Re-record with
`node scripts/record-ogc-fixtures.mjs`.

Artifacts are written to the package root as
`mcp-certification-results.json` and `mcp-certification-results.md` (gitignored;
uploaded by CI). To certify against a **live** honua-server, set `HONUA_BASE_URL`
(and `HONUA_TRANSPORT`, `HONUA_MCP_SERVICE_ID`, `HONUA_MCP_LAYER_ID`; optionally
`HONUA_MCP_SOURCE` for a neutral `<protocol>:<address>` source ref,
`HONUA_MCP_ADDRESS` for the geocoding scenario, `HONUA_MCP_STYLE_ID`, and
`HONUA_MCP_STATISTIC_FIELD`); the
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

**Published results:
[Cross-model MCP eval scorecard](../docs/generated/mcp-eval-scorecard.md)** —
generated from the committed run artifacts in [`evals/runs/`](evals/runs), with
the deterministic control row, every non-passing run, and the protocol
certification failures. It ships on the docs site; its freshness is a CI gate
(`npm run docs:mcp-scorecard:check` from the repo root).

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

### Non-GeoServices semantic corpus (`src/eval/ogc-corpus.ts`)

The **ogc** corpus runs the identical catalog against the plain OGC API Features
fixture, addressing every source as `ogc-features:<collectionId>` — no `serviceId`,
no `layerId`, anywhere in the corpus (a test asserts that). Its assertions are
anchored to the recorded pygeoapi data (5 observations, 31 Utah cities:
`avg(value)=96.14`, `sum(POP_2000)=354212`, `stn_id=2147 ⇒ 2 rows`, the
2001–2004 interval ⇒ 3 rows), and it exercises the typed filter, a GeoJSON/bbox
spatial constraint, and canonical temporal predicates. Three scenarios grade
*honesty* rather than data: client-side aggregation must be reported as degraded,
an extent that came from the declared collection extent must say so, and a CQL2
spatial predicate the endpoint does not publish must come back as a structured
capability refusal — never as an empty result set.

```bash
npm run eval:ogc              # deterministic control over the OGC API Features fixture (offline)
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
