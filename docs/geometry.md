# `@honua/geometry` — client-side geometry operations

`@honua/geometry` (the `@honua/sdk-js/geometry` subpath, split-packaged as
`@honua/geometry`) adds curated, tree-shakeable client-side geometry operations
and reprojection to the Honua SDK, wrapping the individual [`@turf/*`](https://turfjs.org)
packages and [`proj4`](https://github.com/proj4js/proj4js). It is typed against
the SDK's own GeoJSON contract and never reimplements the underlying algorithms.

The core SDK has **no dependency edge** into this module, so core-only consumers
never pull turf/proj4 into their bundle. See
[`decisions/geometry-library-selection.md`](./decisions/geometry-library-selection.md)
for the dependency-placement ADR.

## Install / import

```bash
# split package (turf/proj4 are regular deps — zero config)
npm install @honua/geometry

# or via the unified SDK subpath (install the turf/proj4 optional peers you use)
npm install @honua/sdk-js @turf/buffer @turf/area proj4
```

```ts doc-test=skip reason="partial excerpt requires application host context"
import { area, buffer, project, toWgs84 } from "@honua/geometry";
// unified: import { area, buffer } from "@honua/sdk-js/geometry";
```

## Operations

| Op | turf backing | Notes |
| --- | --- | --- |
| `buffer(geom, radius, unit?)` | `@turf/buffer` | Geodesic buffer; `unit` default `"meters"`. |
| `area(geom)` | `@turf/area` | Geodesic area in **m²**. |
| `length(geom, unit?)` | `@turf/length` | Geodesic length; `unit` default `"meters"`. |
| `centroid(geom)` | `@turf/centroid` | Returns a `Point`. |
| `bbox(geom)` | `@turf/bbox` | `[minX, minY, maxX, maxY]`. |
| `simplify(geom, tolerance, highQuality?)` | `@turf/simplify` | Ramer–Douglas–Peucker vertex reduction. |
| `booleanIntersects(a, b)` | `@turf/boolean-intersects` | Predicate. |
| `booleanContains(a, b)` | `@turf/boolean-contains` | Predicate. |
| `booleanWithin(a, b)` | `@turf/boolean-within` | Predicate. |
| `union(...polys)` | `@turf/union` | Polygon union; `null` if empty. |
| `intersect(a, b)` | `@turf/intersect` | Polygon intersection; `null` if disjoint. |
| `difference(a, b)` | `@turf/difference` | Polygon `a − b`; `null` if fully removed. |
| `nearestPoint(target, points)` | `@turf/nearest-point` | Nearest candidate `Feature<Point>`. |
| `convex(geom)` | `@turf/convex` | Convex hull; `null` if undefined. |

### Units

Linear units (`buffer`, `length`): `"meters"` (default), `"kilometers"`,
`"miles"`, `"feet"`, `"yards"`, `"nauticalmiles"`. `area` always returns square
meters — divide by the relevant factor for other units.

## Reprojection

| Function | Purpose |
| --- | --- |
| `project(geom, fromCrs, toCrs)` | Reproject between any registered CRS. |
| `toWgs84(geom, fromCrs)` | Fast path → EPSG:4326. |
| `toWebMercator(geom, fromCrs)` | Fast path → EPSG:3857. |
| `defineProjection(code, proj4def)` | Register an additional CRS on demand. |
| `normalizeCrs(code)` | Resolve numeric/`"EPSG:xxxx"`/alias codes to a proj4 id. |

Only **EPSG:4326** and **EPSG:3857** are bundled (both are built into proj4, so
the module registers nothing at import time and is side-effect-safe for
tree-shaking). Web Mercator aliases (`3785`, `900913`, `102100`, `102113`) are
normalized to `EPSG:3857`. `project` never mutates its input; a same-CRS call is
a deep clone. Extra ordinates (`z`/`m`) pass through untouched.

```ts doc-test=skip reason="partial excerpt requires application host context"
defineProjection(32610, "+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs +type=crs");
const utm = project(feature.geometry, 4326, 32610);
```

## CRS caveats

- turf operates on **WGS84 longitude/latitude degrees**. Feed geographic
  coordinates to `area`/`length`/`buffer`, or reproject first.
- Running geodesic ops on projected coordinates (e.g. raw Web Mercator meters)
  yields wrong results — reproject to 4326 first (`toWgs84`).
- Coordinate-space ops (`union`/`intersect`/`difference`/`simplify`/`convex`
  and the boolean predicates) are CRS-agnostic as long as **both** operands
  share the same CRS.

## `geometryEngine` compat shim

For ArcGIS migrants, `@honua/sdk-js/esri-compat` exposes a
`geometryEngine`-shaped shim (`geometryEngineCompat` / `geometryEngineAsyncCompat`)
backed by `@honua/geometry`. Inputs may be plain Esri-JSON geometries or Honua
compat instances (`PointCompat`, `PolygonCompat`, …) that expose `toJSON()`.
Results are Esri geometries stamped with the source `spatialReference`. The
migration codemod rewrites
`import geometryEngine from "@arcgis/core/geometry/geometryEngine"` (and
`geometryEngineAsync`) to these shims.

### Coverage matrix

| geometryEngine op | Shim | turf backing | Semantic difference vs. Esri |
| --- | --- | --- | --- |
| `buffer` | ✅ `buffer` | `@turf/buffer` | Esri `buffer` is **planar**; the shim is **geodesic** (closer to `geodesicBuffer`). |
| `union` | ✅ `union` | `@turf/union` | Coordinate-space; parity within polygon-clipping tolerance. |
| `intersect` | ✅ `intersect` | `@turf/intersect` | Coordinate-space. `null` when disjoint. |
| `difference` | ✅ `difference` | `@turf/difference` | Coordinate-space. |
| `geodesicArea` | ✅ `geodesicArea` | `@turf/area` | Reprojects to WGS84; spherical model. |
| `planarArea` | ✅ `planarArea` | shoelace | Exact in a projected CRS (e.g. Web Mercator); meaningless in degrees. |
| `geodesicLength` | ✅ `geodesicLength` | `@turf/length` | Reprojects to WGS84; spherical model. |
| `planarLength` | ✅ `planarLength` | Euclidean | Exact in a projected CRS. |
| `simplify` | ✅ `simplify` | Esri↔GeoJSON round-trip | **Topological normalization** (ring rewinding), not vertex reduction. Use `@honua/geometry`'s `simplify(geom, tolerance)` for RDP thinning. |
| `convexHull` | ✅ `convexHull` | `@turf/convex` | Coordinate-space. |
| `contains` | ✅ `contains` | `@turf/boolean-contains` | Predicate. |
| `intersects` | ✅ `intersects` | `@turf/boolean-intersects` | Predicate. |
| `geodesicDensify`, `densify`, `offset`, `cut`, `generalize`, `nearestCoordinate`, `nearestVertex`, `rotate`, `flip*`, `clip`, `overlaps`, `touches`, `crosses`, `within`, `disjoint`, `equals`, `isSimple`, `relate`, `symmetricDifference`, `geodesicBuffer` | ❌ not shimmed | — | Migration codemod keeps a **manual-intervention TODO** for these call sites. |

### Parity tolerances

Numerical parity is tested in `test/geometry-engine-compat.test.ts` against
analytically-derived expected outputs (fixtures use Web Mercator geometries so
planar ops have exact values):

- **planar area / length:** exact to `< 1e-6` relative (pure coordinate
  arithmetic).
- **geodesic area / length:** within ~0.5 % of the great-circle analytic value
  (turf's spherical model vs. a spherical hand-calc).
- **buffer:** asserted on monotonic area growth and output shape, not exact
  vertices (geodesic turf buffer ≠ Esri planar buffer).

## Example: measure + buffer + reproject

```ts doc-test=skip reason="partial excerpt requires application host context"
import { area, buffer, toWgs84 } from "@honua/geometry";

// A parcel returned in Web Mercator (EPSG:3857).
const parcel3857 = feature.geometry;

// Reproject to WGS84 so geodesic measures are correct.
const parcel = toWgs84(parcel3857, 3857);

// Measure it (m²) and grow a 25 m setback ring.
const parcelArea = area(parcel);
const setback = buffer(parcel, 25, "meters");

console.log(`parcel is ${parcelArea.toFixed(0)} m²`);
```
