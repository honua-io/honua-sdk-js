/**
 * Node-only local Honua installer shared by `honua admin install local` and the
 * laptop-side `honua_admin_install_local` MCP bootstrap tool.
 *
 * @experimental The release-image gate and generated configuration may change
 *   before the 2026.1 candidate is certified.
 * @module
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { HonuaAdminClient } from "./control-plane/admin-client.js";
import {
  ADMIN_LOCAL_SERVER_IMAGE,
  ADMIN_RELEASE_CONTRACT_COMPATIBLE,
  ADMIN_RELEASE_CONTRACT_STATUS,
  ADMIN_RELEASE_OPERATION_COUNT,
  ADMIN_RELEASE_SERVER_SHA,
} from "./control-plane/generated/admin-operations.js";

export type LocalInstallProfile = "quickstart" | "gp-dev";

export interface LocalInstallOptions {
  readonly directory: string;
  readonly profile?: LocalInstallProfile;
  readonly httpPort?: number;
  readonly timeoutMs?: number;
}

export interface LocalInstallRuntime {
  readonly run?: (command: string, args: readonly string[], cwd: string) => Promise<CommandResult>;
  readonly fetchFn?: typeof fetch;
  readonly randomSecret?: (bytes: number) => string;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LocalInstallResult {
  readonly status: "ready";
  readonly profile: LocalInstallProfile;
  readonly directory: string;
  readonly baseUrl: string;
  readonly readyUrl: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly mcpConfigFile: string;
  readonly claudeDesktopConfigFile: string;
  readonly adminKeyWritten: true;
  /** Secret-free identity and grant evidence for the credential handed to MCP. */
  readonly accessCredential: LocalAccessCredentialReceipt;
  readonly serverImage: string;
  readonly reused: boolean;
}

export interface LocalAccessCredentialReceipt {
  readonly id: string;
  readonly name: string;
  readonly status: "active";
  readonly requestedGrants: readonly string[];
  readonly effectiveGrants: readonly string[];
  readonly canAuthenticate: true;
  readonly referenceType: "private-env-file";
  readonly referenceDigestSha256: string;
  readonly provisioned: boolean;
}

interface ProvisionedAdminCredential {
  readonly material: string;
  readonly id: string;
  readonly name: string;
  readonly requestedGrants: readonly string[];
  readonly effectiveGrants: readonly string[];
  readonly provisioned: boolean;
}

const LOCAL_AGENT_GRANTS = ["admin:read", "admin:write"] as const;

export interface LocalInstallStatus {
  readonly installed: boolean;
  readonly ready: boolean;
  readonly directory: string;
  readonly baseUrl?: string;
  readonly serverImage?: string;
  readonly compose?: CommandResult;
}

export const LOCAL_INSTALL_SERVER_IMAGE = ADMIN_LOCAL_SERVER_IMAGE;

export async function installHonuaLocal(
  options: LocalInstallOptions,
  runtime: LocalInstallRuntime = {},
): Promise<LocalInstallResult> {
  if (!ADMIN_RELEASE_CONTRACT_COMPATIBLE) {
    throw new Error(
      `Honua local install is blocked: the manifest-pinned server ${ADMIN_RELEASE_SERVER_SHA} exposes ` +
        `${ADMIN_RELEASE_OPERATION_COUNT} Admin REST operations, but the 2026.1 SDK requires 396 ` +
        `(${ADMIN_RELEASE_CONTRACT_STATUS}). Advance the immutable honua-release image pin before installing.`,
    );
  }
  const directory = path.resolve(options.directory);
  const profile = options.profile ?? "quickstart";
  const httpPort = options.httpPort ?? 8080;
  const baseUrl = `http://127.0.0.1:${httpPort}`;
  const composeFile = path.join(directory, "compose.yaml");
  const envFile = path.join(directory, ".env");
  const mcpConfigFile = path.join(directory, ".mcp.json");
  const claudeDesktopConfigFile = path.join(directory, "claude_desktop_config.json");
  const existingEnv = await readEnv(envFile);
  const reused = Object.keys(existingEnv).length > 0;
  const secret = runtime.randomSecret ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const env = {
    HONUA_SERVER_IMAGE: LOCAL_INSTALL_SERVER_IMAGE,
    HONUA_HTTP_PORT: String(httpPort),
    POSTGRES_PASSWORD: existingEnv.POSTGRES_PASSWORD ?? secret(24),
    HONUA_ADMIN_PASSWORD: existingEnv.HONUA_ADMIN_PASSWORD ?? secret(24),
    HONUA_CONNECTION_ENCRYPTION_MASTER_KEY: existingEnv.HONUA_CONNECTION_ENCRYPTION_MASTER_KEY ?? secret(32),
    HONUA_ADMIN_KEY: existingEnv.HONUA_ADMIN_KEY,
  };

  await mkdir(directory, { recursive: true });
  await writePrivateFile(envFile, renderEnv(env));
  await writeFile(composeFile, renderLocalCompose({ profile }), "utf8");

  const run = runtime.run ?? runCommand;
  await requireCommand(run, "docker", ["version", "--format", "{{.Server.Version}}"], directory, "Docker Engine");
  await requireCommand(run, "docker", ["compose", "version"], directory, "Docker Compose v2");
  await requireCommand(
    run,
    "docker",
    ["compose", "--project-directory", directory, "--file", composeFile, "up", "-d", "--wait"],
    directory,
    "Honua local stack",
  );

  await waitForReady(`${baseUrl}/healthz/ready`, options.timeoutMs ?? 180_000, runtime);

  let credential: ProvisionedAdminCredential;
  if (!env.HONUA_ADMIN_KEY) {
    credential = await bootstrapAdminKey(baseUrl, env.HONUA_ADMIN_PASSWORD, runtime.fetchFn);
    env.HONUA_ADMIN_KEY = credential.material;
    await writePrivateFile(envFile, renderEnv(env));
  } else {
    credential = await resolveExistingAdminKey(baseUrl, env.HONUA_ADMIN_KEY, runtime.fetchFn);
  }

  const mcpConfig = renderMcpConfig(baseUrl, credential.material);
  await writePrivateFile(mcpConfigFile, mcpConfig);
  await writePrivateFile(claudeDesktopConfigFile, mcpConfig);

  return {
    status: "ready",
    profile,
    directory,
    baseUrl,
    readyUrl: `${baseUrl}/healthz/ready`,
    composeFile,
    envFile,
    mcpConfigFile,
    claudeDesktopConfigFile,
    adminKeyWritten: true,
    accessCredential: {
      id: credential.id,
      name: credential.name,
      status: "active",
      requestedGrants: credential.requestedGrants,
      effectiveGrants: credential.effectiveGrants,
      canAuthenticate: true,
      referenceType: "private-env-file",
      referenceDigestSha256: createHash("sha256").update(`file:${envFile}#HONUA_ADMIN_KEY`, "utf8").digest("hex"),
      provisioned: credential.provisioned,
    },
    serverImage: LOCAL_INSTALL_SERVER_IMAGE,
    reused,
  };
}

export async function getHonuaLocalStatus(
  directory: string,
  runtime: LocalInstallRuntime = {},
): Promise<LocalInstallStatus> {
  const resolved = path.resolve(directory);
  const env = await readEnv(path.join(resolved, ".env"));
  if (!env.HONUA_HTTP_PORT || !env.HONUA_SERVER_IMAGE) {
    return { installed: false, ready: false, directory: resolved };
  }
  const baseUrl = `http://127.0.0.1:${env.HONUA_HTTP_PORT}`;
  const run = runtime.run ?? runCommand;
  const compose = await run(
    "docker",
    [
      "compose",
      "--project-directory",
      resolved,
      "--file",
      path.join(resolved, "compose.yaml"),
      "ps",
      "--format",
      "json",
    ],
    resolved,
  ).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: errorMessage(error) }));
  let ready = false;
  try {
    const response = await (runtime.fetchFn ?? fetch)(`${baseUrl}/healthz/ready`);
    ready = response.ok && (await response.text()).trim().toLowerCase() === "ready";
  } catch {
    ready = false;
  }
  return {
    installed: true,
    ready,
    directory: resolved,
    baseUrl,
    serverImage: env.HONUA_SERVER_IMAGE,
    compose,
  };
}

export function renderLocalCompose(options: { readonly profile: LocalInstallProfile }): string {
  const gpEdition = options.profile === "gp-dev" ? "Pro" : "";
  return `name: honua-local
services:
  postgres:
    image: pgrouting/pgrouting:17-3.5-3.7.3
    environment:
      POSTGRES_DB: honua
      POSTGRES_USER: honua
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U honua -d honua"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped
  redis:
    image: redis:7.4-alpine
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"]
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped
  honua:
    image: \${HONUA_SERVER_IMAGE}
    ports:
      - "127.0.0.1:\${HONUA_HTTP_PORT}:8080"
    environment:
      ASPNETCORE_ENVIRONMENT: Development
      ConnectionStrings__DefaultConnection: "Host=postgres;Database=honua;Username=honua;Password=\${POSTGRES_PASSWORD}"
      ConnectionStrings__Redis: redis:6379
      HONUA_ADMIN_PASSWORD: \${HONUA_ADMIN_PASSWORD}
      Security__ConnectionEncryption__MasterKey: \${HONUA_CONNECTION_ENCRYPTION_MASTER_KEY}
      Database__MigrationSafety__ContractApplyPolicy: Gate
      Licensing__DevGrantEdition: "${gpEdition}"
      FileStorage__Provider: Local
      FileStorage__LocalStorage__BasePath: /var/lib/honua/storage
      Kestrel__Endpoints__Http__Url: http://+:8080
      Kestrel__Endpoints__Http__Protocols: Http1
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    volumes:
      - honua_storage:/var/lib/honua/storage
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/healthz/live"]
      interval: 10s
      timeout: 5s
      retries: 20
    restart: unless-stopped
volumes:
  postgres_data:
  redis_data:
  honua_storage:
`;
}

export function renderMcpConfig(baseUrl: string, adminKey: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        honua: {
          command: "npx",
          args: ["-y", "--package", "@honua/mcp-server", "honua-mcp-proxy"],
          env: {
            HONUA_MCP_REMOTE_URL: `${baseUrl}/mcp`,
            HONUA_ADMIN_KEY: adminKey,
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

export function cloudInstallHandoff(stack = "aws"): {
  readonly status: "handoff-required";
  readonly stack: string;
  readonly iacPath: string;
  readonly mcpTool: "provision_infrastructure";
} {
  const supported = new Set(["aws", "azure", "aws-serverless", "azure-functions"]);
  if (!supported.has(stack)) throw new Error(`Unknown cloud stack ${stack}. Expected ${[...supported].join(", ")}.`);
  return {
    status: "handoff-required",
    stack,
    iacPath: `honua-iac/infrastructure/terraform/examples/${stack}`,
    mcpTool: "provision_infrastructure",
  };
}

async function bootstrapAdminKey(
  baseUrl: string,
  rootKey: string,
  fetchFn: typeof fetch | undefined,
): Promise<ProvisionedAdminCredential> {
  const client = new HonuaAdminClient({ baseUrl, adminKey: rootKey, fetchFn });
  const result = await client.call("createAdminApiKey", {
    body: { name: "honua-local-agent", permissions: LOCAL_AGENT_GRANTS },
  });
  const issued = readIssuedAdminCredential(result.data);
  const effective = await readEffectiveAdminCredential(client, issued.id);
  if (!sameStrings(LOCAL_AGENT_GRANTS, effective.permissions)) {
    throw new Error("Admin key bootstrap effective grants did not match the requested grants.");
  }
  return {
    material: issued.material,
    id: issued.id,
    name: issued.name,
    requestedGrants: LOCAL_AGENT_GRANTS,
    effectiveGrants: effective.permissions,
    provisioned: true,
  };
}

async function resolveExistingAdminKey(
  baseUrl: string,
  material: string,
  fetchFn: typeof fetch | undefined,
): Promise<ProvisionedAdminCredential> {
  const client = new HonuaAdminClient({ baseUrl, adminKey: material, fetchFn });
  const result = await client.call("listAdminApiKeys", {});
  const root = result.data;
  if (!isRecord(root) || !Array.isArray(root.data)) {
    throw new Error("Existing Admin credential could not be resolved to secret-safe server metadata.");
  }
  const matches = root.data.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) &&
      candidate.name === "honua-local-agent" &&
      candidate.status === "active" &&
      typeof candidate.keyPrefix === "string" &&
      candidate.keyPrefix.length > 0 &&
      isStringArray(candidate.permissions) &&
      sameStrings(candidate.permissions, LOCAL_AGENT_GRANTS) &&
      material.startsWith(candidate.keyPrefix),
  );
  if (matches.length !== 1) {
    throw new Error("Existing Admin credential did not resolve to exactly one active local-agent identity.");
  }
  const match = matches[0];
  if (!match || typeof match.id !== "string" || !isStringArray(match.permissions) || typeof match.name !== "string") {
    throw new Error("Existing Admin credential metadata was incomplete.");
  }
  const effective = await readEffectiveAdminCredential(client, match.id);
  if (!sameStrings(LOCAL_AGENT_GRANTS, effective.permissions)) {
    throw new Error("Existing Admin credential was not scoped to the required local-agent grants.");
  }
  return {
    material,
    id: match.id,
    name: match.name,
    requestedGrants: LOCAL_AGENT_GRANTS,
    effectiveGrants: effective.permissions,
    provisioned: false,
  };
}

function readIssuedAdminCredential(value: unknown): {
  readonly material: string;
  readonly id: string;
  readonly name: string;
} {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.key !== "string") {
    throw new Error("Admin key bootstrap response did not contain one-time key material.");
  }
  const apiKey = value.data.apiKey;
  if (!isRecord(apiKey) || typeof apiKey.id !== "string" || typeof apiKey.name !== "string") {
    throw new Error("Admin key bootstrap response did not contain secret-safe key identity metadata.");
  }
  return { material: value.data.key, id: apiKey.id, name: apiKey.name };
}

async function readEffectiveAdminCredential(
  client: HonuaAdminClient,
  id: string,
): Promise<{ readonly permissions: readonly string[] }> {
  const result = await client.call("getAdminApiKeyEffectivePermissions", { path: { id } });
  const root = result.data;
  if (
    !isRecord(root) ||
    !isRecord(root.data) ||
    root.data.id !== id ||
    root.data.status !== "active" ||
    root.data.canAuthenticate !== true ||
    !isStringArray(root.data.permissions)
  ) {
    throw new Error("Admin key bootstrap could not verify active effective grants.");
  }
  return { permissions: root.data.permissions };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...new Set(left)].sort().join("\n") === [...new Set(right)].sort().join("\n");
}

async function waitForReady(url: string, timeoutMs: number, runtime: LocalInstallRuntime): Promise<void> {
  const now = runtime.now ?? Date.now;
  const wait = runtime.wait ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const fetchFn = runtime.fetchFn ?? fetch;
  const deadline = now() + timeoutMs;
  let last = "no response";
  while (now() < deadline) {
    try {
      const response = await fetchFn(url);
      const body = await response.text();
      last = `HTTP ${response.status}: ${body}`;
      if (response.ok && body.trim().toLowerCase() === "ready") return;
    } catch (error) {
      last = errorMessage(error);
    }
    await wait(1_000);
  }
  throw new Error(`Honua did not become ready at ${url} within ${timeoutMs}ms (${last}).`);
}

async function requireCommand(
  run: NonNullable<LocalInstallRuntime["run"]>,
  command: string,
  args: readonly string[],
  cwd: string,
  label: string,
): Promise<CommandResult> {
  const result = await run(command, args, cwd);
  if (result.exitCode !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  return result;
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

async function readEnv(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return Object.fromEntries(
      raw
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const separator = line.indexOf("=");
          return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : [line, ""];
        }),
    );
  } catch {
    return {};
  }
}

function renderEnv(env: Record<string, string | undefined>): string {
  return `${Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

async function writePrivateFile(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
