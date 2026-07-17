<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Error tree-shaking evidence

Deterministic #583 evidence from the same esbuild configuration used by the bundle-budget gate.
The contractual ceiling is the integer floor of 75% of each admitted #524 gzip baseline.

| Target | #524 baseline | Current gzip | Reduction | 25% ceiling | Status | Retained error modules |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `/routing` | 7109 B | 4341 B | 38.94% | 5331 B | Pass | `dist/src/core/error-base.js` |
| `/geocoding` | 8488 B | 5852 B | 31.06% | 6366 B | Pass | `dist/src/core/error-base.js` |
| `/auth` | 8139 B | 5466 B | 32.84% | 6104 B | Pass | `dist/src/core/error-base.js` |
| `/realtime` | 12598 B | 9067 B | 28.03% | 9448 B | Pass | `dist/src/core/error-base.js` |
| `/offline` | 12301 B | 8404 B | 31.68% | 9225 B | Pass | `dist/src/core/error-base.js` |
| `tree-shake:map-source-workflow` | 11161 B | 8740 B | 21.69% | 8370 B | Variance (+370 B) | `dist/src/core/error-base.js` |

## Explicit import fixtures

| Fixture | Min | Gzip | Retained error modules |
| --- | ---: | ---: | --- |
| `tree-shake:error-leaf` | 3660 B | 1453 B | `dist/src/core/error-base.js` |
| `tree-shake:error-registry` | 10858 B | 2388 B | `dist/src/core/error-code-registry.js` |
| `tree-shake:error-serializer` | 12538 B | 3700 B | `dist/src/core/error-base.js`<br>`dist/src/core/error-classifications.js`<br>`dist/src/core/error-envelope.js` |

The leaf fixture imports only `@honua/sdk-js/realtime`; it must retain `error-base.js` and exclude the
complete runtime-classification table, descriptive registry, and explicit serializer module. The registry
fixture intentionally retains descriptors. The serializer fixture retains compact classifications but excludes
human-readable descriptors. Fixture sources use public package specifiers and are also bundled from the packed
tarball by `npm run verify:packed-sdk`.

## Map workflow retained-input attribution

Exact esbuild metafile attribution for the map source workflow, sorted by each retained input's bytes in the
minified output. This makes any NFR variance reviewable without removing plan-integrity or credential-admission
logic.

| Retained input | Bytes in minified output |
| --- | ---: |
| `dist/src/map/source-to-maplibre.js` | 9334 B |
| `dist/src/query-planner/ir.js` | 4290 B |
| `dist/src/core/error-base.js` | 3915 B |
| `dist/src/query-planner/plan-integrity.js` | 1947 B |
| `dist/src/map/geojson-projection.js` | 1806 B |
| `dist/src/query-planner/types.js` | 1459 B |
| `dist/src/map/feature-service-adapter.js` | 1077 B |
| `dist/src/query-planner/canonical.js` | 966 B |
| `dist/src/core/errors.js` | 416 B |
