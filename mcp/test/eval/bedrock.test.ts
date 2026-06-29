import { describe, expect, it } from "vitest";
import {
  BedrockDriver,
  extractText,
  extractToolUses,
  toBedrockTools,
  toToolResultBlock,
} from "../../src/eval/drivers/bedrock.js";
import { parseDriverName, resolveDrivers, selectDrivers } from "../../src/eval/drivers/index.js";
import type { ToolDescriptor } from "../../src/eval/types.js";

describe("Bedrock driver mapping (#1956)", () => {
  it("maps MCP tool descriptors to Converse toolSpec entries", () => {
    const tools: ToolDescriptor[] = [
      { name: "honua_list_services", description: "list services", inputSchema: { type: "object", properties: {} } },
    ];
    const mapped = toBedrockTools(tools);
    expect(mapped).toEqual([
      {
        toolSpec: {
          name: "honua_list_services",
          description: "list services",
          inputSchema: { json: { type: "object", properties: {} } },
        },
      },
    ]);
  });

  it("defaults a missing inputSchema to an empty object schema", () => {
    const mapped = toBedrockTools([{ name: "t", description: "d", inputSchema: undefined }]);
    expect(mapped[0]?.toolSpec.inputSchema.json).toEqual({ type: "object" });
  });

  it("extracts tool-use blocks and ignores text/empty blocks", () => {
    const uses = extractToolUses([
      { text: "thinking" },
      { toolUse: { toolUseId: "u1", name: "honua_count_features", input: { service: "s" } } },
      {},
      { toolUse: undefined },
    ]);
    expect(uses).toEqual([{ toolUseId: "u1", name: "honua_count_features", input: { service: "s" } }]);
  });

  it("concatenates text blocks only", () => {
    const text = extractText([{ text: "line one" }, { toolUse: { toolUseId: "u", name: "n" } }, { text: "line two" }]);
    expect(text).toBe("line one\nline two");
  });

  it("builds success and error toolResult blocks", () => {
    expect(toToolResultBlock("u1", "ok", false)).toEqual({
      toolResult: { toolUseId: "u1", content: [{ text: "ok" }], status: "success" },
    });
    expect(toToolResultBlock("u2", "boom", true)).toEqual({
      toolResult: { toolUseId: "u2", content: [{ text: "boom" }], status: "error" },
    });
  });
});

describe("Bedrock driver configuration (#1956)", () => {
  it("defaults to the Sonnet 4.5 model id and us-west-2 region", () => {
    const d = new BedrockDriver({ enabled: undefined, region: undefined, model: undefined });
    expect(d.id).toBe("anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(d.region).toBe("us-west-2");
    expect(d.vendor).toBe("bedrock");
  });

  it("honors explicit model and region overrides", () => {
    const d = new BedrockDriver({
      enabled: "1",
      model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      region: "us-east-1",
    });
    expect(d.id).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(d.region).toBe("us-east-1");
  });

  it("treats common falsey opt-in values as unavailable", () => {
    for (const v of [undefined, "", " ", "0", "false", "no", "off"]) {
      expect(new BedrockDriver({ enabled: v }).isAvailable()).toBe(false);
    }
    for (const v of ["1", "true", "yes", "on", "us-west-2"]) {
      expect(new BedrockDriver({ enabled: v }).isAvailable()).toBe(true);
    }
  });
});

describe("Bedrock driver selection (#1956)", () => {
  it("adds the Bedrock driver via resolveDrivers when HONUA_EVAL_BEDROCK is set", () => {
    const drivers = resolveDrivers({ env: { HONUA_EVAL_BEDROCK: "1" } });
    expect(drivers.map((d) => d.vendor).sort()).toEqual(["bedrock", "deterministic"]);
  });

  it("omits the Bedrock driver when the opt-in flag is absent", () => {
    const drivers = resolveDrivers({ env: {} });
    expect(drivers.map((d) => d.vendor)).toEqual(["deterministic"]);
  });

  it("force-includes the Bedrock driver via selectDrivers even without the flag", () => {
    const drivers = selectDrivers(["bedrock"], { env: {} });
    expect(drivers.map((d) => d.vendor)).toEqual(["deterministic", "bedrock"]);
    // explicit selection means the driver runs (and would report an honest error)
    const bedrock = drivers.find((d) => d.vendor === "bedrock");
    expect(bedrock?.isAvailable()).toBe(true);
  });

  it("validates --driver names", () => {
    expect(parseDriverName("bedrock")).toBe("bedrock");
    expect(parseDriverName("anthropic")).toBe("anthropic");
    expect(() => parseDriverName("gemini")).toThrow(/unknown --driver/);
  });
});
