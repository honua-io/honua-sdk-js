import { describe, expect, it } from "vitest";
import { execute, schema } from "../../src/tools/apply-style-preset.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("honua_apply_style_preset", () => {
  it("returns the resolved StyleRef and MapLibre stylesheet for client-side application", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({ styleId: "topographic" }));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.style.styleId).toBe("topographic");
    expect(parsed.application).toBe("client-side");
    expect(parsed.stylesheet).toEqual({
      version: 8,
      name: "Topographic",
      layers: [{ id: "background", type: "background" }],
    });
    expect(parsed.note).toMatch(/does not mutate server state/i);
  });

  it("requires a styleId", () => {
    expect(() => schema.parse({})).toThrow();
  });

  it("only issues GET requests (read-only)", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ styleId: "topographic" }));

    for (const call of mock.pipelineFetch.mock.calls) {
      expect(call[0]).toBe("GET");
    }
  });

  it("fetches the stylesheet only once per call", async () => {
    // resolveStyleRef already inlines the MapLibre body; the tool must reuse it
    // rather than issuing a second identical GET /ogc/styles/{id}.
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ styleId: "topographic" }));

    const stylesheetFetches = mock.pipelineFetch.mock.calls.filter((call) => call[1] === "/ogc/styles/topographic");
    expect(stylesheetFetches).toHaveLength(1);
  });
});
