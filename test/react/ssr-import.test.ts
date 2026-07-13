// Intentionally NO jsdom: this suite runs in the default node environment to
// prove the `@honua/react` entrypoint is SSR-safe — importable and renderable
// with no `window` / `document` in scope (NFR-001 of the react depth pass).
import { describe, expect, it } from "vitest";

describe("@honua/react SSR safety", () => {
  it("runs without window/document (node environment)", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
  });

  it("imports the entrypoint at module scope without touching the DOM", async () => {
    const entry = await import("../../src/react/index.js");
    // Representative slice of the public surface, old and new.
    expect(typeof entry.HonuaProvider).toBe("function");
    expect(typeof entry.HonuaMap).toBe("function");
    expect(typeof entry.HonuaMapProvider).toBe("function");
    expect(typeof entry.HonuaSourceLayer).toBe("function");
    expect(typeof entry.HonuaSelectionProvider).toBe("function");
    expect(typeof entry.useMountedSource).toBe("function");
    expect(typeof entry.useSelection).toBe("function");
    expect(typeof entry.useHover).toBe("function");
    expect(typeof entry.useHonuaMap).toBe("function");
    expect(typeof entry.useQuery).toBe("function");
    expect(typeof entry.HonuaSelectionStore).toBe("function");
  });

  it("renders providers, hooks, and bridge components to markup on the server", async () => {
    const [{ renderToStaticMarkup }, React, entry] = await Promise.all([
      import("react-dom/server"),
      import("react"),
      import("../../src/react/index.js"),
    ]);
    const { HonuaProvider, HonuaMapProvider, HonuaSelectionProvider, HonuaSourceLayer, useSelection, useHonuaMap } =
      entry;

    function Probe() {
      const { selected } = useSelection();
      const map = useHonuaMap();
      return React.createElement("span", null, `selected:${selected.length} map:${map === null ? "none" : "set"}`);
    }

    const client = {} as never; // never dereferenced during a render-only pass
    const markup = renderToStaticMarkup(
      React.createElement(
        HonuaProvider,
        { client },
        React.createElement(
          HonuaSelectionProvider,
          null,
          React.createElement(
            HonuaMapProvider,
            { map: null },
            // No map on the server: the source layer renders nothing and
            // must not attempt to mount.
            React.createElement(HonuaSourceLayer, { source: null }),
            React.createElement(Probe, null),
          ),
        ),
      ),
    );
    expect(markup).toContain("selected:0 map:none");
  });
});
