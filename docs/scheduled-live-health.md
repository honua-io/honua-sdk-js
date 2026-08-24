# Scheduled and live lane health

`config/scheduled-live-lanes.v1.json` is the reviewed inventory of retained
scheduled and live evidence lanes. Each entry names its workflow, owner,
requiredness, freshness ceiling, and—where a live failure has been
investigated—triage bound to that exact Actions run ID. A classification never
transfers to a newer run implicitly.

The daily `Scheduled and live lane health` workflow queries the latest run of
every entry and publishes `scheduled-live-health.v1.json`. The named `Required
live evidence health` aggregate fails for required lanes that are failing,
never-run, running past the observation point, stale, or inside their
pre-staleness warning window. Optional/manual signals remain visible in the
same projection but cannot masquerade as release gates.

An unhealthy required aggregate opens or updates `Scheduled/live lane health
alert` and assigns the configured repository owner. This makes a lapse visible
before its freshness ceiling. Release qualification and installed-package
certification must consume only required entries whose status is `healthy`;
the presence of an artifact or a prior successful run is not candidate proof.

The paid MCP cross-model evaluation is intentionally optional and manual. Its
replacement evidence is the deterministic offline MCP evaluation plus the
non-billable live MCP certification. Do not dispatch the Bedrock workflow
without explicit cost authorization.
