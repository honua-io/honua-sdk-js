---
name: honua-arcgis-migration
description: Use when migrating an existing ArcGIS Maps SDK for JavaScript (@arcgis/core) app to Honua — running the honua-migrate scan and codemod, reading the parity/gate reports, and resolving the manual-intervention warnings the codemod flags. Drives the real CLI in src/migration/cli.ts; do not hand-translate ArcGIS code without it.
---

# ArcGIS → Honua migration

Migrate `@arcgis/core` apps file-by-file with the `honua-migrate` codemod. The
loop is: **scan → interpret report → codemod → resolve manual warnings → re-run
to green**. Every command below wraps `dist/src/migration/cli.js` (built by the
npm scripts) — see `src/migration/cli.ts` for the full flag surface.

## 0. Build

The migration npm scripts build the SDK first automatically. If you invoke the
CLI directly, run `npm run build` once so `dist/src/migration/cli.js` exists.

## 1. Scan

Inventory ArcGIS usage before changing anything:

```bash
npm run scan:arcgis -- ./src
```

`scan:arcgis` wraps `cli.js scan`; the trailing `-- ./src` targets a directory
(default: current directory). The report lists imports, per-module usage, and
`flags`. Blocking/attention flags to read for:

- `arcgis-reexports-detected`, `arcgis-barrel-imports-detected`
- `webmap-detected`
- `dynamic-import-detected`
- `advanced-widget-or-networking-detected`
- `auth-or-request-customization-detected`
- `commonjs-detected`
- `esri-leaflet-imports-detected` (existing esri-leaflet apps usually do **not**
  need this codemod — it targets `@arcgis/core` inputs)

## 2. Codemod (dry run first)

```bash
npm run migrate:arcgis -- ./src --report migration-report.json
```

`migrate:arcgis` wraps `cli.js codemod`. Without `--write` it is a dry run.
Pick a `--target` for the output style:

- `--target honua` / `honua-compat` (default) — rewrite to
  `@honua/sdk-js/esri-compat` wrappers (`FeatureLayerCompat`, `MapViewCompat`, …).
- `--target honua-maplibre` — rewrite supported constructs to
  `@honua/sdk-js/map` + `maplibre-gl` helpers.
- `--target esri-leaflet` — mixed `esri-leaflet` + compat output.

Apply once you have reviewed the dry run:

```bash
npm run migrate:arcgis -- ./src --target honua-compat --write --annotate-todos --report migration-report.json
```

`--annotate-todos` inserts `TODO(honua-migrate)` markers at each manual site.

## 3. Interpret the report

The codemod stdout and `migration-report.json` carry:

- `filesScanned` / `filesChanged`, `autoMigrated` (auto-rewritten call sites).
- `manual=[trivial:N moderate:N complex:N]` — manual sites bucketed by
  difficulty.
- `manualRewrite=n/d` and `manualIntervention=n/d` — the two ratio metrics.
- `readiness` — `ready` (all gates pass), `assisted` (some manual work), or
  `blocked` (a blocking flag present).
- `gates` — `no-manual-todos`, `no-unhandled-modules`, `no-blocking-flags`
  (each `pass`/`fail`).
- `manualTodos:` (file:line:column [kind] reason), `manualReasons:` (top
  reasons), and `unhandledArcGisModules:` (modules the codemod does not rewrite).

## 4. Resolve manual-intervention warnings

The codemod emits these categories at flagged sites (verbatim reasons live in
`src/migration/codemod.ts`). How to resolve each:

- **"…constructor has more than one argument; requires manual migration."** —
  Collapse the ArcGIS call into the single object-literal form the codemod
  understands, then re-run.
- **"…constructor argument is not an object literal."** — The argument is a
  variable/spread. Inline it to an object literal, or convert the site by hand
  to the compat wrapper.
- **"…options contain spread/method/computed property syntax; requires manual
  migration."** — Remove spreads / shorthand methods / computed keys from the
  options object so it is statically analyzable.
- **"…options include unsupported properties: …; requires manual migration."** —
  The listed properties have no compat mapping yet; port them by hand against
  the compat API and delete the unsupported ones.
- **"FeatureLayer options missing required url property; requires manual
  migration."** — Add the `url` (or `portalItem`) source the layer resolves from.
- **"IdentityManager / esriRequest / esriConfig / ReactiveUtils … requires
  import-based migration."** — These are not constructors; migrate the import
  and call sites manually using the compat request/auth bridge (`docs/guide.md`,
  Request/Auth bridge section).
- **"Unsupported ArcGIS constructor usage." / unhandled modules** — No
  automated path; reimplement against `@honua/sdk-js` or the compat layer.

For **WebMap JSON** (`webmap-detected`), convert with the `content-webmap`
command; its manual-intervention warning codes are `unsupported-renderer`,
`unsupported-layer-type`, `unsupported-feature-collection`,
`unsupported-arcade-expression`, `unsupported-3d-property`, `complex-arcade`,
and `complex-label-expression`. Resolve each in the source WebMap or in the
converted MapLibre style.

## 5. Gate and re-scan

Re-run the codemod until `readiness=ready`. To fail hard in CI/scripts, add gate
flags (they set a non-zero exit code):

```bash
npm run migrate:arcgis -- ./src --fail-on-manual --fail-on-unhandled --fail-on-blocked --max-manual-ratio 0 --max-manual-intervention-ratio 0
```

## Coverage evidence and parity (repo fixtures)

These scripts run the CLI over the repo's bundled Esri fixtures — useful to see
expected metrics and parity, not to migrate a user's app:

- `npm run report:migration:real-samples` / `npm run gate:migration:real-samples`
  — real-sample fixtures via the `fixtures` command.
- `npm run report:migration:demo-target` / `npm run gate:migration:demo-target`.
- `npm run report:migration:esri-leaflet-target` / `npm run gate:migration:esri-leaflet-target`.
- `npm run matrix:parity` / `npm run matrix:runtime` — API and runtime parity
  matrices.

## References

- `src/migration/cli.ts` — every command and flag (run the CLI with no build to
  see usage: `node dist/src/migration/cli.js --help`).
- `docs/migration-honua-maplibre.md` — MapLibre-runtime migration guide.
- `docs/migration-punch-list.md` — codemod coverage and parity punch list.
- `examples/migration-workbench/` — interactive migration demo (`npm run demo:migration-workbench`).
