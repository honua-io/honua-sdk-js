# AI Spatial App Builder and Query Studio

Fixture-backed sample for issue #74. It demonstrates a bounded natural-language spatial app builder flow without live LLM or cloud calls by default.

- Prompt to optional structured clarification.
- Deterministic query/spec draft before execution.
- Plan/apply job status with warnings, degraded capabilities, and cache notes.
- Generated map/table/chart/filter/detail mini-app state synchronized through Honua exploration linked context.
- Serializable workspace export for saved-state and MCP inspection flows.
