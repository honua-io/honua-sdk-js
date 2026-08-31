import { describe, expect, it } from "vitest";

import {
  OGC_PROCESSES_QUALIFICATION_FORMAT,
  assertCandidateEvidenceRedacted,
  classifyGovernedInputRejection,
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
});
