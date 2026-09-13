# Windows candidate Studio discovery diagnostic

The 2026.1 terminal Admin/SDK/MCP promise includes composing and saving a 2D
map through the server-authored catalog. This diagnostic does **not** qualify
that complete release promise. The retained JSON has status `failed`.

The release platform manifest selected server source
`7ba422672e0c751843b17beb36e954a019cc19fb` and image
`ghcr.io/honua-io/honua-server@sha256:dd50cd81c057e37e73a6144572abdfc90d48de314d7625c54c4ef3b6eb65b0fd`.
The image was run with authentication enabled using native Windows Docker
Desktop, fresh PostgreSQL/PostGIS and Redis containers, and a random admin key.
The receipt records the manifest hash, running image identity, source SDK SHA,
full descriptors, projected definitions, and assertions. Containers are removed
after the run. No model request or installed-client certification is claimed.

Before this fix, a default SDK-created Studio session initialized the server's
default view, which advertised 12 general tools and no classified Studio tools.
The session now negotiates `setup` through initialize `_meta`, including after
reconnect. A generic McpClient still uses the server default unless its caller
selects a workflow view. Neither path introduces a routing name allowlist.

The live setup view advertises 20 tools, of which only three are classified as
Studio composition members: create draft, validate draft, and propose publication.
The default SDK policy discovers all three and preserves their actual annotations
and output schemas in its proxy projection. A valid MapPackage fixture is created
and independently validated. Assertions compare literal input expectations for
longitude/latitude ordering, zoom, CRS, feature identity, name, null elevation,
and package format. This is an identity roundtrip, not evidence of mutation or
geoprocessing execution; raster nodata does not apply to this vector fixture.

The next assertion fails because `honua_studio_add_layer`,
`honua_studio_set_view`, and `honua_studio_get_draft` are absent from the
discovered set. These recipe requirements are diagnostic assertions, never
SDK routing credentials. Save/reopen/status and the complete lifecycle have
not been exercised through this catalog.

Acceptance disposition for issue 1397:

| Criterion | Evidence / outstanding work |
| --- | --- |
| Candidate classification and default discovery | Pass for the actual candidate's three classified members, including default-session reconnect. |
| Annotations/output schemas reach model | Live SDK projection matches descriptors; downstream model delivery remains unproven. No terminal model endpoint/name is configured for this lane. |
| Real push/listChanged | Existing transport regression tests pass; no live catalog-change push was induced in this diagnostic. |
| Full 2D lifecycle | Blocked by the candidate setup catalog's missing mutation/read tools. Valid create/validate alone does not meet this criterion. |
| Add/remove server member | Not proven by reconnecting an unchanged catalog; requires a candidate catalog mutation fixture. |
| Real RBAC negatives | Not proven by the admin-key diagnostic; requires distinct authenticated principals and negative discovery/invocation replay. |
| Browser reuse | honua-studio main at `c7193a8efc34838dda8babdc10267d5e3687e9ea` still exports `STATIC_STUDIO_AGENT_TOOLS` in `src/chat/studio-agent-tools.ts`; deletion and compilation remain outstanding in that repository. |

Reproduce after `npm ci` and `npm run build`:

```powershell
node scripts/qualify-studio-discovery.mjs <path-to-release-platform-manifest.yaml>
```

The command exits 1 on the pinned candidate and retains the failed receipt.
The focused classification/session/listChanged regression suite passes 78 tests;
the new negotiation regression first failed with an empty discovered set before
the fix. These deterministic tests do not substitute for the outstanding live
qualification criteria.
