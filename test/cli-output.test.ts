import { describe, expect, it } from "vitest";

import { renderDetail, renderJson, renderTable } from "../src/cli/output.js";

describe("renderTable", () => {
  it("renders an aligned header + rows", () => {
    const out = renderTable(
      [
        { name: "maui-parcels", type: "FeatureServer" },
        { name: "maui-roads", type: "FeatureServer" },
      ],
      [
        { key: "name", header: "SERVICE" },
        { key: "type", header: "TYPE" },
      ],
    );
    const lines = out.split("\n");
    expect(lines[0]).toBe("SERVICE       TYPE");
    expect(lines[1]).toBe("------------  -------------");
    expect(lines[2]).toContain("maui-parcels");
    expect(lines[2]).toContain("FeatureServer");
  });

  it("right-aligns numeric columns", () => {
    const out = renderTable([{ id: 1 }, { id: 42 }], [{ key: "id", header: "ID", align: "right" }]);
    const lines = out.split("\n");
    // " 1" padded to width 2, "42" already width 2.
    expect(lines[2]).toBe(" 1");
    expect(lines[3]).toBe("42");
  });

  it("shows the empty text when there are no rows", () => {
    const out = renderTable([], [{ key: "name" }], { emptyText: "(no services)" });
    expect(out).toContain("(no services)");
  });

  it("renders null/undefined cells as blanks", () => {
    const out = renderTable(
      [{ a: null, b: "x" }],
      [
        { key: "a", header: "A" },
        { key: "b", header: "B" },
      ],
    );
    expect(out.split("\n")[2]).toBe("   x");
  });
});

describe("renderDetail", () => {
  it("aligns key/value pairs", () => {
    const out = renderDetail({ baseUrl: "https://demo.honua.io", auth: "anonymous" });
    expect(out).toContain("baseUrl:  https://demo.honua.io");
    expect(out).toContain("auth:     anonymous");
  });
});

describe("renderJson", () => {
  it("pretty-prints", () => {
    expect(renderJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
