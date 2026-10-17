import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { inspectLocalAgentAccess, installHonuaLocal, readVerifiedLocalEnv } from "@honua/sdk-js/local-install";
import type { ProxyOptions } from "../proxy.js";

const execute = promisify(execFile);

export interface AgentTarget {
  readonly id: string;
  readonly endpoint: string;
  readonly credentialId: string;
}

export interface AgentConnection {
  readonly target: AgentTarget;
  /** Transport-only configuration. Never serialize this into an MCP result. */
  readonly transport: ProxyOptions;
}

export interface AgentRuntime {
  inspect(): Promise<Record<string, unknown>>;
  install(input: { confirm: true; profile: "quickstart" | "gp-dev"; httpPort: number }): Promise<void>;
  resolve(): Promise<AgentConnection>;
}

/** The host fixes the installation root; no tool accepts credential paths or URLs. */
export function createLocalAgentRuntime(directory: string): AgentRuntime {
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
      await installHonuaLocal({ directory: root, profile: input.profile, httpPort: input.httpPort });
    },
    async resolve() {
      const env = await readVerifiedLocalEnv(root);
      const port = Number(env.HONUA_HTTP_PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !env.HONUA_ADMIN_KEY) {
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
      const credential = await inspectLocalAgentAccess(baseUrl, env.HONUA_ADMIN_KEY, (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" }),
      );
      const endpoint = `${baseUrl}/mcp`;
      const id = createHash("sha256").update(`${endpoint}\n${credential.id}`).digest("hex");
      return {
        target: { id, endpoint, credentialId: credential.id },
        transport: { remoteUrl: endpoint, apiKey: env.HONUA_ADMIN_KEY },
      };
    },
  };
}
