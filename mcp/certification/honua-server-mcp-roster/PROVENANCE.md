# Vendored honua-server MCP tool roster

`mcp-tool-roster.v1.json` in this directory is a verbatim copy of
`docs/gis/data/mcp-tool-roster.v1.json` from honua-server, read at the commit
the working-candidate contract is pinned to.

- **Source repo:** https://github.com/honua-io/honua-server
- **Source path:** `docs/gis/data/mcp-tool-roster.v1.json`
- **Server commit:** `93cad86ec4fb28fba3ff0b9358059d86aa55dde5`
  (`ADMIN_RELEASE_SERVER_SHA` in `src/control-plane/generated/admin-operations.ts`)

The customer installer image (`ADMIN_LOCAL_SERVER_IMAGE`) follows the separate
immutable customer-install manifest; it may lag this working-candidate contract.
Scheduled live certification uses that image's `ADMIN_LOCAL_SERVER_SHA`, verified
against the running container's OCI revision, for its remote roster fetch. It
never labels the older installed binary with this newer compatibility SHA.

## Status: vendored

The roster is present at the pinned working-candidate commit and is copied
byte-for-byte from that commit. Its embedded `serverSha` records the server's
roster-generation input; it is preserved as upstream metadata rather than
rewritten to the fetch commit.

The offline catalog-parity test can now compare advertised tools with this
roster. This does not establish live transport, authorization, durable audit,
or release-candidate qualification.

## Refreshing

When the pinned server commit advances (the `ADMIN_RELEASE_SERVER_SHA`
constant), update **Server commit** above to the same sha and run:

```sh
node mcp/scripts/sync-mcp-roster.mjs --write
```

It copies the roster at that commit into this directory, or reports that it is
still blocked. Do not hand-edit the vendored roster. The unit test fails if the
commit above and `ADMIN_RELEASE_SERVER_SHA` disagree.
