# Vendored geospatial-mcp JSON Schemas

These JSON Schema files are a verbatim, vendored copy of the published
machine-readable schemas from the open **geospatial-mcp** standard.

- **Source repo:** https://github.com/honua-io/geospatial-mcp
- **Source path:** `spec/schemas/`
- **Source commit:** `fff3e305ff4a3cf5ab99a18b81f8442979da82d2`
  (`feat: admit governed feature mutation into the standard (mutation profile) (#51)`)
- **Schema index date:** `2026-07-06`
- **Dialect:** JSON Schema draft 2020-12

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
