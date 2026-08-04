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
  apps there is no readiness verdict to read: the report says
  `readiness: "no-usage-detected"` and every number beside it measures the
  scanner's blind spot, not the app. This count is `0` in the current
  observation and any return to a non-zero value is a detection regression.

The regression gate compares a fresh run against the published observation and
fails when an app's auto-migrated ratio drops or when usage that was previously
visible stops being detected.

## Post-codemod build validation (deep mode)

The readiness page counts call sites. It cannot tell you whether the migrated
app still builds — and a codemod that rewrites 86% of call sites into something
that does not compile has not helped anyone. Deep mode answers that, and it is
the only part of the corpus that installs third-party dependencies.

It is therefore a **separate runner** (`scripts/oss-arcgis-corpus-deep.mjs`)
behind a **second switch** and an explicit per-app allowlist
(`deepValidation.apps`). The standard lane is unchanged and still never
installs anything.

### The measurement is paired

Running a build over a stranger's app and reporting the failures proves nothing
about the codemod: third-party apps carry their own pre-existing type errors and
pinned toolchains. So every deep run measures the same app **twice, at the same
commit, with the same installed dependency tree**:

| Phase | What runs |
| --- | --- |
| `baseline` | clone the pin → `npm ci --ignore-scripts` → typecheck probe → the app's build script |
| `migrated` | `codemod --write` → install the packed Honua packages → the same typecheck probe → the same build script |

The app's own diagnostics appear in both phases and cancel. What remains —
`introducedDiagnostics` and a build that passed before and fails after — is the
migration's, and nothing else is claimed.

The typecheck probe is a generated config (`allowJs`, `checkJs`, `strict:
false`, `skipLibCheck`) rather than the app's own, because not every corpus app
ships one. That means the baseline can carry diagnostics the app's author never
saw. This is fine precisely because only the delta is reported — but it is why
the raw diagnostic counts on the published page are not a judgment of the app.

### Supply-chain posture

Recorded in `deepValidation.supplyChain` as booleans the guardrail check
enforces, not as prose:

- **Lifecycle scripts never run.** Every install passes `--ignore-scripts`.
- **Committed lockfile required, used verbatim.** Only apps with a lockfile are
  eligible; `npm ci` resolves it exactly. A repository that commits its own
  `node_modules` has it deleted first, so the measured tree is always the one
  the lockfile describes.
- **The app's manifest is never rewritten.** Honua packages are added with
  `--no-save`; `package.json` and the lockfile stay pristine.
- **Honua packages are packed locally.** `npm pack` from `dist/packages/*`, so
  the bytes under test are the bytes a consumer would install — never a
  registry fetch.
- **Everything is ephemeral.** The checkout, including `node_modules`, is
  deleted when the run ends.

In CI the deep job is dispatch-only, defaults to off, and never runs on the
schedule.

```bash
# Requires BOTH switches
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true HONUA_OSS_ARCGIS_CORPUS_DEEP=true \
  npm run corpus:oss-arcgis:deep

# Refresh the published observation and regenerate the page
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true HONUA_OSS_ARCGIS_CORPUS_DEEP=true \
  npm run corpus:oss-arcgis:deep:publish
npm run docs:oss-arcgis-corpus-deep
```

Results: [post-codemod build validation](./oss-arcgis-corpus-post-codemod-build.md).

### Adding an app to the allowlist

An app is eligible when it has a committed lockfile at the pinned commit and a
plain npm build script. `buildScript` is validated as an npm script *name*, so a
manifest edit can never turn it into a shell command. Prefer the smallest app
that still exercises the compat entry; deep runs are minutes, not seconds.

## Gaps the corpus has already found

The first sweep (2026-08-03) is why this corpus exists. Three of the six pinned
apps produced `filesWithArcGisImports=0` — the scanner saw nothing at all —
because `findArcGisImports` in `src/migration/scanner.ts` matched only
`@arcgis/core/*` specifiers. Each gap was filed with the app and the construct
that exposed it:

| Issue | Gap | Exposed by | Status |
| --- | --- | --- | --- |
| [#980](https://github.com/honua-io/honua-sdk-js/issues/980) | AMD `define([...])` / `require([...])` dependency arrays with bare `esri/*` specifiers are invisible | `cmv/cmv-app` — `viewer/js/config/viewer.js`, `viewer/js/gis/dijit/Basemaps.js` | fixed |
| [#981](https://github.com/honua-io/honua-sdk-js/issues/981) | Bare `esri/*` ES-module specifiers, including TypeScript `import X = require("esri/...")`, are invisible | `WSDOT-GIS/bridge-clearance-app` — `src/main.ts`; `ekenes/national-park-visits` — `app/main.ts`, `app/widgets.ts` | fixed |
| [#982](https://github.com/honua-io/honua-sdk-js/issues/982) | A scan that detects nothing reports `readiness: "ready"` with all three gates passing vacuously | All three apps above | fixed |

#981 also recorded a concrete internal inconsistency: on
`ekenes/national-park-visits` the **widget** scanner reported four widget usage
sites in the same files the ArcGIS scanner reported zero imports in, so the two
scanners disagreed about the same source.

The scanner now reads module specifiers off the TypeScript AST and recognizes
AMD dependency arrays, bare `esri/*` ids, and TypeScript import-equals in
addition to the `@arcgis/core/*` shapes it already handled; a bare `esri/<path>`
resolves to the same codemod kind as `@arcgis/core/<path>` wherever the paths
correspond. A report whose scan recognized nothing now says
`readiness: "no-usage-detected"` instead of `ready`, and `--fail-on-no-usage`
turns that into a CI failure. The three formerly dark apps are measured on the
page above; the "Detection gaps" section disappears when no app is dark.

The first deep run (2026-08-04) then found the next layer down. `owls-of-bavaria`
**builds post-codemod** against `@honua/sdk-esri-compat` — baseline build passed,
migrated build passed — but it picked up three type diagnostics it did not have
before, and one of them is structural:

| Issue | Gap | Exposed by |
| --- | --- | --- |
| [#1012](https://github.com/honua-io/honua-sdk-js/issues/1012) | The codemod migrates a construct whose only consumer is out of scope, producing a compat-to-ArcGIS value handoff that cannot typecheck — and still counts the call site as auto-migrated | `lujoh/owls_of_bavaria` — `src/features/map/filterOwlLayer.jsx`: `FeatureFilter` → `FeatureFilterCompat` handed to an un-migrated `@arcgis/core/layers/support/FeatureEffect` |
| [#1013](https://github.com/honua-io/honua-sdk-js/issues/1013) | `FeatureFilterCompat.objectIds` is `ReadonlyArray<number \| string>` where ArcGIS declares a mutable `number[]` — an undocumented divergence from the surface being emulated | the same call site |

The other two introduced diagnostics are restatements rather than new problems:
both are pre-existing errors in the app's untyped Redux wiring whose *message*
changed because the value is now named `MapViewCompat` instead of `any`. They
are listed verbatim on the published page anyway — the generated evidence stays
mechanical, and the argument about what each one means lives here, where it can
be reviewed.

What the corpus measures now is the *next* cliff, and it is the honest one: the
codemod rewrites nothing inside an AMD module body (`cmv-app`: 0 of 27
codemod-scoped call sites auto-migrated), because rewriting a constructor while
the Dojo loader still delivers the ArcGIS module would leave the file broken.
Those call sites are reported as manual TODOs, and the `esri/dijit/*` widget
namespace — which has no `@arcgis/core` counterpart at all — is reported as
unhandled modules rather than being mapped onto a 4.x construct it is not.

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
