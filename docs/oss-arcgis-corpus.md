# Third-party open-source ArcGIS app corpus

Every migration number Honua published before this corpus came from
Honua-authored fixtures — code written to exercise the codemod, by people who
knew exactly what the codemod does. That is a useful regression suite and a
poor prediction of what happens to *your* app.

This corpus is the counterweight. It pins real, third-party, open-source ArcGIS
JS applications on GitHub — state DOT tools, a state geospatial office's parcel
viewer, a long-lived community map viewer, a citizen-science map — and runs the
real `honua-migrate` CLI over them in an opt-in lane. The published results live
in [docs/oss-arcgis-corpus-readiness.md](./oss-arcgis-corpus-readiness.md).

- Manifest: [`config/oss-arcgis-corpus.v1.json`](../config/oss-arcgis-corpus.v1.json)
  (schema: [`config/oss-arcgis-corpus.schema.json`](../config/oss-arcgis-corpus.schema.json))
- Published observation: [`docs/data/oss-arcgis-corpus-readiness.v1.json`](./data/oss-arcgis-corpus-readiness.v1.json)
- Lane: [`scripts/oss-arcgis-corpus.mjs`](../scripts/oss-arcgis-corpus.mjs)
  and [`.github/workflows/oss-arcgis-corpus.yml`](../.github/workflows/oss-arcgis-corpus.yml)

## Guardrails

The corpus is a manifest of **pointers**. Nothing about it puts third-party code
in this repository, and nothing about it talks to Esri.

- **No vendored third-party code.** Each entry records a repository URL and the
  exact commit to check out. The lane clones into `.tmp/oss-arcgis-corpus/`
  (git-ignored), analyzes the working copy, and deletes the checkout.
- **Never in PR CI.** The lane is a manually dispatched / scheduled workflow.
  It also refuses to run unless `HONUA_OSS_ARCGIS_CORPUS_ENABLED=true`, so an
  accidental invocation is an explicit no-op rather than a surprise network
  fetch.
- **No live Esri service contact.** The lane is static analysis only: it reads
  source files. It never issues a request to an ArcGIS service, a portal, or a
  basemap, and it never resolves a cloned app's dependency tree.
- **License-reviewed.** Only the SPDX ids in `licensePolicy.allowedSpdxIds`
  (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `Unlicense`,
  `CC0-1.0`) are eligible. Each entry stores the SPDX id, a permalink to the
  license file at the pinned commit, and the copyright holder named in it.
  Repositories with no license, `NOASSERTION`, or a copyleft license are
  rejected — including otherwise ideal government apps.

`summarizeOssArcGisCorpus()` enforces the structural half of these promises and
the lane refuses to start if any of them regress.

## Corpus shape

The manifest must pin at least five apps and must span all three authoring
styles a migrating team actually shows up with:

| Style | What it means |
| --- | --- |
| `amd-require` | Legacy Dojo/AMD loading — `define([...])` or `require([...])` dependency arrays, or bare `esri/*` module specifiers |
| `widget-heavy` | Many `esri/widgets/*` / `@arcgis/core/widgets/*` (or `esri/dijit/*`) constructions |
| `featurelayer-centric` | ES modules over `@arcgis/core` built around `FeatureLayer`, `Map`, and `MapView` |

Each app records `repo` (owner/name/default branch/**full 40-character commit
SHA**/observation date), `license`, `provenance` (author kind and a plain-English
description), `styles`, the `scanRoot` the CLI is pointed at, `evidencePaths`
(the files a reviewer actually read to confirm ArcGIS usage), and `notes`.

`evidencePaths` is load-bearing, not decoration: it is what lets the readiness
page distinguish "this app has nothing to migrate" from "the scanner could not
see this app", which turned out to be the most important thing the corpus
measures.

## Running the lane

```bash
# Full corpus (clones every pinned app, then deletes the checkouts)
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true npm run corpus:oss-arcgis

# One app, keeping the checkout for inspection
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true node scripts/oss-arcgis-corpus.mjs \
  --apps owls-of-bavaria --keep-clones

# Refresh the published observation and regenerate the summary page
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true npm run corpus:oss-arcgis:publish
npm run docs:oss-arcgis-corpus

# Regression gate: fail when an app's auto-migrated ratio drops below
# the published observation, or when previously visible usage disappears
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true npm run corpus:oss-arcgis:gate
```

Without the env var the lane prints a skip line and exits 0:

```text
ossArcGisCorpus=skipped reason=opt-in-required set HONUA_OSS_ARCGIS_CORPUS_ENABLED=true to run (apps=6)
```

For each app the lane runs the same three commands a migrating team runs, then
projects the result onto a per-app record:

1. `honua-migrate scan <scanRoot> --report scan.json`
2. `honua-migrate widgets <scanRoot> --gate <pct> --report widgets.json`
3. `honua-migrate codemod <scanRoot> --target <target> --write --annotate-todos --report codemod.json`

`codemod.json` is a plain `JsMigrationReport` — the same schema
`migration-report.test.ts` covers and the same schema every fixture lane emits.
The corpus adds no report format of its own; it only aggregates.

Outputs land under `test-results/oss-arcgis-corpus/` (git-ignored):

```text
test-results/oss-arcgis-corpus/
  readiness.v1.json          aggregate run record
  apps/<id>/scan.json        ArcGisScanReport
  apps/<id>/widgets.json     WidgetReadinessReport
  apps/<id>/codemod.json     JsMigrationReport
  apps/<id>/readiness.json   per-app corpus record
  apps/<id>/cli.log          the CLI invocations and their leading output
```

## Reading the published page

Two numbers on [the readiness page](./oss-arcgis-corpus-readiness.md) matter
most, and they must be read together:

- **Auto-migrated call-site ratio** — of the call sites the codemod claims,
  how many did it rewrite without leaving a manual TODO.
- **Apps with no ArcGIS usage detected** — apps where the scanner found
  *nothing*, despite reviewed evidence that they are ArcGIS apps. For those
  apps the readiness verdict is not a result. A `ready` next to
  "no usage detected" means the scanner was blind, not that the app is done.

The regression gate compares a fresh run against the published observation and
fails when an app's auto-migrated ratio drops or when usage that was previously
visible stops being detected.

## Gaps the corpus has already found

The first sweep (2026-08-03) is why this corpus exists. Three of the six pinned
apps produced `filesWithArcGisImports=0` — the scanner saw nothing at all —
because `findArcGisImports` in `src/migration/scanner.ts` matches only
`@arcgis/core/*` specifiers. Each gap is filed with the app and the construct
that exposed it:

| Issue | Gap | Exposed by |
| --- | --- | --- |
| [#980](https://github.com/honua-io/honua-sdk-js/issues/980) | AMD `define([...])` / `require([...])` dependency arrays with bare `esri/*` specifiers are invisible | `cmv/cmv-app` — `viewer/js/config/viewer.js`, `viewer/js/gis/dijit/Basemaps.js` |
| [#981](https://github.com/honua-io/honua-sdk-js/issues/981) | Bare `esri/*` ES-module specifiers, including TypeScript `import X = require("esri/...")`, are invisible | `WSDOT-GIS/bridge-clearance-app` — `src/main.ts`; `ekenes/national-park-visits` — `app/main.ts`, `app/widgets.ts` |
| [#982](https://github.com/honua-io/honua-sdk-js/issues/982) | A scan that detects nothing reports `readiness: "ready"` with all three gates passing vacuously | All three apps above |

#981 also records a concrete internal inconsistency: on
`ekenes/national-park-visits` the **widget** scanner reported four widget usage
sites in the same files the ArcGIS scanner reported zero imports in, so the two
scanners disagree about the same source.

## Adding an app

1. Confirm the repository exists, note its default branch, and read its license
   file. Reject anything outside `licensePolicy.allowedSpdxIds`.
2. Pin the full commit SHA (`gh api repos/<owner>/<repo>/commits/<branch> --jq .sha`).
3. Read enough of the source to record honest `styles` and `evidencePaths` —
   at least one file per claimed style.
4. Add the entry to `config/oss-arcgis-corpus.v1.json` and set `revision` to
   today.
5. Run the lane with `--publish`, regenerate the page, and file follow-up issues
   for any new codemod or compat gap the app exposes, naming the app and the
   construct that exposed it.

Moving an existing pin is the same process: licenses are re-reviewed whenever a
pin moves, because a repository can relicense between commits.
