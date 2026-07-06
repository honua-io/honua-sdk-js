# MCP Certification — honua.operator.mcp vv1

**Result:** ❌ FAIL

- Generated: `2026-07-06T18:44:56.766Z`
- Certified surface: live honua /mcp (https://demo.honua.io/mcp)
- Target mode: `remote`
- MCP transport: `streamable-http`
- Backend: `live`
- Standard: `geospatial-mcp@54cbd49 (spec/schemas)` (index 2026-07-01, https://json-schema.org/draft/2020-12/schema)

## Provenance

| Field | Value |
| --- | --- |
| Target | live honua /mcp (https://demo.honua.io/mcp) |
| Auth mode | `api-key` |
| Negotiated protocol | `2025-06-18` |
| Tools advertised | 20 |
| Suite git SHA | `60dc44091089443316950b8cbb0af05e42fd5479` (git) |
| Generated | `2026-07-06T18:44:56.766Z` |

## Summary

| Metric | Value |
| --- | ---: |
| Tools discovered | 20 |
| Tools with valid inputSchema | 20 / 20 |
| Tools conformance-checked | 20 |
| Tools conformant | 20 / 20 |
| Tools round-tripped | 9 |
| Tools with output-schema validated | 9 |
| Resources discovered | 2 |
| Prompts discovered | 4 |
| Contracts checked | 11 / 13 passed |
| Contracts skipped | 5 |
| Known gaps | 7 |
| Failures | 5 |

## Tools

| Tool | Schema | Standard | Conformant | Read-only | Round-trip | Output schema |
| --- | :---: | --- | :---: | :---: | :---: | :---: |
| `honua_cancel_job` | valid | cancel_job | yes | no | skipped | advertised |
| `honua_clarify_intent` | valid | clarify_intent | yes | yes | passed | validated |
| `honua_create_app_package` | valid | create_app_package | yes | no | skipped | advertised |
| `honua_create_map_package` | valid | create_map_package | yes | no | skipped | advertised |
| `honua_dry_run_plan` | valid | validate_plan | yes | yes | passed | validated |
| `honua_execute_plan` | valid | execute_plan | yes | no | skipped | advertised |
| `honua_geocode_address` | valid | geocode_address | yes | yes | failed | advertised |
| `honua_ground_candidates` | valid | ground_candidates | yes | yes | passed | validated |
| `honua_list_capabilities` | valid | list_capabilities | yes | yes | passed | validated |
| `honua_list_layers` | valid | list_layers | yes | yes | passed | validated |
| `honua_plan_analysis` | valid | plan_analysis | yes | yes | passed | validated |
| `honua_preview_package` | valid | preview_package | yes | yes | skipped | advertised |
| `honua_propose_operation` | valid | propose_operation | yes | no | skipped | advertised |
| `honua_publish_service` | valid | publish_service | yes | no | skipped | advertised |
| `honua_query_features` | valid | query_features | yes | yes | failed | advertised |
| `honua_render_map` | valid | render_map | yes | yes | failed | no |
| `honua_resolve_entity` | valid | resolve_entity | yes | yes | passed | validated |
| `honua_solve_route` | valid | solve_route | yes | yes | passed | validated |
| `honua_validate_package` | valid | validate_package | yes | yes | skipped | advertised |
| `honua_validate_plan` | valid | validate_plan | yes | yes | passed | validated |

## Contracts

| Contract | Target | Status | Detail |
| --- | --- | :---: | --- |
| `list-pagination` | `tools` | ➖ skipped | tools list is a single page (no nextCursor advertised) |
| `list-pagination` | `resources` | ➖ skipped | resources list is a single page (no nextCursor advertised) |
| `output-schema` | `honua_clarify_intent` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_dry_run_plan` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_ground_candidates` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_list_capabilities` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_list_layers` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_plan_analysis` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_resolve_entity` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_solve_route` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_validate_plan` | ✅ passed | structuredContent validated against advertised outputSchema |
| `error-shape` | `honua_query_features` | ❌ failed | invalid arguments raised a protocol error instead of a structured tool error: MCP error -32602: Structured content does not match the tool's output schema: data must have required property 'serviceId', data must have required property 'layerId', data must have required property 'returnedCount', data must have required property 'limit', data must have required property 'exceededTransferLimit', data must have required property 'geojson' |
| `auth-unauthenticated` | `tools/call` | ✅ passed | contract satisfied |
| `auth-unauthenticated` | `resources/read` | ✅ passed | contract satisfied |
| `mutating-round-trip` | `honua_edit_features` | ➖ skipped | honua_edit_features/honua_query_features not advertised by this surface (pre-P1 or read-only) |
| `mutating-permission-denied` | `honua_edit_features` | ➖ skipped | honua_edit_features not advertised by this surface (pre-P1) |
| `async-job-lifecycle` | `honua_execute_plan` | ➖ skipped | job lifecycle disabled for this target — set HONUA_MCP_CERT_ALLOW_MUTATION=1 to certify execution against a scratch target |
| `query-pagination` | `honua_query_features` | ❌ failed | query pagination raised: MCP error -32602: Structured content does not match the tool's output schema: data must have required property 'serviceId', data must have required property 'layerId', data must have required property 'returnedCount', data must have required property 'limit', data must have required property 'exceededTransferLimit', data must have required property 'geojson' |

### Tool failures

- `honua_geocode_address`
  - round-trip: MCP error -32602: Structured content does not match the tool's output schema: data must have required property 'provider', data must have required property 'candidates'
- `honua_query_features`
  - round-trip: MCP error -32602: Structured content does not match the tool's output schema: data must have required property 'serviceId', data must have required property 'layerId', data must have required property 'returnedCount', data must have required property 'limit', data must have required property 'exceededTransferLimit', data must have required property 'geojson'
- `honua_render_map`
  - round-trip: tool returned isError=true

## Resources

- `Feature catalog` — `honua://catalog/features`
- `Process catalog` — `honua://catalog/processes`

## Known gaps

These are standard capabilities not yet advertised as discrete tools, or advertised tools outside the standard. They are recorded, not failed.

- **standard-tool** `refine_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `get_style` _(Style inspection)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `apply_style_preset` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `compose_mixed_protocol_map` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_app_package` _(App composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `publish_result` _(Publishing)_ — standard family not yet implemented as a discrete tool

