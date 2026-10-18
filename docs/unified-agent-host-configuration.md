---
type: reference
title: Unified agent host configuration
description: Configure the optional private DevOps adapter behind the public Honua agent connection.
---

# Unified agent host configuration

This reference describes the implementation preview tracked in
[the unified agent epic](https://github.com/honua-io/honua-server/issues/6297).
It requires a server build with the workspace authorization endpoints and a
connector build containing the private adapter. The currently advertised local
server image must not be assumed to contain those changes. Local Docker setup
without this optional integration remains available through the same connector.

## Optional DevOps adapter

Set `HONUA_AGENT_DEVOPS_CONFIG` in the connector host environment to an absolute
path to a protected JSON file. On Unix the file must have no group/other access
(for example mode `0600`); it must be a regular file no larger than 64 KiB. The
host chooses executable paths and configuration. Model tool arguments cannot
choose those paths or replace the connection credential.

The file has these fields:

| Field | Contract |
| --- | --- |
| `serverTargetId` | The actual deployment identity returned by authenticated `GET /api/v1/agent/target`. This differs from the connector's credential-bound connection ID. |
| `deployTargetId` | An existing ECS target in the server's deployment registry. |
| `environment` | That target's exact environment. |
| `command` | Absolute path to the installed private DevOps executable. |
| `args` | Optional argument array; a native DevOps executable uses `--mcp`. |
| `cwd` | Optional absolute working directory selected by the host. |
| `env` | Optional private subprocess environment; keep this file outside Git and model context. |
| `provisioningScope` | Required to expose provisioning: `environment`, `region`, `namePrefix`, and nonempty `allowedImages`. Its environment must equal the top-level environment. |
| `fixedArguments` | Per-tool host bindings. Install handoff requires fixed `baseUrl`, `adminKeySecretRef`, and `outputDirectory`; verification requires its fixed configuration path. Discover the actual installed tool schema. |

The connector replaces any child Honua API URL/key with the current scoped agent
connection and pins its deployment target, allowed environment and ECS profile.
It does not borrow a separately configured human/admin key. Each discovery or
tool call checks the current credential and asks the server to authorize the
actual target, environment and effective arguments. Status/proposal reads also
check the stored operation's target and tenant. Credential rotation requires an
explicit connector restart.

Private tools appear as `honua_agent_devops_*` through the existing registration.
A missing or unauthorized optional adapter does not prevent public server tools
from working. Calls do not automatically replay after a subprocess disconnect;
reconcile the recorded operation before retrying a mutation.

The DevOps executable still enforces its own exact-plan, audit, execution-tier,
secret-reference and approval requirements. Configure those through its own
operator documentation. Exposing a tool does not grant cloud permission, approve
a plan, or certify ECS deployment recovery. Lambda and EKS are outside this
adapter's qualified scope.

## Native Console chat

The preview executable `honua-agent-gateway` exposes the same composed gateway
over a backend HTTP transport. External agents keep their existing
`honua-agent-mcp` registration. Console sends native chat requests through its
authenticated backend; the browser never connects to this transport directly.

On the gateway host, configure `HONUA_AGENT_INSTALL_DIRECTORY` and an independent
`HONUA_AGENT_GATEWAY_KEY` of at least 32 bytes. The gateway reads the verified
workspace agent credential from the installation. It also reads the optional
`HONUA_AGENT_DEVOPS_CONFIG` described above. Its default listen address is
`127.0.0.1:7863`; `HONUA_AGENT_GATEWAY_HOST` and `HONUA_AGENT_GATEWAY_PORT` are
explicit host settings. For a containerized Console, provide a reachable private
network address; container loopback does not reach a host process.

Configure Console's backend with both `HONUA_AGENT_GATEWAY_URL` (the gateway's
base URL) and the same independent `HONUA_AGENT_GATEWAY_KEY`. A partial
configuration is rejected. With neither setting, Console uses the canonical
server directly and does not discover the optional private adapter. These
settings are host configuration, not chat arguments or browser credentials.

For an agent-driven preview install, the existing gateway host can also supply
the optional installer settings below, alongside all four required preview
artifact/executable settings in the [local preview reference](local-agent-workspace-preview.md).

| Host setting | Installer configuration |
| --- | --- |
| `HONUA_AGENT_PREVIEW_MODEL_KIND` | `openai`, `anthropic`, or `bedrock`; requires `MODEL_NAME`. |
| `HONUA_AGENT_PREVIEW_MODEL_NAME` | Model identifier accepted by the configured provider. |
| `HONUA_AGENT_PREVIEW_MODEL_ENDPOINT` | Provider endpoint; required for OpenAI/Anthropic, optional for Bedrock. |
| `HONUA_AGENT_PREVIEW_MODEL_REGION` | Optional provider region. |
| `HONUA_AGENT_PREVIEW_MODEL_KEY_ENV` | Name of a protected host environment variable containing the model credential. |
| `HONUA_AGENT_PREVIEW_GATEWAY_HTTP_URL` | Private gateway origin reachable from the Console container. |
| `HONUA_AGENT_PREVIEW_GATEWAY_HTTP_KEY_ENV` | Name of a protected host environment variable containing the independent bridge credential; required with the HTTP URL. |
| `HONUA_AGENT_PREVIEW_GP_WORKSPACE_URL` | Private local-process daemon origin reachable from the server container; requires `GP_WORKSPACE_KEY_ENV`. |
| `HONUA_AGENT_PREVIEW_GP_WORKSPACE_KEY_ENV` | Name of a protected host environment variable containing an independent local-process service credential. |

All names in the table include the `HONUA_AGENT_PREVIEW_` prefix. Partial model
or gateway settings fail rather than silently enabling a different setup. The
installer resolves credential references into protected configuration; never
paste their values into a prompt. Bedrock still requires an explicit AWS
credential chain available to the server container. A host AWS login alone
does not configure container credentials. The HTTP gateway must be started by
the host using its configured private address and the same bridge credential.

For local Python/.NET process editing, configure the daemon separately with
`HONUA_GP_WORKSPACE_KEY` and an explicit private bind address and allowed Host.
The installer accepts `host.docker.internal`, private IPv4 addresses, or IPv6
unique-local addresses for this daemon. It adds Docker's host-gateway mapping;
`localhost` would address the server container and is rejected. The daemon must
actually listen on the chosen reachable interface. These settings configure the
connection; they do not start the daemon or qualify a sandbox image.

The CLI equivalents are `--native-gp-workspace-url` and
`--native-gp-workspace-key-env`. The installer resolves the credential reference
into the protected installation environment and passes it only to the server as
`HONUA_GP_WORKSPACE_KEY`, alongside `LocalProcesses__WorkspaceUrl`. Console and
model tool arguments never receive it. Use a separate value from the model,
gateway, human and agent credentials. Removing this optional configuration on
reinstall clears its managed URL and credential.

The server verifies the current caller, workspace membership, captured turn and
process grant before forwarding trusted identity assertions to the daemon.
Human binding/revocation remains separate from agent source edits and immutable
process runs. The service credential authenticates this private hop; it does not
replace per-request RBAC or grant an agent ownership of a project.

The HTTP gateway provides `/mcp` and `/capabilities`. Every request verifies the
current scoped agent key and rereads the captured workspace turn on the actual
server. Sessions are pinned to the operator partition, workspace, target and
credential; concurrent turns retain their own context. The gateway disables
local bootstrap tools on this transport. Private DevOps tools are advertised to
native chat only after authorized discovery, and each call rechecks RBAC. The
capability response cannot grant permission or approve an operation.

## Evidence boundaries

The connector's packaged workflow resource is available at
`honua://agent/knowledge/workflows/v1`, including before local installation. It
teaches workflow intent, references, preconditions and recovery rules. It is not
a second executor or an authorization document.

Gateway/runtime tests cover discovery, routing and failure behavior. Host
configuration tests cover credential and target binding. A real published
private process has also been exercised for discovery and planning. Those
checks do not replace the full native chat, GitHub or ECS deployment/recovery
qualification required by the epic.
