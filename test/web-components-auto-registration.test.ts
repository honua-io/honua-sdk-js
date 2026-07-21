// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

/**
 * Regresses issue #679's PR review finding: `src/web-components/elements.ts`
 * must be side-effect-free on import (so `src/controls/registry.ts`'s
 * dynamic `import()` of it, used for single-tag registration, cannot also
 * run the kit's blanket auto-registration as an accidental side effect), while
 * `@honua/sdk-js/web-components` (`./index.js`) — every existing consumer's
 * actual entry point — must keep auto-registering all 16 tags on import,
 * unchanged.
 *
 * Each `it` block gets its own dynamic import + a fresh jsdom
 * `customElements` registry is not resettable, so this relies on tag names
 * that no other test file in this run touches to avoid cross-test pollution;
 * the assertions below only check for *absence* before the relevant import,
 * which is still meaningful evidence regardless of run order.
 */
describe("web-components auto-registration lives on the public entry, not the element module", () => {
  it("importing src/web-components/elements.js alone does not register any tag", async () => {
    expect(customElements.get("honua-print-export")).toBeUndefined();
    const elements = await import("../src/web-components/elements.js");
    expect(customElements.get("honua-print-export")).toBeUndefined();
    expect(customElements.get("honua-action-panel")).toBeUndefined();
    // The module still exports the registration primitives; it just never
    // calls them itself.
    expect(typeof elements.defineHonuaWebComponents).toBe("function");
    expect(typeof elements.defineHonuaWebComponent).toBe("function");
  });

  it("importing @honua/sdk-js/web-components (index.js) auto-registers every tag", async () => {
    expect(customElements.get("honua-map-status")).toBeUndefined();
    await import("../src/web-components/index.js");
    expect(customElements.get("honua-map-status")).toBeDefined();
    expect(customElements.get("honua-bookmarks")).toBeDefined();
    expect(customElements.get("honua-legend")).toBeDefined();
    expect(customElements.get("honua-layer-list")).toBeDefined();
  });
});
