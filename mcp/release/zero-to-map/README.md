# Zero-to-map 2026.1 release journey

This bundle is the executable contract for `honua-release#123` D9.3: install
Honua, configure and publish deterministic data with AI-accessible admin tools,
run Buffer through the AI-facing Esri MCP tool, the SDK's Esri GPServer
compatibility path, and the MCP-native analysis verb, compose distinct map,
app, and dashboard packages in Studio, save each as an immutable version, read
that exact version, reopen it as a new draft, record three publication intents,
and save three new intent-bearing versions. It then stops at the human Console
gate before verifying the three approved public URLs. Both MCP
jobs are polled through `honua://jobs/{id}` and joined to their
`honua://jobs/{id}/results` packages; a queued submission alone cannot pass.

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
query parameters, fragments, cross-origin redirects, and catalogs other than
the exact 432-tool default roster fail closed before the first mutation.

## Run a live candidate

Prerequisites:

- Node.js 20.19 or newer and Docker with Compose
- the 2026.1 `honua` CLI work from `honua-sdk-js#1370-#1373`
- a server build exposing the complete default 432-tool roster (47 static plus
  385 `honua_admin_*` tools), with all eleven secret/session Admin operations
  absent, plus the three
  `honua_esri_gp_*` tools, `honua_buffer_features`, and the Studio lifecycle
  tools including `honua_studio_save_version`, `honua_studio_get_version`, and
  `honua_studio_reopen_version`
- the `geoprocessing/Buffer` GPServer task seeded by the deployment
- these fixtures available to the server at an HTTP(S) base URL
- a writable checkpoint path; the first pass emits the exact resolved Console
  receipt request after all pre-approval work completes

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

The first pass exits `2` with `external-receipt-missing`. It has already run
stages 1-5 exactly once. Give the checkpoint's resolved
`consoleReceiptRequest` to the Console producer, carry
`checkpoint.integrity.digest` outside that file, and resume with the same
command plus:

```sh
  --checkpoint-digest <checkpoint.integrity.digest> \
  --console-receipt ./console-approval.json
```

The resume atomically claims the checkpoint before any adapter work. A second
or concurrent claimant fails closed. The checkpoint is bound to the exact plan
bytes, SDK source SHA (`HONUA_SOURCE_REVISION`), target, MCP endpoint,
candidate/release, and (for AWS) provisioning receipt; it contains only
allowlisted captures/evidence, including the non-secret deterministic
`serviceName` identity and access-credential ID/grants/reference digest required
by external producers, and never the database password, admin key, token, or
authorization material. A successful resume
marks it consumed and binds the final receipt hash.

For a deployment already provisioned by the DevOps ECS producer, use
`--target aws-ecs --provision-receipt <pre-teardown-binding.json>`. The binding
must match `contracts/aws-ecs-provision-binding.schema.json`, the candidate and
release variables, and `--mcp-url=<binding.endpoint>/mcp`. Stage 1 then records
the real image/digest, Terraform, readiness, and a secret-free access receipt
whose reference digest is verified against the producer's Secrets Manager ARN;
it does not invoke or pretend to invoke the Docker installer.

The catalog is checked in full before the first MCP call. Missing tools or
input-schema drift block the run without sending that call. The preflight
requires the exact 385-tool Admin roster and at least the 47-tool default static
surface; additive opt-in analysis/Esri tools are allowed. The connection is
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
The journey does not treat `honua_studio_get_draft` as reopen evidence: every
family must capture its `itemId`, immutable `versionId`, `contentHash`, and the
new draft whose `baseVersionId` points back to that exact version. After the
proposal increments that reopened draft's generation, the journey saves a new
immutable publication version. Console must create and publish the request for
that new version, never the earlier pre-intent version.

The Console receipt is accepted only when it is `passed` and binds this
journey/release contract to the exact connection, service, layers, three GP job
identities, result packages/artifacts, map/app/dashboard draft and immutable
version identities, all three reopened drafts and intent-bearing publication
versions, all three Console request/publication/status/public-URL identities,
execution operations, audit correlations, routes, candidate, and release. Each
audit operation must equal its family's execution operation, each proposal ID
must equal its publication request ID, and the app public URL must equal the
top-level share URL. The Studio proposal actions reject any pre-approval
publication ID or public URL and must report both `recorded=true` and
`humanConfirmationRequired=true`. Agent execution never claims the human
publication step. Stage 7 independently requires identity-preserving HTTPS
HTTP 200 responses for map, app, and dashboard URLs.

## Evidence status

The fixtures, plan, contracts, and simulated end-to-end tests are deterministic.
They are not a live release recording. Until all deployment dependencies are
available and an operator supplies a matching Console receipt, the honest
candidate result is `blocked`/`skipped`, not passed.
