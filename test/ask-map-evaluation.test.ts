import { describe, expect, it } from "vitest";
import { enforceEvaluationDeadline } from "../examples/nl-map-control/src/evaluation.js";

describe("Ask this map evaluation acceptance", () => {
  it("fails a late successful result independently of cooperative cancellation", () => {
    expect(enforceEvaluationDeadline({ passed: true, elapsedMs: 15001 })).toMatchObject({
      passed: false,
      latencyExceeded: true,
    });
    expect(enforceEvaluationDeadline({ passed: true, elapsedMs: 15000 })).toMatchObject({
      passed: true,
      latencyExceeded: false,
    });
    expect(enforceEvaluationDeadline({ passed: false, elapsedMs: 1 }).passed).toBe(false);
    expect(enforceEvaluationDeadline({ passed: true, elapsedMs: Number.NaN }).passed).toBe(false);
  });
});
