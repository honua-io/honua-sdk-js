# Vendored geospatial-mcp JSON Schemas

These JSON Schema files are a verbatim, vendored copy of the published
machine-readable schemas from the open **geospatial-mcp** standard.

- **Source repo:** https://github.com/honua-io/geospatial-mcp
- **Source path:** `spec/schemas/`
- **Source commit:** `4fac81c2f93a110921bb62638bc5ab599ef5e626`
  (`Declare release component versions for the nightly resolver (#92)`, trunk HEAD on 2026-10-08)
- **Schema index date:** `2026-08-12`
- **Dialect:** JSON Schema draft 2020-12

> Re-vendored at trunk HEAD for the 2026.1 rc.3 certification fix (unit K2).
> The earlier hold at `eb53989` (pre geospatial-mcp#58) is over: honua-server
> now serves the #58 platform-ops tools (`honua_ops_health`, `honua_ops_findings`,
> `honua_alert_events`, `honua_operate_events`, `honua_platform_release_status`,
> `honua_deploy_operations`, `honua_propose_rollback`).
>
> Known upstream lag: this index still maps `propose_operation` to the retired
> `honua_propose_operation` as `implemented`. Marking it `known-gap` is
> geospatial-mcp unit K4, which had not landed at this commit. Until it does, the
> certifier records `propose_operation` as a standard-tool known gap (reference
> tool not advertised), which is recorded, not failed. Re-pin once K4 merges.

## Why vendored

The MCP certification harness (`src/certification/`) must run deterministically
in CI with **zero network access and zero model/API token spend**. Vendoring the
published schemas pins the standard the Honua MCP surface is certified against to
a known, reproducible revision and removes any cross-repo fetch at certify time.

## Refreshing

To re-pin to a newer published revision, edit the **Source commit** SHA (and the
index date) above, then run `scripts/sync-schemas.sh --write` from the repo root
to re-copy `spec/schemas/` verbatim from that commit. Do not hand-edit individual
schema files; the standard is owned upstream. The `schema-sync` CI workflow
(`.github/workflows/schema-sync.yml`) runs `scripts/sync-schemas.sh` on every PR
and fails on any byte difference from the pinned commit.

## Index

`index.json` maps each standard tool's bare `standardName` (taxonomy.md name) to
the `referenceToolName` the reference implementation (Honua `/mcp`) advertises,
plus an `implementationStatus` (`implemented` | `known-gap`). The certifier reads
this index to decide which advertised tools to conformance-check and which
standard tools to record as known gaps.
