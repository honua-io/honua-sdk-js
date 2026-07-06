# MCP Certification — honua.operator.mcp vv1

**Result:** ❌ FAIL

- Generated: `2026-07-05T22:58:22.129Z`
- Certified surface: live honua /mcp (https://demo.honua.io/mcp)
- Target mode: `remote`
- MCP transport: `streamable-http`
- Backend: `live`
- Standard: `geospatial-mcp@54cbd49 (spec/schemas)` (index 2026-07-01, https://json-schema.org/draft/2020-12/schema)

## Summary

| Metric | Value |
| --- | ---: |
| Tools discovered | 15 |
| Tools with valid inputSchema | 15 / 15 |
| Tools conformance-checked | 15 |
| Tools conformant | 15 / 15 |
| Tools round-tripped | 6 |
| Tools with output-schema validated | 0 |
| Resources discovered | 1 |
| Prompts discovered | 0 |
| Contracts checked | 2 / 3 passed |
| Known gaps | 12 |
| Failures | 5 |

## Tools

| Tool | Schema | Standard | Conformant | Read-only | Round-trip | Output schema |
| --- | :---: | --- | :---: | :---: | :---: | :---: |
| `honua_cancel_job` | valid | cancel_job | yes | no | skipped | no |
| `honua_clarify_intent` | valid | clarify_intent | yes | yes | passed | no |
| `honua_dry_run_plan` | valid | validate_plan | yes | yes | passed | no |
| `honua_execute_plan` | valid | execute_plan | yes | no | skipped | no |
| `honua_geocode_address` | valid | geocode_address | yes | yes | failed | no |
| `honua_ground_candidates` | valid | ground_candidates | yes | yes | passed | no |
| `honua_list_layers` | valid | list_layers | yes | yes | passed | no |
| `honua_plan_analysis` | valid | plan_analysis | yes | yes | passed | no |
| `honua_preview_package` | valid | preview_package | yes | yes | skipped | no |
| `honua_propose_operation` | valid | propose_operation | yes | no | skipped | no |
| `honua_query_features` | valid | query_features | yes | yes | failed | no |
| `honua_render_map` | valid | render_map | yes | yes | failed | no |
| `honua_solve_route` | valid | solve_route | yes | yes | failed | no |
| `honua_validate_package` | valid | validate_package | yes | yes | skipped | no |
| `honua_validate_plan` | valid | validate_plan | yes | yes | passed | no |

## Contracts

| Contract | Target | Status | Detail |
| --- | --- | :---: | --- |
| `list-pagination` | `tools` | ➖ skipped | tools list is a single page (no nextCursor advertised) |
| `list-pagination` | `resources` | ➖ skipped | resources list is a single page (no nextCursor advertised) |
| `error-shape` | `honua_query_features` | ❌ failed | structured error is missing a geoprocessing-error envelope |
| `auth-unauthenticated` | `tools/call` | ✅ passed | contract satisfied |
| `auth-unauthenticated` | `resources/read` | ✅ passed | contract satisfied |

### Tool failures

- `honua_geocode_address`
  - round-trip: tool returned isError=true
- `honua_query_features`
  - round-trip: tool returned isError=true
- `honua_render_map`
  - round-trip: tool returned isError=true
- `honua_solve_route`
  - round-trip: tool returned isError=true

## Resources

- `Process catalog` — `honua://catalog/processes`

## Known gaps

These are standard capabilities not yet advertised as discrete tools, or advertised tools outside the standard. They are recorded, not failed.

- **standard-tool** `create_map_package` _(Map composition)_ — reference tool honua_create_map_package not advertised by the certified surface
- **standard-tool** `refine_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `get_style` _(Style inspection)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `apply_style_preset` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `compose_mixed_protocol_map` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `preview_map_package` _(Map composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `create_app_package` _(App composition)_ — reference tool honua_create_app_package not advertised by the certified surface
- **standard-tool** `preview_app_package` _(App composition)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `publish_result` _(Publishing)_ — standard family not yet implemented as a discrete tool
- **standard-tool** `publish_service` _(Publishing)_ — reference tool honua_publish_service not advertised by the certified surface
- **standard-tool** `resolve_entity` _(Discovery and grounding (Honua extension))_ — reference tool honua_resolve_entity not advertised by the certified surface
- **standard-tool** `list_capabilities` _(Discovery and grounding (Honua extension))_ — reference tool honua_list_capabilities not advertised by the certified surface

