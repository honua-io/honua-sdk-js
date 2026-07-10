# Scope split and the road to 1.0

Status: accepted and executed by `honua-sdk-js#357`. The current inventory and
compatibility-removal release are recorded below and enforced from
`config/public-surface.json`.

## Context

`@honua/sdk-js` publishes **39 subpath entrypoints** from a single package. The
independent review of 2026-07-06 recorded two findings that frame this decision:

1. **A client SDK has grown an app platform inside it.** Roughly half the
   entrypoints — `/app`, `/app-controller`, `/app-workspace`, `/scene-workspace`,
   `/collaboration`, `/control-plane`, `/console`, `/replica-sync`, `/share`,
   `/operate`, `/generated-app`, `/studio`, `/operator` (five subpaths),
   `/controls`, `/web-components` — are application-shell and hosted-product
   surfaces, not client primitives. They dilute the SDK identity (a
   protocol-neutral geospatial client), inflate the maintained surface, and
   delay a credible 1.0.
2. **39 entrypoints maintained by effectively one author is unsustainable.** The
   review set a target of **≤ 20 entrypoints for the stable package** and named
   `esri-leaflet`'s refusal to promise a lifecycle as the cautionary tale a
   credible 1.0 must answer.

A 1.0 with a frozen, semver-protected stable tier is the single most-requested
trust signal for library adoption. This ADR decides (a) the disposition of every
current entrypoint, (b) how the app-platform surfaces are extracted into a
separate package (working name `@honua/app-platform`) without breaking anyone,
and (c) the 1.0 readiness checklist, support policy, and the CI gate that keeps
the stable surface honest from now on.

Two constraints frame the split, mirroring the tension recorded in
[`geometry-library-selection.md`](./geometry-library-selection.md):

- The core `@honua/sdk-js` package has exactly **one** runtime dependency by
  deliberate design (`@maplibre/maplibre-gl-style-spec`); everything heavier is
  an optional peer. The stable tier must not grow that.
- No stable-tier entrypoint may depend on a moved app-platform entrypoint after
  the split, or the split is a lie. §"Dependency analysis" audits this.

## Evidence

### Dependency analysis (does app-platform pull from stable code?)

Import-edge audit of `src/` (`grep` of every app-platform source directory's
imports of sibling directories; reverse-edge audit of the stable directories'
imports of app-platform directories):

- **App-platform → stable is expected and fine.** Every app-platform surface
  imports downward into the stable core: `app` → `runtime`/`core`/`contract`;
  `app-controller` → `exploration`/`style`/`runtime`/`core`/`contract`;
  `app-workspace` → `exploration`/`contract`/`realtime`; `scene-workspace` →
  `core`/`exploration`/`contract`/`realtime`; `control-plane` →
  `core`/`runtime`/`contract`; `generated-app` →
  `runtime`/`exploration`/`contract`/`interactions`; `studio` →
  `runtime`/`generated-app`/`control-plane`; `operator` → its own
  subtree + `runtime`/`exploration`/`contract`. After the split the new package
  simply declares `@honua/sdk-js` as a dependency; these edges become
  cross-package imports of the **stable** surface.
- **One stable → app-platform back-edge exists and blocks a clean split.** The
  stable `/runtime` entrypoint re-exports Studio symbols:
  `src/runtime/map-package-validation.ts` ends with
  `export { fromMapPackageValidation, toStudioValidationResponse } from "../studio/validation.js"`
  plus three `StudioPackage*` type re-exports. Studio in turn imports *types*
  from `runtime` (`ValidateMapPackageResult`, `HonuaMapPackage`), so the
  coupling is bidirectional. These re-exports are already annotated
  `@experimental`. **Resolution (execution PR):** delete the Studio re-exports
  from the stable `/runtime` entrypoint; consumers reach them via
  `@honua/sdk-js/studio` (moving to `@honua/app-platform/studio`). This is the
  single stable-tier edit the extraction requires and the reason the eviction
  must not be done blindly by moving directories.
- No other stable directory imports any app-platform directory.

### Consumer audit (who actually imports these surfaces?)

- **`honua-console` — the nominated new home — does not depend on `@honua/sdk-js`
  at all.** Every occurrence of the string `@honua/sdk-js` in that checkout is a
  comment, a doc code-sample, or a JSON data value; `@honua/console`'s
  `package.json` does not list the SDK, and it re-implements the shapes it needs
  in its own `smoke/parity/*` fixtures. So the eviction breaks **zero**
  honua-console imports, and `console` cannot claim honua-console as a live
  consumer.
- **`examples/` consume only a handful of app-platform surfaces**, all of which
  move together cleanly:
  - `/app-workspace` — 9 demos (service-explorer, stac-imagery-browser,
    spatial-analytics-workbench, planning-permitting-workbench, mcp-gis-assistant,
    geoprocessing-job-runner, edit-workflow-demo, ai-spatial-app-builder,
    unified-ops-workspace).
  - `/scene-workspace` — 2 demos (terrain-rgb-elevation, storytelling-25d-map).
  - `/app-controller` — 1 demo (runtime-parity-showcase).
  - `/app` — 1 demo (app-bootstrap-basic).
  - `/controls` — 2 demos; `/web-components` — 2 demos.
  - `/control-plane` — README prose only, no source import.
- **`mcp/` imports one app-platform-adjacent surface:** `/agent-tools`
  (`explainHonuaCapabilityGap`). See its disposition below — it stays in the
  stable package precisely because the in-repo MCP server depends on it.
- **No `examples/` or `mcp/` consumer imports** `/collaboration`, `/console`,
  `/replica-sync`, `/share`, `/operate`, `/generated-app`, `/studio`, or any
  `/operator*` subpath. Their only exercised consumer today is the internal
  split-package smoke test (`scripts/verify-split-packages.mjs`). This
  zero-external-consumer status is what makes moving (or, for `/console`,
  deleting) them low-risk.

## Decision — per-entrypoint disposition

Three dispositions: **stable-1.0** (stays in `@honua/sdk-js`, in scope for the
1.0 semver contract), **move** (relocates to `@honua/app-platform`), **delete**
(removed; folded into its true owner). Counts: **20 stable / 18 move / 1 delete**
= 39. The stable count of 20 meets the review's ≤ 20 target and cuts the stable
package's entrypoints by nearly half.

### Post-execution inventory

Later adoption work added `/auth` and `/geoparquet` while the split was being
executed. The resulting package has 40 exports: 20 semver-protected stable
entrypoints, 2 subpath-only experimental entrypoints (`/agent-tools` and
`/geoparquet`), and 18 deprecated app-platform compatibility shims. The stable
count remains at the accepted ceiling because `/agent-tools` is explicitly
experimental, while `/auth`, `/browser`, and `/cli` are included in the stable
API report. `config/public-surface.json` supersedes the historical table below
as the exact current inventory.

The app-platform shims first shipped in `0.1.0-beta.0`, remain for the complete
`0.1.x` line, and are removed in `0.2.0`. CI rejects a `0.2.x` package while any
shim remains.

### Stable-1.0 (20)

| Entrypoint | Disposition | Rationale |
|---|---|---|
| `.` | stable-1.0 | Root barrel of the most-common stable client symbols; the package's front door. |
| `./browser` | stable-1.0 | Build-less/CDN variant of `.` (same `types`, prebuilt ESM). A build target of the root, not a distinct API. |
| `./honua` | stable-1.0 | `HonuaClient` — the raw GeoServices/OGC client. The irreducible core of the SDK. |
| `./contract` | stable-1.0 | Protocol-neutral `Dataset`/`Source`/`Query`/`Result` — the cross-language contract the whole SDK identity rests on. |
| `./esri-compat` | stable-1.0 | ArcGIS JS-API compatibility layer; a headline adoption driver and already its own split package. |
| `./migration` | stable-1.0 | Codemod/scanner behind `honua-migrate`; headline adoption driver, own split package. |
| `./runtime` | stable-1.0 | MapLibre `MapPackage` runtime (`loadMapPackage`, `HonuaMapRuntime`). Core render path. (Must shed its Studio re-exports — see Evidence.) |
| `./expr` | stable-1.0 | Typed expression builder; low-level primitive used across map/style/filter. |
| `./webmap` | stable-1.0 | Esri WebMap JSON load/save; core interop primitive. |
| `./geocoding` | stable-1.0 | `HonuaGeocodingClient`; a first-class client capability. |
| `./exploration` | stable-1.0 | Linked-view exploration state; documented stable, imported by app-platform surfaces (a dependency they keep after the split). |
| `./interactions` | stable-1.0 | Hit-test / pointer / chart-map bindings; low-level client primitive. |
| `./filter-registry` | stable-1.0 | Shared filter clause registry + query projection; low-level primitive. |
| `./style` | stable-1.0 | Honua style spec + parsers/validators; core render primitive. |
| `./map` | stable-1.0 | `HonuaMap` programmatic container; core render surface. |
| `./geometry` | stable-1.0 | Curated turf/proj4 client-side ops; own split package (`@honua/geometry`), decided in the geometry ADR. |
| `./realtime` | stable-1.0 (promote) | Realtime transport adapters (SSE). A client-transport primitive, not app furniture; `app-workspace`/`scene-workspace`/`react` depend on it, so it belongs on the stable side of the cut. Currently `@experimental`; graduates to semver-stable at 1.0. |
| `./agent-tools` | stable-1.0 (promote) | Agent-facing JSON-Schema tool definitions (MCP/OpenAI). The in-repo `@honua/mcp-server` — a first-class supported consumer — imports it; keeping it stable avoids the MCP package depending on `@honua/app-platform`. May stay `@experimental`-tier *within* the stable package until the AI surface settles (see Open questions). |
| `./react` | stable-1.0 (promote) | React provider/hooks/map components — the idiomatic binding to the stable client (`HonuaClient`/`Dataset`/`Query`), already published standalone as `@honua/react`. A framework binding to core primitives, distinct from the pre-built app UI widgets. Currently `@experimental`; graduates at 1.0. |
| `./cli` | stable-1.0 | Programmatic entry to the `honua` CLI, a documented first-class product (README "Command-line client"); tied to the stable migration surface. |

### Move to `@honua/app-platform` (18)

| Entrypoint | Disposition | Rationale |
|---|---|---|
| `./app` | move | Browser app-shell bootstrap. Application platform, not a client primitive. Only consumer: 1 demo. |
| `./app-controller` | move | Renderer-neutral app controller (`HonuaController`). App-shell orchestration. |
| `./app-workspace` | move | Framework-neutral workspace state orchestration. The most-used app-platform surface (9 demos) but unambiguously app-shell state, not client contract. |
| `./scene-workspace` | move | 3D scene workspace + MapLibre/Cesium adapters. App-shell + optional heavy Cesium peer; belongs with the app platform. |
| `./collaboration` | move | Saved-map collaboration client. Hosted-product surface; zero external consumers. |
| `./control-plane` | move | Hosted-product/admin client (`/api/v1/admin`). Not a general client capability; README-only mentions, no source consumer. |
| `./replica-sync` | move | Offline-replica sync client. Hosted-product/app feature; zero external consumers. |
| `./share` | move | Embed-token + DCAT sharing helpers. Hosted-product/app feature; zero external consumers. |
| `./operate` | move | Operations/observability client (`/api/v1/operate`). Hosted-product surface; zero external consumers. |
| `./generated-app` | move | Manifest projection + preview runtime for generated apps. App-builder platform; imported only by `console`/`studio` internally. |
| `./studio` | move | Studio package-family projections/validation/publish contracts. App-builder platform; the stable-tier back-edge to it is severed in execution. |
| `./operator` | move | Operator chat/plan-review/approval controllers. Operator app platform. |
| `./operator/controllers` | move | Framework-neutral controllers behind `/operator`. Moves with `/operator`. |
| `./operator/workspace` | move | Operator workspace state container. Moves with `/operator`. |
| `./operator/theming` | move | Operator design-system theme provider + tokens. Moves with `/operator`. |
| `./operator/i18n` | move | Operator message catalog + resolution. Moves with `/operator`. |
| `./controls` | move | Native UI control kit (`<honua-basemap-switcher>`, legend). Pre-built application UI widgets — app furniture, distinct from the `react` *binding*. Moves with the app-platform UI layer. |
| `./web-components` | move | Framework-neutral custom elements (charts, feature tables, sketch/measure). The web-component app UI kit; moves with `controls`. |

### Delete (1)

| Entrypoint | Disposition | Rationale |
|---|---|---|
| `./console` | delete | `projectAppPackage` / `projectMapPackage` / chart-widget projections duplicate logic whose canonical owner is the `@honua/console` application (per the "honua-console is the UI home" decision). honua-console does not import these — it maintains its own parity shapes — and no `examples/` or `mcp/` consumer imports `/console` either. Rather than move a duplicated projection layer into `@honua/app-platform`, fold it into honua-console during execution and remove the SDK entrypoint. Flagged for owner confirmation (see Open questions). |

## Extraction plan (`#357` REQ-004, authorized here)

The moves above are executed in a follow-up PR (or a small series), keeping CI
green throughout. This ADR fixes the design so that PR is mechanical.

### 1. Split-package pipeline

- `@honua/app-platform` builds from the **same `src/` tree** via the existing
  `scripts/prepare-split-packages.mjs` mechanism (the pattern already used for
  `honua-sdk`, `honua-sdk-esri-compat`, `honua-migrate`, `honua-react`,
  `honua-geometry`). Add an `app-platform` package descriptor whose entrypoints
  are the 18 "move" subpaths, that declares `@honua/sdk-js` (stable) as a
  `dependency`, and that carries the optional peers those subpaths need
  (`cesium` for `scene-workspace`, etc.).
- Extend `scripts/verify-split-packages.mjs`: relocate the app-platform import
  smoke assertions (currently importing `@honua/sdk/console`, `.../share`,
  `.../operate`, `.../collaboration`, `.../studio`, `.../operator*`,
  `.../generated-app`, `.../app*`, `.../scene-workspace`) from the `@honua/sdk`
  block to a new `@honua/app-platform` block. Drop the `/console` assertions
  (deleted).
- Sever the stable-tier back-edge: remove the Studio re-exports from
  `src/runtime/map-package-validation.ts` (see Evidence) in the same PR that
  moves `studio`, so the stable `/runtime` surface no longer reaches into moved
  code. This is a stable-API change and will show up in the API report
  (`api-report/stable-api.json`) — an intended, reviewed diff.

### 2. release-please config for `@honua/app-platform`

Add a package stanza to `release-please-config.json` mirroring the `mcp`
stanza — independent versioning so the app platform moves at its own pre-1.0
cadence while the SDK freezes at 1.0:

```jsonc
"packages/app-platform": {
  "release-type": "node",
  "component": "app-platform",
  "tag-separator": "-",
  "include-component-in-tag": true,
  "bump-minor-pre-major": true,
  "bump-patch-for-minor-pre-major": true,
  "changelog-sections": [ /* same sections as the js-sdk stanza */ ]
}
```

and seed `.release-please-manifest.json` with
`"packages/app-platform": "0.0.0"` (or the current SDK pre-release line if the
history is carried over). Keep the `node-workspace` plugin so peer bumps stay
linked. **Note:** `release-please-config.json` and `.release-please-manifest.json`
are edited by sibling branches; the execution PR must rebase and apply this
stanza additively, not wholesale.

### 3. Deprecation re-export shims (one minor window)

To honor **NFR-001 (no breaking change for stable-tier consumers during the
transition)** — and to give the app-platform demo consumers a soft landing —
each moved subpath keeps a **thin re-export shim at its old `@honua/sdk-js`
subpath for exactly one minor-version window**:

```ts
/**
 * @deprecated Moved to `@honua/app-platform/app-workspace`. This re-export is
 *   retained for one minor version and will be removed in the next minor.
 *   Update imports to `@honua/app-platform/app-workspace`.
 */
export * from "@honua/app-platform/app-workspace";
```

The shim files stay listed in `package.json#exports` (so old imports resolve)
but are excluded from the stable API report and carry the `@deprecated` JSDoc so
TypeScript/editor tooling flags them. The subsequent minor removes the shims and
the `exports` entries. `/console` gets **no shim** (it is deleted, not moved);
its removal is called out in the release notes with the honua-console migration
pointer.

### 4. git-history preservation

Move directories with `git mv` in a **dedicated, move-only commit** (no content
edits in the same commit) so `git log --follow` and `git blame` track each file
across the package boundary. Content edits (fixing internal import specifiers
from `../runtime` to `@honua/sdk-js/runtime`, adding the shims) land in a
**separate follow-up commit**. Do not squash the two. If the app-platform
package is later extracted to its own repository, use `git filter-repo
--path src/<moved-dir>` from this history so blame survives the repo boundary.

## 1.0 readiness checklist

1. **This ADR** merged with the per-entrypoint disposition table. ✅ (this file)
2. **API report gate active in CI for the stable tier.** ✅ (this branch —
   `scripts/report-api-surface.mjs`, `api-report/stable-api.json`,
   `verify:api-report` wired into `ci.yml`).
3. **Semver policy** documented — see below and README §"Support and lifecycle".
4. **Support/lifecycle statement in README** — ✅ (this branch; text below).
5. **Extraction executed** (`#357` REQ-004) — moves the 18, deletes `/console`,
   severs the runtime→studio back-edge, ships the deprecation shims, and reduces
   `package.json#exports` to the 20 stable subpaths (+ one-minor shims). Blocker:
   this ADR's review/approval.
6. **1.0 milestone created** with the remaining blockers as linked issues:
   - `#357` REQ-004 — execute the split (this ADR's follow-up).
   - Studio↔runtime decoupling (the back-edge severance) — subtask of REQ-004.
   - Freeze/label pass: audit every `@experimental` JSDoc on the 20 stable
     entrypoints; promote `realtime`/`react` (and decide `agent-tools`) or keep
     them explicitly experimental-within-stable.
   - Cross-language 1.0 coordination (JS/Python/.NET major alignment, per the
     existing INSTALL "Cross-language alignment" note).

### Semver policy

- The public contract is the set of symbols reachable from the **stable subpath
  entrypoints** (the 20 above; the committed `api-report/stable-api.json` is the
  machine-checked manifest of that set).
- Pre-1.0 (`0.x`, `-alpha`/`-beta`): minors may change even stable-tier
  signatures; the API report still gates *unintended* drift (every change is a
  reviewed diff).
- At 1.0+: removing or breaking a stable-tier symbol requires a major; additive
  changes are minors. Symbols carrying `@experimental` JSDoc are exempt and may
  change in any minor.
- `@honua/app-platform` versions independently and stays pre-1.0 until it earns
  its own freeze.

## README support/lifecycle policy (draft text to add)

The following replaces/augments the README "Stability and versioning" section.
It is deliberately honest about pre-1.0 status — the review named
`esri-leaflet`'s *refusal* to state a lifecycle as the anti-pattern, so we state
one, and we state plainly that the guarantees strengthen at 1.0 rather than
overpromising them today:

> ## Support and lifecycle
>
> We publish a lifecycle because a library you build on should tell you what it
> promises. `esri-leaflet` never did, and "will this break under me?" is the
> question that decides adoption.
>
> **Today (pre-1.0, `0.x`).** The **stable tier** — the subpath entrypoints
> listed under "Stable subpath entrypoints" in [`INSTALL.md`](./INSTALL.md) — is
> where we invest compatibility effort and is guarded in CI by a public-API
> report (`npm run verify:api-report`): no symbol leaves or changes shape by
> accident. While we are on `0.x` a minor *may* still change a stable symbol, but
> only as a reviewed, called-out change — never silently. Symbols marked
> `@experimental` in JSDoc may change in any minor.
>
> **At 1.0.** The stable tier freezes under [Semantic Versioning](https://semver.org/):
> breaking or removing a stable symbol requires a major version; minors are
> additive. Major versions are coordinated across the Honua SDK family
> (JavaScript, Python, .NET) so one semver line describes the contract on every
> platform.
>
> **Application-platform surfaces move separately.** App-shell, builder, and
> hosted-product entrypoints are being extracted to a separate
> `@honua/app-platform` package that versions at its own pre-1.0 cadence, so the
> client SDK can reach a frozen 1.0 without waiting on them. During the
> transition their old `@honua/sdk-js/*` subpaths keep working for one minor
> behind a `@deprecated` re-export shim.
>
> **What we don't promise.** No security-backport window or LTS branch pre-1.0;
> fixes land on the current line. We will publish that policy when we cut 1.0.

## Decisions

Recorded 2026-07-06, decided by the repo owner. These resolve the five review
questions above and govern the execution (`#357` REQ-004, phase 2).

1. **`/console` — DELETE (confirmed).** Fold nothing into the SDK; honua-console
   owns its own parity shapes. The `./console` entrypoint and `src/console` are
   removed outright, with **no** deprecation shim (delete means delete). The
   removal is called out in INSTALL.md / README with the honua-console pointer.
2. **`agent-tools` — stays in the stable package; symbols remain
   `@experimental` within the stable package (not semver-frozen).** The in-repo
   `@honua/mcp-server` depends on it, so it does not move to `@honua/app-platform`.
   Revisit the freeze/label decision before 1.0.
3. **`realtime` + `react` — promote to semver-stable at 1.0 (confirmed).** Both
   graduate from `@experimental` and join the stable subpath table in INSTALL.md
   (and therefore the `verify:api-report` gate). **Exclusion:** the not-yet-built
   WS/WebTransport realtime adapters are *not* part of the frozen surface — we do
   not freeze names that do not exist yet. Only the shipped SSE transport
   adapters are covered; the future WS/WebTransport names are added to the frozen
   surface when they are actually built.
4. **Package name — `@honua/app-platform` (confirmed final).**
5. **`scene-workspace` Cesium peer — proceed with the move; verified clean.**
   Mechanical check (grep of `src/` and the built `dist/` for the stable
   entrypoint set): after eviction, **no stable entrypoint imports or type-
   references Cesium.** The only occurrences of "cesium" in stable source are two
   prose comments (`src/contract/pmtiles.ts`, `src/map/index.ts`) that merely
   mention the Cesium adapter; the sole real Cesium type/import usage lives in
   `src/scene-workspace`, which moves to `@honua/app-platform`. The optional
   `cesium` peer therefore moves to `@honua/app-platform`'s peer list and leaves
   the stable package's peer surface.

### Execution deviations from the plan above (recorded for reviewers)

Two mechanical realities of the existing split-package machinery override the
literal text of the "Extraction plan" section; the intent (a separately
published, independently evolving app-platform package) is preserved.

- **No release-please stanza for `@honua/app-platform` (§2 "release-please
  config" superseded).** The existing split packages `@honua/react` and
  `@honua/geometry` are the precedents, and *neither* is registered in
  `release-please-config.json` / `.release-please-manifest.json`. release-please
  manages in-repo package directories (`.` and `mcp/`); the split packages are
  generated from the shared `src/` tree into `dist/packages/*` at build time and
  publish from there, inheriting the root version. `@honua/app-platform` is
  another such generated split target, so it is registered the same way the other
  split packages are — via `scripts/prepare-split-packages.mjs`,
  `docs/split-packages.md`, `verify:publish-surface`, and the publish workflow —
  and gets **no** release-please stanza. (Adding a stanza keyed at a
  non-existent `packages/app-platform/` directory would break release-please.)
- **Self-contained split target, no `git mv` (§4 "git-history preservation"
  superseded).** The split packages build from the single shared `src/` tree by
  copying each package's import closure into `dist/packages/*` (the
  `@honua/react` precedent); they do not relocate source into per-package
  directories. Physically `git mv`-ing the app-platform directories out of
  `src/` would break every downward import into the stable core and the shared
  build. Source therefore stays in `src/`; the eviction is expressed as (a)
  removing the moved subpaths from the stable package's advertised/contracted
  surface, (b) one-minor `@deprecated` re-export shims under
  `src/_deprecated/*`, and (c) the new `@honua/app-platform` split target that
  owns the canonical subpaths. If the app platform is later extracted to its own
  repository, use `git filter-repo --path src/<moved-dir>` from this history so
  blame survives the boundary.
