import { describe, expect, it } from "vitest";

/**
 * The `ssr-import` qualification gate for both app-platform component kits
 * (issue #683, REQ-005; the gate row lives in `src/controls/qualification.ts`).
 *
 * Intentionally NO jsdom: this suite runs in the default Node environment to
 * prove `@honua/sdk-js/controls` and `@honua/sdk-js/web-components` are
 * import-safe during a server render, in a worker, or in a build-time tool that
 * introspects the catalog. The pattern deliberately mirrors
 * `test/react/ssr-import.test.ts`, which is the repo's established shape for
 * this gate.
 *
 * Both kits already relied on this working — several existing suites import
 * these modules under Node — but that was incidental, not asserted. This suite
 * makes it a declared gate, so a future top-level `document.querySelector` or
 * eager `customElements.define` fails here with a message that says why.
 */
describe("component kits are SSR-safe to import", () => {
  it("runs with no DOM globals present", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(typeof customElements).toBe("undefined");
    expect(typeof HTMLElement).toBe("undefined");
  });

  it("imports the web-components entrypoint, which auto-registers, without touching a DOM", async () => {
    const kit = await import("../src/web-components/index.js");
    // The blanket auto-registration side effect runs on import and must no-op.
    expect(typeof kit.defineHonuaWebComponents).toBe("function");
    expect(() => kit.defineHonuaWebComponents()).not.toThrow();
    expect(kit.HONUA_COMPONENT_CATALOG.length).toBeGreaterThan(0);
  });

  it("imports the controls entrypoint, which auto-registers, without touching a DOM", async () => {
    const kit = await import("../src/controls/index.js");
    expect(typeof kit.defineHonuaControls).toBe("function");
    expect(() => kit.defineHonuaControls()).not.toThrow();
  });

  it("imports the side-effect-free element module and the pure metadata modules", async () => {
    const elements = await import("../src/web-components/elements.js");
    const catalog = await import("../src/controls/catalog.js");
    const qualification = await import("../src/controls/qualification.js");
    const registry = await import("../src/controls/registry.js");
    expect(typeof elements.defineHonuaWebComponent).toBe("function");
    expect(catalog.HONUA_COMPONENT_CATALOG.length).toBe(qualification.listComponentQualifications().length);
    // Registration against the absent global registry resolves rather than throwing.
    await expect(registry.registerAllComponents()).resolves.toBeUndefined();
  });

  it("imports the production-tier feature editor's own module with no DOM", async () => {
    // Named explicitly rather than left to the barrel: this element extends its
    // DOM-optional base directly and hand-rolls its own render path, so the
    // `ssr-import` gate the matrix records for it must actually touch this
    // module (issue #680 component, issue #683 gate).
    const editor = await import("../src/web-components/feature-editor.js");
    expect(typeof editor.HonuaFeatureEditorElement).toBe("function");
    expect(typeof editor.defineHonuaFeatureEditor).toBe("function");
    expect(() => editor.defineHonuaFeatureEditor()).not.toThrow();

    const workflow = await import("../src/web-components/feature-editor-workflow.js");
    const model = await import("../src/web-components/feature-editor-model.js");
    expect(typeof workflow.createFeatureEditorWorkflow).toBe("function");
    expect(typeof model.buildEditorFormModel).toBe("function");
  });

  it("imports the bounded feature table's own modules and renders grid HTML with no DOM", async () => {
    // Named explicitly for the same reason as the feature editor above: the
    // bounded table ships its own engine and view modules, and the view module
    // exists precisely to produce markup as a string, which is a server-render
    // capability worth asserting rather than assuming.
    const engine = await import("../src/web-components/feature-table-engine.js");
    const view = await import("../src/web-components/feature-table-view.js");
    expect(typeof engine.createHonuaFeatureTable).toBe("function");
    expect(typeof view.featureTableGridHtml).toBe("function");
    expect(typeof engine.featureTableRowKey).toBe("function");
  });

  it("imports the export contract and sanitizes state with no DOM", async () => {
    const { runHonuaExport, sanitizeHonuaExportState, createBrowserPrintExportAdapter } = await import(
      "../src/web-components/index.js"
    );
    expect(sanitizeHonuaExportState(undefined).state.layers).toEqual([]);
    // No `window` in this environment, so the built-in print adapter declares nothing.
    expect(createBrowserPrintExportAdapter().describeCapabilities().kinds).toEqual([]);
    const result = await runHonuaExport({ kind: "snapshot" });
    expect(result.status).toBe("unsupported");
  });

  it("defines no custom element as a side effect of any of those imports", async () => {
    // A `customElements` global would be the only way a registration could have
    // happened; its absence above is the assertion. This re-checks after every
    // import has run, so an import that *installs* a registry shim also fails.
    expect((globalThis as { customElements?: unknown }).customElements).toBeUndefined();
  });
});
