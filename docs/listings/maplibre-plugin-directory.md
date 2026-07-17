# MapLibre ecosystem listing kit

Status: **prepared, not filed**. This file contains everything needed to file
the external directory submissions for issue
[#499](https://github.com/honua-io/honua-sdk-js/issues/499) in minutes. The
submissions themselves are external PRs to other projects and are tracked as
acceptance items on the issue — they are deliberately **not** part of the repo
PR that added this file. Record the filed PR links on #499.

## The linkable, CI-green example every listing points at

Every entry below links an example that CI keeps green (issue #499, REQ-004):

- **Example:** `maplibre-quickstart` (First Map) — any public GeoServices or OGC Features endpoint →
  accepted plan → typed bounded query → styled MapLibre map. No account or browser secret.
- **Hosted walkthrough:**
  <https://honua-io.github.io/honua-sdk-js/guides/quickstart.html>
- **Committed source:**
  <https://github.com/honua-io/honua-sdk-js/tree/trunk/examples/maplibre-quickstart>
- **CI gate:** Playwright browser smoke (`npm run test:playwright:quickstart`)
  covers Chromium, Firefox, and WebKit; the fixture lane (`npm run demo:quickstart:mock`)
  is deterministic and externally network-blocked.
- **Gallery (all examples):**
  <https://honua-io.github.io/honua-sdk-js/gallery.html>

## 1. MapLibre plugin directory (official docs site)

The plugins page at <https://maplibre.org/maplibre-gl-js/docs/plugins/> is
generated at docs-build time from the `[JAVASCRIPT-PLUGINS]` block of
[`maplibre/awesome-maplibre`](https://github.com/maplibre/awesome-maplibre)'s
`README.md` — see `generatePluginsPage()` in
[`build/generate-docs.ts`](https://github.com/maplibre/maplibre-gl-js/blob/main/build/generate-docs.ts)
(verified 2026-07-13). **One PR to `maplibre/awesome-maplibre` therefore lands
both the awesome-list entry and the official plugin-directory page.**

- **Target:** `maplibre/awesome-maplibre`, file `README.md`
- **Section:** `## Utility Libraries` (it sits inside the
  `[JAVASCRIPT-PLUGINS]` block that the directory page renders)
- **Entry format:** one markdown bullet, `- [name](url) - Description.`

Exact line to add:

```markdown
- [@honua/sdk-js](https://github.com/honua-io/honua-sdk-js) - Typed multi-protocol data client for MapLibre: query ArcGIS/Esri GeoServices, OGC API, WFS, WMS/WMTS, STAC, OData, and GeoParquet services and mount the results as MapLibre sources, plus an ArcGIS-to-MapLibre migration codemod. [demo](https://honua-io.github.io/honua-sdk-js/guides/quickstart.html)
```

Suggested PR title: `Add @honua/sdk-js to Utility Libraries`

Suggested PR body:

```text
Adds @honua/sdk-js — an Apache-2.0 TypeScript data/service client that rides
MapLibre for rendering: one typed query contract over ArcGIS/Esri GeoServices,
OGC API (Features/Tiles/Maps), WFS 2.0, WMS/WMTS, STAC, OData v4, and
GeoParquet, with helpers that mount results as MapLibre sources/layers and an
ArcGIS→MapLibre migration codemod. Linked demo is kept green by Playwright
smoke tests on every PR.
```

## 2. Ecosystem list: Protomaps / PMTiles docs

Honua ships first-party PMTiles support (auto-registered `pmtiles://`
protocol on map attach, `describe()` archive metadata, lazy optional peer —
see [`docs/pmtiles.md`](../pmtiles.md)), which is what the Protomaps docs
index for third-party integrations.

- **Target:** `protomaps/docs`, file `pmtiles/index.md`
- **Section:** the third-party libraries list (currently under
  `## Other Languages`, "These libraries are maintained by other individuals
  and organizations."; format verified 2026-07-13)
- **Entry format:** one markdown bullet per library, `* Language: [link](url)`

Exact line to add:

```markdown
* JavaScript (MapLibre + data SDK): [honua-io/honua-sdk-js](https://github.com/honua-io/honua-sdk-js) - typed geospatial SDK whose MapLibre runtime auto-registers the `pmtiles://` protocol and reads archive metadata.
```

Suggested PR title: `docs: list @honua/sdk-js under PMTiles third-party libraries`

## 3. Ecosystem list: awesome-geospatial

- **Target:** `sacridini/Awesome-Geospatial`, file `README.md`
- **Section:** `## Web Map Development` (where MapLibre, OpenLayers, and the
  Esri JS SDK are listed; section names verified 2026-07-13)
- **Entry format:** one markdown bullet, `- [name](url) - Description.`

Exact line to add:

```markdown
- [Honua SDK JS](https://github.com/honua-io/honua-sdk-js) - TypeScript geospatial client for ArcGIS/Esri GeoServices, OGC API, WFS, WMS/WMTS, STAC, OData and GeoParquet with a MapLibre runtime and an ArcGIS migration codemod.
```

## Filing checklist (for the human doing the submissions)

1. Confirm the linked example is green on trunk (latest CI run includes the
   Playwright standalone smoke).
2. File the three PRs above; keep each to the single bullet line in the
   documented section (alphabetical placement where the list is sorted).
3. Record the PR links (and later, acceptance) on issue #499.
4. When at least one is accepted, tick the corresponding acceptance criterion
   on #499 and add the external URLs to the docs-site link-check allowlist if
   they are ever referenced from docs.
