import { describe, expect, it } from "vitest";

import { PSEUDO_LOCALE_MIN_EXPANSION, pseudoLocale, pseudoLocaleExpansion } from "./pseudo-locale.js";

describe("component pseudo-locale", () => {
  it("is deterministic and visibly accented", () => {
    const source = "Search";
    expect(pseudoLocale(source)).toBe(pseudoLocale(source));
    expect(pseudoLocale(source)).toContain("⟦");
    expect(pseudoLocale(source)).toContain("ḗ");
    expect(pseudoLocaleExpansion(source)).toBeGreaterThanOrEqual(PSEUDO_LOCALE_MIN_EXPANSION);
  });

  it("maintains the expansion contract for short and long labels", () => {
    for (const source of ["Map", "Search", "A longer feature table heading"]) {
      expect(pseudoLocaleExpansion(source)).toBeGreaterThanOrEqual(PSEUDO_LOCALE_MIN_EXPANSION);
    }
  });
});
