# MCP Certification — honua.operator.mcp vv1

**Result:** ❌ FAIL

- Generated: `2026-10-26T14:00:53.583Z`
- Certified surface: live honua /mcp (http://localhost:8080/mcp)
- Target mode: `remote`
- MCP transport: `streamable-http`
- Backend: `live`
- Standard: `geospatial-mcp@4fac81c (spec/schemas)` (index 2026-08-12, https://json-schema.org/draft/2020-12/schema)

## Provenance

| Field | Value |
| --- | --- |
| Target | live honua /mcp (http://localhost:8080/mcp) |
| Auth mode | `api-key` |
| Negotiated protocol | `2025-06-18` |
| Tools advertised | 12 |
| Suite git SHA | `0fd89bb63d74ab599909bd85b4945bb3d4f52b2a` (env) |
| Generated | `2026-10-26T14:00:53.583Z` |

## Summary

| Metric | Value |
| --- | ---: |
| Tools discovered | 12 |
| Tools with valid inputSchema | 12 / 12 |
| Tools conformance-checked | 9 |
| Tools conformant | 9 / 9 |
| Tools round-tripped | 6 |
| Tools with output-schema validated | 6 |
| Resources discovered | 8 |
| Prompts discovered | 5 |
| Contracts checked | 9 / 9 passed |
| Contracts skipped | 6 |
| Contracts blocked | 2 |
| Known gaps | 44 |
| Failures | 0 |

## Tools

| Tool | Schema | Standard | Conformant | Read-only | Round-trip | Output schema |
| --- | :---: | --- | :---: | :---: | :---: | :---: |
| `honua_describe_layer` | valid | — | n/a | yes | skipped | advertised |
| `honua_list_capabilities` | valid | list_capabilities | yes | yes | passed | validated |
| `honua_list_layers` | valid | list_layers | yes | yes | passed | validated |
| `honua_query_features` | valid | query_features | yes | yes | skipped | advertised |
| `honua_resolve_entity` | valid | resolve_entity | yes | yes | passed | validated |
| `honua_supported_operation_kinds` | valid | — | n/a | yes | skipped | advertised |
| `honua_dry_run_plan` | valid | validate_plan | yes | yes | passed | validated |
| `honua_execute_plan` | valid | execute_plan | yes | no | skipped | advertised |
| `honua_list_jobs` | valid | — | n/a | yes | skipped | advertised |
| `honua_plan_analysis` | valid | plan_analysis | yes | yes | passed | validated |
| `honua_render_map` | valid | render_map | yes | yes | skipped | advertised |
| `honua_validate_plan` | valid | validate_plan | yes | yes | passed | validated |

## Contracts

| Contract | Target | Status | Detail |
| --- | --- | :---: | --- |
| `list-pagination` | `tools` | ➖ skipped | tools list is a single page (no nextCursor advertised) |
| `list-pagination` | `resources` | ➖ skipped | resources list is a single page (no nextCursor advertised) |
| `output-schema` | `honua_list_capabilities` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_list_layers` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_resolve_entity` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_dry_run_plan` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_plan_analysis` | ✅ passed | structuredContent validated against advertised outputSchema |
| `output-schema` | `honua_validate_plan` | ✅ passed | structuredContent validated against advertised outputSchema |
| `error-shape` | `honua_query_features` | ✅ passed | contract satisfied |
| `auth-unauthenticated` | `tools/call` | ✅ passed | contract satisfied |
| `auth-unauthenticated` | `resources/read` | ✅ passed | contract satisfied |
| `mutating-round-trip` | `honua_edit_features` | ➖ skipped | honua_edit_features/honua_query_features not advertised by this surface (pre-P1 or read-only) |
| `mutating-permission-denied` | `honua_edit_features` | ➖ skipped | honua_edit_features not advertised by this surface (pre-P1) |
| `async-job-lifecycle` | `honua_execute_plan` | ➖ skipped | job lifecycle disabled for this target — set HONUA_MCP_CERT_ALLOW_MUTATION=1 to certify execution against a scratch target |
| `query-pagination` | `honua_query_features` | ➖ skipped | no published layer to page: the candidate serves no published layer (honua_list_layers returned none); publish a service before certifying the round trips |
| `round-trip-target` | `HONUA_MCP_SERVICE_ID=discover` | ⛔ blocked | the candidate serves no published layer (honua_list_layers returned none); publish a service before certifying the round trips |
| `roster-parity` | `tools/list` | ⛔ blocked | docs/gis/data/mcp-tool-roster.v1.json not found at honua-server@87966c3f7b6c840ffc4d4da0b451714ab717b18a: absent at that sha, or not readable without HONUA_MCP_ROSTER_TOKEN [https://raw.githubusercontent.com/honua-io/honua-server/87966c3f7b6c840ffc4d4da0b451714ab717b18a/docs/gis/data/mcp-tool-roster.v1.json] |

## Resources

- `App packages index` — `honua://app-packages`
- `Feature catalog` — `honua://catalog/features`
- `Process catalog` — `honua://catalog/processes`
- `Deployments index` — `honua://deployments`
- `Map packages index` — `honua://map-packages`
- `Ops findings` — `honua://ops/findings`
- `Ops health` — `honua://ops/health`
- `Published services index` — `honua://published-services`

## Known gaps

These are standard capabilities not yet advertised as discrete tools, or advertised tools outside the standard. They are recorded, not failed.

- **standard-tool** `ground_candidates` _(Intent and planning)_ — reference tool honua_ground_candidates not advertised by the certified surface
- **standard-tool** `clarify_intent` _(Intent and planning)_ — reference tool honua_clarify_intent not advertised by the certified surface
- **standard-tool** `create_map_package` _(Map composition)_ — reference tool honua_create_map_package not advertised by the certified surface
- **standard-tool** `refine_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `get_style` _(Style inspection)_ — reference tool honua_get_style not advertised by the certified surface
- **standard-tool** `apply_style_preset` _(Map composition (reference shape))_ — reference tool honua_apply_style_preset not advertised by the certified surface
- **standard-tool** `compose_mixed_protocol_map` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `create_app_package` _(App composition)_ — reference tool honua_create_app_package not advertised by the certified surface
- **standard-tool** `preview_app_package` _(App composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `bind_interaction` _(Composition interactions)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `remove_interaction` _(Composition interactions)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `add_control` _(Composition controls)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `remove_control` _(Composition controls)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `create_exploration_context` _(Composition exploration)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `remove_exploration_context` _(Composition exploration)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `bind_component_context` _(Composition exploration)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `publish_result` _(Publishing)_ — reference tool honua_publish_result not advertised by the certified surface
- **standard-tool** `edit_features` _(Feature editing)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `geocode_address` _(Analysis and geoprocessing (reference shape))_ — reference tool honua_geocode_address not advertised by the certified surface
- **standard-tool** `geocode_addresses` _(Analysis and geoprocessing (reference shape))_ — reference tool honua_geocode_addresses not advertised by the certified surface
- **standard-tool** `solve_route` _(Analysis and geoprocessing (reference shape))_ — reference tool honua_solve_route not advertised by the certified surface
- **standard-tool** `buffer_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `overlay_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `summarize_statistics` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `reproject_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `join_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `export_dataset` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `cancel_job` _(Execution (reference shape))_ — reference tool honua_cancel_job not advertised by the certified surface
- **standard-tool** `propose_operation` _(Control-plane proposal (reference shape))_ — reference tool honua_propose_operation not advertised by the certified surface
- **standard-tool** `ops_health` _(Platform operations (reference shape))_ — reference tool honua_ops_health not advertised by the certified surface
- **standard-tool** `ops_findings` _(Platform operations (reference shape))_ — reference tool honua_ops_findings not advertised by the certified surface
- **standard-tool** `alert_events` _(Platform operations (reference shape))_ — reference tool honua_alert_events not advertised by the certified surface
- **standard-tool** `operate_events` _(Platform operations (reference shape))_ — reference tool honua_operate_events not advertised by the certified surface
- **standard-tool** `platform_release_status` _(Platform operations (reference shape))_ — reference tool honua_platform_release_status not advertised by the certified surface
- **standard-tool** `deploy_operations` _(Platform operations (reference shape))_ — reference tool honua_deploy_operations not advertised by the certified surface
- **standard-tool** `propose_rollback` _(Control-plane proposal (reference shape))_ — reference tool honua_propose_rollback not advertised by the certified surface
- **standard-tool** `ingest_dataset` _(Publishing)_ — reference tool honua_ingest_dataset not advertised by the certified surface
- **standard-tool** `publish_service` _(Publishing)_ — reference tool honua_publish_service not advertised by the certified surface
- **standard-tool** `validate_package` _(Composition review (reference shape))_ — reference tool honua_validate_package not advertised by the certified surface
- **standard-tool** `preview_package` _(Composition review (reference shape))_ — reference tool honua_preview_package not advertised by the certified surface
- **advertised-tool** `honua_describe_layer` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_supported_operation_kinds` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_list_jobs` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)

