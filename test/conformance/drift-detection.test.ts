/**
 * Negative / effectiveness test for the conformance gate.
 *
 * REQ-006 + the acceptance criteria require a demonstration that a *mutated*
 * golden field fails the gate with the standard diagnostic block — i.e. the
 * gate is not trivially always-green. This test runs in the normal unit lane
 * (no live server, no fetched fixtures needed) so the gate's effectiveness is
 * continuously verified in CI even when the live conformance lane is an
 * unconfigured no-op.
 *
 * It uses an inline copy of the canonical `geospatial.v1` feature-query
 * contract shape (the same shape as the shared golden fixture), maps it to the
 * expected `Result`, then asserts that:
 *   - a conformant live `Result` produces zero drift findings; and
 *   - each class of mutation (renamed field, changed type, dropped attribute,
 *     dropped geometry, flipped exceededTransferLimit, wrong totalCount)
 *     produces a non-empty, correctly-classified drift finding.
 */

import type { Result } from "@honua/sdk-js/contract";
import { describe, expect, it } from "vitest";
import { findLiveProjectionDrift, findQueryResultDrift, formatDriftFindings } from "./assert.js";
import {
  type CanonQueryRequest,
  type CanonQueryResponse,
  VALID_ESRI_FIELD_TYPES,
  canonRequestToQuery,
  goldenToExpectedQueryResult,
} from "./mapping.js";

// Inline canonical fixture shapes — mirror conformance/fixtures/*feature_query*
// from the shared bundle so this guardrail does not depend on a fetched bundle.
const CANON_REQUEST: CanonQueryRequest = {
  serviceId: "sf-parks",
  layerId: 0,
  where: "AREA > 1000",
  outFields: ["OBJECTID", "NAME", "AREA"],
  returnGeometry: true,
  outSr: { wkid: 4326, latestWkid: 4326 },
  resultOffsetLong: "0",
  resultRecordCountLong: "10",
  orderBy: "NAME ASC",
};

const CANON_GOLDEN: CanonQueryResponse = {
  objectIdFieldName: "OBJECTID",
  geometryType: "GEOMETRY_TYPE_POINT",
  spatialReference: { wkid: 4326, latestWkid: 4326 },
  fields: [
    { name: "OBJECTID", fieldType: "FIELD_TYPE_BIG_INTEGER", alias: "Object ID" },
    { name: "NAME", fieldType: "FIELD_TYPE_STRING", length: 128, nullable: true, alias: "Park Name" },
    { name: "AREA", fieldType: "FIELD_TYPE_DOUBLE", nullable: true, alias: "Area (sq ft)" },
  ],
  features: [
    {
      id: "42",
      attributes: { NAME: { stringValue: "Golden Gate Park" }, AREA: { doubleValue: 44340000 } },
      geometry: { point: { x: -122.486, y: 37.769 } },
    },
  ],
  exceededTransferLimit: false,
};

/** A synthetic, fully-conformant live `Result` derived from the golden. */
function conformantResult(): Result {
  return {
    features: [
      {
        attributes: { OBJECTID: 42, NAME: "Golden Gate Park", AREA: 44340000 },
        geometry: { x: -122.486, y: 37.769 },
      },
    ],
    exceededTransferLimit: false,
    fields: [
      { name: "OBJECTID", type: "esriFieldTypeInteger" },
      { name: "NAME", type: "esriFieldTypeString", length: 128, nullable: true },
      { name: "AREA", type: "esriFieldTypeDouble", nullable: true },
    ],
  };
}

describe("conformance gate effectiveness (negative drift detection)", () => {
  it("maps the canonical request into a protocol-neutral Query", () => {
    const query = canonRequestToQuery(CANON_REQUEST);
    expect(query.where).toBe("AREA > 1000");
    expect(query.outFields).toEqual(["OBJECTID", "NAME", "AREA"]);
    expect(query.orderBy).toEqual([{ field: "NAME", direction: "asc" }]);
    expect(query.pagination).toEqual({ limit: 10, offset: 0 });
    expect(query.outSr).toBe(4326);
    expect(query.returnGeometry).toBe(true);
  });

  it("fails closed when canonical int64 pagination cannot be represented exactly", () => {
    expect(() =>
      canonRequestToQuery({ ...CANON_REQUEST, resultOffsetLong: "9007199254740992" }),
    ).toThrow(/safe-integer boundary/);
    expect(() => canonRequestToQuery({ ...CANON_REQUEST, resultRecordCountLong: "1.5" })).toThrow(
      /canonical non-negative int64/,
    );
  });

  it("reports zero drift for a conformant live Result", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const drift = findQueryResultDrift(expected, conformantResult());
    expect(drift, formatDriftFindings("feature_query", drift)).toEqual([]);
  });

  it("FAILS when a golden field is renamed/removed on the wire (drift)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = conformantResult();
    // Server renamed AREA -> AREA_SQFT (the honua-server#1238 regression class).
    mutated.fields = mutated.fields?.map((f) => (f.name === "AREA" ? { ...f, name: "AREA_SQFT" } : f));
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.some((d) => d.kind === "missing-field")).toBe(true);
  });

  it("FAILS when a golden field changes type on the wire (drift)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = conformantResult();
    mutated.fields = mutated.fields?.map((f) => (f.name === "AREA" ? { ...f, type: "esriFieldTypeString" } : f));
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.some((d) => d.kind === "field-type")).toBe(true);
  });

  it("FAILS when a golden attribute is dropped from features (drift)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = conformantResult();
    mutated.features = [{ attributes: { OBJECTID: 42, AREA: 44340000 }, geometry: { x: -122.486, y: 37.769 } }];
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.some((d) => d.kind === "missing-attribute")).toBe(true);
  });

  it("FAILS when geometry is dropped from a feature (drift)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = conformantResult();
    mutated.features = [{ attributes: { OBJECTID: 42, NAME: "Golden Gate Park", AREA: 44340000 }, geometry: null }];
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.some((d) => d.kind === "geometry")).toBe(true);
  });

  it("passes when SOME live features carry null geometry (nullable stored geometry, not drift)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = conformantResult();
    mutated.features = [
      { attributes: { OBJECTID: 42, NAME: "Golden Gate Park", AREA: 44340000 }, geometry: { x: -122.486, y: 37.769 } },
      { attributes: { OBJECTID: 43, NAME: "No Shape", AREA: 1 }, geometry: null },
    ];
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.filter((d) => d.kind === "geometry")).toEqual([]);
  });

  it("FAILS when exceededTransferLimit drifts from the golden", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = conformantResult();
    mutated.exceededTransferLimit = true;
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.some((d) => d.kind === "transfer-limit")).toBe(true);
  });

  it("FAILS when totalCount drifts from a golden that declares one", () => {
    const golden: CanonQueryResponse = { ...CANON_GOLDEN, totalCount: "1" };
    const expected = goldenToExpectedQueryResult(golden);
    const mutated = conformantResult();
    mutated.totalCount = 5;
    const drift = findQueryResultDrift(expected, mutated);
    expect(drift.some((d) => d.kind === "total-count")).toBe(true);
  });
});

describe("live projection conformance (seed-independent)", () => {
  // A live result whose names differ from the golden's seed but whose
  // PROJECTION SHAPE is conformant: field schema present, canonical field
  // types, geometry present, >= golden attribute count, boolean transfer flag.
  function liveResult(): Result {
    return {
      features: [
        {
          attributes: { objectid: 1, name: "Generic Seed Park", area: 123.4 },
          geometry: { x: 0, y: 0 },
        },
      ],
      exceededTransferLimit: false,
      fields: [
        { name: "objectid", type: "esriFieldTypeOID" },
        { name: "name", type: "esriFieldTypeString" },
        { name: "area", type: "esriFieldTypeDouble" },
      ],
    };
  }

  it("reports zero drift for a conformant live Result with different seed names", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const drift = findLiveProjectionDrift(expected, liveResult(), VALID_ESRI_FIELD_TYPES);
    expect(drift, formatDriftFindings("feature_query/live", drift)).toEqual([]);
  });

  it("FAILS when a live field type is not a canonical SDK type (enum/projection drift)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = liveResult();
    mutated.fields = mutated.fields?.map((f) => (f.name === "area" ? { ...f, type: "esriFieldTypeJsonb" } : f));
    const drift = findLiveProjectionDrift(expected, mutated, VALID_ESRI_FIELD_TYPES);
    expect(drift.some((d) => d.kind === "field-type")).toBe(true);
  });

  it("FAILS when the live response drops a projection column below the golden count (#1238 class)", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = liveResult();
    // Golden projects 2 attributes (NAME, AREA); drop the live feature to 1.
    mutated.features = [{ attributes: { objectid: 1 }, geometry: { x: 0, y: 0 } }];
    const drift = findLiveProjectionDrift(expected, mutated, VALID_ESRI_FIELD_TYPES);
    expect(drift.some((d) => d.kind === "missing-attribute")).toBe(true);
  });

  it("FAILS when the live response drops the fields[] schema entirely", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = liveResult();
    mutated.fields = [];
    const drift = findLiveProjectionDrift(expected, mutated, VALID_ESRI_FIELD_TYPES);
    expect(drift.some((d) => d.kind === "missing-field")).toBe(true);
  });

  it("passes projection check when SOME live features carry null geometry", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = liveResult();
    mutated.features = [
      { attributes: { objectid: 1, name: "x", area: 1 }, geometry: { x: 1, y: 2 } },
      { attributes: { objectid: 2, name: "y", area: 2 }, geometry: null },
    ];
    const drift = findLiveProjectionDrift(expected, mutated, VALID_ESRI_FIELD_TYPES);
    expect(drift.filter((d) => d.kind === "geometry")).toEqual([]);
  });

  it("FAILS when a live feature drops geometry that was requested", () => {
    const expected = goldenToExpectedQueryResult(CANON_GOLDEN);
    const mutated = liveResult();
    mutated.features = [{ attributes: { objectid: 1, name: "x", area: 1 }, geometry: null }];
    const drift = findLiveProjectionDrift(expected, mutated, VALID_ESRI_FIELD_TYPES);
    expect(drift.some((d) => d.kind === "geometry")).toBe(true);
  });
});
