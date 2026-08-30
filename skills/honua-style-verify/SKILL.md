---
name: honua-style-verify
description: Use when applying a style to a Honua published layer or Studio draft and proving the rendered map is actually correct — resolving styles from the server, applying a preset to a published layer and rendering it to a PNG, applying a preset client-side, setting a draft layer's style and visibility, framing the view, and verifying the approved public URL responds. Covers the published-layer style/render proof in 2026.1 zero-to-map stage 3 (style), styling in stage 5 (studio), and the URL check in stage 8 (artifact).
release: "2026.1"
stages: [style, studio, artifact]
---

# Style and rendered-map verification (stages 3, 5 and 8)

Styling is a claim; a rendered, reachable map is the evidence. This skill covers
all three halves of that: the published-layer render proof, draft styling, and
the final URL check.

## Resolve a style from the server

`honua_get_style` (`mcp/src/tools/get-style.ts`) reads a server's OGC API –
Styles surface. Pass `styleId` for the canonical `StyleRef` (`style_id`,
`title`, encodings including an inlined MapLibre style); omit it to list what is
available.

On a plain FeatureServer with no styling surface it returns a structured
`{ "available": false, "surface": ..., "reason": ..., "guidance": ... }`
result. That is a *capability* answer, not a failure — do not retry it, and do
not report "no styles found" as if the server had an empty catalog.

## Apply a preset — two different tools with the same name

There are two `honua_apply_style_preset` implementations, and confusing them is
the usual reason a style "doesn't take":

- **This SDK's tool** (`mcp/src/tools/apply-style-preset.ts`) resolves a preset
  and returns its MapLibre stylesheet **for the client to apply locally**. It is
  read-only and does not mutate server state.
- **The Honua server's tool**, reached through `honua-mcp-proxy`, binds a
  catalog preset as a published layer's primary/default style, addressed by
  `serviceId` + `layerId`. It mutates. This is what stage `style` calls.

If you want the served layer's default style changed and you are not going
through the server tool, that is the admin path (`updateAdminLayerStyle`, or
`suggestLayerStyle` for a proposal) — see `docs/admin-cli-reference.md`.

## Prove a published layer's style reaches pixels (stage `style`)

Stage 3 is the only place the journey proves that styling a *published* layer —
not a draft — changes what gets drawn. Six steps, in order:

1. `honua_get_style` with `serviceId` + `layerId` — the layer's style before
   anything is applied. Keep the `styleVersion`; it is the baseline a reviewer
   compares against.
2. `honua_get_style` with **no arguments** — list mode, the catalog of presets
   this server actually publishes. Discover the preset here rather than naming
   one: a preset id you invented is not evidence.
3. `honua_apply_style_preset` with `serviceId`, `layerId`, `styleId`. Check
   `applied` in the response. `applied: false` is a silent no-op — the call
   succeeded and nothing changed.
4. `honua_get_style` again — the read-back must now report the preset as the
   layer's primary style, at the version the apply returned. A read-back that
   still shows the baseline means step 3 lied.
5. `honua_render_map` with `layers: [{ serviceId, layerId }]` and a `bbox`. The
   response's `layers[].styleId` is the server's own statement of which style it
   drew with — that, not the apply response, is the style-identity evidence.
6. Fetch the artifact. By default `honua_render_map` returns a `resource_link`
   (`image.uri`) rather than inline base64, so the PNG must be read back with
   `resources/read` and judged: PNG signature, IHDR dimensions matching what the
   renderer reported, at least one non-empty IDAT chunk, and a plausible byte
   length. A valid PNG of the right size with no pixel data is exactly what a
   render no-op produces, which is why the byte count alone is not enough.

Set `maxInlineBytes` only if you genuinely want the image in the model context;
a 512x512 render inlined as base64 is a large amount of context for something a
validator can check without reading.

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
- `mcp/release/zero-to-map/journey.v1.json` — stages `style`, `studio` and
  `artifact`.
