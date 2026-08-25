---
name: honua-map-composition
description: Use when composing a Honua map, app, or dashboard through Studio MCP tools and getting it toward publication — creating a draft, adding layers/widgets/controls/interactions, validating, saving an immutable version, reopening it, and recording publication intent without bypassing the human approval gate. Covers 2026.1 zero-to-map stage 4 (studio) and stage 5 (proposal).
release: "2026.1"
stages: [studio, proposal]
---

# Map/dashboard composition, save/reopen, and proposal (stages 4–5)

Three package families are composed the same way and are **distinct artifacts**:
`map`, `app`, and `dashboard`. Composing one does not produce the others — the
journey builds all three separately
(`mcp/release/zero-to-map/journey.v1.json`, stage `studio`).

## The draft loop

Every call after `create` carries `draftId` **and** `generation`. `generation`
is optimistic concurrency: pass the value returned by the previous call. A
stale `generation` is a conflict, not a retryable error — re-read the draft.

```
honua_studio_create_draft   { packageKey, family: "map" | "app" | "dashboard", schemaVersion, body }
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

Widgets and controls bind to a layer by `sourceId`; `honua_studio_bind_interaction`
is what makes a chart selection drive the map. A dashboard with an unbound chart
is a screenshot, not a dashboard.

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

## Publication intent is not publication

Stage `proposal` records intent and structurally requires human confirmation:

```
honua_studio_propose_publication
{ draftId, generation, route: "<route>", visibility: "public", embed: true, note: "<why>" }

honua_studio_save_version
{ draftId, generation, changeNote: "<publication intent>" }
```

The hard rules:

- The propose response **does not** return `publicationId`, `publicUrl`, or
  `shareUrl` — the journey declares those as forbidden pointers. If you find
  yourself constructing a public URL, you have skipped the gate.
- A Studio `PublicationIntent` is *not* the admin approval proposal, and not
  Console approval. Do not describe it as "published".
- `visibility: "public"` is a human decision. Ask; do not infer it.
- An agent never self-approves. Approval happens in Console (stage `console`),
  and only then does the stable URL exist for stage `artifact` to verify.
- The intent must be saved as a version to be governed — propose then save.

This boundary is the SDK's documented agent-safety posture: plans are proposed,
signed, and approved out of band, and receipts record what actually ran. See
`docs/agent-safety.md`.

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
