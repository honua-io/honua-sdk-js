---
type: guide
title: "Zero-to-map release journey"
description: "The 2026.1 release journey answers one end-to-end question: can an operator use"
---
# Zero-to-map release journey

The September 9, 2026 scope decision on #1401 limits the first cut to the
bounded setup → configure → publish path. The broader integration driver
described below is retained engineering, not a requirement to enable full
Admin MCP, additional analysis families or dashboards for that cut. Use the
[pinned bounded catalog qualification](../mcp/certification/setup-parity.md)
for current HTTP/stdio discovery evidence, alongside separate immutable
install, task execution and style/render receipts.

The 2026.1 release journey answers one end-to-end question: can one admin, in
one session, install the platform, configure services, buffer a published
layer, and publish a map, app, and dashboard whose share URLs return HTTP 200?

The executable bundle lives at
[`mcp/release/zero-to-map`](../mcp/release/zero-to-map/README.md). It implements
the stages from `honua-release#123` D9.3:

1. Run the control-plane Docker installer and verify API, MCP, and Console.
2. Use the closed admin roster to create a connection, import fixtures, publish
   layers, and set access. Arguments are the flat published fields.
3. Buffer the published parcel layer with `honua_validate_plan` then
   `honua_execute_plan` for `analytics.buffer-aggregate`. Poll
   `honua://jobs/{jobId}` to terminal success and read `artifacts[].artifactId`
   from `honua://jobs/{jobId}/results`. Separately, prove `geometry.buffer`
   through `HonuaClient.geoprocessingRunner()` with WKB. That process has no
   `layerId`. The journey does not call `honua_esri_gp_*` or
   `honua_buffer_features`.
4. Use Studio MCP tools to create a draft, add layers and the retained buffer
   artifact, style and show it, set the view, add a chart/control/interaction,
   validate, save, read the version, and reopen it.
5. Call `honua_studio_propose_publication` after save, with `itemId`,
   `versionId`, `contentHash`, `route`, `visibility`, and `note`. An admin
   result has `humanConfirmationRequired: false` and a `shareUrl`.
6. Fetch those share URLs and require HTTP 200. One admin credential. No second
   principal and no Console receipt.

Save captures read `/structuredContent/version/versionId`,
`/structuredContent/version/contentHash`, and `versionNumber` under `version`.
`honua_studio_get_version` still returns top-level `versionId` and `contentHash`.
`details.response` on admin calls stays a string; the journey `JSON.parse`s it
and reads `/data/connectionId` and `/data/layerId`.

Contract mode is the default and is safe to run in CI. It validates the plan,
records live execution as blocked, and never starts Docker. Live mode is
explicit (`--execute --yes`). The preflight asserts the closed roster this
journey calls. It does not require 432 or 441 tools and it does not require the
`analysis` or `esri-gp` profiles. (`--yes` is required: the install command
creates files and starts Docker containers, so without it, or without
`--dry-run`, it refuses to run.)

The checked-in fixtures and simulated tests are contract evidence, not a live
candidate recording. A release owner retains the driver receipt and the three
HTTP 200 responses.
