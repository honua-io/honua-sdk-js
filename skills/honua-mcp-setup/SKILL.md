---
name: honua-mcp-setup
description: Use when connecting an MCP client (Claude Desktop, Claude Code, or any MCP-compatible agent) to a Honua FeatureServer / OGC endpoint via @honua/mcp-server — building and configuring the server, setting its environment variables, choosing a transport, or using the stdio proxy for a remote /mcp catalog. Grounded in mcp/README.md and mcp/src.
---

# Honua MCP server setup

`@honua/mcp-server` (in `mcp/`) exposes Honua discovery and query workflows to
MCP clients. It ships two bins: `honua-mcp` (the local server that talks to a
Honua backend) and `honua-mcp-proxy` (a stdio bridge to a remote `/mcp`
catalog). Requires Node.js `>=20` and a reachable Honua server.

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

- `HONUA_BASE_URL` (required): absolute Honua base URL, e.g. `https://honua.example.com`.
- `HONUA_TRANSPORT` (optional): `grpc-web` (default) or `rest`.
- `HONUA_API_KEY` (optional): admin/API key when the deployment requires it. Use
  `https://` for non-localhost servers when a key is set.
- `HONUA_TIMEOUT_MS` (optional): request timeout in ms (default `30000`).
- `HONUA_RETRY_MAX_RETRIES` (optional): retry attempts for transient failures (default `2`).

## Run against a FeatureServer / OGC endpoint

From inside `mcp/`:

```bash
HONUA_BASE_URL="https://honua.example.com" HONUA_TRANSPORT="grpc-web" node dist/src/index.js
```

## Register with an MCP client

Point the client at the `honua-mcp` bin (or `node dist/src/index.js`) over
stdio. Example client config (`claude_desktop_config.json` / a project
`.mcp.json`):

```json
{
  "mcpServers": {
    "honua": {
      "command": "honua-mcp",
      "env": {
        "HONUA_BASE_URL": "https://honua.example.com",
        "HONUA_TRANSPORT": "grpc-web"
      }
    }
  }
}
```

If `honua-mcp` is not on `PATH`, use `"command": "node"` with
`"args": ["dist/src/index.js"]` and set the working directory to `mcp/`.

## Tools and resources exposed

Tools (all read-only in the default surface):

- `honua_list_services`
- `honua_describe_layer`
- `honua_query_features`
- `honua_count_features`
- `honua_get_extent`
- `honua_statistics`

Resources:

- `honua://services`
- `honua://services/{encodedServiceId}/layers/{layerId}`

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

The package ships an offline certification harness and a cross-model eval:

```bash
npm --prefix mcp run certify
```

## References

- `mcp/README.md` — full server, proxy, certification, and eval documentation.
- `mcp/src/index.ts` — server entrypoint and the tool/resource wiring.
- `mcp/package.json` — bin names and scripts.
