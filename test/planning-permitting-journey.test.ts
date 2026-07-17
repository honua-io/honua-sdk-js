import { afterEach, describe, expect, it } from "vitest";

import { startPlanningWorkbenchFixtureServer } from "../examples/planning-permitting-workbench/mock-server.mjs";
import {
  DEFAULT_PROPOSAL,
  PLANNING_CANDIDATE_LIMIT,
  PLANNING_FIXTURE_VERSION,
  createPlanningPermittingJourney,
} from "../examples/planning-permitting-workbench/src/journey.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("Planning and Permitting public SDK journey", () => {
  it("composes deterministic search, bounded analysis, edit outcomes, and export", async () => {
    const server = await startPlanningWorkbenchFixtureServer({ build: false });
    cleanups.push(() => server.close());
    const journey = await createPlanningPermittingJourney({ baseUrl: server.url });
    cleanups.push(() => journey.dispose());

    expect(journey.inspection()).toMatchObject({
      protocol: "geoservices-feature-service",
      sources: [{ discovery: "metadata" }],
    });
    expect(journey.inspection().sources[0]?.descriptor.capabilities.has("query")).toBe(true);
    expect(journey.inspection().sources[0]?.descriptor.capabilities.has("applyEdits")).toBe(true);
    expect(journey.inspection().sources[0]?.descriptor.capabilities.has("attachments")).toBe(true);
    expect(journey.metadataFields().find((field) => field.name === "permit_type")?.domain).toEqual(
      expect.objectContaining({
        type: "coded-value",
        codedValues: expect.arrayContaining([expect.objectContaining({ code: "commercial" })]),
      }),
    );

    const search = await journey.search("300 Hana Hwy");
    expect(search).toMatchObject({
      featureId: 5001,
      protocol: "geoservices-feature-service",
      attributes: { parcel_tmk: "3-7-010-031", zoning: "B-2", flood_zone: "AE" },
    });

    const analysis = await journey.analyze(DEFAULT_PROPOSAL);
    expect(analysis.candidateLimit).toBe(PLANNING_CANDIDATE_LIMIT);
    expect(analysis.boundedCandidateCount).toBeLessThanOrEqual(PLANNING_CANDIDATE_LIMIT);
    expect(analysis.proposalAreaSquareMeters).toBeGreaterThan(0);
    expect(analysis.hazardOverlapSquareMeters).toBeGreaterThan(0);
    expect(analysis.intersectsFloodHazard).toBe(true);
    expect(analysis.plan.map((step) => [step.execution, step.id])).toEqual([
      ["source", "candidate-query"],
      ["client", "client-geometry"],
      ["client", "hazard-intersection"],
    ]);
    expect(analysis.provenance.fixtureVersion).toBe(PLANNING_FIXTURE_VERSION);
    expect(analysis.provenance.metadataSources[0]).toContain("/rest/services/Maui/Planning/FeatureServer/0");
    expect(analysis.fidelity).toMatchObject({ status: "exact-client-geometry", crs: "EPSG:4326" });

    const draft = journey.createDraft(DEFAULT_PROPOSAL);
    const invalid = await journey.submit(draft, "invalid-domain");
    expect(invalid).toMatchObject({
      status: "validation-failed",
      optimisticTransitions: [],
      recoverable: true,
    });
    expect(invalid.result.validation.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ fieldName: "permit_type", code: "domain" })]),
    );

    const conflict = await journey.submit(draft, "conflict");
    expect(conflict.status).toBe("failed");
    expect(conflict.optimisticTransitions).toEqual(["applied", "rolled-back"]);
    expect(conflict.result.failures[0]).toMatchObject({
      kind: "conflict",
      code: 409,
      conflict: { state: "supported", versionField: "version", value: 3 },
    });

    const attachmentFailure = await journey.submit(draft, "attachment-failure");
    expect(attachmentFailure.status).toBe("partial");
    expect(attachmentFailure.optimisticTransitions).toEqual(["applied", "rolled-back"]);
    expect(attachmentFailure.result.failures[0]).toMatchObject({
      kind: "transport",
      operation: "attachment-add",
      code: 413,
    });

    const unsupported = await journey.submit(draft, "unsupported");
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.optimisticTransitions).toEqual([]);
    expect(unsupported.result.failures.map((failure) => failure.kind)).toEqual(["capability", "capability"]);

    const success = await journey.submit(draft, "success");
    expect(success.status).toBe("succeeded");
    expect(success.optimisticTransitions).toEqual(["applied", "committed"]);
    expect(success.result.attachmentResults).toEqual([
      expect.objectContaining({ operation: "add", outcomes: [expect.objectContaining({ success: true })] }),
    ]);

    const review = journey.reviewModel();
    expect(review).toMatchObject({
      kind: "honua.planning-permitting-review",
      version: 1,
      fixtureVersion: PLANNING_FIXTURE_VERSION,
      semantic: {
        workflow: "search-analyze-edit-export",
        publicSurfaces: ["source-query", "geocoding", "geometry", "edit-session", "attachments"],
        failureScenarios: ["invalid-domain", "conflict", "attachment-failure", "unsupported"],
      },
    });
    expect(review.submissions.map((entry) => [entry.scenario, entry.status])).toEqual([
      ["invalid-domain", "validation-failed"],
      ["conflict", "failed"],
      ["attachment-failure", "partial"],
      ["unsupported", "unsupported"],
      ["success", "succeeded"],
    ]);
    expect(JSON.parse(journey.exportReview())).toEqual(review);

    await fetch(`${server.url}/__fixture__/state?token=fixture-secret`);
    const trace = await (await fetch(`${server.url}/__fixture__/requests`)).json();
    const requests = trace.requests as Array<{ pathname: string; query: Record<string, string> }>;
    expect(requests.map((request) => request.pathname)).toEqual(
      expect.arrayContaining([
        "/rest/services/Maui/GeocodeServer/findAddressCandidates",
        "/rest/services/Maui/Planning/FeatureServer/0/query",
        "/rest/services/Maui/Planning/FeatureServer/0/applyEdits",
      ]),
    );
    expect(
      requests.some(
        (request) =>
          request.pathname.endsWith("/query") &&
          request.query.geometryType === "esriGeometryEnvelope" &&
          request.query.resultRecordCount === String(PLANNING_CANDIDATE_LIMIT),
      ),
    ).toBe(true);
    expect(requests.find((request) => request.pathname === "/__fixture__/state")?.query.token).toBe("[REDACTED]");
    expect(JSON.stringify(trace)).not.toContain("fixture-secret");
  });

  it("fails closed when authoritative edit metadata is absent", async () => {
    const server = await startPlanningWorkbenchFixtureServer({ build: false, metadataMode: "missing-fields" });
    cleanups.push(() => server.close());

    await expect(createPlanningPermittingJourney({ baseUrl: server.url })).rejects.toThrow(
      "requires authoritative field metadata",
    );
  });

  it("rejects credential-bearing fixture origins without reflecting the secret", async () => {
    const error = await createPlanningPermittingJourney({
      baseUrl: "http://sdk-user:fixture-secret@127.0.0.1:9",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("credential-free, origin-only");
    expect((error as Error).message).not.toContain("fixture-secret");
  });
});
