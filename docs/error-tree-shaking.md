<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run report:bundle-sizes -->

# Error tree-shaking evidence

Deterministic #583 evidence from the same esbuild configuration used by the bundle-budget gate.
The contractual ceiling is the integer floor of 75% of each admitted #524 gzip baseline.

| Target | #524 baseline | Current gzip | Reduction | 25% ceiling | Retained error modules |
| --- | ---: | ---: | ---: | ---: | --- |
| `/routing` | 7109 B | 4341 B | 38.94% | 5331 B | `dist/src/core/error-base.js` |
| `/geocoding` | 8488 B | 5852 B | 31.06% | 6366 B | `dist/src/core/error-base.js` |
| `/auth` | 8139 B | 5466 B | 32.84% | 6104 B | `dist/src/core/error-base.js` |
| `/realtime` | 12598 B | 9067 B | 28.03% | 9448 B | `dist/src/core/error-base.js` |
| `/offline` | 12301 B | 8404 B | 31.68% | 9225 B | `dist/src/core/error-base.js` |
| `tree-shake:map-source-workflow` | 11161 B | 8130 B | 27.16% | 8370 B | `dist/src/core/error-base.js` |

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
