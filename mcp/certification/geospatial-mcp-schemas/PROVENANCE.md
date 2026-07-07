# Vendored geospatial-mcp JSON Schemas

These JSON Schema files are a verbatim, vendored copy of the published
machine-readable schemas from the open **geospatial-mcp** standard.

- **Source repo:** https://github.com/honua-io/geospatial-mcp
- **Source path:** `spec/schemas/`
- **Source commit:** `eb53989cc61c856261cf017b4b5a8e721317dc41`
  (`feat: direct geoprocessing verbs (analysis profile) + geometryPrecision/maxInlineBytes (#55)`)
- **Schema index date:** `2026-07-06`
- **Dialect:** JSON Schema draft 2020-12

> The pin is deliberately held at `eb53989` (pre geospatial-mcp#58): the #58
> platform-ops schemas are marked implemented in the manifest but honua-server
> does not serve those tools yet, so re-vendoring past #58 would introduce
> conformance failures. The post-#58 bump is owned by honua-server#2555/#2566,
> which implement the new tools and vendor their schemas together.

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
