# MCP Certification — honua.operator.mcp vv1

**Result:** ❌ FAIL

- Generated: `2026-08-31T14:55:25.288Z`
- Certified surface: live honua /mcp (https://demo.honua.io/mcp)
- Target mode: `remote`
- MCP transport: `streamable-http`
- Backend: `live`
- Standard: `geospatial-mcp@54cbd49 (spec/schemas)` (index 2026-07-06, https://json-schema.org/draft/2020-12/schema)

## Provenance

| Field | Value |
| --- | --- |
| Target | live honua /mcp (https://demo.honua.io/mcp) |
| Auth mode | `anonymous` |
| Negotiated protocol | `2025-06-18` |
| Tools advertised | 52 |
| Suite git SHA | `0c9bdb7ec07317515e4494494bf7d9aee8b4f8d5` (env) |
| Generated | `2026-08-31T14:55:25.288Z` |

## Summary

| Metric | Value |
| --- | ---: |
| Tools discovered | 52 |
| Tools with valid inputSchema | 52 / 52 |
| Tools conformance-checked | 25 |
| Tools conformant | 25 / 25 |
| Tools round-tripped | 0 |
| Tools with output-schema validated | 0 |
| Resources discovered | 8 |
| Prompts discovered | 4 |
| Contracts checked | 3 / 4 passed |
| Contracts skipped | 5 |
| Known gaps | 38 |
| Failures | 15 |

## Tools

| Tool | Schema | Standard | Conformant | Read-only | Round-trip | Output schema |
| --- | :---: | --- | :---: | :---: | :---: | :---: |
| `honua_alert_events` | valid | — | n/a | yes | skipped | advertised |
| `honua_apply_style_preset` | valid | apply_style_preset | yes | no | skipped | advertised |
| `honua_cancel_job` | valid | cancel_job | yes | no | skipped | advertised |
| `honua_clarify_intent` | valid | clarify_intent | yes | yes | failed | advertised |
| `honua_create_app_package` | valid | create_app_package | yes | no | skipped | advertised |
| `honua_create_map_package` | valid | create_map_package | yes | no | skipped | advertised |
| `honua_deploy_operations` | valid | — | n/a | yes | skipped | advertised |
| `honua_describe_layer` | valid | — | n/a | yes | failed | advertised |
| `honua_dry_run_plan` | valid | validate_plan | yes | yes | failed | advertised |
| `honua_execute_plan` | valid | execute_plan | yes | no | skipped | advertised |
| `honua_geocode_address` | valid | geocode_address | yes | yes | failed | advertised |
| `honua_geocode_addresses` | valid | geocode_addresses | yes | yes | skipped | advertised |
| `honua_get_style` | valid | get_style | yes | yes | failed | advertised |
| `honua_ground_candidates` | valid | ground_candidates | yes | yes | failed | advertised |
| `honua_ingest_dataset` | valid | ingest_dataset | yes | no | skipped | advertised |
| `honua_list_capabilities` | valid | list_capabilities | yes | yes | failed | advertised |
| `honua_list_jobs` | valid | — | n/a | yes | skipped | advertised |
| `honua_list_layers` | valid | list_layers | yes | yes | failed | advertised |
| `honua_operate_events` | valid | — | n/a | yes | skipped | advertised |
| `honua_ops_findings` | valid | — | n/a | yes | skipped | advertised |
| `honua_ops_health` | valid | — | n/a | yes | skipped | advertised |
| `honua_plan_analysis` | valid | plan_analysis | yes | yes | failed | advertised |
| `honua_platform_release_status` | valid | — | n/a | yes | skipped | advertised |
| `honua_preview_package` | valid | preview_package | yes | yes | skipped | advertised |
| `honua_propose_operation` | valid | propose_operation | yes | no | skipped | advertised |
| `honua_propose_rollback` | valid | — | n/a | no | skipped | advertised |
| `honua_publish_result` | valid | publish_result | yes | no | skipped | advertised |
| `honua_publish_service` | valid | publish_service | yes | no | skipped | advertised |
| `honua_query_features` | valid | query_features | yes | yes | failed | advertised |
| `honua_render_map` | valid | render_map | yes | yes | failed | advertised |
| `honua_resolve_entity` | valid | resolve_entity | yes | yes | failed | advertised |
| `honua_solve_route` | valid | solve_route | yes | yes | failed | advertised |
| `honua_studio_add_control` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_add_layer` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_add_widget` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_bind_interaction` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_create_draft` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_get_draft` | valid | — | n/a | yes | skipped | advertised |
| `honua_studio_preview_draft` | valid | — | n/a | yes | skipped | advertised |
| `honua_studio_propose_publication` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_remove_control` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_remove_interaction` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_remove_layer` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_remove_widget` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_set_layer_style` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_set_layer_visibility` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_set_view` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_update_draft` | valid | — | n/a | no | skipped | advertised |
| `honua_studio_validate_draft` | valid | — | n/a | yes | skipped | advertised |
| `honua_supported_operation_kinds` | valid | — | n/a | yes | skipped | advertised |
| `honua_validate_package` | valid | validate_package | yes | yes | skipped | advertised |
| `honua_validate_plan` | valid | validate_plan | yes | yes | failed | advertised |

## Contracts

| Contract | Target | Status | Detail |
| --- | --- | :---: | --- |
| `list-pagination` | `tools` | ✅ passed | tools list paginated across 2 pages; nextCursor honored and terminated |
| `list-pagination` | `resources` | ➖ skipped | resources list is a single page (no nextCursor advertised) |
| `error-shape` | `honua_query_features` | ❌ failed | expected geoprocessing-error kind "ValidationFailed", got "AuthorizationDenied"; expected at least one structured validation `violation` |
| `auth-unauthenticated` | `tools/call` | ✅ passed | contract satisfied |
| `auth-unauthenticated` | `resources/read` | ✅ passed | contract satisfied |
| `mutating-round-trip` | `honua_edit_features` | ➖ skipped | honua_edit_features/honua_query_features not advertised by this surface (pre-P1 or read-only) |
| `mutating-permission-denied` | `honua_edit_features` | ➖ skipped | honua_edit_features not advertised by this surface (pre-P1) |
| `async-job-lifecycle` | `honua_execute_plan` | ➖ skipped | job lifecycle disabled for this target — set HONUA_MCP_CERT_ALLOW_MUTATION=1 to certify execution against a scratch target |
| `query-pagination` | `honua_query_features` | ➖ skipped | surface returned a single page with no nextCursor (pagination not exercised — pre-P1 surface or fewer than 2 features) |

### Tool failures

- `honua_clarify_intent`
  - round-trip: tool returned isError=true
- `honua_describe_layer`
  - round-trip: tool returned isError=true
- `honua_dry_run_plan`
  - round-trip: tool returned isError=true
- `honua_geocode_address`
  - round-trip: tool returned isError=true
- `honua_get_style`
  - round-trip: tool returned isError=true
- `honua_ground_candidates`
  - round-trip: tool returned isError=true
- `honua_list_capabilities`
  - round-trip: tool returned isError=true
- `honua_list_layers`
  - round-trip: tool returned isError=true
- `honua_plan_analysis`
  - round-trip: tool returned isError=true
- `honua_query_features`
  - round-trip: tool returned isError=true
- `honua_render_map`
  - round-trip: tool returned isError=true
- `honua_resolve_entity`
  - round-trip: tool returned isError=true
- `honua_solve_route`
  - round-trip: tool returned isError=true
- `honua_validate_plan`
  - round-trip: tool returned isError=true

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

- **standard-tool** `refine_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `compose_mixed_protocol_map` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_app_package` _(App composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `edit_features` _(Feature editing)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `buffer_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `overlay_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `summarize_statistics` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `reproject_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `join_features` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `export_dataset` _(Analysis verbs)_ — standard family not yet implemented as a discrete tool
- **advertised-tool** `honua_alert_events` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_deploy_operations` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_describe_layer` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_list_jobs` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_operate_events` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_ops_findings` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_ops_health` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_platform_release_status` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_propose_rollback` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_add_control` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_add_layer` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_add_widget` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_bind_interaction` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_create_draft` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_get_draft` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_preview_draft` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_propose_publication` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_remove_control` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_remove_interaction` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_remove_layer` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_remove_widget` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_set_layer_style` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_set_layer_visibility` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_set_view` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_update_draft` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_studio_validate_draft` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_supported_operation_kinds` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)

