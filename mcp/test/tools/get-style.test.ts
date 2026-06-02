import { describe, expect, it } from "vitest";
import { execute, schema } from "../../src/tools/get-style.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("honua_get_style", () => {
  it("returns the styles catalog when no styleId is given", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({}));
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.default).toBe("topographic");
    expect(parsed.styles).toHaveLength(2);
    expect(parsed.styles[0]).toEqual({
      styleId: "topographic",
      title: "Topographic",
      uri: "honua://styles/topographic",
    });
  });

  it("returns a StyleRef for a specific styleId", async () => {
    const mock = createMockClient();
    const result = await execute(asClient(mock), schema.parse({ styleId: "topographic" }));
    const styleRef = JSON.parse(result.content[0].text);

    expect(styleRef.styleId).toBe("topographic");
    expect(styleRef.title).toBe("Topographic");
    expect(styleRef.styleVersion).toBe(3);
    expect(styleRef.encodings).toHaveLength(3);
    expect(styleRef.encodings.map((e: { encoding: string }) => e.encoding)).toEqual([
      "mapbox-style",
      "sld-1.0.0",
      "sld-1.1.0",
    ]);
  });

  it("requests the OGC styles endpoints", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ styleId: "topographic" }));

    const paths = mock.pipelineFetch.mock.calls.map((call) => call[1]);
    expect(paths).toContain("/ogc/styles/topographic");
    expect(paths).toContain("/ogc/styles/topographic/metadata");
  });
});
