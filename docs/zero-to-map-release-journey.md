# Zero-to-map release journey

The 2026.1 release journey answers one end-to-end question: can an operator use
AI-facing Honua surfaces to install the platform, configure services and
geoprocessing, then create and save a map app without pretending that an agent
performed the human publication gate?

The executable bundle lives at
[`mcp/release/zero-to-map`](../mcp/release/zero-to-map/README.md). It implements
the seven stages from `honua-release#123` D9.3:

1. Run the control-plane Docker installer and verify API, MCP, and Console.
2. Use the generated admin MCP surface to test a connection, import fixtures,
   publish layers, set access, and create a scoped key.
3. Discover and execute the Esri-compatible Buffer task through MCP, poll its
   job/result resources to a retained artifact, prove the same task through the
   SDK's GPServer adapter, then run and poll the dataset-oriented MCP Buffer
   verb separately.
4. Use Studio MCP tools to create a draft, add layers and the retained GP
   artifact, style and show it, set the view, add a chart/control/interaction,
   validate, and reopen the saved draft.
5. Record publication intent while structurally requiring human confirmation.
6. Import a Console receipt bound to the exact connection/service/layers, all
   three GP jobs and result identities, draft, real admin proposal, execution
   operation, audit correlation, and approved release candidate, including
   health and recovery checks.
7. Require HTTP 200 from the stable approved share URL.

The GP story is deliberately dual-surface. `honua_esri_gp_list_tasks`,
`honua_esri_gp_describe_task`, and `honua_esri_gp_execute_task` are the
AI-facing Esri compatibility roster; the third tool is executed, then its
`honua://jobs/{id}` and `/results` resources are joined before the gate passes.
`HonuaClient.geoprocessingRunner()` separately drives the GPServer task with the
same `IJobRun` lifecycle used elsewhere in the SDK.
`honua_buffer_features` remains the native MCP dataset-reference verb. Honua's
server owns the process catalog and translation; the journey does not invent
external ArcGIS Server federation.

Contract mode is the default and is safe to run in CI. It validates the plan,
records live execution as blocked, and skips dependent stages. Live mode is
explicit (`--execute --yes`), preflights the complete MCP catalog before the
first MCP mutation, blocks on missing deployment capabilities, and accepts a
Console receipt only when its journey, resource, job, result, proposal,
execution-operation, audit-correlation, candidate, and release identities
match. The Studio `PublicationIntent` is not mislabeled as the separate admin
approval proposal.

The checked-in fixtures and simulated tests are contract evidence, not a live
candidate recording. A release owner must retain the driver receipt, Console
receipt hash, and the final URL response as the release evidence bundle.
