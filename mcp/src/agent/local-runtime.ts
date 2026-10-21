import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type LocalInstallOptions,
  inspectLocalAgentAccess,
  inspectLocalWorkspaceAgentAccess,
  installHonuaLocal,
  readVerifiedLocalEnv,
} from "@honua/sdk-js/local-install";
import type { ProxyOptions } from "../proxy.js";

const execute = promisify(execFile);

/** Preview artifacts come from host configuration, never from model tool arguments. */
export function nativeWorkspaceFromEnv(env: NodeJS.ProcessEnv): LocalInstallOptions["nativeWorkspace"] {
  const prefix = "HONUA_AGENT_PREVIEW_";
  const modelNames = ["MODEL_KIND", "MODEL_ENDPOINT", "MODEL_NAME", "MODEL_REGION", "MODEL_KEY_ENV"];
  const gatewayNames = ["GATEWAY_HTTP_URL", "GATEWAY_HTTP_KEY_ENV"];
  const processNames = ["GP_WORKSPACE_URL", "GP_WORKSPACE_KEY_ENV"];
  const names = [
    "SERVER_IMAGE",
    "CONSOLE_IMAGE",
    "RELEASE_ID",
    "GATEWAY_COMMAND",
    "GATEWAY_ARGS",
    "CONSOLE_PORT",
    ...modelNames,
    ...gatewayNames,
    ...processNames,
  ];
  if (!names.some((name) => env[`${prefix}${name}`] !== undefined)) return undefined;
  const required = (name: string): string => {
    const value = env[`${prefix}${name}`];
    if (!value?.trim()) throw new Error(`Incomplete native workspace host configuration: ${name}`);
    return value;
  };
  let gatewayArgs: string[] = [];
  if (env.HONUA_AGENT_PREVIEW_GATEWAY_ARGS !== undefined) {
    const parsed: unknown = JSON.parse(env.HONUA_AGENT_PREVIEW_GATEWAY_ARGS);
    if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string"))
      throw new Error("Preview gateway arguments must be a JSON string array");
    gatewayArgs = parsed;
  }
  const consolePort =
    env.HONUA_AGENT_PREVIEW_CONSOLE_PORT === undefined ? undefined : Number(env.HONUA_AGENT_PREVIEW_CONSOLE_PORT);
  if (consolePort !== undefined && (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535))
    throw new Error("Invalid preview Console port");
  let modelProvider: NonNullable<LocalInstallOptions["nativeWorkspace"]>["modelProvider"];
  if (modelNames.some((name) => env[`${prefix}${name}`] !== undefined)) {
    const kind = required("MODEL_KIND");
    if (kind !== "openai" && kind !== "anthropic" && kind !== "bedrock")
      throw new Error("Invalid preview model provider kind");
    modelProvider = {
      kind,
      model: required("MODEL_NAME"),
      ...(env.HONUA_AGENT_PREVIEW_MODEL_ENDPOINT === undefined ? {} : { endpoint: required("MODEL_ENDPOINT") }),
      ...(env.HONUA_AGENT_PREVIEW_MODEL_REGION === undefined ? {} : { region: required("MODEL_REGION") }),
      ...(env.HONUA_AGENT_PREVIEW_MODEL_KEY_ENV === undefined
        ? {}
        : { apiKeyEnvironmentVariable: required("MODEL_KEY_ENV") }),
    };
  }
  const gatewayHttp = gatewayNames.some((name) => env[`${prefix}${name}`] !== undefined)
    ? { url: required("GATEWAY_HTTP_URL"), keyEnvironmentVariable: required("GATEWAY_HTTP_KEY_ENV") }
    : undefined;
  const localProcesses = processNames.some((name) => env[`${prefix}${name}`] !== undefined)
    ? { url: required("GP_WORKSPACE_URL"), keyEnvironmentVariable: required("GP_WORKSPACE_KEY_ENV") }
    : undefined;
  return {
    serverImage: required("SERVER_IMAGE"),
    consoleImage: required("CONSOLE_IMAGE"),
    releaseId: required("RELEASE_ID"),
    gatewayCommand: required("GATEWAY_COMMAND"),
    gatewayArgs,
    ...(consolePort === undefined ? {} : { consolePort }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(gatewayHttp === undefined ? {} : { gatewayHttp }),
    ...(localProcesses === undefined ? {} : { localProcesses }),
  };
}

export interface AgentTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly credentialId: string;
}

export interface AgentConnection {
  readonly target: AgentTarget;
  /** Transport-only configuration. Never serialize this into an MCP result. */
  readonly transport: ProxyOptions;
  readonly credentialKind?: "workspace-agent" | "bootstrap-admin";
  /** Verified installation release; changing it invalidates a turn-bound session. */
  readonly releaseId?: string;
}

export interface AgentRuntime {
  inspect(): Promise<Record<string, unknown>>;
  install(input: { confirm: true; profile: "quickstart" | "gp-dev"; httpPort: number }): Promise<void>;
  resolve(): Promise<AgentConnection>;
}

/** The host fixes the installation root; no tool accepts credential paths or URLs. */
export function createLocalAgentRuntime(
  directory: string,
  nativeWorkspace?: LocalInstallOptions["nativeWorkspace"],
): AgentRuntime {
  const root = path.resolve(directory);
  async function docker(args: string[]): Promise<string> {
    const result = await execute("docker", args, { timeout: 15_000, maxBuffer: 256 * 1024 });
    return result.stdout.trim();
  }

  async function inspect(): Promise<Record<string, unknown>> {
    const facts: Record<string, unknown> = {
      directory: root,
      platform: platform(),
      architecture: arch(),
      ready: false,
    };
    try {
      const context = JSON.parse(await docker(["context", "inspect"])) as { Endpoints: { docker: { Host: string } } }[];
      const endpoint = process.env.DOCKER_CONTEXT
        ? context[0]?.Endpoints.docker.Host
        : process.env.DOCKER_HOST || context[0]?.Endpoints.docker.Host;
      // This first local lane deliberately excludes remote engines and Windows pipes.
      facts.localDaemon = typeof endpoint === "string" && endpoint.startsWith("unix://");
      if (!facts.localDaemon) return { ...facts, reason: "local-unix-docker-context-required" };
      facts.engineVersion = await docker(["version", "--format", "{{.Server.Version}}"]);
      facts.composeVersion = await docker(["compose", "version", "--short"]);
      const version = String(facts.composeVersion)
        .replace(/^v/, "")
        .match(/^(\d+)\.(\d+)\.(\d+)/);
      const compatible =
        version &&
        (Number(version[1]) > 2 ||
          (Number(version[1]) === 2 &&
            (Number(version[2]) > 23 || (Number(version[2]) === 23 && Number(version[3]) >= 1))));
      return { ...facts, ready: Boolean(compatible), ...(compatible ? {} : { reason: "compose-2.23.1-required" }) };
    } catch {
      return { ...facts, reason: "docker-or-compose-unavailable" };
    }
  }

  return {
    inspect,
    async install(input) {
      if (!(await inspect()).ready) throw new Error("Local Docker prerequisites are not ready");
      await installHonuaLocal({ directory: root, profile: input.profile, httpPort: input.httpPort, nativeWorkspace });
    },
    async resolve() {
      const env = await readVerifiedLocalEnv(root);
      const workspaceCredentialPresent = env.HONUA_AGENT_API_KEY !== undefined || env.HONUA_AGENT_KEY_ID !== undefined;
      if (workspaceCredentialPresent && (!env.HONUA_AGENT_API_KEY || !env.HONUA_AGENT_KEY_ID)) {
        throw new Error("Native workspace credential identity is incomplete");
      }
      const apiKey = workspaceCredentialPresent ? env.HONUA_AGENT_API_KEY : env.HONUA_ADMIN_KEY;
      const port = Number(env.HONUA_HTTP_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !apiKey) {
        throw new Error("No verified local installation");
      }
      const baseUrl = `http://127.0.0.1:${port}`;
      const response = await fetch(`${baseUrl}/healthz/ready`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok || (await response.text()).trim().toLowerCase() !== "ready") {
        throw new Error("Installed server is not ready");
      }
      const fetchCredential: typeof fetch = (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
      const credential = workspaceCredentialPresent
        ? await inspectLocalWorkspaceAgentAccess(baseUrl, apiKey, env.HONUA_AGENT_KEY_ID!, fetchCredential)
        : await inspectLocalAgentAccess(baseUrl, apiKey, fetchCredential);
      const endpoint = `${baseUrl}/mcp`;
      const id = createHash("sha256").update(`${endpoint}\n${credential.id}`).digest("hex");
      return {
        target: { id, endpoint, credentialId: credential.id },
        transport: { remoteUrl: endpoint, apiKey },
        credentialKind: workspaceCredentialPresent ? "workspace-agent" : "bootstrap-admin",
        releaseId: env.HONUA_AGENT_RELEASE_ID,
      };
    },
  };
}
