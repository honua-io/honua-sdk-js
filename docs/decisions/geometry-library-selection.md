# Geometry library selection

Status: implementation-time decision for `honua-sdk-js#351`
(`@honua/geometry` — curated turf/proj4 ops + geometryEngine compat shim).

## Constraint context

Two project constraints frame this decision, pulling in opposite
directions — the same tension recorded in
[`odata-library-selection.md`](./odata-library-selection.md):

- **`must_follow` on the ticket:** "curate and re-export tree-shaken
  `@turf/*` + `proj4` — do **not** reimplement algorithms."
- **Project dependency policy:** the core `@honua/sdk-js` package has
  exactly **one** runtime dependency by deliberate design
  (`@maplibre/maplibre-gl-style-spec`). Everything heavier
  (`maplibre-gl`, `cesium`, `@bufbuild/*`, `@connectrpc/*`) is an
  **optional peer dependency**, pulled in only by the subpaths that
  need it.

The first says wrap turf/proj4. The second says do not grow the core
package's hard-dependency surface.

## Selection criteria

| Criterion | Bar |
| --- | --- |
| License | Apache-2.0 / MIT compatible |
| Algorithms | Do not hand-roll buffer/area/overlay/reprojection |
| Tree-shaking | A consumer importing one op must not pull the rest |
| Core isolation | No import edge from core entrypoints (`src/index.ts`, `src/honua.ts`) into the geometry code |
| Types | First-party `.d.ts`; typed against the SDK's own GeoJSON contract, not a new public `@types/geojson` surface |
| Side-effect safety | `proj4` definition registration must not run at import time (`sideEffects` audit) |

## Candidates evaluated

| Option | Verdict |
| --- | --- |
| Monolithic `@turf/turf` | Rejected — importing any op pulls the whole ~500 KB bundle; defeats the tree-shaking bar. |
| Individual `@turf/*` packages | **Chosen for ops.** Each op wraps exactly one package (`@turf/buffer`, `@turf/area`, …) so a single-op import stays small. |
| `jsts` | Rejected — JTS port is large, GC-heavy, and not tree-shakeable per op; overkill for the curated surface. |
| Hand-rolled geodesy | Rejected by the ticket's `must_follow`. |
| `proj4` | **Chosen for reprojection.** De-facto standard, ships types, has EPSG:4326 / EPSG:3857 built in (no registration needed for the two bundled CRS). |
| `epsg-index` / `proj4-list` | Rejected as a default — bundling a global EPSG registry is weight nobody needs; custom CRS register on demand via `defineProjection`. |

## Decision

### 1. Wrap individual `@turf/*` packages + `proj4`

`src/geometry/ops.ts` wraps one turf package per function; `src/geometry/project.ts`
wraps `proj4`. Nothing is reimplemented. The API is typed against the SDK's own
`GeoJsonGeometry` / `GeoJsonFeature` contract (`src/expr/expression.ts`,
`src/core/types.ts`), and Esri ↔ GeoJSON conversion **reuses** the single
canonical converter in `src/core/esri-geojson.ts` (heritage of #264) — the
reverse direction (`geoJsonToEsriGeometry`) was added there rather than forked.

### 2. Dependency placement: optional peers on the unified package, real deps on the split package

This mirrors the established `maplibre-gl` / `cesium` precedent:

- **Unified `@honua/sdk-js`:** turf packages + `proj4` are declared as
  **optional `peerDependencies`** (`peerDependenciesMeta.optional = true`).
  The hard-`dependencies` count stays at exactly **one**. Consumers of the
  `@honua/sdk-js/geometry` subpath install the turf/proj4 peers the same way
  `@honua/sdk-js/map` consumers install `maplibre-gl`.
- **Split `@honua/geometry`:** turf packages + `proj4` are **regular
  `dependencies`**, so the split package's advertised workflow
  (`npm install @honua/geometry`) is zero-config.
- **`@honua/sdk-esri-compat`:** because the `geometryEngine` compat shim is
  backed by the geometry package, the compat split package copies
  `src/geometry` and declares the same turf/proj4 runtime deps.

### 3. No core → geometry edge; tree-shaking preserved

Core entrypoints never import `src/geometry`. Bundlers therefore drop turf/proj4
entirely for core-only consumers regardless of `package.json` placement
(NFR-001's "no dependency edge from core → geometry"). Importing a single op
(`import { buffer } from "@honua/geometry"`) only reaches that op's turf package.

### 4. Side-effect-safe reprojection

`proj4` knows EPSG:4326 and EPSG:3857 natively, so the module registers
**nothing** at import time. `defineProjection(code, def)` registers additional
CRS lazily at call time. `src/geometry/*` is absent from the `package.json`
`sideEffects` allowlist, so it is treated as side-effect-free.

## Exit plan

The public surface (`@honua/geometry` barrel + the `geometryEngineCompat`
shim) is stable and type-only-coupled to the SDK contract. Swapping a turf
package for a lighter implementation, or replacing `proj4`, is a localized
change inside `src/geometry/{ops,project}.ts` and does not touch the contract
types or the compat shim's signatures.

## Known semantic caveats (documented, not papered over)

- turf area/length/buffer are **geodesic**; the compat shim's `planar*`
  variants compute in the geometry's native coordinate plane. See
  [`../geometry.md`](../geometry.md) for the per-op matrix and tolerances.
- `geometryEngine.simplify` (topological repair) is approximated by an
  Esri↔GeoJSON round-trip, not turf's RDP vertex reduction.
