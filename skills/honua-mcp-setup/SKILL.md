---
name: honua-mcp-setup
description: Use when connecting an MCP client (Claude Desktop, Claude Code, or any MCP-compatible agent) to ANY public ArcGIS/OGC FeatureServer via @honua/mcp-server — the platform-free geospatial MCP server. Covers pointing honua-mcp at a plain public endpoint (no Honua server needed), building and configuring the server, env vars, transports, graceful capability degradation, and the stdio proxy for a Honua /mcp catalog. Grounded in mcp/README.md and mcp/src.
---

# Honua MCP server setup

`@honua/mcp-server` (in `mcp/`) is a **platform-free** geospatial MCP server: point
it at ANY public Esri FeatureServer or OGC API endpoint and it exposes discovery
and query workflows to MCP clients — with ZERO Honua-server assumptions. Unlike
the MCP servers Mapbox/CARTO/Esri ship, it is not bound to a platform or metering.

It ships two bins:

- `honua-mcp` — the **standalone / platform-free** server. Point `HONUA_BASE_URL`
  at any public FeatureServer/OGC endpoint (e.g. a `services.arcgis.com`
  FeatureServer). No Honua server required.
- `honua-mcp-proxy` — a stdio bridge to a Honua-enhanced `/mcp` catalog (the
  upgrade path: planning, async jobs, publishing). Requires a Honua deployment.
  Honua does **not** expose an AI/MCP feature-mutation tool — AI operational data
  editing is not supported (honua-server ADR-0028).

Requires Node.js `>=20`.

## Point it at any ArcGIS / OGC endpoint (platform-free front door)

Set `HONUA_BASE_URL` to the origin/folder that serves the standard GeoServices
REST paths (`/rest/services`, `/FeatureServer/{id}/query`). For example, the
public US Census apportionment FeatureServer on `services.arcgis.com`:

```bash
HONUA_BASE_URL="https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis" \
  HONUA_TRANSPORT="rest" node dist/src/index.js
```

Tools that need a Honua-only surface (server-side styling via OGC API – Styles, a
`/rest/services` catalog) **degrade gracefully** on a plain endpoint: they return a
structured `{ "available": false, "surface": ..., "reason": ..., "guidance": ... }`
result instead of crashing or returning misleading empty data.

## Build

The MCP package consumes `@honua/sdk-js`, so build the SDK first. From the repo
root:

```bash
npm ci && npm run build
npm ci --prefix mcp
npm run build --prefix mcp
```

The build output runs as `dist/src/index.js` (from inside `mcp/`), which is what
the `honua-mcp` bin points at.

## Environment variables (`honua-mcp`)

- `HONUA_BASE_URL` (required): absolute base URL of the endpoint, e.g. a public
  ArcGIS folder `https://services.arcgis.com/<org>/arcgis`, or a Honua deployment
  `https://honua.example.com`.
- `HONUA_TRANSPORT` (optional): `grpc-web` (default, Honua deployments) or `rest`.
  Use `rest` for plain public ArcGIS/OGC endpoints — they speak GeoServices REST,
  not Honua's gRPC-web fast path.
- `HONUA_API_KEY` (optional): API key when the deployment requires it. Use
  `https://` for non-localhost servers when a key is set. Public endpoints need none.
- `HONUA_TIMEOUT_MS` (optional): request timeout in ms (default `30000`).
- `HONUA_RETRY_MAX_RETRIES` (optional): retry attempts for transient failures (default `2`).

## Register with an MCP client

Point the client at the `honua-mcp` bin (or `node dist/src/index.js`) over
stdio. Example client config (`claude_desktop_config.json` / a project
`.mcp.json`) against a public ArcGIS FeatureServer:

```json
{
  "mcpServers": {
    "featureserver": {
      "command": "honua-mcp",
      "env": {
        "HONUA_BASE_URL": "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis",
        "HONUA_TRANSPORT": "rest"
      }
    }
  }
}
```

If `honua-mcp` is not on `PATH`, use `"command": "node"` with
`"args": ["dist/src/index.js"]` and set the working directory to `mcp/`.

## Tools and resources exposed

Tools (all read-only):

- `honua_list_services` — discover services (degrades if the target has no catalog)
- `honua_describe_layer` — fields, geometry type, extent, relationships
- `honua_query_features` — attribute/spatial filters, field selection, paging
- `honua_count_features` — cardinality without pulling rows
- `honua_get_extent` — bounding box of a filter
- `honua_statistics` — count/sum/avg/min/max/stddev aggregates
- `honua_explain_capability_gap` — protocol/capability guidance
- `honua_get_style`, `honua_apply_style_preset` — server-side styling; on a plain
  FeatureServer these return a structured "not available on this target" result

Resources:

- `honua://services`
- `honua://services/{encodedServiceId}/layers/{layerId}`
- `honua://styles`, `honua://styles/{styleId}` (structured-unavailable on a plain target)

## Remote `/mcp` via the stdio proxy

A Honua server exposes one MCP catalog over streamable-HTTP/SSE at `/mcp`. To
bridge a stdio client to it without reimplementing the catalog, use
`honua-mcp-proxy` (`dist/src/proxy.js`):

```bash
HONUA_MCP_REMOTE_URL="https://demo.honua.io/mcp" honua-mcp-proxy
```

Proxy environment variables:

- `HONUA_MCP_REMOTE_URL` (required; alias `HONUA_MCP_URL`): the remote `/mcp` endpoint.
- `HONUA_MCP_AUTH_TOKEN` (optional): sent as `Authorization: Bearer <token>`.
- `HONUA_API_KEY` (optional): sent as `x-api-key`.

## Verify

The package ships an offline certification harness and a cross-model eval. The
platform-free lanes certify and eval the standalone surface against a recorded
public FeatureServer fixture (deterministic, no network):

```bash
npm --prefix mcp run certify                    # Honua operator surface (offline mock)
npm --prefix mcp run certify:standalone         # platform-free: plain FeatureServer fixture
npm --prefix mcp run eval:standalone            # 50+ semantic scenarios, deterministic control
```

## References

- `mcp/README.md` — full server, proxy, certification, and eval documentation.
- `mcp/src/index.ts` — server entrypoint and the tool/resource wiring.
- `mcp/package.json` — bin names and scripts.
