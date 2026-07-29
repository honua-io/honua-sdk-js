// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";

import { renderCspSafeShadowHtml } from "../src/web-components/csp-styles.js";

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

describe("web-component CSP stylesheet rendering", () => {
  test("moves static style blocks to an adopted stylesheet", () => {
    Object.defineProperty(globalThis, "CSSStyleSheet", { configurable: true, value: FakeStyleSheet });
    const root = {
      adoptedStyleSheets: [] as CSSStyleSheet[],
      innerHTML: "",
    } as unknown as ShadowRoot;
    Object.setPrototypeOf(root, ShadowRoot.prototype);

    renderCspSafeShadowHtml(root, '<style>.panel { color: red; }</style><div class="panel">Ready</div>');

    expect(root.innerHTML).toBe('<div class="panel">Ready</div>');
    expect(root.innerHTML).not.toContain("<style");
    expect((root.adoptedStyleSheets[0] as unknown as FakeStyleSheet).cssText).toContain("color: red");
  });
});
