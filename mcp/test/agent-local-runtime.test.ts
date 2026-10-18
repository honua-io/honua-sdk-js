import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentRuntime, nativeWorkspaceFromEnv } from "../src/agent/local-runtime.js";

const access = vi.hoisted(() => ({
  readVerifiedLocalEnv: vi.fn(),
  inspectLocalAgentAccess: vi.fn(),
  inspectLocalWorkspaceAgentAccess: vi.fn(),
  installHonuaLocal: vi.fn(),
}));
vi.mock("@honua/sdk-js/local-install", () => access);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ready")));
  access.inspectLocalWorkspaceAgentAccess.mockResolvedValue({ id: "workspace-key-id" });
  access.inspectLocalAgentAccess.mockResolvedValue({ id: "legacy-key-id" });
});
afterEach(() => vi.unstubAllGlobals());

describe("local gateway credential selection", () => {
  it("reattaches using the verified workspace identity and never presents the operator key", async () => {
    access.readVerifiedLocalEnv.mockResolvedValue({
      HONUA_HTTP_PORT: "8080",
      HONUA_ADMIN_KEY: "operator-material",
      HONUA_AGENT_API_KEY: "workspace-material",
      HONUA_AGENT_KEY_ID: "workspace-key-id",
    });
    const result = await createLocalAgentRuntime("/local").resolve();
    expect(access.inspectLocalWorkspaceAgentAccess).toHaveBeenCalledWith(
      "http://127.0.0.1:8080",
      "workspace-material",
      "workspace-key-id",
      expect.any(Function),
    );
    expect(access.inspectLocalAgentAccess).not.toHaveBeenCalled();
    expect(result.transport.apiKey).toBe("workspace-material");
    expect(result.target.credentialId).toBe("workspace-key-id");
    expect(JSON.stringify(result)).not.toContain("operator-material");
  });

  it.each([
    { HONUA_AGENT_KEY_ID: "workspace-key-id" },
    { HONUA_AGENT_API_KEY: "workspace-material" },
    { HONUA_AGENT_API_KEY: "", HONUA_AGENT_KEY_ID: "" },
  ])("refuses incomplete workspace credentials before network access: %j", async (partial) => {
    access.readVerifiedLocalEnv.mockResolvedValue({ HONUA_HTTP_PORT: "8080", HONUA_ADMIN_KEY: "operator", ...partial });
    await expect(createLocalAgentRuntime("/local").resolve()).rejects.toThrow("incomplete");
    expect(fetch).not.toHaveBeenCalled();
    expect(access.inspectLocalAgentAccess).not.toHaveBeenCalled();
  });

  it("does not fall back when workspace credential verification fails", async () => {
    access.readVerifiedLocalEnv.mockResolvedValue({
      HONUA_HTTP_PORT: "8080",
      HONUA_ADMIN_KEY: "operator",
      HONUA_AGENT_API_KEY: "revoked",
      HONUA_AGENT_KEY_ID: "workspace-key-id",
    });
    access.inspectLocalWorkspaceAgentAccess.mockRejectedValue(new Error("Revoked credential"));
    await expect(createLocalAgentRuntime("/local").resolve()).rejects.toThrow("Revoked credential");
    expect(access.inspectLocalAgentAccess).not.toHaveBeenCalled();
  });

  it("retains the verified legacy install path when no workspace identity exists", async () => {
    access.readVerifiedLocalEnv.mockResolvedValue({ HONUA_HTTP_PORT: "8080", HONUA_ADMIN_KEY: "legacy" });
    const result = await createLocalAgentRuntime("/local").resolve();
    expect(result.transport.apiKey).toBe("legacy");
    expect(access.inspectLocalWorkspaceAgentAccess).not.toHaveBeenCalled();
    expect(access.inspectLocalAgentAccess).toHaveBeenCalledOnce();
  });
});

it("requires a complete host-selected preview configuration rather than silently installing a different release", () => {
  expect(nativeWorkspaceFromEnv({})).toBeUndefined();
  expect(() => nativeWorkspaceFromEnv({ HONUA_AGENT_PREVIEW_RELEASE_ID: "preview" })).toThrow("Incomplete");
  const env = {
    HONUA_AGENT_PREVIEW_SERVER_IMAGE: `server@sha256:${"a".repeat(64)}`,
    HONUA_AGENT_PREVIEW_CONSOLE_IMAGE: `console@sha256:${"b".repeat(64)}`,
    HONUA_AGENT_PREVIEW_RELEASE_ID: "preview",
    HONUA_AGENT_PREVIEW_GATEWAY_COMMAND: "/qualified/node",
    HONUA_AGENT_PREVIEW_GATEWAY_ARGS: '["/qualified/gateway.js"]',
  };
  expect(nativeWorkspaceFromEnv(env)).toMatchObject({
    releaseId: "preview",
    gatewayCommand: "/qualified/node",
    gatewayArgs: ["/qualified/gateway.js"],
  });
  expect(() => nativeWorkspaceFromEnv({ ...env, HONUA_AGENT_PREVIEW_GATEWAY_ARGS: "[1]" })).toThrow("string array");
  expect(() => nativeWorkspaceFromEnv({ ...env, HONUA_AGENT_PREVIEW_CONSOLE_PORT: "0" })).toThrow("Console port");
});

it("passes host-selected model and gateway credential references without resolving secrets into configuration", () => {
  const env = {
    HONUA_AGENT_PREVIEW_SERVER_IMAGE: `server@sha256:${"a".repeat(64)}`,
    HONUA_AGENT_PREVIEW_CONSOLE_IMAGE: `console@sha256:${"b".repeat(64)}`,
    HONUA_AGENT_PREVIEW_RELEASE_ID: "preview",
    HONUA_AGENT_PREVIEW_GATEWAY_COMMAND: "/qualified/node",
    HONUA_AGENT_PREVIEW_MODEL_KIND: "bedrock",
    HONUA_AGENT_PREVIEW_MODEL_NAME: "amazon.nova-pro-v1:0",
    HONUA_AGENT_PREVIEW_MODEL_REGION: "us-east-1",
    HONUA_AGENT_PREVIEW_MODEL_KEY_ENV: "PRIVATE_MODEL_TOKEN",
    HONUA_AGENT_PREVIEW_GATEWAY_HTTP_URL: "http://private-gateway:7863",
    HONUA_AGENT_PREVIEW_GATEWAY_HTTP_KEY_ENV: "PRIVATE_GATEWAY_BRIDGE",
    HONUA_AGENT_PREVIEW_GP_WORKSPACE_URL: "http://host.docker.internal:7194",
    HONUA_AGENT_PREVIEW_GP_WORKSPACE_KEY_ENV: "PRIVATE_PROCESS_BRIDGE",
    PRIVATE_MODEL_TOKEN: "model-secret-must-not-be-copied-here",
    PRIVATE_GATEWAY_BRIDGE: "gateway-secret-must-not-be-copied-here",
    PRIVATE_PROCESS_BRIDGE: "process-secret-must-not-be-copied-here",
  };
  const configuration = nativeWorkspaceFromEnv(env);
  expect(configuration?.modelProvider).toEqual({
    kind: "bedrock",
    model: "amazon.nova-pro-v1:0",
    region: "us-east-1",
    apiKeyEnvironmentVariable: "PRIVATE_MODEL_TOKEN",
  });
  expect(configuration?.gatewayHttp).toEqual({
    url: "http://private-gateway:7863",
    keyEnvironmentVariable: "PRIVATE_GATEWAY_BRIDGE",
  });
  expect(JSON.stringify(configuration)).not.toContain("secret-must-not-be-copied-here");
  expect(configuration?.localProcesses).toEqual({
    url: "http://host.docker.internal:7194",
    keyEnvironmentVariable: "PRIVATE_PROCESS_BRIDGE",
  });
  for (const field of [
    "HONUA_AGENT_PREVIEW_MODEL_KIND",
    "HONUA_AGENT_PREVIEW_MODEL_NAME",
    "HONUA_AGENT_PREVIEW_GATEWAY_HTTP_URL",
    "HONUA_AGENT_PREVIEW_GATEWAY_HTTP_KEY_ENV",
    "HONUA_AGENT_PREVIEW_GP_WORKSPACE_URL",
    "HONUA_AGENT_PREVIEW_GP_WORKSPACE_KEY_ENV",
  ] as const) {
    expect(() => nativeWorkspaceFromEnv({ ...env, [field]: undefined })).toThrow();
  }
  expect(() => nativeWorkspaceFromEnv({ ...env, HONUA_AGENT_PREVIEW_MODEL_KIND: "unknown" })).toThrow("provider kind");
  expect(() => nativeWorkspaceFromEnv({ HONUA_AGENT_PREVIEW_MODEL_NAME: "partial" })).toThrow("Incomplete");
  expect(() => nativeWorkspaceFromEnv({ HONUA_AGENT_PREVIEW_GATEWAY_HTTP_KEY_ENV: "partial" })).toThrow("Incomplete");
  expect(() => nativeWorkspaceFromEnv({ HONUA_AGENT_PREVIEW_GP_WORKSPACE_KEY_ENV: "partial" })).toThrow("Incomplete");
});
