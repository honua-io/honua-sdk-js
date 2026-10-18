---
type: reference
title: Local native workspace preview
description: Configure explicit Docker preview artifacts and separate human and agent credentials for the shared Honua workspace.
---

# Local native workspace preview

The manifest-pinned public server and MCP package do not yet prove the native
workspace contract. The default installer remains on its published pins. The
Node installer API accepts an explicit `nativeWorkspace` preview configuration
with `serverImage`, `consoleImage` (both immutable `@sha256` references), a
`releaseId`, an absolute host-selected `gatewayCommand` and optional `gatewayArgs`,
and an optional loopback `consolePort` (default 8081). Supply actual
approved preview artifacts; no preview image names are built into the SDK.

The CLI exposes the same opt-in with `--native-server-image`,
`--native-console-image`, `--native-release-id`, `--native-gateway-command`,
repeatable `--native-gateway-arg`, and optionally `--native-console-port`.
Supply all four artifact/identity/executable flags together. The single MCP
registration uses that qualified executable and only its fixed installation
directory; neither credential material nor an unpublished npm pin is written
into the preview MCP configuration.
`--dry-run` renders the proposed Compose configuration without starting Docker.

For the same preview through an already registered agent gateway, configure the
host with `HONUA_AGENT_PREVIEW_SERVER_IMAGE`, `HONUA_AGENT_PREVIEW_CONSOLE_IMAGE`,
`HONUA_AGENT_PREVIEW_RELEASE_ID`, and `HONUA_AGENT_PREVIEW_GATEWAY_COMMAND`.
Optional `HONUA_AGENT_PREVIEW_GATEWAY_ARGS` is a JSON array of executable
arguments; `HONUA_AGENT_PREVIEW_CONSOLE_PORT` selects the loopback Console port.
These are host configuration, not prompt arguments. A partially supplied preview
configuration is an error. Once installed, the generated single registration
needs only the installation directory to reconnect using its persisted, verified
workspace credential. An incomplete or rejected workspace credential never falls
back to the legacy installer credential.

The installer records a stable deployment identity in its private `.env`, starts
PostGIS, Redis, the selected server and Console, checks the live workspace target,
and issues an independent `honua-local-workspace-agent` key. Its exact grants are
`admin:read`, `admin:write`, `read:*`, and `agent:workspace`. The existing
`honua-local-agent` key retains its existing grants and configuration. The new
key and issued ID are private file values, never result fields. Returned evidence
contains identity, grants, and a reference digest only. Reinstallation verifies
identity and effective grants before reuse; broader, revoked, or incomplete
credentials fail closed.

Server `AgentWorkspace:LocalAgentPrincipalId` uses the canonical actor
`apikey:api-key:<issued UUID>`. Console receives only the separate agent key and
its fixed internal server URL for native transport. It receives no administrator
fallback. The second Compose application recreates the server with this binding.
A failed recreation can be retried from the persisted key without reissuing it.

This setup returns `preview-requires-human-pairing`. A working Console human
session remains required. Preview Compose explicitly enables the Development-only
local human bridge: a separate random bridge secret is shared by server and
Console, while the independent operator-token signing key is supplied only to
the server. Console exchanges its authenticated development cookie for a bounded
human bearer with the server-owned `public` tenant. No bootstrap key or signer
is substituted into agent transport. API keys currently use the configured
default local tenant (`public`); the bridge issues the matching validated claim.
Preview Compose also enables Studio end-user authorization on the server and
the embedded Studio view in Console, so both surfaces use that human session.
Do not infer successful pairing or execution from a healthy Docker container.
The preview release, public gateway artifact, Console sign-in, shared workspace,
canonical approval inbox, and native turn must be qualified together before
advancing public installer pins or calling this release verified. A preview
release change currently requires a separate install directory.
