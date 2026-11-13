# Honua MCP GIS Assistant

> **Native application path:** [gRPC for live data and edits; PMTiles, GeoParquet and COG through the CDN](../../docs/native-data-paths.md). Start there for browser gRPC-Web setup, signed private URLs and regeneration after changes. OGC API and GeoServices REST examples below are compatibility workflows.

Fixture-backed sample for issue #63. It demonstrates MCP assistant interaction
patterns against Honua Cloud concepts without a live LLM:

- grounded service, layer, schema, and capability discovery
- review-before-apply generated filters
- raw tool-call diagnostics
- bounded feature result summaries
- safe missing-credential and unsupported-capability states

Run locally:

```sh
npm run demo:mcp-gis-assistant
```

The first PR intentionally keeps the assistant deterministic. Feature query
results are bounded per turn and are not globally cached; only metadata cache
state is represented in diagnostics.
