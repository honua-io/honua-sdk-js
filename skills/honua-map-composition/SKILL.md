---
name: honua-map-composition
description: Use when composing a bounded 2D Honua map through Studio MCP tools — creating a draft, adding layers/style/view/basic controls, saving and reopening an immutable version, and proposing publication for a separate human approver. Covers 2026.1 zero-to-map stages studio and proposal.
release: "2026.1"
stages: [studio, proposal]
---

# Compose a 2D map, save/reopen, and propose publication

The bounded 2026.1 release journey requires one `map` artifact with published
layers, style, view, and basic controls. The broader repository integration
bundle also exercises `app` and `dashboard`; those are distinct artifacts and
are outside this release qualification. See `docs/zero-to-map-release-journey.md`
for the release-owned deterministic driver and model-canary boundaries.

## The draft loop

Every call after `create` carries `draftId` **and** `generation`. `generation`
is optimistic concurrency: pass the value returned by the previous call. A
stale `generation` is a conflict, not a retryable error — re-read the draft.

```
honua_studio_create_draft   { packageKey, family: "map", schemaVersion, body }
honua_studio_add_layer      { draftId, generation, layer: { id, sourceId, type, title, visible } }
honua_studio_set_layer_style      { draftId, generation, layerId, styleRef }
honua_studio_set_layer_visibility { draftId, generation, layerId, visible }
honua_studio_set_view       { draftId, generation, view: { bbox, crs } }
honua_studio_add_widget     { draftId, generation, widget:  { id, kind, title, sourceId, config } }
honua_studio_add_control    { draftId, generation, control: { id, kind, title, sourceId } }
honua_studio_bind_interaction { draftId, generation, ... }
honua_studio_validate_draft { draftId, generation }
```

`sourceId` addressing — get this right or the layer renders empty:

- A published layer is `honua://services/<serviceName>/layers/<layerId>`
  (from `honua-publish-layers`).
- A retained geoprocessing result is `honua://artifacts/<artifactId>`
  (from `honua-geoprocessing`, after joining the job to its result package).

`body` on `create_draft` is the family's package projection and is gated by its
`format` constant — `honua_map_package.v1` for maps,
`honua_generated_app_manifest.v1` for dashboards. A loader refuses any other
value. The full family table is in `docs/studio-package-contracts.md`.

## From the terminal

`honua_studio_create_draft` and `honua_studio_validate_draft` are MCP tools.
The `honua` CLI has no `studio` command. The same two calls over HTTP, with
`HONUA_ADMIN_KEY` set and never printed, are:

- create: `POST /api/v1/studio/package-drafts`
- validate: `POST /api/v1/studio/package-drafts/{draftId}/validate`

`honua_studio_add_layer` has no separate route. Put the layer in the draft
body. A published layer's `sourceId` is
`honua://services/<serviceName>/layers/<layerId>`.

Use the candidate's discovered input schema and the map package contract in
`docs/studio-package-contracts.md`. Retain a real validation result; do not
add guessed loader fields or substitute an app/dashboard body. Widgets and
cross-widget interactions belong to the broader composition surface and are
not additional requirements for this bounded map.

## Validate, save, read, reopen

```
honua_studio_validate_draft  → unified validation envelope; read it, do not skip it
honua_studio_save_version    { draftId, generation, changeNote }  → immutable content version
honua_studio_get_version     → read back the exact version you saved
honua_studio_reopen_version  → a NEW draft from that immutable version
```

Saved versions are immutable. Editing after a save means `reopen_version` and
then working on the new draft id/generation it returns — never mutating the
saved version in place. Always `get_version` after `save_version`: that
round-trip is what proves the save actually persisted what you composed.

## Publish the saved version

Save first. `honua_studio_save_version` nests `versionId`, `contentHash`, and
`versionNumber` under `version`. `honua_studio_get_version` still returns
top-level `versionId` and `contentHash`. Then propose that exact version:

```
honua_studio_propose_publication
{ itemId, versionId, contentHash, route: "<route>", visibility: "public", note: "<why>" }
```

Do not send `draftId`, `generation`, or `embed`.

The release-qualified path must retain a durable proposal in `AwaitingApproval`
(or its documented pending equivalent), bound to the saved item, version, and
content hash. Use the candidate's supported proposer role and policy. An
immediate admin publication with `humanConfirmationRequired: false` may be a
supported general operation, but it does not prove this governed journey. If
that is all the candidate supports, report the missing approval boundary.
Never invent a proposal, approval ID, or a second principal.

A separate human with the required approval authority reviews the actual
proposal and runs the typed CLI under their own authenticated profile:

```bash
(
  unset HONUA_ADMIN_KEY HONUA_API_KEY HONUA_BEARER_TOKEN HONUA_BASE_URL
  honua admin operate approveOperationProposal --path id=<proposal-id> --profile approver --yes
  honua admin operate getOperationProposal --path id=<proposal-id> --profile approver --json
)
```

Approval takes no request body. The profile name alone does not change identity:
configure it with the approver's own credential and target base URL. The subshell
clears the environment credentials and base URL that would override the profile. API keys need full admin or `admin:approve`; operator bearers need
RBAC approval authority. Do not mint, reuse, or impersonate that human credential
from the proposing agent session. `--yes` permits the CLI mutation; it does not
establish separate human approval.

A separation-of-duties control must use a proposer that independently has
approval authority, under a supported qualification policy that still requires
review. Retain that effective authority, require HTTP 403 with
`Separation of duties: the requester of a proposal cannot approve it.`, and
verify that the same proposal remains pending with unchanged state. The default
local key lacks `admin:approve`; its generic refusal proves limited permissions,
not separation of duties. If an approval-capable proposer cannot be established,
retain that control as blocked instead of claiming a pass.

After actual human approval, poll the authoritative
proposal to terminal success and retain the server-issued approval identity,
requester/resolver identities, and operation/audit/correlation joins. Read the
final published map and compare its item, version, hash, and content with the
saved map. An HTTP 200 or share URL alone does not prove approved publication.
Until the human acts, report `AwaitingApproval`, not a completed journey.

This is the SDK's documented agent-safety boundary: proposals and approval are
separate, and receipts record what actually ran. See `docs/agent-safety.md`.

## Real-time and collaboration

If several people edit a saved map at once, the collaboration envelope,
reconnect semantics, and event shapes are in
`docs/saved-map-collaboration.md`. Do not invent your own merge behavior on top
of `generation`.

## Verify

- `docs/studio-package-contracts.md` — families, format constants, validation
  envelope, publish/share/embed contracts.
- `docs/agent-safety.md` — the plan/approval/receipt boundary.
- `docs/saved-map-collaboration.md` — concurrent editing.
- `mcp/release/zero-to-map/journey.v1.json` — stages `studio` and `proposal`.
