---
type: guide
title: Unified agent workflows
description: Evaluate, publish and operate GIS resources through one persistent Honua agent connection, preserving canonical resource evidence and human approvals.
---

# Unified agent workflows

The connector ships semantic workflow knowledge as `honua.agent-workflow-knowledge/v1`,
knowledge version `2026-10-17.1`, resource `honua://agent/knowledge/workflows/v1`.
The packaged module is `mcp/src/agent/workflow-knowledge.ts`; its preconditions,
canonical actions, resource references and observed outcomes apply equally to an
external agent and a native conversation. This is guidance, not an execution
language or a claim of live qualification. Discover the connected target's actual
tool schemas before acting; missing capabilities remain unsupported.

Start by inspecting local Docker, install after explicit authorization, and attach
the verified target through the same persistent registration. Complete separate
human pairing before a human action is required. Keep bootstrap credentials in
the host transport. Persist target, resource, command and operation references;
resume from canonical records after a new chat or restart. A lost response requires
reconciliation before retrying a mutation.

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
state. Lambda/EKS are unsupported until real adapters and execution proof exist.

See [MCP integration](mcp-server.md), [Studio versioning](studio-package-contracts.md), and
[agent execution](agent-safety.md) for the connected contract details.
