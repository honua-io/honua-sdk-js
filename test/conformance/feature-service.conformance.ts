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
import { findQueryResultDrift, formatDriftFindings } from "./assert.js";
import { conformanceSuite, runWithDiagnostics } from "./harness.js";
import {
  type CanonQueryRequest,
  type CanonQueryResponse,
  canonRequestToQuery,
  goldenToExpectedQueryResult,
} from "./mapping.js";

conformanceSuite<CanonQueryRequest, CanonQueryResponse>(
  "FeatureService query",
  "feature-server",
  "feature_query",
  ({ context, config, fixture, source }) => {
    const query: Query = canonRequestToQuery(fixture.request);
    const expected = goldenToExpectedQueryResult(fixture.golden);

    it("GeoServices FeatureServer Result conforms to the golden contract", async () => {
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
      const drift = findQueryResultDrift(expected, result);
      expect(drift, formatDriftFindings("feature_query/geoservices", drift)).toEqual([]);
    });

    it("OGC API Features Result conforms to the golden contract", async () => {
      const ogc = source("ogc-features", {
        url: config.baseUrl,
        collectionId: config.collectionId,
      });
      const result: Result = await runWithDiagnostics(context, "datasetSource(ogc-features).query", () =>
        ogc.query(query),
      );
      expect(result.features.length).toBeGreaterThan(0);
      // OGC Features carries geometry + attributes; assert the golden
      // attribute coverage and geometry presence hold on the wire. Field
      // schema is GeoServices-specific, so OGC checks the feature shape.
      const ogcExpected = { ...expected, fields: [] };
      const drift = findQueryResultDrift(ogcExpected, result);
      expect(drift, formatDriftFindings("feature_query/ogc-features", drift)).toEqual([]);
    });
  },
);
