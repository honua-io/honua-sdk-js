# Esri-compat installed-package browser driver

`test/playwright/migration-browser-installed-package.spec.mjs` is the
installed-package browser driver for the 2026.1 codemod cohort
(honua-sdk-js#1662). It answers a question the rest of the migration test
suite does not: does a real consumer's install of the published packages
actually work in a browser, end to end, against a real service?

`test/playwright/migration-browser-real-sample.spec.mjs` proves the
compat layer's *generated behavior* is correct by serving `dist/src/**`
straight out of this checkout. That is not proof of the installed bytes: the
split-package boundary (`scripts/prepare-split-packages.mjs`) rewrites
cross-package imports and changes what a consumer actually receives. This
driver closes that gap by proving the same fixtures run correctly when:

1. `dist/packages/honua-sdk` and `dist/packages/honua-sdk-esri-compat` are
   `npm pack`ed and `npm install`ed into a throwaway consumer — never a
   directory reference into this checkout, the same technique
   [`docs/oss-arcgis-corpus-post-codemod-build.md`](./oss-arcgis-corpus-post-codemod-build.md)
   uses for third-party apps.
2. The codemod (`src/migration/codemod.ts`, unmodified) runs with its
   **default** `compatImportPath` (`@honua/sdk-esri-compat`) — real migrated
   output imports the published package by name, not a repo-relative path.
3. The installed package trees are served to a real Chromium instance with
   an import map resolving those bare specifiers to the installed bytes.

## What it certifies

- **Rendering, querying/filtering, paging, popup/selection, layer controls,
  search, measurement, routing/directions, and editing** — reused from the
  four `esri-real-sample-*` / `esri-demo-feature-table-*` fixtures already
  proven by `migration-browser-real-sample.spec.mjs`, now executed from
  installed bytes instead of `dist/src`.
- **A real HTTP round trip against a real Honua service** —
  `esri-real-sample-service-query-app` (TypeScript) points its migrated
  `FeatureLayer` at `honua-featureserver-fixture-server.mjs`, a
  protocol-faithful GeoServices `FeatureServer` (the same wire shape
  `src/core/geoservices.ts` speaks against a real `honua-server`), across a
  real cross-origin HTTP boundary (CORS preflight included, not proxied).
  It proves query + `where`-filtering + `resultOffset`/`resultRecordCount`
  paging + `applyEdits` (editing) all execute as genuine network requests.
- **The documented auth-error-then-retry path** — the same fixture first
  attempts the query unauthenticated, receives the real GeoServices
  `{error:{code:498}}` envelope the fixture server returns, and the compat
  `FeatureLayerCompat` surfaces it as `HonuaHttpError` with
  `statusCode === 498` — exactly the pattern documented in `src/core/errors.ts`'s
  own JSDoc example — before retrying with a `HonuaClient` configured with a
  bearer token.
- **No hidden `@arcgis/core` runtime** — every fixture asserts zero requests
  to an `arcgis`-origin host, checked against what Chromium actually issued,
  not inferred from the codemod's manual-call-site count.
- **Required widget registration fails visibly, not silently** — already
  covered end to end by `test/esri-compat-widget-kit-diagnostic.test.ts`
  (issue #957): a compat widget mount with no registered widget kit emits a
  `console.warn` plus a `widget-kit.missing` bus event rather than rendering
  an inert control. This driver does not duplicate that coverage.
- **Pristine-versus-migrated build/typecheck delta for an independent
  third-party app** — already covered by the `oss-arcgis-corpus-deep` lane
  (see [`docs/oss-arcgis-corpus-post-codemod-build.md`](./oss-arcgis-corpus-post-codemod-build.md));
  this driver does not re-implement that comparison.

## Reproducing

```bash
npm run test:playwright:migration-installed-driver
```

This builds `dist/packages/*` first, then runs only this spec. The spec's
own `beforeAll` skips (not fails) when `dist/packages/*` has not been built,
so the default `npm run test:playwright` matrix — which never runs the
heavier split-package build — stays green and unaffected.

## Release certification

Each test run is a pass/fail proof against the exact `dist/packages/*` bytes
under test; there is no separate receipt file to keep in sync. To bind a run
to a specific release candidate the way
`scripts/installed-package-certification.mjs` binds the SDK-wide gate to a
candidate server image digest, capture this spec's `npx playwright test
--reporter=json` output alongside the `dist/packages/*/package.json`
versions it packed — the same package-coordinate/version fields
`installed-package-certification`'s receipt already records.
