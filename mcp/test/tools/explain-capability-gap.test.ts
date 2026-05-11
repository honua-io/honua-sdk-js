import { describe, expect, it } from "vitest";
import { execute, schema } from "../../src/tools/explain-capability-gap.js";

describe("honua_explain_capability_gap", () => {
  it("explains unsupported protocol defaults", async () => {
    const result = await execute(undefined, schema.parse({ protocol: "wmts", capability: "query" }));
    const payload = JSON.parse(result.content[0].text);

    expect(payload.explanation).toMatchObject({
      supported: false,
      protocol: "wmts",
      capability: "query",
    });
  });

  it("honors source-declared capabilities", async () => {
    const result = await execute(
      undefined,
      schema.parse({
        sourceId: "parcels",
        capability: "query",
        declaredCapabilities: ["query", "queryExtent"],
      }),
    );
    const payload = JSON.parse(result.content[0].text);

    expect(payload.explanation).toMatchObject({
      supported: true,
      sourceId: "parcels",
      capabilities: ["query", "queryExtent"],
    });
  });

  it("validates protocol and capability identifiers", () => {
    expect(() => schema.parse({ protocol: "unknown", capability: "query" })).toThrow();
    expect(() => schema.parse({ protocol: "wmts", capability: "not-real" })).toThrow();
  });
});
