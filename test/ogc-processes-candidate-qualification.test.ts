import { describe, expect, it } from "vitest";

import {
  OGC_PROCESSES_QUALIFICATION_FORMAT,
  assertCandidateEvidenceRedacted,
  qualificationEnabled,
} from "../scripts/ogc-processes-candidate-qualification.mjs";

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
});
