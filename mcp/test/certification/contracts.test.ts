import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  checkAuthContract,
  checkFeatureRoundTrip,
  checkInvalidArgsContract,
  checkJobLifecycle,
  checkPaginationContract,
  extractStructuredError,
  validateGeoprocessingError,
} from "../../src/certification/contracts.js";

describe("extractStructuredError", () => {
  it("pulls an envelope out of a tool result's structuredContent", () => {
    const env = extractStructuredError({
      isError: true,
      structuredContent: { code: "invalid_argument", error: { kind: "ValidationFailed", message: "bad" } },
    });
    expect(env?.code).toBe("invalid_argument");
    expect((env?.error as { kind: string }).kind).toBe("ValidationFailed");
  });

  it("pulls an envelope out of an McpError data field", () => {
    const err = new McpError(-32001, "denied", {
      code: "unauthenticated",
      error: { kind: "AuthorizationDenied", message: "no token" },
    });
    const env = extractStructuredError(err);
    expect(env?.code).toBe("unauthenticated");
  });

  it("treats a bare geoprocessing-error as the envelope", () => {
    const env = extractStructuredError({ kind: "Timeout", message: "slow" });
    expect((env?.error as { kind: string }).kind).toBe("Timeout");
  });

  it("returns undefined for unstructured input", () => {
    expect(extractStructuredError("nope")).toBeUndefined();
    expect(extractStructuredError({ irrelevant: true })).toBeUndefined();
  });
});

describe("validateGeoprocessingError", () => {
  it("accepts a valid geoprocessing-error", () => {
    const res = validateGeoprocessingError({ kind: "ValidationFailed", message: "bad" });
    expect(res.ok).toBe(true);
  });

  it("rejects an invalid kind", () => {
    const res = validateGeoprocessingError({ kind: "Nope", message: "bad" });
    expect(res.ok).toBe(false);
  });

  it("rejects a missing message", () => {
    const res = validateGeoprocessingError({ kind: "Timeout" });
    expect(res.ok).toBe(false);
  });
});

describe("checkInvalidArgsContract", () => {
  it("passes on a structured ValidationFailed error result", () => {
    const outcome = checkInvalidArgsContract({
      isError: true,
      structuredContent: {
        code: "invalid_argument",
        error: {
          kind: "ValidationFailed",
          message: "bad args",
          violations: [{ code: "SCHEMA_VIOLATION", message: "missing layerId", fieldPath: "/layerId" }],
        },
      },
    });
    expect(outcome.ok).toBe(true);
  });

  it("fails when the result is not marked isError", () => {
    const outcome = checkInvalidArgsContract({
      isError: false,
      structuredContent: {
        code: "invalid_argument",
        error: { kind: "ValidationFailed", message: "x", violations: [{ code: "c", message: "m" }] },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("isError");
  });

  it("fails when the kind is not ValidationFailed", () => {
    const outcome = checkInvalidArgsContract({
      isError: true,
      structuredContent: {
        code: "invalid_argument",
        error: { kind: "Timeout", message: "x", violations: [{ code: "c", message: "m" }] },
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("ValidationFailed");
  });

  it("fails when violations are absent", () => {
    const outcome = checkInvalidArgsContract({
      isError: true,
      structuredContent: { code: "invalid_argument", error: { kind: "ValidationFailed", message: "x" } },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("violation");
  });

  it("fails when no structured envelope is present", () => {
    const outcome = checkInvalidArgsContract({ isError: true });
    expect(outcome.ok).toBe(false);
  });
});

describe("checkAuthContract", () => {
  it.each(AUTH_ERROR_CODES)("passes on the %s code", (code) => {
    const outcome = checkAuthContract({
      structuredContent: { code, error: { kind: "AuthorizationDenied", message: "no" } },
    });
    expect(outcome.ok).toBe(true);
  });

  it("passes on an AuthorizationDenied kind even without a code", () => {
    const err = new McpError(-32001, "denied", { error: { kind: "AuthorizationDenied", message: "no token" } });
    expect(checkAuthContract(err).ok).toBe(true);
  });

  it("fails on a non-auth structured error", () => {
    const outcome = checkAuthContract({
      structuredContent: { code: "invalid_argument", error: { kind: "ValidationFailed", message: "x" } },
    });
    expect(outcome.ok).toBe(false);
  });

  it("fails when nothing structured is present", () => {
    expect(checkAuthContract(new Error("plain")).ok).toBe(false);
  });
});

describe("checkPaginationContract", () => {
  it("passes when nextCursor is honored and terminates", () => {
    const outcome = checkPaginationContract([
      { keys: ["a", "b"], nextCursor: "c1" },
      { keys: ["c", "d"], nextCursor: undefined },
    ]);
    expect(outcome.ok).toBe(true);
  });

  it("passes for a single unpaginated page", () => {
    const outcome = checkPaginationContract([{ keys: ["a"], nextCursor: undefined }]);
    expect(outcome.ok).toBe(true);
  });

  it("fails when the final page still advertises a cursor", () => {
    const outcome = checkPaginationContract([{ keys: ["a"], nextCursor: "still-more" }]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("did not terminate");
  });

  it("fails when a cursor repeats (non-termination)", () => {
    const outcome = checkPaginationContract([
      { keys: ["a"], nextCursor: "loop" },
      { keys: ["b"], nextCursor: "loop" },
      { keys: ["c"], nextCursor: undefined },
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("repeated");
  });

  it("fails when following the cursor yields no new items", () => {
    const outcome = checkPaginationContract([
      { keys: ["a", "b"], nextCursor: "c1" },
      { keys: ["a", "b"], nextCursor: undefined },
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("additional distinct items");
  });
});

describe("checkFeatureRoundTrip", () => {
  const ok = {
    insertedObjectId: 1000,
    presentAfterInsert: true,
    attributeAfterUpdate: "cert-updated",
    expectedAttribute: "cert-updated",
    absentAfterDelete: true,
  };

  it("passes on a full insert→update→delete round-trip", () => {
    expect(checkFeatureRoundTrip(ok).ok).toBe(true);
  });

  it("fails when the insert returned no objectId", () => {
    const outcome = checkFeatureRoundTrip({ ...ok, insertedObjectId: undefined });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("objectId");
  });

  it("fails when the insert is not observable", () => {
    expect(checkFeatureRoundTrip({ ...ok, presentAfterInsert: false }).ok).toBe(false);
  });

  it("fails when the update did not round-trip", () => {
    const outcome = checkFeatureRoundTrip({ ...ok, attributeAfterUpdate: "stale" });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("round-trip");
  });

  it("fails when the feature survives the delete", () => {
    expect(checkFeatureRoundTrip({ ...ok, absentAfterDelete: false }).ok).toBe(false);
  });
});

describe("checkJobLifecycle", () => {
  const ok = {
    initialStatus: "Submitted",
    polledStatuses: ["Running", "Succeeded"],
    progressFractions: [0.3, 1],
    finalStatus: "Succeeded",
    resultReady: true,
  };

  it("passes on a well-formed Submitted→Running→Succeeded lifecycle", () => {
    expect(checkJobLifecycle(ok).ok).toBe(true);
  });

  it("fails on an unrecognized state", () => {
    const outcome = checkJobLifecycle({ ...ok, polledStatuses: ["Sleeping", "Succeeded"] });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("unrecognized");
  });

  it("fails when the state rank regresses", () => {
    const outcome = checkJobLifecycle({
      ...ok,
      polledStatuses: ["Succeeded", "Running"],
      finalStatus: "Running",
      progressFractions: [1, 0.5],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("regressed");
  });

  it("fails when progress is out of range", () => {
    const outcome = checkJobLifecycle({ ...ok, progressFractions: [0.3, 1.5] });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("out of the documented");
  });

  it("fails when a succeeded job has no ready result", () => {
    const outcome = checkJobLifecycle({ ...ok, resultReady: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("result package");
  });

  it("fails when the job never reaches a terminal state", () => {
    const outcome = checkJobLifecycle({
      ...ok,
      polledStatuses: ["Running", "Running"],
      finalStatus: "Running",
      progressFractions: [0.3, 0.6],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.join(" ")).toContain("terminal");
  });
});
