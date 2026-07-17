<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Error tree-shaking evidence

Deterministic #583 evidence from the same esbuild configuration used by the bundle-budget gate.
The contractual ceiling is the integer floor of 75% of each admitted #524 gzip baseline.

| Target | #524 baseline | Current gzip | Reduction | 25% ceiling | Status | Retained error modules |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| `/routing` | 7109 B | 4324 B | 39.18% | 5331 B | Pass | `dist/src/core/error-base.js` |
| `/geocoding` | 8488 B | 5832 B | 31.29% | 6366 B | Pass | `dist/src/core/error-base.js` |
| `/auth` | 8139 B | 5461 B | 32.90% | 6104 B | Pass | `dist/src/core/error-base.js` |
| `/realtime` | 12598 B | 9064 B | 28.05% | 9448 B | Pass | `dist/src/core/error-base.js` |
| `/offline` | 12301 B | 8402 B | 31.70% | 9225 B | Pass | `dist/src/core/error-base.js` |
| `tree-shake:map-source-workflow` | 11161 B | 8364 B | 25.06% | 8370 B | Pass | `dist/src/core/error-base.js` |

## Explicit import fixtures

| Fixture | Min | Gzip | Retained error modules |
| --- | ---: | ---: | --- |
| `tree-shake:error-leaf` | 3656 B | 1450 B | `dist/src/core/error-base.js` |
| `tree-shake:error-registry` | 10858 B | 2388 B | `dist/src/core/error-code-registry.js` |
| `tree-shake:error-serializer` | 12526 B | 3703 B | `dist/src/core/error-base.js`<br>`dist/src/core/error-classifications.js`<br>`dist/src/core/error-envelope.js` |

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
| `dist/src/map/source-to-maplibre.js` | 9856 B |
| `dist/src/core/error-base.js` | 3847 B |
| `dist/src/query-planner/plan-integrity.js` | 2909 B |
| `dist/src/query-planner/ir.js` | 2814 B |
| `dist/src/map/geojson-projection.js` | 2210 B |
| `dist/src/query-planner/types.js` | 1459 B |
| `dist/src/core/errors.js` | 416 B |
| `dist/src/core/remove-undefined.js` | 73 B |
