import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HonuaClient } from "@honua/sdk-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureClient } from "../src/certification/fixture-client.js";
import {
  SERVER_VERSION,
  createBootstrapServer,
  createClientFromEnv,
  createServer,
  resolveRuntimeOptions,
} from "../src/index.js";
import * as layerSchemaResource from "../src/resources/layer-schema.js";
import * as servicesResource from "../src/resources/services.js";
import * as stylesResource from "../src/resources/styles.js";
import * as adminInstallLocal from "../src/tools/admin-install-local.js";
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
    expect(toolSpy.mock.calls.some((call) => call[0] === "honua_admin_install_local")).toBe(false);
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
      const handler = registration?.at(-1) as (input: unknown) => Promise<unknown>;
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

  it("isolates local installation in the bootstrap-only catalog and fails closed without confirmation", async () => {
    const toolSpy = vi.spyOn(McpServer.prototype, "tool");
    const installSpy = vi
      .spyOn(adminInstallLocal, "execute")
      .mockResolvedValue({ content: [{ type: "text", text: "{}" }], structuredContent: { status: "ready" } } as never);

    createBootstrapServer();

    expect(toolSpy.mock.calls.map((call) => call[0])).toEqual(["honua_admin_install_local"]);
    const installRegistration = toolSpy.mock.calls[0];
    expect(installRegistration?.[3]).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });

    const handler = installRegistration?.at(-1) as (input: unknown) => Promise<unknown>;
    await expect(handler({ directory: ".honua" })).rejects.toThrow();
    expect(installSpy).not.toHaveBeenCalled();

    await handler({ directory: ".honua", confirm: true });
    expect(installSpy).toHaveBeenCalledWith(
      expect.objectContaining({ directory: ".honua", profile: "quickstart", confirm: true }),
    );
  });
});

/**
 * #1412 fail-closed dispatch proof.
 *
 * Unregistering `honua_admin_install_local` from {@link createServer} is a
 * catalog change; it is NOT on its own proof that the ordinary server refuses
 * to RUN the installer. An agent that already knows the tool name can send a
 * `tools/call` for it without ever reading the catalog. This exercises exactly
 * that hostile path over a real MCP transport and asserts the dispatch aborts
 * in the protocol router -- before argument parsing, and therefore before any
 * filesystem, Docker, or credential mutation the installer would perform.
 */
describe("ordinary MCP server local-install dispatch", () => {
  it("refuses a direct honua_admin_install_local call before any filesystem, Docker, or credential mutation", async () => {
    const installSpy = vi.spyOn(adminInstallLocal, "execute");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const scratch = mkdtempSync(path.join(tmpdir(), "honua-mcp-fail-closed-"));
    // Deliberately NOT created: installHonuaLocal would mkdir it, write
    // compose.yaml/.env/MCP config into it, and spawn Docker there. Its absence
    // after the call is the mutation-free assertion.
    const directory = path.join(scratch, "install-target");

    const server = createServer(createFixtureClient());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "fail-closed-probe", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("honua_admin_install_local");

      // The hostile call: fully-formed, confirm=true, name known out of band.
      const refusal = (await client.callTool({
        name: "honua_admin_install_local",
        arguments: { directory, profile: "quickstart", confirm: true },
      })) as { isError?: boolean; content: { type: string; text: string }[] };

      // -32602 (invalid params) from the router: the name never resolved to a
      // handler, so nothing downstream of registration ever ran.
      expect(refusal.isError).toBe(true);
      expect(refusal.content[0]?.text).toMatch(/-32602/);
      expect(refusal.content[0]?.text).toMatch(/honua_admin_install_local not found/);

      expect(installSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(existsSync(directory)).toBe(false);
    } finally {
      await client.close();
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still exposes the installer on the bootstrap server, so the refusal above is scoping and not absence", async () => {
    const installSpy = vi
      .spyOn(adminInstallLocal, "execute")
      .mockResolvedValue({ content: [{ type: "text", text: "{}" }], structuredContent: { status: "ready" } } as never);

    const server = createBootstrapServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "bootstrap-probe", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(["honua_admin_install_local"]);

      await client.callTool({
        name: "honua_admin_install_local",
        arguments: { directory: ".honua", confirm: true },
      });
      expect(installSpy).toHaveBeenCalledWith(
        expect.objectContaining({ directory: ".honua", profile: "quickstart", confirm: true }),
      );
    } finally {
      await client.close();
      await server.close();
    }
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
