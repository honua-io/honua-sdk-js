# Vendored honua-server MCP tool roster

`mcp-tool-roster.v1.json` in this directory is a verbatim copy of
`docs/gis/data/mcp-tool-roster.v1.json` from honua-server, read at the commit
the pinned candidate image was built from.

- **Source repo:** https://github.com/honua-io/honua-server
- **Source path:** `docs/gis/data/mcp-tool-roster.v1.json`
- **Server commit:** `87966c3f7b6c840ffc4d4da0b451714ab717b18a`
  (`ADMIN_RELEASE_SERVER_SHA` in `src/control-plane/generated/admin-operations.ts`,
  the build of `ADMIN_LOCAL_SERVER_IMAGE`)

## Status: blocked

The roster file does not exist at the pinned server commit yet. The server
change that generates it (`mcp-tool-roster-and-parity-gates`, unit S4) has not
reached the pinned image. Until it does:

- the `roster-parity` certification contract reports `blocked` (never `passed`)
  against a live `/mcp`, which keeps the certification from passing;
- the offline catalog-parity unit test (`test/certification/roster.test.ts`)
  asserts this blocked state instead of skipping silently.

## Refreshing

When the pinned server commit advances (the `ADMIN_RELEASE_SERVER_SHA`
constant), update **Server commit** above to the same sha and run:

```sh
node mcp/scripts/sync-mcp-roster.mjs --write
```

It copies the roster at that commit into this directory, or reports that it is
still blocked. Do not hand-edit the vendored roster. The unit test fails if the
commit above and `ADMIN_RELEASE_SERVER_SHA` disagree.
