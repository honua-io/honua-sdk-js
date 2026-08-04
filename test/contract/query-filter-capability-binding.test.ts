/**
 * Capability-profile binding for the canonical typed filter (#947 S2).
 *
 * A per-source capability profile is evaluated evidence about one endpoint, so
 * it may only NARROW what the protocol's grammar allows. These tests pin that
 * direction: a construct the profile omits is refused by name even though the
 * protocol could carry it, a construct the protocol cannot express stays
 * refused even when the profile claims it, and a source without a profile keeps
 * the protocol-level behaviour (absent evidence is not evidence of absence).
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceDescriptor,
  createDataset,
  queryFilter,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { envelope } from "../../src/core/spatial-filter.js";
import { createCapabilityEvidenceProfile, evaluateCapabilityProfile } from "../../src/source-capabilities.js";
import type { CapabilityConstraints, CapabilityEvidenceEntry } from "../../src/source-capability-types.js";

import { type ParcelAttrs, geoservicesQueryResponse, jsonResponse, makeMockClient } from "./shared.js";

const SOURCE_FINGERPRINT = `sha256:${"b".repeat(64)}` as const;
const OBSERVED_AT = "2026-07-14T00:00:00Z";
const EXPIRES_AT = "2026-07-20T00:00:00Z";
const EVALUATED_AT = "2026-07-15T00:00:00Z";
const SOURCE_ENDPOINT = {
  endpoint: "https://mock/rest/services/Parcels/FeatureServer/0",
  protocol: "geoservices-feature-service",
  sourceId: "parcels",
} as const;

function queryEntry(constraints?: CapabilityConstraints): CapabilityEvidenceEntry {
  return {
    id: "query",
    claimed: "supported",
    observed: "supported",
    evidence: [
      { kind: "protocol-default", truth: "supported", reference: "adapter:query" },
      {
        kind: "metadata",
        truth: "supported",
        reference: "metadata:query",
        observedAt: OBSERVED_AT,
        expiresAt: EXPIRES_AT,
      },
    ],
    ...(constraints ? { constraints } : {}),
  };
}

function profileWith(constraints?: CapabilityConstraints) {
  return evaluateCapabilityProfile(
    createCapabilityEvidenceProfile([queryEntry(constraints)], {
      sourceFingerprint: SOURCE_FINGERPRINT,
      sourceEndpoint: SOURCE_ENDPOINT,
    }),
    { evaluatedAt: EVALUATED_AT },
  );
}

function geoServicesSource(constraints?: CapabilityConstraints, options: { profiled?: boolean } = {}) {
  const seen: { url?: URL } = {};
  const client = makeMockClient({
    routes: [
      [
        "/rest/services/Parcels/FeatureServer/0/query",
        (url) => {
          seen.url = url;
          return jsonResponse(geoservicesQueryResponse());
        },
      ],
    ],
  });
  const profiled = options.profiled ?? true;
  const descriptor: SourceDescriptor = {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock", serviceId: "Parcels", layerId: 0 },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    ...(profiled
      ? {
          schemaV2: { kind: "honua.source-schema", version: "2.0", fingerprint: SOURCE_FINGERPRINT },
          capabilityProfile: profileWith(constraints),
        }
      : {}),
  };
  const source = createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [descriptor],
  }).source<ParcelAttrs>("parcels")!;
  return { source, seen };
}

describe("typed filter / capability-profile binding", () => {
  it("refuses a spatial predicate the source's evidence omits, naming the construct", async () => {
    const { source } = geoServicesSource({ spatialPredicates: ["intersects", "bbox-intersects"] });
    const attempt = source.query({
      filter: queryFilter.spatial("within", envelope(-125, 30, -115, 42)),
    });
    await expect(attempt).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(attempt).rejects.toMatchObject({
      capability: "filter.spatial.within",
      protocol: "geoservices-feature-service",
      sourceId: "parcels",
    });
  });

  it("marks a profile-driven refusal as capability-profile rather than protocol", async () => {
    const { source } = geoServicesSource({ spatialPredicates: ["intersects"] });
    await source.query({ filter: queryFilter.spatial("contains", envelope(0, 0, 1, 1)) }).then(
      () => expect.unreachable("the profile omits contains"),
      (error: HonuaCapabilityNotSupportedError) => {
        expect(error.context).toMatchObject({ construct: "filter.spatial.contains", constraint: "capability-profile" });
      },
    );
  });

  it("refuses an attribute operator the profile omits", async () => {
    const { source } = geoServicesSource({ filterOperators: ["eq", "ne", "and", "or"] });
    await expect(source.query({ filter: queryFilter.like("STATE", "C%") })).rejects.toMatchObject({
      capability: "filter.pattern.like",
      protocol: "geoservices-feature-service",
    });
  });

  it("still compiles the operators the profile does advertise", async () => {
    const { source, seen } = geoServicesSource({ filterOperators: ["eq", "and"] });
    await source.query({ filter: queryFilter.eq("STATE", "CA") });
    expect(seen.url?.searchParams.get("where")).toBe("STATE = 'CA'");
  });

  it("keeps protocol behaviour for a source with no profile", async () => {
    const { source, seen } = geoServicesSource(undefined, { profiled: false });
    await source.query({ filter: queryFilter.like("STATE", "C%") });
    expect(seen.url?.searchParams.get("where")).toBe("STATE LIKE 'C%'");
  });

  it("keeps protocol behaviour when the profile declares no filter constraints", async () => {
    const { source, seen } = geoServicesSource({ outputFormats: ["json"] });
    await source.query({ filter: queryFilter.like("STATE", "C%") });
    expect(seen.url?.searchParams.get("where")).toBe("STATE LIKE 'C%'");
  });

  it("fails closed when the profile advertises only predicates outside the canonical AST", async () => {
    // `within-distance` is a valid CapabilityConstraints predicate the canonical
    // filter cannot name. Dropping it leaves an empty allow list, which must
    // refuse every spatial node rather than silently permitting all of them.
    const { source } = geoServicesSource({ spatialPredicates: ["within-distance"] });
    await expect(
      source.query({ filter: queryFilter.spatial("intersects", envelope(0, 0, 1, 1)) }),
    ).rejects.toMatchObject({ capability: "filter.spatial.intersects" });
  });

  it("narrows but never widens: an evidence claim cannot unlock a construct the protocol lacks", async () => {
    // The profile advertises a spatial predicate GeoServices genuinely cannot
    // carry inside OR, so the protocol-level refusal still wins.
    const { source } = geoServicesSource({ spatialPredicates: ["intersects", "within"] });
    await expect(
      source.query({
        filter: queryFilter.or(queryFilter.eq("STATE", "CA"), queryFilter.spatial("intersects", envelope(0, 0, 1, 1))),
      }),
    ).rejects.toMatchObject({ capability: "filter.spatial.disjunction" });
  });

  it("applies the same gate to a temporal predicate", async () => {
    const { source } = geoServicesSource({ temporalPredicates: ["before", "after"] });
    await expect(
      source.query({ filter: queryFilter.during("REPORTED_AT", "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z") }),
    ).rejects.toMatchObject({ capability: "filter.temporal.during" });
  });
});
