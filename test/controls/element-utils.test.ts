import { afterEach, describe, expect, test } from "vitest";

import { renderShadowRoot } from "../../src/controls/element-utils.js";

class FakeStyleSheet {
  cssText = "";

  replaceSync(cssText: string): void {
    this.cssText = cssText;
  }
}

const originalStyleSheet = Object.getOwnPropertyDescriptor(globalThis, "CSSStyleSheet");

afterEach(() => {
  if (originalStyleSheet) Object.defineProperty(globalThis, "CSSStyleSheet", originalStyleSheet);
  else Reflect.deleteProperty(globalThis, "CSSStyleSheet");
});

describe("renderShadowRoot", () => {
  test("uses a constructable stylesheet without serializing an inline style block", () => {
    Object.defineProperty(globalThis, "CSSStyleSheet", { configurable: true, value: FakeStyleSheet });
    const root = { innerHTML: "", adoptedStyleSheets: [] as CSSStyleSheet[] };

    renderShadowRoot(root, ".root { color: red; }", '<div class="root">Ready</div>');
    const sheet = root.adoptedStyleSheets[0] as unknown as FakeStyleSheet;

    expect(root.innerHTML).toBe('<div class="root">Ready</div>');
    expect(root.innerHTML).not.toContain("<style");
    expect(sheet.cssText).toBe(".root { color: red; }");

    renderShadowRoot(root, ".root { color: blue; }", '<div class="root">Updated</div>');
    expect(root.adoptedStyleSheets).toHaveLength(1);
    expect(root.adoptedStyleSheets[0]).toBe(sheet as unknown as CSSStyleSheet);
    expect(sheet.cssText).toBe(".root { color: blue; }");
    expect(root.innerHTML).toContain("Updated");
  });

  test("keeps the inline fallback for roots without constructable stylesheet support", () => {
    const root = { innerHTML: "" };

    renderShadowRoot(root, ".root { color: red; }", '<div class="root">Ready</div>');

    expect(root.innerHTML).toBe('<style>.root { color: red; }</style><div class="root">Ready</div>');
  });
});
