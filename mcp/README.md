# `@honua/mcp-server`

Model Context Protocol (MCP) server for Honua geospatial feature services.

This package exposes a focused MCP surface for discovery and query workflows on top of Honua's FeatureServer APIs.

## Requirements

- Node.js `>=20`
- A reachable Honua server URL

## Environment Variables

- `HONUA_BASE_URL` (required): absolute Honua base URL, for example `https://honua.example.com`
- `HONUA_TRANSPORT` (optional): `grpc-web` (default) or `rest`
- `HONUA_API_KEY` (optional): admin/API key when your deployment requires it
- `HONUA_TIMEOUT_MS` (optional): request timeout in milliseconds (default `30000`)
- `HONUA_RETRY_MAX_RETRIES` (optional): retry attempts for transient failures (default `2`)

When `HONUA_API_KEY` is configured, use `https://` for non-localhost servers.

## Run Locally

```bash
npm install
npm run build
HONUA_BASE_URL="https://honua.example.com" HONUA_TRANSPORT="grpc-web" node dist/src/index.js
```

## MCP Tools

- `honua_list_services`
- `honua_describe_layer`
- `honua_query_features`
- `honua_count_features`
- `honua_get_extent`
- `honua_statistics`

## MCP Resources

- `honua://services`
- `honua://services/{encodedServiceId}/layers/{layerId}`

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

Artifacts are written to the package root as
`mcp-certification-results.json` and `mcp-certification-results.md` (gitignored;
uploaded by CI). To certify against a **live** honua-server, set `HONUA_BASE_URL`
(and `HONUA_TRANSPORT`, `HONUA_MCP_SERVICE_ID`, `HONUA_MCP_LAYER_ID`); the
harness then drives a real `HonuaClient` instead of the fixture.

The standard schemas are vendored under
`certification/geospatial-mcp-schemas/` (see that directory's `PROVENANCE.md`
for the pinned source revision).
