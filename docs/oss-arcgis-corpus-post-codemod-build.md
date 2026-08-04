<!-- GENERATED FILE - DO NOT EDIT.
     Sources of truth: config/oss-arcgis-corpus.v1.json
                       docs/data/oss-arcgis-corpus-deep-build.v1.json
     Regenerate with: npm run docs:oss-arcgis-corpus-deep -->

# Post-codemod build validation

The [readiness page](./oss-arcgis-corpus-readiness.md) counts call sites. It cannot tell you whether the result still *builds*. This page answers that question the only way it can be answered honestly: by installing a pinned third-party app's real dependency tree, running the codemod over it, installing the Honua compat packages, and building it.

Every app is measured **twice at the same commit with the same dependency tree** — once pristine (`baseline`) and once after `codemod --write` (`migrated`). Third-party apps carry their own pre-existing type errors, so only the *delta* is attributable to the migration. Diagnostics that were already there are reported as the app's, not as ours.

- Observation generated: `2026-08-04T08:58:52.826Z`
- Manifest revision: `2026-08-04`
- Honua packages under test: `0.1.2-beta.0` (packed from `dist/packages`, never a registry)
- Typecheck probe: TypeScript `5.9.3`, resolved from this repository so both phases run the identical compiler
- Opt-in: both `HONUA_OSS_ARCGIS_CORPUS_ENABLED=true` and `HONUA_OSS_ARCGIS_CORPUS_DEEP=true` are required

## Supply-chain posture

Deep validation is the one place the corpus installs third-party dependencies, so the posture is stated explicitly and enforced by the manifest guardrails rather than by convention:

| Property | Value |
| --- | --- |
| Lifecycle scripts disabled (`--ignore-scripts`) | yes |
| Committed lockfile required and used verbatim | yes |
| Installed tree is ephemeral | yes |
| App manifest/lockfile never rewritten | yes |
| Honua packages packed locally | yes |

- Deep validation is the only part of the corpus that installs third-party dependencies, and it needs both the corpus opt-in and its own second switch before it does.
- Every install passes `--ignore-scripts`, so no third-party preinstall/install/postinstall script ever executes on the runner.
- Only apps with a committed lockfile are eligible. `npm ci` consumes that lockfile verbatim; the app's package.json and lockfile are never rewritten.
- A repository that commits its own `node_modules` has it deleted before install, so the measured tree is always the one the lockfile resolves.
- Honua packages are `npm pack`ed from `dist/packages/*` and installed with `--no-save`, so the bytes under test are the bytes a consumer would get and the app's manifest stays pristine.
- The checkout, including `node_modules`, is deleted when the run ends unless `--keep-clones` is passed for local inspection.

## Results

| App | Outcome | Baseline build | Migrated build | New diagnostics | Resolved |
| --- | --- | --- | --- | --- | --- |
| [Owls of Bavaria](#owls-of-bavaria) | builds, new diagnostics | pass | pass | 3 | 4 |

1 of 1 allowlisted app built post-codemod against `@honua/sdk-esri-compat`.

## Owls of Bavaria

- Repository: <https://github.com/lujoh/owls_of_bavaria>
- Pinned commit: `284949156925c63b0258aece1f48cd9e4f5ea55d`
- License: `MIT`
- Observed: 2026-08-04
- Build script: `npm run build` in `.`
- Lockfile: `package-lock.json`
- Codemod scan root: `src`

The codemod rewrote 6 of 7 in-scope call sites across 3 files to `@honua/sdk-esri-compat`, leaving 1 annotated manual TODO. The un-migrated call sites keep importing `@arcgis/core`, so the build below exercises a genuinely half-migrated module graph.

| Step | Baseline | Migrated |
| --- | --- | --- |
| Typecheck | **fail** (27 diagnostics) | **fail** (26 diagnostics) |
| Build | pass | pass |

### Diagnostics the migration introduced

These are present after the codemod and absent before it, at the same commit with the same installed dependencies. They are the migration's to answer for.

```text doc-test=skip reason="captured tsc output, not a compilable snippet"
src/components/MapWindow.jsx: error TS2345: Argument of type 'AsyncThunkAction<MapViewCompat, void, AsyncThunkConfig>' is not assignable to parameter of type 'AnyAction'.
src/features/map/filterOwlLayer.jsx: error TS2322: Type 'FeatureFilterCompat' is not assignable to type 'FeatureFilterProperties'.
src/features/map/mapSlice.jsx: error TS2322: Type 'void' is not assignable to type 'string | HTMLElement'.
```

### Diagnostics the migration removed

Reported for symmetry, not as a win: most of these disappear because a compat type is looser than the ArcGIS type it replaced, which is a fact about the shim, not an improvement to the app.

```text doc-test=skip reason="captured tsc output, not a compilable snippet"
src/features/map/loadMap.jsx: error TS2353: Object literal may only specify known properties, and 'xmin' does not exist in type 'Geometry'.
src/features/map/loadOwlFeatureLayer.jsx: error TS2353: Object literal may only specify known properties, and 'type' does not exist in type 'GeometryProperties'.
src/features/map/loadOwlFeatureLayer.jsx: error TS2353: Object literal may only specify known properties, and 'type' does not exist in type 'SymbolProperties'.
src/features/map/mapSlice.jsx: error TS2322: Type 'void' is not assignable to type 'HTMLDivElement'.
```

The app ships no TypeScript, so the probe type-checks its JavaScript with `allowJs`/`checkJs` rather than running a config the author maintained. That is why the baseline carries diagnostics the author never saw — and why only the paired delta is reported as the migration's.

## Reproducing this page

```bash doc-test=skip reason="shell commands for the opt-in deep lane, not a compilable snippet"
HONUA_OSS_ARCGIS_CORPUS_ENABLED=true HONUA_OSS_ARCGIS_CORPUS_DEEP=true npm run corpus:oss-arcgis:deep:publish
npm run docs:oss-arcgis-corpus-deep
```

See [docs/oss-arcgis-corpus.md](./oss-arcgis-corpus.md) for the corpus manifest, license policy, and the standard (static-analysis-only) lane.

