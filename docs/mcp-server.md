---
type: guide
title: "@honua/mcp-server: the standalone MCP server"
description: "A stdio MCP server that points at any public FeatureServer or OGC API endpoint, and a proxy that bridges a Honua deployment's /mcp catalog. Which tools come from which surface."
resource: "https://www.npmjs.com/package/@honua/mcp-server"
tags: [mcp, agents, install]
---
# `@honua/mcp-server`

There are two different MCP servers in the Honua platform and they advertise
different tools. Calling a tool against the wrong one returns "unknown tool",
which is the single most common way an agent gets stuck here.

| | `@honua/mcp-server` (this package) | Honua Server's built-in `/mcp` |
| --- | --- | --- |
| Transport | stdio | HTTP `POST /mcp`, authenticated |
| Needs a Honua deployment | No | Yes |
| Points at | any public Esri FeatureServer or OGC API endpoint | that one deployment |
| Surface | 10 read-only discovery/query/style tools | the full operator catalog: planning, async jobs, Studio drafts, publishing |
| Install | `npx -y -p @honua/mcp-server honua-mcp` | already running; connect to it |

The package ships two binaries. `honua-mcp` is the standalone server — no Honua
server, no admin API, no `/mcp` catalog. `honua-mcp-proxy` bridges a Honua
deployment's `/mcp` catalog to stdio for clients that only speak stdio; it does
not add tools of its own.

## Install

```bash
npx -y -p @honua/mcp-server honua-mcp
```

Needs Node.js `>=20.19` and `HONUA_BASE_URL`. Client configuration
(`.mcp.json`, `claude_desktop_config.json`, Cursor):

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

`HONUA_TRANSPORT` is `grpc-web` by default, which is what a Honua deployment
speaks; use `rest` for a plain public ArcGIS or OGC endpoint.

## What this server advertises

All read-only:

`honua_list_sources`, `honua_list_services`, `honua_describe_layer`,
`honua_query_features`, `honua_count_features`, `honua_get_extent`,
`honua_statistics`, `honua_explain_capability_gap`, `honua_get_style`,
`honua_apply_style_preset`, and `honua_docs_search`.

Tools that need a Honua-only surface — server-side styling through OGC API –
Styles, a `/rest/services` catalog — do not crash on a plain endpoint. They
return `{ "available": false, "surface": …, "reason": …, "guidance": … }`, so a
client can tell "this endpoint cannot do that" from "the call failed".

## What it does not advertise

Anything that plans, executes, publishes, or composes. Those live on a Honua
deployment's `/mcp` — see [Connect AI agents to Honua over
MCP](https://github.com/honua-io/honua-server/blob/trunk/docs/guides/connect/ai-agents-mcp.md).

The geoprocessing verbs named in the geospatial-mcp standard's opt-in `analysis`
and `esri-gp` conformance profiles — `honua_buffer_features`,
`honua_esri_gp_list_tasks`, `honua_esri_gp_describe_task`,
`honua_esri_gp_execute_task` — are advertised by neither surface today. They are
profile members the zero-to-map release preflight checks a *candidate* server
for. To run geoprocessing now, use `honua_plan_analysis` → `honua_validate_plan`
→ `honua_execute_plan` on a deployment's `/mcp`, or
`HonuaClient.geoprocessingRunner()` from this SDK over HTTP.

There is no MCP tool that edits features. AI operational data editing is not
supported (honua-server ADR-0028), on either surface.

## Going further

The [package README](https://github.com/honua-io/honua-sdk-js/blob/trunk/mcp/README.md)
carries the full protocol-neutral addressing table, the typed filter grammar,
the environment variables, and the bootstrap-only local-install mode. How well
different client models actually drive this surface is measured, not claimed:
see the [cross-model eval scorecard](generated/mcp-eval-scorecard.md).
