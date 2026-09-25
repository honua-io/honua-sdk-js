# Zero-to-map 2026.1 release journey

The September 9 release decision on #1401 narrows first-cut qualification.
This older journey still exercises the broader Admin/analysis and multi-family
Studio integration. Its roster is not the bounded 2026.1 setup gate. Use the
[pinned setup catalog check](../../certification/setup-parity.md) for that
gate's HTTP/stdio discovery evidence; retain separate install and style/render
execution receipts. Full Admin MCP and broader analysis qualification remain
outside the bounded first-cut dependency chain.

This bundle is the executable contract for `honua-release#123` D9.3: install
Honua, configure and publish deterministic data with the closed admin roster,
buffer the published parcels with `honua_validate_plan` then
`honua_execute_plan` (`analytics.buffer-aggregate`), prove `geometry.buffer`
through the SDK GPServer runner, compose distinct map, app, and dashboard
packages in Studio, save each as an immutable version, and publish that saved
version. An admin `honua_studio_propose_publication` returns `shareUrl` with
`humanConfirmationRequired: false`. The same session fetches each share URL and
requires HTTP 200. It does not import a Console receipt and it does not require
a second principal. The buffer job is polled through `honua://jobs/{jobId}` to
terminal success, and `artifacts[].artifactId` is read from
`honua://jobs/{jobId}/results`; a queued submission alone cannot pass.

The driver reuses `honua admin install` and `honua-mcp-proxy`. It does not ship
a second installer, admin client, or MCP transport. The installer is the
canonical credential-issuance boundary: material is handed directly to its
private environment/MCP configuration files, while its JSON receipt contains
only the credential ID, requested/effective grants, active status, and a digest
of the file reference.

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
it at the remote MCP endpoint. Set `HONUA_MCP_AUTH_TOKEN` separately when
the deployment requires bearer authentication; do not put credentials in the
journey plan or a release receipt.
Credential-bearing proxy and live-journey endpoints require HTTPS, except for
exact loopback HTTP used by the bounded local-Docker profile. User information,
query parameters, fragments, cross-origin redirects, and any catalog that is not
exactly the enabled-profile roster fail closed before the first mutation.

## Run a live candidate

Prerequisites:

- Node.js 20.19 or newer and Docker with Compose
- the 2026.1 `honua` CLI work from `honua-sdk-js#1370-#1373`
- one admin credential. The journey does not require a second principal
- a server build that advertises the closed operator roster this journey calls:
  `honua_admin_connections_create`, `honua_admin_connections_test`,
  `honua_admin_import_upload_url`, `honua_admin_layer_publish`,
  `honua_admin_services_access_policy_set`, `honua_admin_server_status`,
  `honua_admin_api_key_list`, `honua_admin_api_key_effective_permissions`,
  `honua_validate_plan`, `honua_execute_plan`, and the Studio lifecycle tools
  including `honua_studio_save_version`, `honua_studio_get_version`,
  `honua_studio_reopen_version`, and `honua_studio_propose_publication`.
  It does not require a 432- or 441-tool catalog, and it does not require the
  `analysis` or `esri-gp` profiles. `honua_esri_gp_*` and `honua_buffer_features`
  are not called
- the `geoprocessing/Buffer` GPServer task seeded for the separate
  `geometry.buffer` proof. That task takes WKB and has no `layerId`
- these fixtures available to the server at an HTTP(S) base URL

Serve the checked-in fixtures from a URL reachable by the Honua container, for
example with an existing static-file server. Then run:

```sh
npm run release:zero-to-map -- \
  --execute --yes \
  --target local-docker \
  --mcp-url http://localhost:8080/mcp \
  --var fixtureBaseUrl=http://host.docker.internal:4173 \
  --var dbSecretReference=env:HONUA_ZERO_TO_MAP_DB_CONNECTION \
  --var dbSecretType=environment \
  --var candidateId=manifest-sha256:<platform-manifest-sha256> \
  --var releaseId=2026.1 \
  --checkpoint ./zero-to-map.checkpoint.json \
  --output ./zero-to-map-live-receipt.json
```

`dbSecretReference` is a request-supplied secret reference: the journey sends
it to the server, and the server resolves it from its own environment. The
server the journey runs against must therefore both define that variable (the
fixture database connection string) and permit it in its allowlist for
request-supplied secret references (honua-server #5055), which is
deny-by-default. Permit exactly this one name rather than a prefix, in the
server's environment:

```sh
Security__RequestSecretReferences__AllowedEnvironmentVariables__0=HONUA_ZERO_TO_MAP_DB_CONNECTION
```

Without that entry the `create-connection` action in stage 2 is refused before
any connection is stored. Server images that predate the setting ignore the
variable. `honua admin install local` does not write either variable into the
compose file it generates, so add both to the `honua` service's environment (or
start an equivalent server yourself) before running with `--execute`. If you
pass a different `--var dbSecretReference=env:<NAME>`, permit `<NAME>` instead.

The live run does not pause for a Console receipt. An admin publish returns
`shareUrl` (`/api/v1/studio/published` plus the route) with
`humanConfirmationRequired: false`, and the journey fetches that URL. A
root-relative share path is resolved against the MCP endpoint origin. HTTP is
accepted only for a loopback origin; any other share URL must be HTTPS and must
not embed credentials. One admin credential performs configuration, publication,
and the fetch.

For a deployment already provisioned by the DevOps ECS producer, use
`--target aws-ecs --provision-receipt <pre-teardown-binding.json>`. The binding
must match `contracts/aws-ecs-provision-binding.schema.json`, the candidate and
release variables, and `--mcp-url=<binding.endpoint>/mcp`. Stage 1 then records
the real image/digest, Terraform, readiness, and a secret-free access receipt
whose reference digest is verified against the producer's Secrets Manager ARN;
it does not invoke or pretend to invoke the Docker installer.

The catalog is checked before the first MCP call. The preflight selects
`tools/list` view `full` and asserts the closed roster: every tool this journey
calls, by name, with the stage and action that needs it. It does not require
432 or 441 tools and it does not require the `analysis` or `esri-gp` profiles.
Extra advertised tools are not a failure. A duplicate name or an input schema
that rejects a planned argument blocks the run without sending that call.
Default-profile certification (`certifyAdminCatalogParity`) is a separate gate
and is not this journey's roster.

The connection is
created with `secretReference` + `secretType`; raw database credentials never
enter MCP arguments, checkpoints, or receipts. One-time-secret and session-bound
operations (including API-key issuance) are deliberately absent from MCP and
must be handled by the install/control-plane credential boundary. The journey
then exercises only secret-safe API-key list and effective-permissions tools to
verify the provisioned identity and its exact grants. Admin operations
must return a completed PublishedOperation; queued or approval-required handles
produce explicit blocked receipts. The driver reads connection/layer IDs only
from `structuredContent.details.response`, the server's PublishedOperation
endpoint-response seam.

The Studio version tools are also preflighted before the first server mutation.
Map, app, and dashboard each exercise layer, style, view, widget, and control
mutations before validation; family-specific shortcuts or embedded lookalikes
cannot satisfy the release roster.
The journey does not treat `honua_studio_get_draft` as reopen evidence. Save
captures read `/structuredContent/version/versionId`,
`/structuredContent/version/contentHash`, and `versionNumber` under `version`.
`honua_studio_get_version` still returns top-level `versionId` and `contentHash`.
Publication runs after that save. `honua_studio_propose_publication` takes
`itemId`, `versionId`, `contentHash`, `route`, `visibility`, and `note`. It does
not take `draftId`, `generation`, or `embed`. For this admin journey the result
has `humanConfirmationRequired: false` and a `shareUrl`. The journey fetches
each share URL and requires HTTP 200. It does not forbid `shareUrl` and it does
not wait for a second principal.

## Evidence status

The fixtures, plan, contracts, and simulated end-to-end tests are deterministic.
They are not a live release recording. Contract mode stays `blocked` and does
not start Docker. A live pass is the same admin session reaching HTTP 200 on
the three share URLs.
