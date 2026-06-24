# Vendored geospatial-mcp JSON Schemas

These JSON Schema files are a verbatim, vendored copy of the published
machine-readable schemas from the open **geospatial-mcp** standard.

- **Source repo:** https://github.com/honua-io/geospatial-mcp
- **Source path:** `spec/schemas/`
- **Source commit:** `968d7d7709f15d0626f8f3c607532489e48f07d1`
  (`spec(schemas): publish machine-readable JSON Schemas + conformance fixtures (#1957)`)
- **Schema index date:** `2026-06-21`
- **Dialect:** JSON Schema draft 2020-12

## Why vendored

The MCP certification harness (`src/certification/`) must run deterministically
in CI with **zero network access and zero model/API token spend**. Vendoring the
published schemas pins the standard the Honua MCP surface is certified against to
a known, reproducible revision and removes any cross-repo fetch at certify time.

## Refreshing

To re-pin to a newer published revision, re-copy `spec/schemas/` from the
`geospatial-mcp` repo at the desired tag/commit and update the source commit and
index date above. Do not hand-edit individual schema files; the standard is owned
upstream.

## Index

`index.json` maps each standard tool's bare `standardName` (taxonomy.md name) to
the `referenceToolName` the reference implementation (Honua `/mcp`) advertises,
plus an `implementationStatus` (`implemented` | `known-gap`). The certifier reads
this index to decide which advertised tools to conformance-check and which
standard tools to record as known gaps.
