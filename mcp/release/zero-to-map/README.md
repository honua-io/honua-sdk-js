# Zero-to-map 2026.1 release journey

This bundle is the executable contract for `honua-release#123` D9.3: install
Honua, configure and publish deterministic data with AI-accessible admin tools,
run Buffer through the AI-facing Esri MCP tool, the SDK's Esri GPServer
compatibility path, and the MCP-native analysis verb, compose distinct map,
app, and dashboard packages in Studio, save each as an immutable version, read
that exact version, reopen it as a new draft, then stop at the human Console
gate before verifying the approved URL. Both MCP
jobs are polled through `honua://jobs/{id}` and joined to their
`honua://jobs/{id}/results` packages; a queued submission alone cannot pass.

The driver reuses `honua admin install` and `honua-mcp-proxy`. It does not ship
a second installer, admin client, or MCP transport.

## Inspect the contract without changing anything

From the `mcp` package directory:

```sh
npm run release:zero-to-map -- --output zero-to-map-contract-receipt.json
```

Contract mode never invokes Docker, CLI, MCP, GPServer, Console, or HTTP. Its
receipt is intentionally `blocked`, with the first live action blocked and all
later actions skipped. Static issue references remain under `dependencyRefs`;
they are never reported as runtime blockers on a passed live receipt.

## Configure an MCP client

The `configs` directory contains equivalent examples for Claude Desktop,
Claude Code, and Cursor. Each launches the existing `honua-mcp-proxy` and points
it at the remote HTTP MCP endpoint. Set `HONUA_MCP_AUTH_TOKEN` separately when
the deployment requires bearer authentication; do not put credentials in the
journey plan or a release receipt.

## Run a live candidate

Prerequisites:

- Node.js 20.19 or newer and Docker with Compose
- the 2026.1 `honua` CLI work from `honua-sdk-js#1370-#1373`
- a server build exposing the 119 `honua_admin_*` tools, the three
  `honua_esri_gp_*` tools, `honua_buffer_features`, and the Studio lifecycle
  tools including `honua_studio_save_version`, `honua_studio_get_version`, and
  `honua_studio_reopen_version`
- the `geoprocessing/Buffer` GPServer task seeded by the deployment
- these fixtures available to the server at an HTTP(S) base URL
- a separately captured Console approval receipt matching
  `contracts/console-receipt.schema.json`

Serve the checked-in fixtures from a URL reachable by the Honua container, for
example with an existing static-file server. Then run:

```sh
npm run release:zero-to-map -- \
  --execute --yes \
  --mcp-url http://localhost:8080/mcp \
  --var fixtureBaseUrl=http://host.docker.internal:4173 \
  --var dbPassword=replace-with-local-password \
  --console-receipt ./console-approval.json \
  --output ./zero-to-map-live-receipt.json
```

The catalog is checked in full before the first MCP call. Missing tools or
input-schema drift block the run without sending that call. Admin operations
must return a completed PublishedOperation; queued or approval-required handles
produce explicit blocked receipts. The driver reads connection/layer IDs only
from `structuredContent.details.response`, the server's PublishedOperation
endpoint-response seam.

The Studio version tools are also preflighted before the first server mutation.
The journey does not treat `honua_studio_get_draft` as reopen evidence: every
family must capture its `itemId`, immutable `versionId`, `contentHash`, and the
new draft whose `baseVersionId` points back to that exact version.

The Console receipt is accepted only when it is `passed` and binds this
journey/release contract to the exact connection, service, layers, three GP job
identities, result packages/artifacts, map/app/dashboard draft and immutable
version identities, the reopened app draft proposed for publication, proposal,
execution operation, audit correlation, route, candidate, and release. Its audit operation must be
the proposal's execution operation. The Studio proposal action itself only
records `PublicationIntent` and must report both `recorded=true` and
`humanConfirmationRequired=true`; the separately supplied `proposalId` is the
real admin approval proposal inspected by Console and `honua admin`. Agent
execution never claims the human publication step.

## Evidence status

The fixtures, plan, contracts, and simulated end-to-end tests are deterministic.
They are not a live release recording. Until all deployment dependencies are
available and an operator supplies a matching Console receipt, the honest
candidate result is `blocked`/`skipped`, not passed.
