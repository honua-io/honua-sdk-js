/**
 * Live conformance coverage for the FeatureService query workflow — the
 * honua-server#1238 regression class (FeatureServer / OGC Features projection
 * and on-the-wire response shape).
 *
 * For the shared `feature_query` fixture this suite:
 *   1. maps the canonical `geospatial.v1.QueryFeaturesRequest` fixture into a
 *      protocol-neutral `Query`;
 *   2. issues that `Query` through the real `HonuaClient` against the pinned,
 *      live `honua-server` via the protocol-neutral `Source`
 *      (GeoServices FeatureServer AND OGC API Features — same contract);
 *   3. derives the expected `Result` contract from the golden response; and
 *   4. asserts the live `Result` carries no drift (field schema + types,
 *      geometry presence, attribute coverage, `exceededTransferLimit`,
 *      `totalCount`).
 *
 * Any drift fails the suite with the standard integration diagnostic block
 * plus the conformance drift findings.
 *
 * @module
 */

import type { Query, Result } from "@honua/sdk-js/contract";
import { expect, it } from "vitest";
import { findLiveProjectionDrift, formatDriftFindings } from "./assert.js";
import { conformanceSuite, runWithDiagnostics } from "./harness.js";
import {
  type CanonQueryRequest,
  type CanonQueryResponse,
  VALID_ESRI_FIELD_TYPES,
  canonRequestToQuery,
  goldenToExpectedQueryResult,
} from "./mapping.js";

// The golden fixture's field/attribute *names* are tied to its own seed
// (sf-parks); the pinned honua-server:nightly seed the job connects to is
// generic. So the live suite asserts the seed-independent PROJECTION SHAPE the
// golden commits to — the exact class honua-server#1238 broke: a field schema
// is present, every on-the-wire field type is a canonical SDK type, geometry
// is present when requested, the attribute count is not reduced below the
// golden's, and exceededTransferLimit is a boolean. Literal-name golden-vs-
// actual comparison is covered (with both sides controlled) by the negative
// unit test in drift-detection.test.ts.
conformanceSuite<CanonQueryRequest, CanonQueryResponse>(
  "FeatureService query",
  "feature-server",
  "feature_query",
  ({ context, config, fixture, source }) => {
    // Preserve the canonical request's structural intent (returnGeometry,
    // outSr, pagination) but make the predicate seed-agnostic: the golden's
    // where/outFields name sf-parks columns, while the pinned server seed is
    // generic. We assert the projection SHAPE, not the seed's specific rows.
    const canonicalQuery = canonRequestToQuery(fixture.request);
    const query: Query = {
      ...canonicalQuery,
      where: "1=1",
      outFields: ["*"],
    };
    const expected = goldenToExpectedQueryResult(fixture.golden);

    it("GeoServices FeatureServer Result conforms to the golden projection shape", async () => {
      const fs = source("geoservices-feature-service", {
        url: config.baseUrl,
        serviceId: config.serviceId,
        layerId: config.layerId,
      });
      const result: Result = await runWithDiagnostics(context, "datasetSource(geoservices-feature-service).query", () =>
        fs.query(query),
      );
      // The seed must return at least one feature so the shape is observable.
      expect(result.features.length).toBeGreaterThan(0);
      const drift = findLiveProjectionDrift(expected, result, VALID_ESRI_FIELD_TYPES);
      expect(drift, formatDriftFindings("feature_query/geoservices", drift)).toEqual([]);
    });

    it("OGC API Features Result conforms to the golden projection shape", async () => {
      const ogc = source("ogc-features", {
        url: config.baseUrl,
        collectionId: config.collectionId,
      });
      const result: Result = await runWithDiagnostics(context, "datasetSource(ogc-features).query", () =>
        ogc.query(query),
      );
      expect(result.features.length).toBeGreaterThan(0);
      // OGC Features does not carry an Esri-style fields[] schema, so check the
      // feature-level projection shape (geometry presence + attribute count).
      const ogcExpected = { ...expected, fields: [] };
      const drift = findLiveProjectionDrift(ogcExpected, result, VALID_ESRI_FIELD_TYPES);
      expect(drift, formatDriftFindings("feature_query/ogc-features", drift)).toEqual([]);
    });
  },
);
