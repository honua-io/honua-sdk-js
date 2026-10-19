---
type: guide
title: Unified agent workflows
description: Evaluate, publish and operate GIS resources through one persistent Honua agent connection, preserving canonical resource evidence and human approvals.
---

# Unified agent workflows

The connector ships semantic workflow knowledge as `honua.agent-workflow-knowledge/v1`,
knowledge version `2026-10-19.1`, resource `honua://agent/knowledge/workflows/v1`.
The canonical source is `src/studio-agent/workflow-knowledge.ts`; the MCP module
is generated from it with `node scripts/sync-workflow-knowledge.mjs --write`.
External MCP clients read the resource. SDK conversation hosts can opt into the
same versioned preconditions, canonical actions, resource references and observed
outcomes with the `workflowKnowledge` session option. Its packaged data is also
exported from `@honua/sdk-js/studio-agent`. The option adds guidance to each turn's
fresh host system context without changing tool discovery or authorization.
Native Console integration requires a matching published SDK and an editor bundle
that enables this option; its current default is not qualified by this SDK change.
This is guidance, not an execution
language or a claim of live qualification. Discover the connected target's actual
tool schemas before acting; missing capabilities remain unsupported.

This guide belongs to the repository's Open Knowledge Format (OKF) bundle: typed
Markdown pages connected by links. The MCP resource is the packaged workflow
guidance for agents; it does not introduce another executable GIS DSL. Use
[local native workspace preview](local-agent-workspace-preview.md) for preview
Docker configuration and [host configuration](unified-agent-host-configuration.md)
for the optional DevOps adapter.

Start by inspecting local Docker, install after explicit authorization, and attach
the verified target through the same persistent registration. Complete separate
human pairing before a human action is required. Keep bootstrap credentials in
the host transport. Persist target, resource, command and operation references;
resume from canonical records after a new chat or restart. A lost response requires
reconciliation before retrying a mutation.

For shared Console/Studio work, use the actual paired workspace and tab/view
references. Discover `honua_workspace_*`, read the current context, and capture
each prompt with its submitted context revision before execution. Keep reading
that immutable turn while the user navigates; a newer selection applies to the
next prompt. An existing publish-layer form can be read and patched by either
the form or the agent using its current revision. Preserve its command identity
and reconcile the canonical command before retrying a submission. Conflicts
require review of current state, not overwriting another tab's changes.

A Studio task refers to its real draft, generation and package key. A built-in
process task refers to an immutable workflow-package id, version and content
hash authorized for this workspace. Local Python/.NET run references remain
separate. Native chat supplies request bindings through the Console backend;
external agents use the explicit workspace tool contracts. A client connection
alone does not supply the browser's current selection or establish human pairing.

For data, validate the source schema and CRS, import/connect, wait for the actual
job outcome, publish a service/layer, and query it. For a map or app, compose and
style against those resource references, validate, save an immutable Studio
version, then read/reopen it before publishing. Preserve unrelated concurrent
edits by reconciling against the current draft revision. A `Published` receipt
permits audience verification; `AwaitingApproval` hands its proposal to the
separate human inbox and does not mean the app is published.

Processes keeps built-in graphs separate from sandboxed Python/.NET development.
Snapshot inputs and code, build/run with bounded resources, inspect sanitized
failure diagnostics, and rerun corrected code as a new immutable snapshot. Import
successful output through the normal artifact/data tools before querying and
mapping it. Syntax validation is not execution evidence.

An optional private DevOps process sits behind this connection. Its existing
ECS exact-plan executor retains its approval and durable audit gates; no public
second registration or replacement executor is needed. The gateway exposes only
allowlisted provisioning/planning tools and rechecks current authorization for
every call. A separate trusted signer approves the exact plan. Never supply
signing keys or cloud credentials to a model. A secretless handoff is unverified
until the canonical verifier produces authenticated evidence.

Git configuration changes are scoped to server-produced metadata release packages,
including Studio version references where supported. Generate and review the
change set; generation alone does not write Git, open a PR, or prove a commit.
The optional host-configured `create_scoped_gitops_pull_request` adapter commits
the scoped diff on a deterministic review branch, opens a PR and records a canonical
server proposal. `revert_scoped_gitops_pull_request` creates a reviewed recovery PR
for a single immutable config-only commit. Both require the exact current base,
durable audit and configured execution tier; neither merges or deploys. Preserve
commit/PR and canonical operation references. The canonical server owns health, version operations, proposals and
recovery; it retains its separate human approval inbox. Do not route approvals
through an agent tool or infer recovery readiness from ECS provisioning support.
Recovery qualification must bind the exact adapter, server artifact, prior and
candidate revisions, protection policy, terminal operation and observed service
state. The host's protected DevOps configuration can select `runtimeKind`
(`aws-ecs`, `aws-lambda`, or `aws-eks`; legacy configurations default to ECS).
Lambda and EKS require the server authorization response to match the selected
runtime and its canonical backend before the gateway exposes operations. EKS
requires the native `honua-kubernetes-deployment` backend. Argo is not a
dependency: the workflow uses standard Kubernetes Deployments, with Honua
approvals, rollout health checks and rollback to a recorded immutable image.
Neither an Argo adapter nor a generic GitOps handoff is interchangeable. The EKS
Terraform infrastructure root does not yet install the Honua application; its
Deployment, Service, route and bound cluster identity need separate verification. These gateway bindings do not establish deployment/recovery
qualification: complete Lambda and EKS journeys remain unqualified.

See [MCP integration](mcp-server.md), [Studio versioning](studio-package-contracts.md), and
[agent execution](agent-safety.md) for the connected contract details.

## Prompts that describe the workflow

Name the intended result, data or resource, target, and what should be verified.
You do not need to translate the request into tool calls:

- **Set up:** "Set up Honua locally in Docker. Check this machine first, then verify the running server and my agent's access."
- **Import and publish:** "Import this parcels file, check its CRS and geometry, publish it as Parcels, and query the result. Ask me for missing source details."
- **Make a map:** "Use Parcels to make a map colored by land use. Show changes live, save a version, reopen it, and publish it when validation succeeds."
- **Build a process:** "Create a process that buffers these roads and intersects the result with Parcels. Run it, show any errors, and add the successful output to my map."
- **Operate:** "Inspect this deployment, propose the supported version update, and send any required approval to my inbox. Verify the deployed version and health afterward."
- **Recover:** "Find the last known-good revision and show the supported recovery plan. Keep the failed attempt's receipts and verify the restored service."

The agent must discover which steps the connected release supports. A missing
executor or unqualified recovery backend is an explicit stopping condition for
that step. An approval request remains pending until the separate human action
occurs. A new conversation should resume from saved resource and operation
references rather than repeat completed mutations.

Operators connecting the private extension can use the deeper
[host configuration reference](unified-agent-host-configuration.md).

### Reading large process catalogs and job results

`honua://catalog/processes` and other JSON resources can span multiple text
windows. A first `resources/read` response can contain incomplete JSON with a
`nextCursor`. Echo that opaque value in the next request's `cursor`, retain the
same URI, and concatenate text for that URI until the cursor is absent before
parsing JSON. The gateway preserves these Honua extensions. `maxChars` optionally
sets the per-request character budget from 1 through 1,000,000; omitting it uses
the Server default of 64,000. Clients must bound page counts and reject repeated
cursors rather than loop indefinitely.

The native SDK exposes the same window contract through
`McpClient.readResource(uri, { cursor, maxChars, signal })`. Its result includes
`nextCursor`; reads do not automatically retry, switch targets or execute jobs.
Single-window `readResource(uri)` calls remain valid.
