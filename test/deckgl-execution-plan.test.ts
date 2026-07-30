import { describe, expect, it } from "vitest";

import { planDeckGlExecution } from "../src/deckgl/index.js";

describe("planDeckGlExecution", () => {
  it("uses the SDK binary lane by default without probing optional runtimes", () => {
    expect(planDeckGlExecution({ layer: "scatterplot" })).toMatchObject({
      execution: "gpu-binary",
      fallback: "none",
      fidelity: "exact-input",
      ownership: "sdk",
    });
  });

  it("selects an explicit caller fallback when the binary lane is unavailable", () => {
    expect(
      planDeckGlExecution({
        layer: "feature-path",
        preferred: ["gpu-binary", "cpu-object", "tile"],
        availability: { gpuBinary: false, cpuObject: true },
      }),
    ).toMatchObject({
      execution: "cpu-object",
      fallback: "cpu-object",
      fidelity: "bounded-object",
      ownership: "caller",
    });
  });

  it("fails closed when every requested lane is unavailable", () => {
    expect(
      planDeckGlExecution({ layer: "feature-polygon", preferred: ["cpu-object", "tile"], availability: {} }),
    ).toMatchObject({ execution: "unsupported", fidelity: "unsupported", ownership: "none" });
  });
});
