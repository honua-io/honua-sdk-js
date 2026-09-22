import { describe, expect, it } from "vitest";

import {
  OGC_PROCESSES_QUALIFICATION_FORMAT,
  assertBufferResult,
  assertCandidateEvidenceRedacted,
  assertLegalJobTransitions,
  auditPreferHeaders,
  classifyGovernedInputRejection,
  decodeWkbPoint,
  qualificationEnabled,
} from "../scripts/ogc-processes-candidate-qualification.mjs";

/** Minimal stand-ins for the SDK error shapes this classifier reads. */
function httpError(statusCode: number): Error {
  return Object.assign(new Error("http"), { name: "HonuaHttpError", statusCode });
}
function jobFailedError(status: string): Error {
  return Object.assign(new Error("job"), { name: "HonuaJobFailedError", status });
}

describe("OGC Processes exact-candidate qualification policy", () => {
  it("is double-gated and never defaults a live mutation on", () => {
    expect(qualificationEnabled({})).toBe(false);
    expect(qualificationEnabled({ HONUA_OGC_PROCESSES_QUALIFICATION_ENABLED: "false" })).toBe(false);
    expect(qualificationEnabled({ HONUA_OGC_PROCESSES_QUALIFICATION_ENABLED: "true" })).toBe(true);
  });

  it("rejects credential material from retained evidence", () => {
    expect(() => assertCandidateEvidenceRedacted({ format: OGC_PROCESSES_QUALIFICATION_FORMAT })).not.toThrow();
    expect(() => assertCandidateEvidenceRedacted({ headers: { "X-API-Key": "value" } })).toThrow(/credential/);
    expect(() => assertCandidateEvidenceRedacted({ authorization: "Bearer value" })).toThrow(/credential/);
    expect(() => assertCandidateEvidenceRedacted({ accidental: "quickstart-admin-password" })).toThrow(/credential/);
  });

  it("accepts only a real governed-input validation rejection", () => {
    // The server read the request and refused it.
    for (const statusCode of [400, 422]) {
      const classification = classifyGovernedInputRejection(httpError(statusCode));
      expect(classification).toMatchObject({ accepted: true, kind: "request-rejected" });
      expect(classification.error.statusCode).toBe(statusCode);
    }

    // The server accepted the job and failed it on the input.
    expect(classifyGovernedInputRejection(jobFailedError("failed"))).toMatchObject({
      accepted: true,
      kind: "job-failed",
    });
  });

  it("refuses failures that never prove the candidate validated anything", () => {
    const unrelated = [
      // Local capability refusal raised before any request is issued.
      Object.assign(new Error("x"), { name: "HonuaCapabilityNotSupportedError" }),
      // Wrong credential, not a governed-input verdict.
      httpError(401),
      httpError(403),
      // A defect, not a refusal.
      httpError(500),
      httpError(503),
      // A route that does not exist is not a validation rejection.
      httpError(404),
      // Never observed a terminal at all.
      Object.assign(new Error("x"), { name: "HonuaJobPollTimeoutError" }),
      Object.assign(new Error("x"), { name: "HonuaTimeoutError" }),
      Object.assign(new Error("x"), { name: "HonuaNetworkError" }),
      // A dismissed job is a cancellation, not an input verdict.
      jobFailedError("dismissed"),
      // Not an Error at all.
      "boom",
    ];
    for (const error of unrelated) {
      expect(classifyGovernedInputRejection(error)).toMatchObject({ accepted: false, kind: "unrelated-failure" });
    }
  });

  it("projects the fields that distinguish those cases, and no message", () => {
    // Reading only a numeric `status` recorded null for both real shapes, which
    // is what made an auth failure indistinguishable from a validation refusal.
    expect(classifyGovernedInputRejection(httpError(400)).error).toEqual({
      name: "HonuaHttpError",
      statusCode: 400,
      jobStatus: null,
      errorCode: null,
    });
    expect(classifyGovernedInputRejection(jobFailedError("failed")).error).toEqual({
      name: "HonuaJobFailedError",
      statusCode: null,
      jobStatus: "failed",
      errorCode: null,
    });
    // The projection is retained in evidence, so it must never carry a message.
    expect(Object.keys(classifyGovernedInputRejection(httpError(400)).error)).not.toContain("message");
  });

  it("refuses the non-standard synchronous or an invented Prefer token on the wire", () => {
    // Assembled from parts, as in ogc-processes-prefer-residue.test.ts, so this file is not a violation.
    const nonStandard = `respond-${"sync"}`;
    const request = (prefer: string | null) => ({
      method: "POST",
      path: "/ogc/processes/processes/p/execution",
      status: 200,
      prefer,
    });
    expect(auditPreferHeaders([request(null), request("respond-async")])).toEqual({
      preferValues: ["respond-async"],
      respondSyncSent: false,
    });
    expect(auditPreferHeaders([request(null)])).toEqual({ preferValues: [], respondSyncSent: false });
    expect(() => auditPreferHeaders([request(nonStandard)])).toThrow(/non-standard/);
    expect(() => auditPreferHeaders([request(`${nonStandard.toUpperCase()}, wait=5`)])).toThrow(/non-standard/);
    expect(() => auditPreferHeaders([request("wait=5")])).toThrow(/unexpected Prefer/);
  });

  it("accepts only a legal job lifecycle", () => {
    expect(assertLegalJobTransitions(["accepted", "accepted", "running", "successful", "successful"])).toEqual([
      "accepted",
      "running",
      "successful",
    ]);
    expect(assertLegalJobTransitions(["accepted", "successful"])).toEqual(["accepted", "successful"]);
    expect(() => assertLegalJobTransitions([])).toThrow(/no job status/);
    expect(() => assertLegalJobTransitions(["running", "accepted"])).toThrow(/regressed/);
    expect(() => assertLegalJobTransitions(["successful", "failed"])).toThrow(/after terminal/);
    expect(() => assertLegalJobTransitions(["accepted", "queued"])).toThrow(/unknown job status/);
  });

  it("checks buffer results against the decoded input point, not their presence", () => {
    const center = decodeWkbPoint("AQEAAABQ/Bhz15pewNDVVuwv40JA");
    expect(center[0]).toBeCloseTo(-122.4194, 6);
    expect(center[1]).toBeCloseTo(37.7749, 6);
    const ring = (radius: number) =>
      Array.from({ length: 9 }, (_, index) => {
        const angle = (index / 8) * 2 * Math.PI;
        return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
      });
    const feature = (radius: number) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring(radius)] },
    });
    expect(assertBufferResult({ value: feature(0.00025) }, { center, distance: 0.00025 })).toMatchObject({
      geometryType: "Polygon",
      vertexCount: 9,
    });
    expect(
      assertBufferResult({ type: "FeatureCollection", features: [feature(0.00025)] }, { center, distance: 0.00025 }),
    ).toMatchObject({
      geometryType: "Polygon",
    });
    expect(() => assertBufferResult({ value: feature(0.001) }, { center, distance: 0.00025 })).toThrow(/vertices lie/);
    expect(() =>
      assertBufferResult({ value: { type: "Point", coordinates: center } }, { center, distance: 0.00025 }),
    ).toThrow(/expected Polygon/);
    expect(() => assertBufferResult(undefined, { center, distance: 0.00025 })).toThrow(/missing/);
    expect(() => decodeWkbPoint(Buffer.alloc(8).toString("base64"))).toThrow(/not a 2D point/);
  });
});
