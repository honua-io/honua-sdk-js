---
name: honua-style-verify
description: Use when applying a style to a Honua layer or Studio draft and proving the rendered map is actually correct — resolving styles from the server, applying a preset client-side, setting a draft layer's style and visibility, framing the view, and verifying the approved public URL responds. Covers styling in 2026.1 zero-to-map stage 4 (studio) and the URL check in stage 7 (artifact).
release: "2026.1"
stages: [studio, artifact]
---

# Style and rendered-map verification (stages 4 and 7)

Styling is a claim; a rendered, reachable map is the evidence. This skill covers
both halves.

## Resolve a style from the server

`honua_get_style` (`mcp/src/tools/get-style.ts`) reads a server's OGC API –
Styles surface. Pass `styleId` for the canonical `StyleRef` (`style_id`,
`title`, encodings including an inlined MapLibre style); omit it to list what is
available.

On a plain FeatureServer with no styling surface it returns a structured
`{ "available": false, "surface": ..., "reason": ..., "guidance": ... }`
result. That is a *capability* answer, not a failure — do not retry it, and do
not report "no styles found" as if the server had an empty catalog.

## Apply a preset

`honua_apply_style_preset` (`mcp/src/tools/apply-style-preset.ts`) resolves a
preset and returns its MapLibre stylesheet **for the client to apply locally**.
It is read-only: it does not mutate server state. If the user wants the served
layer's default style changed, that is the admin path
(`updateAdminLayerStyle`, or `suggestLayerStyle` for a proposal) — see
`docs/admin-cli-reference.md`.

## Style a Studio draft layer

Inside a Studio draft (stage `studio`), styling is two distinct calls, both
carrying the draft's optimistic-concurrency `generation`:

```
honua_studio_set_layer_style
{ "draftId": "<id>", "generation": "<gen>", "layerId": "parcel-buffer", "styleRef": "zero-to-map-buffer" }

honua_studio_set_layer_visibility
{ "draftId": "<id>", "generation": "<gen>", "layerId": "parcel-buffer", "visible": true }
```

Set visibility explicitly. A styled-but-invisible layer is the single most
common "the style didn't work" report. `styleRef` names a style the server
already knows; it is not an inline stylesheet.

Then frame it, or the reviewer sees an empty ocean:

```
honua_studio_set_view
{ "draftId": "<id>", "generation": "<gen>",
  "view": { "bbox": [-157.862, 21.3064, -157.8595, 21.3083], "crs": "EPSG:4326" } }
```

Derive the bbox from `honua_get_extent` on the layer rather than inventing
coordinates.

## Validate the composition

`honua_studio_validate_draft` returns the unified validation envelope described
in `docs/studio-package-contracts.md`. Read it before saving. A draft that fails
validation will not become a publishable version, and each package family is
gated on its `format` constant (for example `honua_map_package.v1`) — a loader
refuses any other value.

## Verify the rendered artifact (stage `artifact`)

The journey's final gate is deliberately dumb and therefore honest: an
identity-bound HTTP 200 from the approved URL
(`mcp/release/zero-to-map/journey.v1.json`, stage `artifact` — the map public
URL, the app share URL, and the dashboard public URL).

- The URL only exists after a human approved the candidate in Console. An agent
  cannot mint it by proposing (stage `proposal` explicitly forbids
  `publicUrl` / `shareUrl` / `publicationId` in the propose response).
- A 200 proves reachability. It does not prove the map looks right. For visual
  confirmation, load the returned map package in a MapLibre runtime and
  inspect it, or hand the URL to the human.
- A 401/403 usually means the service access policy was never set — see
  `honua-publish-layers`.

## Verify

- `docs/studio-package-contracts.md` — package families, format constants, and
  the validation envelope.
- `mcp/README.md` — the styling tools' graceful-degradation contract.
- `mcp/release/zero-to-map/journey.v1.json` — stages `studio` and `artifact`.
