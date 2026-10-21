import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { buildUpstreamHeaders } from "../proxy.js";
import { type DevOpsExtension, createDevOpsExtension } from "./devops-runtime.js";
import { devOpsTarget } from "./devops-targets.js";
import type { AgentTurnBinding } from "./gateway.js";
import type { AgentConnection, AgentRuntime } from "./local-runtime.js";

const configuration = z
  .object({
    serverTargetId: z.string().min(1).max(128),
    environment: z.string().min(1).max(128),
    deployTargetId: z.string().min(1).max(128),
    runtimeKind: z.enum(["aws-ecs", "aws-lambda", "aws-eks"]).default("aws-ecs"),
    command: z.string().min(1),
    args: z.array(z.string()).max(64).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    fixedArguments: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    provisioningScope: z
      .object({
        environment: z.string().min(1),
        region: z.string().min(1),
        namePrefix: z.string().min(1),
        allowedImages: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
const turnIdentifier = /^[A-Za-z0-9_-]{1,128}$/;

/** The host selects this protected file; MCP arguments cannot select executable paths or credentials. */
export async function configuredDevOps(
  file: string,
  runtime: AgentRuntime,
  fetchImpl: typeof fetch = fetch,
  boundTurn?: () => AgentTurnBinding | undefined,
): Promise<DevOpsExtension> {
  if (!path.isAbsolute(file)) throw new Error("DevOps configuration requires an absolute host path");
  const info = await lstat(file);
  if (!info.isFile() || info.size > 65536 || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
    throw new Error("DevOps configuration must be a private, bounded regular file");
  const config = configuration.parse(JSON.parse(await readFile(file, "utf8")));
  const target = devOpsTarget(config.runtimeKind);
  if (!path.isAbsolute(config.command) || (config.cwd && !path.isAbsolute(config.cwd)))
    throw new Error("DevOps executable and working directory must be host-selected absolute paths");
  if (config.provisioningScope && config.provisioningScope.environment !== config.environment)
    throw new Error("Provisioning scope must match the configured environment");
  type Entry = { binding?: AgentTurnBinding; extension: Promise<DevOpsExtension>; active: number; retired: boolean };
  const entries = new Set<Entry>();
  const closing = new Set<Promise<void>>();
  let currentEntry: Entry | undefined;
  let closed = false;
  function retire(entry: Entry): void {
    entry.retired = true;
    if (entry.active === 0 && entries.delete(entry)) {
      const finished = entry.extension.then((value) => value.close()).catch(() => {});
      closing.add(finished);
      void finished.finally(() => closing.delete(finished));
    }
  }
  function acquire(): Entry {
    if (closed) throw new Error("Private integration closed");
    const binding = boundTurn?.();
    if (binding && (!turnIdentifier.test(binding.workspaceId) || !turnIdentifier.test(binding.turnId)))
      throw new Error("Invalid private integration turn binding");
    if (
      currentEntry &&
      (currentEntry.binding?.workspaceId !== binding?.workspaceId || currentEntry.binding?.turnId !== binding?.turnId)
    ) {
      retire(currentEntry);
      currentEntry = undefined;
    }
    if (!currentEntry) {
      const entry = { binding: binding && { ...binding }, active: 0, retired: false } as Entry;
      entry.extension = (async () => {
        const connection = await runtime.resolve();
        const base = new URL(connection.transport.remoteUrl);
        if (!/\/mcp\/?$/.test(base.pathname))
          throw new Error("Private integration requires the canonical MCP endpoint");
        base.pathname = base.pathname.replace(/mcp\/?$/, "");
        base.search = "";
        base.hash = "";
        // Child operations use this same scoped agent credential. A separately configured
        // human/admin key must never become a silent authority fallback.
        if (!connection.transport.apiKey) throw new Error("A scoped private integration credential is required");
        const authorize = async (action: { canonicalTool: string | null; arguments?: Record<string, unknown> }) => {
          const current = await runtime.resolve();
          requireSameConnection(connection, current);
          if (
            boundTurn &&
            (boundTurn()?.workspaceId !== binding?.workspaceId || boundTurn()?.turnId !== binding?.turnId)
          )
            throw new Error("Private integration turn changed");
          const response = await fetchImpl(new URL("api/v1/agent/devops/authorize", base), {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
            headers: {
              ...buildUpstreamHeaders(current.transport),
              ...(binding ? { "X-Honua-Workspace": binding.workspaceId, "X-Honua-Turn": binding.turnId } : {}),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              targetId: config.serverTargetId,
              deployTargetId: config.deployTargetId,
              environment: config.environment,
              canonicalTool: action.canonicalTool,
              arguments: action.arguments,
            }),
          });
          if (!response.ok) throw new Error("Private integration unauthorized");
          const receipt = (await response.json()) as {
            targetId?: unknown;
            deployTargetId?: unknown;
            environment?: unknown;
            runtimeKind?: unknown;
            backend?: unknown;
          };
          if (
            receipt.targetId !== config.serverTargetId ||
            receipt.deployTargetId !== config.deployTargetId ||
            receipt.environment !== config.environment
          )
            throw new Error("Private integration target changed");
          const legacyEcs =
            config.runtimeKind === "aws-ecs" && receipt.runtimeKind === undefined && receipt.backend === undefined;
          if (!legacyEcs && (receipt.runtimeKind !== config.runtimeKind || receipt.backend !== target.backend))
            throw new Error("Private integration runtime changed or is unsupported");
        };
        await authorize({ canonicalTool: null });
        const safeEnv = { ...config.env };
        delete safeEnv.HONUA_DEVOPS_HONUA_WORKSPACE_ID;
        delete safeEnv.HONUA_DEVOPS_HONUA_TURN_ID;
        return createDevOpsExtension(
          {
            ...config,
            requireTurnBindingCapability: Boolean(binding),
            env: {
              ...safeEnv,
              ...(binding
                ? { HONUA_DEVOPS_HONUA_WORKSPACE_ID: binding.workspaceId, HONUA_DEVOPS_HONUA_TURN_ID: binding.turnId }
                : {}),
              HONUA_DEVOPS_HONUA_API_BASE_URL: base.toString().replace(/\/$/, ""),
              HONUA_DEVOPS_HONUA_API_KEY: connection.transport.apiKey,
              HONUA_DEVOPS_TERRAFORM_TARGETS: target.terraformTarget,
              HONUA_DEVOPS_RUNTIME_KIND: config.runtimeKind,
              HONUA_DEVOPS_RUNTIME_BACKEND: target.backend,
              HONUA_DEVOPS_SERVER_TARGET_ID: config.serverTargetId,
              HONUA_DEVOPS_ALLOWED_ENVIRONMENTS: config.environment,
              HONUA_DEVOPS_DEPLOY_TARGET_ID: config.deployTargetId,
            },
          },
          authorize,
        );
      })();
      currentEntry = entry;
      entries.add(entry);
      void entry.extension.catch(() => {
        if (currentEntry === entry) currentEntry = undefined;
        retire(entry);
      });
    }
    currentEntry.active++;
    return currentEntry;
  }
  async function withExtension<T>(use: (extension: DevOpsExtension) => Promise<T>): Promise<T> {
    const entry = acquire();
    try {
      return await use(await entry.extension);
    } finally {
      entry.active--;
      if (entry.retired) retire(entry);
    }
  }
  return {
    async listTools() {
      return withExtension((extension) => extension.listTools());
    },
    async callTool(name, args, options) {
      return withExtension((extension) => extension.callTool(name, args, options));
    },
    async close() {
      closed = true;
      currentEntry = undefined;
      const pending = [...entries];
      entries.clear();
      await Promise.all([
        ...closing,
        ...pending.map((entry) => entry.extension.then((value) => value.close()).catch(() => {})),
      ]);
    },
  };
}

function requireSameConnection(expected: AgentConnection, actual: AgentConnection): void {
  if (
    expected.target.id !== actual.target.id ||
    expected.target.endpoint !== actual.target.endpoint ||
    expected.target.credentialId !== actual.target.credentialId ||
    expected.transport.remoteUrl !== actual.transport.remoteUrl ||
    expected.transport.apiKey !== actual.transport.apiKey ||
    expected.transport.authToken !== actual.transport.authToken ||
    expected.credentialKind !== actual.credentialKind ||
    expected.releaseId !== actual.releaseId ||
    expected.deploymentId !== actual.deploymentId
  )
    throw new Error("Private integration identity changed; restart explicitly");
}
