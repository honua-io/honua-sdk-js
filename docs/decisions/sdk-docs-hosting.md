# SDK docs-site hosting

Status: implementation-time decision for
[`honua-sdk-js#364`](https://github.com/honua-io/honua-sdk-js/issues/364)
("hosted docs site — publish TypeDoc + guide corpus, findable by humans and
agents").

## Problem

`@honua/sdk-js` had zero hosted distribution surface. TypeDoc builds to
`dist/docs-api` but was never published; the 55-page `docs/` guide corpus lived
only as GitHub-blob Markdown; there was no demo gallery. The independent
due-diligence review flagged that "meticulous `llms.txt` cannot compensate for
being unfindable by humans" — every incumbent (Esri, Mapbox, MapLibre, CARTO,
OpenLayers) ships a hosted docs site with runnable examples. Docs findability
gates the payoff of every other adoption investment.

## Decision

**Publish the SDK reference site to GitHub Pages, built from this repository by
GitHub Actions.**

- **Host:** GitHub Pages, `build_type=workflow` (Pages source = GitHub Actions,
  not a branch). Deployed with `actions/upload-pages-artifact` +
  `actions/deploy-pages` using the workflow-scoped `GITHUB_TOKEN`.
  **No new secrets** (satisfies NFR-001).
- **URL:** https://honua-io.github.io/honua-sdk-js/ (the repo's default Pages
  origin). Custom domain is a later, non-blocking step — see below.
- **Build:** `scripts/build-docs-site.mjs` assembles a static site with a small
  vendored Markdown pipeline (`marked`, a zero-runtime-dependency devDependency)
  — deliberately **not** a heavy docs framework (Docusaurus / VitePress / Next).
  The gallery consumes the schema-validated, presentation-safe catalog-v2
  projection rather than reparsing README prose. The build is a pure function of
  the committed sources plus the TypeDoc output, so it is deterministic and fast
  (< 1s locally; the CI job target is ≤ 5 min).

The gallery handoff is consumer fixture v3: it content-binds the catalog-v2
site projection and the separate visual-evidence-v1 projection. Qualified
golden cards publish both desktop and mobile PNGs only after the complete
source, packed, fixture, browser, semantic, performance, and live receipt set
has been validated. Planned candidates continue to render without invented
screenshots, and the site never copies executable sample source.

### Why repo-local, not honua-site's GitBook

The org's marketing + platform docs hub (`honua-io/honua-site`) is authored in
**GitBook** (Markdown + `SUMMARY.md` + `.gitbook.yaml`). We considered homing
the SDK reference there. We chose a **repo-local** site because:

1. **Lock-step with trunk.** The SDK reference (TypeDoc API + `docs/` corpus +
   `llms.txt`) must never drift from the code it documents. Building from this
   repo on every trunk merge — and gating the publish on the existing
   `verify:llms` freshness check (REQ-004) — makes drift structurally
   impossible. A separately-authored GitBook space would reintroduce the drift
   the ticket exists to close.
2. **TypeDoc is not a GitBook-native artifact.** The API reference is generated
   HTML; mounting it under `/api/` from the same pipeline that renders the
   guides keeps one build, one deploy, one source of truth.
3. **Zero new infra / secrets.** Pages-from-Actions needs nothing beyond the
   built-in token.

`honua-site` remains the **marketing / narrative docs hub**; this site is the
**canonical SDK reference**. honua-site can link into it (and, later, proxy it
under a docs subpath) without owning its build.

## URL structure (redirect-safe)

| Path | Contents |
| --- | --- |
| `/` | Landing page (rendered from `README.md`, links rewritten) |
| `/guides/` | Guide index |
| `/guides/<name>.html` | `docs/<name>.md` (and `INSTALL.md`) rendered with nav |
| `/guides/<subdir>/<name>.html` | `docs/<subdir>/**` (decisions, features, examples) |
| `/api/` | TypeDoc API reference (`npm run docs:api` output) |
| `/gallery.html` | Public golden, recipe, and lab cards from the catalog-v2 site projection |

Paths are stable and content-addressed by doc filename, so future redirects
(e.g. onto a custom domain) are a straight prefix swap. Every internal `docs/`
cross-link is rewritten to resolve inside the site; links to non-rendered repo
files (`src/`, `examples/`, `mcp/`, `LICENSE`) fall back to stable GitHub-blob
URLs so nothing 404s. A deterministic, offline link-checker
(`scripts/check-docs-site-links.mjs`) runs over the built output.

## Relationship to `llms.txt` and honua-site#101

`llms.txt` / `llms-full.txt` currently resolve their doc links against
`https://github.com/honua-io/honua-sdk-js/blob/trunk` (the default
`LLMS_BASE_URL`). The generator already supports overriding that base.

**Plan (deferred until the site is verified live):** once
https://honua-io.github.io/honua-sdk-js/ is confirmed serving, regenerate the
llms files with `LLMS_BASE_URL` pointed at the hosted **guides** base so agents
land on rendered pages instead of raw blobs, and update the README/INSTALL
cross-links to match. That flip is intentionally **not** in the site-bootstrap
PR (#364) — the URL must be proven live first, and the base-URL change touches
`llms.txt`, `llms-full.txt`, and every doc link, which is its own reviewable
change.

[`honua-io/honua-site#101`](https://github.com/honua-io/honua-site#101) (serve
`llms.txt` at the docs-domain root) is updated with a comment describing this
sequencing: the SDK repo owns generation and the GitHub Pages origin; honua-site
either serves the generated files at the docs domain or links to the Pages
origin, and the `LLMS_BASE_URL` flip happens once the origin is live.

## Future custom-domain path

When a `docs.honua.io` (or `honua.io/sdk-js`) subdomain/subpath is provisioned:

1. Add the CNAME to the Pages config (`gh api ... pages -f cname=...`) or point
   honua-site's CDN/edge at the Pages origin.
2. Flip `LLMS_BASE_URL` and the README/INSTALL links to the custom base.
3. Because the path structure above is stable, only the origin prefix changes;
   no page paths move.

## CI

`.github/workflows/docs-site.yml` runs on `push` to `trunk` and
`workflow_dispatch`: `npm ci` → `verify:llms` (freshness gate, REQ-004) →
`samples:verify` plus the non-empty and visual-integrity gallery regressions → `docs:api` (TypeDoc) →
`docs:site` (assemble) → `docs:site:linkcheck` → `upload-pages-artifact` →
`deploy-pages`. Catalog verification schema-checks the public projection and
its generated consumer digest before publication. Gallery recipe/lab profile
gates remain declarations rather than receipt claims; `samples:verify`
receipt-validates any qualified golden journey before the docs build may
publish it. `node_modules` is cached and the full SDK test suite is intentionally
skipped to hold the ≤ 5 min budget (NFR-001).
