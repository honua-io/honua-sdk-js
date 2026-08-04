# MapLibre ecosystem listing kit

Status: **filed by the maintainer; SDK CI never files anything.** This file is
both the reusable entry kit and the submission ledger for issue
[#499](https://github.com/honua-io/honua-sdk-js/issues/499). Submissions are PRs
to *other projects*: no automation in this repository opens, updates, or merges
them, and no repo PR may claim an acceptance the ledger below does not record.

## Submission ledger

Verified against each target repository on 2026-08-04.

| Target | Submission | State |
| --- | --- | --- |
| `maplibre/awesome-maplibre` (also renders the official plugin directory) | [#176](https://github.com/maplibre/awesome-maplibre/pull/176) | **Merged** 2026-08-01 |
| `sacridini/Awesome-Geospatial` | [#237](https://github.com/sacridini/Awesome-Geospatial/pull/237) | **Merged** 2026-08-02 |
| `protomaps/docs` | [#136](https://github.com/protomaps/docs/pull/136) | Open, awaiting upstream review |

Two of the three ecosystem submissions are accepted, which satisfies #499's
"at least one is accepted" acceptance criterion. The Protomaps entry is
upstream-owned from here — nothing in this repository can advance it.

Keep this ledger truthful: `npm run verify:discoverability` fails when a target
row carries no state, so the kit cannot silently drift back into claiming an
unfiled or unaccepted submission.

A directory entry is a link, not proof anyone can find the package. Where the
published packages actually rank in npm search for their declared discovery
terms is measured separately in
[`npm-search-verification.md`](./npm-search-verification.md).

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

This repository never files a submission automatically. When adding a new
target, or refreshing an existing one:

1. Confirm the linked example is green on trunk (latest CI run includes the
   Playwright standalone smoke).
2. File the PR by hand; keep each to the single bullet line in the documented
   section (alphabetical placement where the list is sorted).
3. Add the target to the submission ledger above with its real state, and
   record the PR link on issue #499.
4. When a submission is accepted, update its ledger row and tick the
   corresponding acceptance criterion on #499. Add the external URL to the
   docs-site link-check allowlist if it is ever referenced from docs.
