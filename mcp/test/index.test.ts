import { readFileSync } from "node:fs";
import { HonuaClient } from "@honua/sdk-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_VERSION, createClientFromEnv, createServer, resolveRuntimeOptions } from "../src/index.js";
import * as layerSchemaResource from "../src/resources/layer-schema.js";
import * as servicesResource from "../src/resources/services.js";
import * as stylesResource from "../src/resources/styles.js";
import * as applyStylePreset from "../src/tools/apply-style-preset.js";
import * as countFeatures from "../src/tools/count-features.js";
import * as describeLayer from "../src/tools/describe-layer.js";
import * as explainCapabilityGap from "../src/tools/explain-capability-gap.js";
import * as getExtent from "../src/tools/get-extent.js";
import * as getStyle from "../src/tools/get-style.js";
import * as listServices from "../src/tools/list-services.js";
import * as listSources from "../src/tools/list-sources.js";
import * as queryFeatures from "../src/tools/query-features.js";
import * as statistics from "../src/tools/statistics.js";
import { asClient, createMockClient } from "./test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP server setup", () => {
  it("creates a server from a HonuaClient", () => {
    const client = new HonuaClient({ baseUrl: "http://localhost:5000" });
    const server = createServer(client);

    expect(server).toBeDefined();
  });

  it("keeps MCP server version aligned with package version", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };

    expect(SERVER_VERSION).toBe(packageJson.version);
  });

  it("registers all tools and resources with executable handlers", async () => {
    const toolSpy = vi.spyOn(McpServer.prototype, "tool");
    const resourceSpy = vi.spyOn(McpServer.prototype, "resource");

    const listSpy = vi.spyOn(listServices, "execute").mockResolvedValue({ content: [{ type: "text", text: "[]" }] });
    const listSourcesSpy = vi
      .spyOn(listSources, "execute")
      .mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const describeSpy = vi
      .spyOn(describeLayer, "execute")
      .mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const querySpy = vi.spyOn(queryFeatures, "execute").mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const countSpy = vi.spyOn(countFeatures, "execute").mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const extentSpy = vi.spyOn(getExtent, "execute").mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const statsSpy = vi.spyOn(statistics, "execute").mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const explainSpy = vi
      .spyOn(explainCapabilityGap, "execute")
      .mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const getStyleSpy = vi.spyOn(getStyle, "execute").mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const applyStyleSpy = vi
      .spyOn(applyStylePreset, "execute")
      .mockResolvedValue({ content: [{ type: "text", text: "{}" }] });
    const servicesReadSpy = vi.spyOn(servicesResource, "read").mockResolvedValue({ contents: [] });
    const layerReadSpy = vi.spyOn(layerSchemaResource, "read").mockResolvedValue({ contents: [] });
    const stylesCatalogSpy = vi.spyOn(stylesResource, "readCatalog").mockResolvedValue({ contents: [] });
    const styleReadSpy = vi.spyOn(stylesResource, "read").mockResolvedValue({ contents: [] });

    const client = asClient(createMockClient());
    createServer(client);

    expect(toolSpy.mock.calls.map((call) => call[0])).toEqual([
      "honua_list_sources",
      "honua_list_services",
      "honua_describe_layer",
      "honua_query_features",
      "honua_count_features",
      "honua_get_extent",
      "honua_statistics",
      "honua_explain_capability_gap",
      "honua_get_style",
      "honua_apply_style_preset",
    ]);
    expect(resourceSpy.mock.calls.map((call) => call[0])).toEqual([
      "services-catalog",
      "layer-schema",
      "styles-catalog",
      "style",
    ]);

    const toolInputs: Record<string, Record<string, unknown>> = {
      honua_list_sources: {},
      honua_list_services: {},
      honua_describe_layer: { serviceId: "Parks", layerId: 0 },
      honua_query_features: { serviceId: "Parks", layerId: 0 },
      honua_count_features: { serviceId: "Parks", layerId: 0 },
      honua_get_extent: { serviceId: "Parks", layerId: 0 },
      honua_statistics: { serviceId: "Parks", layerId: 0, statisticType: "count", onField: "OBJECTID" },
      honua_explain_capability_gap: { protocol: "wmts", capability: "query" },
      honua_get_style: { styleId: "topographic" },
      honua_apply_style_preset: { styleId: "topographic" },
    };

    for (const [name, args] of Object.entries(toolInputs)) {
      const registration = toolSpy.mock.calls.find((call) => call[0] === name);
      const handler = registration?.[3] as (input: unknown) => Promise<unknown>;
      await handler(args);
    }

    expect(listSpy).toHaveBeenCalledWith(client, { includeDetails: false });
    expect(listSourcesSpy).toHaveBeenCalledWith(client, { protocol: "auto", maxServices: 25 });
    expect(describeSpy).toHaveBeenCalledWith(client, { serviceId: "Parks", layerId: 0 });
    expect(querySpy).toHaveBeenCalledWith(client, expect.objectContaining({ serviceId: "Parks", layerId: 0 }));
    expect(countSpy).toHaveBeenCalledWith(client, { serviceId: "Parks", layerId: 0 });
    expect(extentSpy).toHaveBeenCalledWith(client, { serviceId: "Parks", layerId: 0 });
    expect(statsSpy).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        serviceId: "Parks",
        layerId: 0,
        statisticType: "count",
        onField: "OBJECTID",
      }),
    );
    expect(explainSpy).toHaveBeenCalledWith(client, { protocol: "wmts", capability: "query" });
    expect(getStyleSpy).toHaveBeenCalledWith(client, { styleId: "topographic" });
    expect(applyStyleSpy).toHaveBeenCalledWith(client, { styleId: "topographic" });

    const servicesRegistration = resourceSpy.mock.calls.find((call) => call[0] === "services-catalog");
    const servicesHandler = servicesRegistration?.[2] as (uri: URL) => Promise<unknown>;
    await servicesHandler(new URL("honua://services"));

    const layerRegistration = resourceSpy.mock.calls.find((call) => call[0] === "layer-schema");
    const layerHandler = layerRegistration?.[2] as (uri: URL, params: Record<string, unknown>) => Promise<unknown>;
    await layerHandler(new URL("honua://services/Parks/layers/0"), { encodedServiceId: "Parks", layerId: "0" });

    const stylesCatalogRegistration = resourceSpy.mock.calls.find((call) => call[0] === "styles-catalog");
    const stylesCatalogHandler = stylesCatalogRegistration?.[2] as (uri: URL) => Promise<unknown>;
    await stylesCatalogHandler(new URL("honua://styles"));

    const styleRegistration = resourceSpy.mock.calls.find((call) => call[0] === "style");
    const styleHandler = styleRegistration?.[2] as (uri: URL, params: Record<string, unknown>) => Promise<unknown>;
    await styleHandler(new URL("honua://styles/topographic"), { styleId: "topographic" });

    expect(servicesReadSpy).toHaveBeenCalledWith(client);
    expect(layerReadSpy).toHaveBeenCalledWith(client, "Parks", "0");
    expect(stylesCatalogSpy).toHaveBeenCalledWith(client);
    expect(styleReadSpy).toHaveBeenCalledWith(client, "topographic");
  });
});

describe("runtime options", () => {
  it("defaults transport to grpc-web and timeout/retries to safe defaults", () => {
    const options = resolveRuntimeOptions({
      HONUA_BASE_URL: "https://example.test",
    } as NodeJS.ProcessEnv);

    expect(options.transport).toBe("grpc-web");
    expect(options.timeoutMs).toBe(30_000);
    expect(options.retryMaxRetries).toBe(2);
  });

  it("accepts explicit rest transport with normalization", () => {
    const options = resolveRuntimeOptions({
      HONUA_BASE_URL: "https://example.test",
      HONUA_TRANSPORT: " REST ",
    } as NodeJS.ProcessEnv);

    expect(options.transport).toBe("rest");
  });

  it("accepts grpc alias values", () => {
    const grpc = resolveRuntimeOptions({
      HONUA_BASE_URL: "https://example.test",
      HONUA_TRANSPORT: "grpc",
    } as NodeJS.ProcessEnv);
    const grcp = resolveRuntimeOptions({
      HONUA_BASE_URL: "https://example.test",
      HONUA_TRANSPORT: "grcp",
    } as NodeJS.ProcessEnv);

    expect(grpc.transport).toBe("grpc-web");
    expect(grcp.transport).toBe("grpc-web");
  });

  it("rejects invalid transport values", () => {
    expect(() =>
      resolveRuntimeOptions({
        HONUA_BASE_URL: "https://example.test",
        HONUA_TRANSPORT: "websocket",
      } as NodeJS.ProcessEnv),
    ).toThrow('HONUA_TRANSPORT must be "grpc-web" (aliases: "grpc", "grcp") or "rest"');
  });

  it("rejects non-http protocols for base URL", () => {
    expect(() =>
      resolveRuntimeOptions({
        HONUA_BASE_URL: "ftp://example.test",
      } as NodeJS.ProcessEnv),
    ).toThrow("HONUA_BASE_URL must use http or https");
  });

  it("rejects missing base URL", () => {
    expect(() => resolveRuntimeOptions({} as NodeJS.ProcessEnv)).toThrow(
      "HONUA_BASE_URL environment variable is required",
    );
  });

  it("rejects invalid base URL", () => {
    expect(() =>
      resolveRuntimeOptions({
        HONUA_BASE_URL: "not-a-url",
      } as NodeJS.ProcessEnv),
    ).toThrow("HONUA_BASE_URL must be a valid absolute URL");
  });

  it("rejects non-local HTTP base URL when API key is present", () => {
    expect(() =>
      resolveRuntimeOptions({
        HONUA_BASE_URL: "http://example.test",
        HONUA_API_KEY: "secret",
      } as NodeJS.ProcessEnv),
    ).toThrow("HONUA_API_KEY over non-local HTTP is not allowed");
  });

  it("allows localhost HTTP base URL with API key", () => {
    const options = resolveRuntimeOptions({
      HONUA_BASE_URL: "http://localhost:8080",
      HONUA_API_KEY: "secret",
    } as NodeJS.ProcessEnv);

    expect(options.baseUrl).toBe("http://localhost:8080/");
  });

  it("accepts custom timeout and retry values", () => {
    const options = resolveRuntimeOptions({
      HONUA_BASE_URL: "https://example.test",
      HONUA_TIMEOUT_MS: "45000",
      HONUA_RETRY_MAX_RETRIES: "4",
    } as NodeJS.ProcessEnv);

    expect(options.timeoutMs).toBe(45_000);
    expect(options.retryMaxRetries).toBe(4);
  });

  it("rejects invalid timeout and retry values", () => {
    expect(() =>
      resolveRuntimeOptions({
        HONUA_BASE_URL: "https://example.test",
        HONUA_TIMEOUT_MS: "0",
      } as NodeJS.ProcessEnv),
    ).toThrow("HONUA_TIMEOUT_MS must be a positive integer");

    expect(() =>
      resolveRuntimeOptions({
        HONUA_BASE_URL: "https://example.test",
        HONUA_RETRY_MAX_RETRIES: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow("HONUA_RETRY_MAX_RETRIES must be a non-negative integer");
  });

  it("creates client from env with configured transport", () => {
    const client = createClientFromEnv({
      HONUA_BASE_URL: "https://example.test",
      HONUA_TRANSPORT: "grcp",
    } as NodeJS.ProcessEnv);

    expect(client).toBeInstanceOf(HonuaClient);
    expect(client.isGrpcWeb).toBe(true);
  });
});
