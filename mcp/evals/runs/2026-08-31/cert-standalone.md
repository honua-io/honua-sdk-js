# MCP Certification — honua v0.1.9-beta.0

**Result:** ❌ FAIL

- Generated: `2026-08-31T14:55:46.467Z`
- Certified surface: honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces)
- Target mode: `standalone`
- MCP transport: `streamable-http`
- Backend: `live` (Honua transport: `rest`)
- Standard: `geospatial-mcp@54cbd49 (spec/schemas)` (index 2026-07-06, https://json-schema.org/draft/2020-12/schema)

## Provenance

| Field | Value |
| --- | --- |
| Target | honua-mcp standalone → https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis (live public FeatureServer, no Honua surfaces) |
| Auth mode | `anonymous` |
| Negotiated protocol | `n/a` |
| Tools advertised | 11 |
| Suite git SHA | `0c9bdb7ec07317515e4494494bf7d9aee8b4f8d5` (env) |
| Generated | `2026-08-31T14:55:46.467Z` |

## Summary

| Metric | Value |
| --- | ---: |
| Tools discovered | 11 |
| Tools with valid inputSchema | 11 / 11 |
| Tools conformance-checked | 3 |
| Tools conformant | 3 / 3 |
| Tools round-tripped | 9 |
| Tools with output-schema validated | 0 |
| Resources discovered | 2 |
| Prompts discovered | 0 |
| Contracts checked | 1 / 1 passed |
| Contracts skipped | 8 |
| Known gaps | 40 |
| Failures | 1 |

## Tools

| Tool | Schema | Standard | Conformant | Read-only | Round-trip | Output schema |
| --- | :---: | --- | :---: | :---: | :---: | :---: |
| `honua_list_sources` | valid | — | n/a | yes | passed | no |
| `honua_list_services` | valid | — | n/a | yes | passed | no |
| `honua_describe_layer` | valid | — | n/a | yes | passed | no |
| `honua_query_features` | valid | query_features | yes | yes | passed | no |
| `honua_count_features` | valid | — | n/a | yes | failed | no |
| `honua_get_extent` | valid | — | n/a | yes | passed | no |
| `honua_statistics` | valid | — | n/a | yes | passed | no |
| `honua_explain_capability_gap` | valid | — | n/a | yes | passed | no |
| `honua_get_style` | valid | get_style | yes | yes | passed | no |
| `honua_apply_style_preset` | valid | apply_style_preset | yes | yes | passed | no |
| `honua_docs_search` | valid | — | n/a | yes | skipped | no |

## Contracts

| Contract | Target | Status | Detail |
| --- | --- | :---: | --- |
| `list-pagination` | `tools` | ➖ skipped | tools list is a single page (no nextCursor advertised) |
| `list-pagination` | `resources` | ➖ skipped | resources list is a single page (no nextCursor advertised) |
| `error-shape` | `honua_query_features` | ✅ passed | contract satisfied |
| `auth-unauthenticated` | `tools/call` | ➖ skipped | target does not support an unauthenticated pass |
| `auth-unauthenticated` | `resources/read` | ➖ skipped | target does not support an unauthenticated pass |
| `mutating-round-trip` | `honua_edit_features` | ➖ skipped | honua_edit_features/honua_query_features not advertised by this surface (pre-P1 or read-only) |
| `mutating-permission-denied` | `honua_edit_features` | ➖ skipped | honua_edit_features not advertised by this surface (pre-P1) |
| `async-job-lifecycle` | `honua_execute_plan` | ➖ skipped | honua_execute_plan not advertised by this surface (pre-P1) |
| `query-pagination` | `honua_query_features` | ➖ skipped | surface returned a single page with no nextCursor (pagination not exercised — pre-P1 surface or fewer than 2 features) |

### Tool failures

- `honua_count_features`
  - round-trip: tool returned isError=true

## Resources

- `services-catalog` — `honua://services`
- `styles-catalog` — `honua://styles`

## Known gaps

These are standard capabilities not yet advertised as discrete tools, or advertised tools outside the standard. They are recorded, not failed.

- **standard-tool** `plan_analysis` _(Intent and planning)_ — reference tool honua_plan_analysis not advertised by the certified surface
- **standard-tool** `ground_candidates` _(Intent and planning)_ — reference tool honua_ground_candidates not advertised by the certified surface
- **standard-tool** `clarify_intent` _(Intent and planning)_ — reference tool honua_clarify_intent not advertised by the certified surface
- **standard-tool** `validate_plan` _(Intent and planning)_ — reference tool honua_validate_plan not advertised by the certified surface
- **standard-tool** `execute_plan` _(Execution)_ — reference tool honua_execute_plan not advertised by the certified surface
- **standard-tool** `create_map_package` _(Map composition)_ — reference tool honua_create_map_package not advertised by the certified surface
- **standard-tool** `refine_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `compose_mixed_protocol_map` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `create_app_package` _(App composition)_ — reference tool honua_create_app_package not advertised by the certified surface
- **standard-tool** `preview_app_package` _(App composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `publish_result` _(Publishing)_ — reference tool honua_publish_result not advertised by the certified surface
- **standard-tool** `list_layers` _(Discovery and query (reference shape))_ — reference tool honua_list_layers not advertised by the certified surface
- **standard-tool** `edit_features` _(Feature editing)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `render_map` _(Discovery and query (reference shape))_ — reference tool honua_render_map not advertised by the certified surface
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
- **standard-tool** `ingest_dataset` _(Publishing)_ — reference tool honua_ingest_dataset not advertised by the certified surface
- **standard-tool** `publish_service` _(Publishing)_ — reference tool honua_publish_service not advertised by the certified surface
- **standard-tool** `validate_package` _(Composition review (reference shape))_ — reference tool honua_validate_package not advertised by the certified surface
- **standard-tool** `preview_package` _(Composition review (reference shape))_ — reference tool honua_preview_package not advertised by the certified surface
- **standard-tool** `resolve_entity` _(Discovery and grounding (Honua extension))_ — reference tool honua_resolve_entity not advertised by the certified surface
- **standard-tool** `list_capabilities` _(Discovery and grounding (Honua extension))_ — reference tool honua_list_capabilities not advertised by the certified surface
- **advertised-tool** `honua_list_sources` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_list_services` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_describe_layer` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_count_features` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_get_extent` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_statistics` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_explain_capability_gap` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)
- **advertised-tool** `honua_docs_search` — advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)

