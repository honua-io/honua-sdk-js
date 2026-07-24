import { describe, expect, it } from "vitest";

import {
  DECK_GL_CAPABILITY_POLICY,
  type DeckGlCapabilityFacts,
  classifyDeckGlCapability,
} from "../bench/browser/capability-policy.mjs";

function facts(overrides: Partial<DeckGlCapabilityFacts> = {}): DeckGlCapabilityFacts {
  return {
    webgl2: true,
    webgl1: true,
    loseContextExtension: true,
    maxTextureSize: 16_384,
    rendererString: "Test Renderer",
    deviceMemoryGiB: 8,
    hardwareConcurrency: 8,
    ...overrides,
  };
}

describe("classifyDeckGlCapability", () => {
  it("classifies a full-capability device as supported", () => {
    const decision = classifyDeckGlCapability(facts());
    expect(decision.tier).toBe("supported");
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it("reports unsupported when neither webgl1 nor webgl2 is available", () => {
    const decision = classifyDeckGlCapability(facts({ webgl2: false, webgl1: false, maxTextureSize: 0 }));
    expect(decision.tier).toBe("unsupported");
    expect(decision.reasons).toEqual(["No WebGL context (webgl or webgl2) is available on this device."]);
  });

  it("falls back to MapLibre when only WebGL1 is available", () => {
    const decision = classifyDeckGlCapability(facts({ webgl2: false }));
    expect(decision.tier).toBe("fallback-maplibre");
    expect(decision.reasons.join(" ")).toMatch(/WebGL2 is unavailable/);
  });

  it("falls back to MapLibre when MAX_TEXTURE_SIZE is below the reviewed floor", () => {
    const decision = classifyDeckGlCapability(
      facts({ maxTextureSize: DECK_GL_CAPABILITY_POLICY.minSupportedMaxTextureSize - 1 }),
    );
    expect(decision.tier).toBe("fallback-maplibre");
    expect(decision.reasons.join(" ")).toMatch(/MAX_TEXTURE_SIZE/);
  });

  it("stays supported but notes an advisory reason when WEBGL_lose_context is unavailable", () => {
    const decision = classifyDeckGlCapability(facts({ loseContextExtension: false }));
    expect(decision.tier).toBe("supported");
    expect(decision.reasons.join(" ")).toMatch(/WEBGL_lose_context is unavailable/);
  });

  it("is a pure function of its input facts (no shared mutable state across calls)", () => {
    const first = classifyDeckGlCapability(facts());
    const second = classifyDeckGlCapability(facts({ webgl2: false }));
    expect(first.tier).toBe("supported");
    expect(second.tier).toBe("fallback-maplibre");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
  });
});
