/**
 * Deterministic GeoServices feature fixture for the real-Cesium entity lane
 * (honua-sdk-js#1050).
 *
 * The accepted-plan `Source` → Cesium entity path only accepts a *real* source:
 * it re-hashes the plan, compares the descriptor identity the plan was built
 * from against the live descriptor, and executes the plan's remote query itself.
 * A hand-rolled feature array cannot exercise any of that, so this module serves
 * a small GeoServices Feature Layer instead and the lane connects to it through
 * `createHonua()` exactly as an application would.
 *
 * The module is deliberately free of Node built-ins so the *same* file is the
 * single source of truth on both sides of the lane: the spec imports it in Node
 * to answer requests, and the browser harness imports it over loopback to know
 * what the source declared. Expectations are therefore never hand-copied.
 *
 * Two snapshots are published for the same layer. `refresh()` re-executes the
 * accepted plan unchanged, so the only honest way to observe a data change is to
 * change what the source answers — which is what {@link ENTITY_SOURCE_SNAPSHOT_PATH}
 * lets the page do between the mount and the refresh.
 *
 * @module
 */

/** Fixture anchor, shared with `cesium-scene-fixture-assets.mjs`. */
export const ENTITY_ORIGIN = Object.freeze({ longitude: -157.858, latitude: 21.307 });

/** Service root handed to `honua.connect()`; the adapter appends `/rest/services/...`. */
export const ENTITY_SOURCE_LAYER_PATH = "/fixtures/entity-source/rest/services/ResponseUnits/FeatureServer/0";

/** Control endpoint: `?name=a|b` selects which snapshot the layer answers with. */
export const ENTITY_SOURCE_SNAPSHOT_PATH = "/fixtures/entity-source/snapshot";

/** The layer's stable feature identity attribute, passed as `featureIdField`. */
export const ENTITY_ID_FIELD = "unit_id";

/**
 * Availability windows, and the two clock instants the lane evaluates them at.
 *
 * The day-shift units are available at `insideWindow` only and the night-shift
 * unit at `earlyWindow` only, so no single instant can make every entity
 * available. That turns "Cesium honours the projected availability" into a
 * two-by-two truth table instead of one assertion that could pass by accident.
 */
export const ENTITY_TIMES = Object.freeze({
  earlyWindow: "2026-03-01T01:00:00Z",
  insideWindow: "2026-03-01T12:00:00Z",
  dayShift: Object.freeze({ start: "2026-03-01T06:00:00Z", end: "2026-03-01T18:00:00Z" }),
  nightShift: Object.freeze({ start: "2026-03-01T00:00:00Z", end: "2026-03-01T03:00:00Z" }),
});

const DAY = ENTITY_TIMES.dayShift;
const NIGHT = ENTITY_TIMES.nightShift;

/**
 * Fixture layout, in degrees from {@link ENTITY_ORIGIN}.
 *
 * Everything is kept inside the nadir frustum of the shared `fixture-camera`
 * viewpoint (900 m straight down, roughly a 1 km × 700 m footprint) and no two
 * features overlap on screen, so a pick at one feature's projected position can
 * only be that feature.
 */
const ZONE_OUTER_ORIGIN = Object.freeze({ longitude: 0.0006, latitude: -0.0018, size: 0.0036 });
const ZONE_HOLE_ORIGIN = Object.freeze({ longitude: 0.0018, latitude: -0.0006, size: 0.0012 });

function at(longitudeOffset, latitudeOffset) {
  return [ENTITY_ORIGIN.longitude + longitudeOffset, ENTITY_ORIGIN.latitude + latitudeOffset];
}

function point(longitudeOffset, latitudeOffset, height) {
  const [x, y] = at(longitudeOffset, latitudeOffset);
  return { x, y, z: height };
}

/** Esri exterior rings wind clockwise (negative shoelace area); interior rings wind the other way. */
function ring({ longitude, latitude, size }, clockwise) {
  const [west, south] = at(longitude, latitude);
  const corners = [
    [west, south],
    [west, south + size],
    [west + size, south + size],
    [west + size, south],
    [west, south],
  ];
  return clockwise ? corners : [...corners].reverse();
}

function unit(id, label, geometry, shift) {
  return { attributes: { unit_id: id, label, observed_at: shift.start, expires_at: shift.end }, geometry };
}

/**
 * Snapshot A — the mounted state.
 *
 * Four features materialize (one per geometry kind the slice supports, with the
 * point pair split across the two availability windows) and two are deliberately
 * unprojectable, so every mount also proves the omission diagnostics fire
 * against a real source rather than only in jsdom.
 */
const SNAPSHOT_A = Object.freeze([
  unit("medic-1", "Medic 1", point(-0.0025, -0.0015, 120), DAY),
  unit("engine-2", "Engine 2", point(-0.0025, 0.0015, 140), NIGHT),
  unit("patrol-3", "Patrol 3", { paths: [[at(-0.0035, -0.0025), at(0, -0.0028), at(0.0035, -0.0025)]] }, DAY),
  unit("zone-a", "Zone A", { rings: [ring(ZONE_OUTER_ORIGIN, true), ring(ZONE_HOLE_ORIGIN, false)] }, DAY),
  // No `unit_id`: omitted with `identity-missing` rather than given a synthetic id.
  { attributes: { label: "Unidentified", observed_at: DAY.start, expires_at: DAY.end }, geometry: point(0.02, 0, 0) },
  // Unparseable interval: omitted with `time-interval-invalid` rather than mounted
  // with an invented availability.
  {
    attributes: { unit_id: "ghost-9", label: "Ghost 9", observed_at: "not-a-time", expires_at: DAY.end },
    geometry: point(0.03, 0, 0),
  },
]);

/**
 * Snapshot B — what the source answers after the page advances it.
 *
 * Chosen so one refresh covers every case at once: `medic-1` and `zone-a` are
 * byte identical (a point and a hole-bearing polygon), `engine-2` moved,
 * `patrol-3` is gone, and `ladder-9` is new. The unchanged rows are the
 * load-bearing ones — they are how the lane measures, by object identity on a
 * live collection, that the refresh diff really does carry an untouched feature
 * across instead of replacing its `Entity`.
 */
const SNAPSHOT_B = Object.freeze([
  SNAPSHOT_A[0],
  unit("engine-2", "Engine 2", point(-0.0035, 0.0015, 160), NIGHT),
  SNAPSHOT_A[3],
  unit("ladder-9", "Ladder 9", point(-0.0015, 0.0025, 90), DAY),
  SNAPSHOT_A[4],
  SNAPSHOT_A[5],
]);

export const ENTITY_SOURCE_SNAPSHOTS = Object.freeze({ a: SNAPSHOT_A, b: SNAPSHOT_B });

/**
 * Ground positions the lane picks at, in `[longitude, latitude]`.
 *
 * `polygonSolid` is inside the zone's exterior ring and outside its interior
 * ring; `polygonHole` is the centre of the interior ring. A `PolygonHierarchy`
 * whose holes never reached the GPU would draw over both.
 */
export const ENTITY_PICK_POSITIONS = Object.freeze({
  polygonSolid: Object.freeze(at(ZONE_OUTER_ORIGIN.longitude + 0.0004, 0)),
  polygonHole: Object.freeze(at(ZONE_HOLE_ORIGIN.longitude + ZONE_HOLE_ORIGIN.size / 2, 0)),
});

/**
 * What the lane expects each snapshot to project to, derived from the fixture
 * itself rather than restated by hand. `suffix` is the trailing part of the
 * entity id the adapter mints (`honua-<source>:s:<feature id>`).
 */
function expectation(feature, kind) {
  const attributes = feature.attributes;
  return Object.freeze({
    suffix: `s:${attributes.unit_id}`,
    featureId: attributes.unit_id,
    label: attributes.label,
    kind,
    availableAt: Object.freeze({
      earlyWindow: attributes.observed_at === NIGHT.start,
      insideWindow: attributes.observed_at === DAY.start,
    }),
    ...(kind === "point"
      ? {
          position: Object.freeze({
            longitude: feature.geometry.x,
            latitude: feature.geometry.y,
            height: feature.geometry.z ?? 0,
          }),
        }
      : {}),
    ...(kind === "polyline" ? { vertexCount: feature.geometry.paths[0].length } : {}),
    ...(kind === "polygon" ? { holeCount: feature.geometry.rings.length - 1 } : {}),
  });
}

/** Expectations in projection order — the adapter mounts features in source order. */
export const ENTITY_EXPECTATIONS = Object.freeze({
  a: Object.freeze([
    expectation(SNAPSHOT_A[0], "point"),
    expectation(SNAPSHOT_A[1], "point"),
    expectation(SNAPSHOT_A[2], "polyline"),
    expectation(SNAPSHOT_A[3], "polygon"),
  ]),
  b: Object.freeze([
    expectation(SNAPSHOT_B[0], "point"),
    expectation(SNAPSHOT_B[1], "point"),
    expectation(SNAPSHOT_B[2], "polygon"),
    expectation(SNAPSHOT_B[3], "point"),
  ]),
  /** Omitted by design; the mount reports each with a stable diagnostic code. */
  omittedDiagnostics: Object.freeze(["identity-missing", "time-interval-invalid"]),
});

/** Layer metadata: the smallest document the GeoServices adapter needs to describe a queryable layer. */
export function buildEntitySourceLayerMetadata() {
  return {
    currentVersion: 11.2,
    id: 0,
    name: "Response Units",
    type: "Feature Layer",
    geometryType: "esriGeometryPoint",
    capabilities: "Query",
    supportedQueryFormats: "JSON",
    useStandardizedQueries: true,
    objectIdField: "OBJECTID",
    advancedQueryCapabilities: { supportsPagination: true },
    extent: { xmin: -157.95, ymin: 21.25, xmax: -157.75, ymax: 21.35, spatialReference: { wkid: 4326 } },
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
      { name: "unit_id", type: "esriFieldTypeString", alias: "Unit", length: 32 },
      { name: "label", type: "esriFieldTypeString", alias: "Label", length: 64 },
      { name: "observed_at", type: "esriFieldTypeString", alias: "Observed", length: 32 },
      { name: "expires_at", type: "esriFieldTypeString", alias: "Expires", length: 32 },
    ],
  };
}

/** Query response for one snapshot. Never transfer-limited: the ceiling is asserted separately. */
export function buildEntitySourceQueryResponse(snapshotName) {
  return {
    objectIdFieldName: "OBJECTID",
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326 },
    fields: buildEntitySourceLayerMetadata().fields,
    features: ENTITY_SOURCE_SNAPSHOTS[snapshotName],
    exceededTransferLimit: false,
  };
}
