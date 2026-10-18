# Local native workspace preview

The manifest-pinned public server and MCP package do not yet prove the native
workspace contract. The default installer remains on its published pins. The
Node installer API accepts an explicit `nativeWorkspace` preview configuration
with `serverImage`, `consoleImage` (both immutable `@sha256` references), a
`releaseId`, and an optional loopback `consolePort` (default 8081). Supply actual
approved preview artifacts; no preview image names are built into the SDK.

The CLI exposes the same opt-in with `--native-server-image`,
`--native-console-image`, `--native-release-id`, and optionally
`--native-console-port`. Supply all three artifact/identity flags together.
`--dry-run` renders the proposed Compose configuration without starting Docker.

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
Do not infer successful pairing or execution from a healthy Docker container.
The preview release, public gateway artifact, Console sign-in, shared workspace,
canonical approval inbox, and native turn must be qualified together before
advancing public installer pins or calling this release verified. A preview
release change currently requires a separate install directory.
