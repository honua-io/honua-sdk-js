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
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

import { HonuaAdminClient } from "./control-plane/admin-client.js";
import {
  ADMIN_LOCAL_SERVER_IMAGE,
  ADMIN_RELEASE_CONTRACT_COMPATIBLE,
  ADMIN_RELEASE_CONTRACT_STATUS,
  ADMIN_RELEASE_OPERATION_COUNT,
  ADMIN_RELEASE_SERVER_SHA,
} from "./control-plane/generated/admin-operations.js";
import { verifyPrivateFile, writePrivateFileAtomic } from "./private-file.js";
import { resolveExecutableFromPath } from "./process-executable.js";

export type LocalInstallProfile = "quickstart" | "gp-dev";
const HOST_AUTHORITY_KEYS = [
  "HONUA_AGENT_API_KEY",
  "HONUA_ADMIN_KEY",
  "HONUA_ADMIN_PASSWORD",
  "HONUA_LOCAL_HUMAN_BRIDGE_KEY",
  "HONUA_LOCAL_OPERATOR_SIGNING_KEY",
  "HONUA_NATIVE_TRANSCRIPT_SEED",
  "HONUA_CONNECTION_ENCRYPTION_MASTER_KEY",
  "HONUA_GP_WORKSPACE_KEY",
  "POSTGRES_PASSWORD",
] as const;

export interface LocalInstallOptions {
  readonly directory: string;
  readonly profile?: LocalInstallProfile;
  readonly httpPort?: number;
  readonly timeoutMs?: number;
  /** Explicit preview artifacts; no public release currently proves this workspace contract. */
  readonly nativeWorkspace?: {
    readonly serverImage: string;
    readonly consoleImage: string;
    readonly releaseId: string;
    /** Qualified host executable, never a guessed unpublished npm release. */
    readonly gatewayCommand: string;
    readonly gatewayArgs?: readonly string[];
    readonly consolePort?: number;
    /** Optional private HTTP gateway reachable from the Console container. */
    readonly gatewayHttp?: { readonly url: string; readonly keyEnvironmentVariable: string };
    /** Host-selected local GP daemon; only the server receives its independent service credential. */
    readonly localProcesses?: { readonly url: string; readonly keyEnvironmentVariable: string };
    /** Server-only model configuration. The credential is referenced by host environment variable name. */
    readonly modelProvider?: {
      readonly kind: "openai" | "anthropic" | "bedrock";
      readonly endpoint?: string;
      readonly model: string;
      readonly region?: string;
      readonly apiKeyEnvironmentVariable?: string;
    };
  };
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
  readonly workspaceCredential?: LocalAccessCredentialReceipt;
  readonly workspaceQualification?: "preview-requires-human-pairing";
  readonly consoleUrl?: string;
  readonly serverImage: string;
  readonly reused: boolean;
  /**
   * True when this run revoked the existing local-agent credential and issued
   * a replacement (see {@link LocalInstallResult.reason}).
   */
  readonly credentialReissued: boolean;
  /**
   * Why the credential was re-issued. `legacy-grants`: the existing key carried
   * only `admin:read`/`admin:write`, which honua-server (#5643) no longer lets
   * read layer data, so it was replaced with one carrying {@link LOCAL_AGENT_GRANTS}.
   */
  readonly reason?: LocalCredentialReissueReason;
}

export type LocalCredentialReissueReason = "legacy-grants";

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

/**
 * Grants on the `honua-local-agent` key the installer hands to MCP clients.
 *
 * `admin:read`/`admin:write` let the agent administer the local server. Since
 * honua-server #5643 a key holding administrative grants is scope-governed and
 * gets no implicit data access, so `read:*` (read every service and layer) is
 * what lets the agent list, query and render layers. No `write:` data grant and
 * no `admin:approve` are issued: data edits and approvals stay with the human.
 */
export const LOCAL_AGENT_GRANTS = ["admin:read", "admin:write", "read:*"] as const;

/**
 * Grants minted by installers before `read:*` was added. A key carrying exactly
 * these is re-issued with {@link LOCAL_AGENT_GRANTS} by `installHonuaLocal`.
 */
export const LEGACY_LOCAL_AGENT_GRANTS = ["admin:read", "admin:write"] as const;

const LOCAL_AGENT_KEY_NAME = "honua-local-agent";
export const LOCAL_WORKSPACE_AGENT_GRANTS = [...LOCAL_AGENT_GRANTS, "agent:workspace"] as const;
const LOCAL_WORKSPACE_AGENT_KEY_NAME = "honua-local-workspace-agent";

export interface LocalInstallStatus {
  readonly installed: boolean;
  readonly ready: boolean;
  readonly directory: string;
  readonly baseUrl?: string;
  readonly serverImage?: string;
  readonly compose?: CommandResult;
}

export const LOCAL_INSTALL_SERVER_IMAGE = ADMIN_LOCAL_SERVER_IMAGE;

/**
 * Candidate MCP/CLI artifact emitted into generated terminal MCP client
 * configurations.
 *
 * This must name a version that is actually published to the public registry:
 * the generated `.mcp.json` / `claude_desktop_config.json` run
 * `npx -y --package <pin> honua-mcp-proxy`, so a pin that only exists in this
 * repository's release lineage produces an uninstallable configuration on a
 * clean machine. Repository release tags and `mcp/CHANGELOG.md` entries are
 * *not* evidence of publication - a tagged version whose npm publish failed
 * still appears there.
 *
 * The pin previously read `0.1.7-beta.0`, which the registry has never served.
 * `@honua/sdk-js@0.1.7-beta.0` was published from a recovery branch rather than
 * from the sealed tag commit, so the coordinated 0.1.7 cut of `@honua/mcp-server`
 * (and `create-honua-app`) never happened at all. It was then held at
 * `0.1.4-beta.0`, the highest version the registry actually served, because
 * advancing it requires a real coordinated publish rather than an edit here.
 *
 * Publication is necessary but not sufficient, and holding the pin back is what
 * exposed the second half of the rule (#1529). `@honua/mcp-server`
 * peer-depends on `@honua/sdk-js`, so the two are a **pair**, and npm's default
 * resolver rejects a pair whose peer range does not admit the SDK installed
 * beside it. A caret range over a prerelease admits exactly one
 * `major.minor.patch` tuple -- `^0.1.4-beta.0` does not accept
 * `0.1.9-beta.0`, and no widening of it would, because a prerelease satisfies a
 * range only when some comparator carries a prerelease on the *same* tuple.
 * Held at `0.1.4-beta.0` beside an `0.1.9-beta.0` SDK, the pinned pair therefore
 * failed `npm install` outright with ERESOLVE unless the customer passed
 * `--legacy-peer-deps`.
 *
 * The pin consequently has to move in lockstep with this package's own version,
 * one coordinated cut at a time. `0.1.9-beta.0` is that cut: both halves were
 * published on 2026-08-29 and co-install with no flags.
 *
 * Advancing it is `npm run sync:mcp-pin`, run *after* the coordinated
 * `@honua/mcp-server` publish, which rewrites this version and the integrity
 * below together from the registry. It is deliberately not a release-please
 * `extra-files` bump: release-please would advance the version at release-PR
 * time, before either half is published -- reintroducing exactly the
 * unpublished-pin failure described above -- and it cannot compute the tarball
 * integrity that has to move with it. Between a release bump and that publish
 * the pin legitimately lags this package's version; `verify:client-pair` is
 * what refuses to ship while it does.
 *
 * `test/local-install.test.ts` proves the pin belongs to the repository's own
 * release lineage and never runs ahead of `mcp/package.json`;
 * `npm run verify:mcp-pin` additionally proves the pinned pair is co-installable
 * offline, and `npm run verify:client-pair` proves it by really installing both
 * halves with default npm resolution. The registry itself is only queried by
 * the opt-in `HONUA_MCP_PIN_LIVE_ENABLED=true npm run verify:mcp-pin:live` lane,
 * never in PR CI.
 */
export const LOCAL_INSTALL_MCP_PACKAGE_NAME = "@honua/mcp-server";
/**
 * Published `@honua/mcp-server` version whose `@honua/sdk-js` peer range admits
 * this package's own version, so the pinned pair co-installs with no flags.
 */
export const LOCAL_INSTALL_MCP_PACKAGE_VERSION = "0.1.19";
/** Registry tarball integrity for {@link LOCAL_INSTALL_MCP_PACKAGE_VERSION}. */
export const LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY =
  "sha512-8a97LvOY2iBgnei7/TVf7KNxCTGB78sd4lRquIcvIqO0tQOMxAiWWYRcrSfPXmE6ZK+ltS8td0QPHWpiOpHLpg==";
export const LOCAL_INSTALL_MCP_PACKAGE = `${LOCAL_INSTALL_MCP_PACKAGE_NAME}@${LOCAL_INSTALL_MCP_PACKAGE_VERSION}`;

function isAdminReleaseContractCompatible(): boolean {
  return Boolean(ADMIN_RELEASE_CONTRACT_COMPATIBLE);
}

export async function installHonuaLocal(
  options: LocalInstallOptions,
  runtime: LocalInstallRuntime = {},
): Promise<LocalInstallResult> {
  const native = options.nativeWorkspace;
  if (native) {
    if (
      !path.isAbsolute(native.gatewayCommand) ||
      /[\r\n\0]/.test(native.gatewayCommand) ||
      native.gatewayArgs?.some((argument) => /[\r\n\0]/.test(argument))
    )
      throw new Error(
        "Native workspace preview requires an absolute host-selected gateway executable and valid arguments.",
      );
    for (const image of [native.serverImage, native.consoleImage]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image))
        throw new Error("Native workspace preview requires explicit immutable server and Console image digests.");
    }
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(native.releaseId) ||
      !Number.isInteger(native.consolePort ?? 8081) ||
      (native.consolePort ?? 8081) < 1024 ||
      (native.consolePort ?? 8081) > 65535 ||
      (native.consolePort ?? 8081) === (options.httpPort ?? 8080)
    )
      throw new Error("Invalid native workspace release identity or Console port.");
  }
  const provider = native?.modelProvider;
  let providerKey: string | undefined;
  if (provider) {
    if (
      !["openai", "anthropic", "bedrock"].includes(provider.kind) ||
      !/^[A-Za-z0-9._:/-]{1,256}$/.test(provider.model) ||
      (provider.region !== undefined && !/^[a-z0-9-]{1,64}$/.test(provider.region))
    )
      throw new Error("Invalid native model provider configuration.");
    if (provider.kind !== "bedrock" || provider.endpoint !== undefined) {
      let endpoint: URL;
      try {
        endpoint = new URL(provider.endpoint ?? "");
      } catch {
        throw new Error("Native model provider requires an absolute endpoint.");
      }
      if (
        /[\s"'`\\$#]/.test(provider.endpoint ?? "") ||
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error("Native model provider endpoint must not contain credentials, query or fragment.");
    }
    if (provider.apiKeyEnvironmentVariable) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(provider.apiKeyEnvironmentVariable))
        throw new Error("Invalid native model credential environment reference.");
      if (
        [...HOST_AUTHORITY_KEYS, "HONUA_AGENT_GATEWAY_KEY"].some((name) => name === provider.apiKeyEnvironmentVariable)
      )
        throw new Error("The model credential reference must be independent from Honua host credentials.");
      providerKey = process.env[provider.apiKeyEnvironmentVariable];
      if (!providerKey || /[\s"'`\\$#\0]/.test(providerKey))
        throw new Error("The referenced native model credential is unavailable.");
      assertIndependentModelCredential(providerKey, process.env);
    }
  }
  let gatewayKey: string | undefined;
  if (native?.gatewayHttp) {
    let gatewayUrl: URL;
    try {
      gatewayUrl = new URL(native.gatewayHttp.url);
    } catch {
      throw new Error("Invalid native gateway origin.");
    }
    if (
      /[\s"'`\\$#]/.test(native.gatewayHttp.url) ||
      !["http:", "https:"].includes(gatewayUrl.protocol) ||
      gatewayUrl.username ||
      gatewayUrl.password ||
      gatewayUrl.pathname !== "/" ||
      gatewayUrl.search ||
      gatewayUrl.hash
    )
      throw new Error(
        "The native gateway requires an absolute HTTP(S) origin without a path, credentials, query or fragment.",
      );
    const reference = native.gatewayHttp.keyEnvironmentVariable;
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference) ||
      [...HOST_AUTHORITY_KEYS, "HONUA_NATIVE_MODEL_API_KEY", "HONUA_STUDIOAI_NATIVE_API_KEY"].some(
        (name) => name === reference,
      )
    )
      throw new Error("The native gateway requires an independent credential environment reference.");
    gatewayKey = process.env[reference];
    if (
      !gatewayKey ||
      Buffer.byteLength(gatewayKey, "utf8") < 32 ||
      Buffer.byteLength(gatewayKey, "utf8") > 512 ||
      /[\s"'`\\$#\0]/.test(gatewayKey)
    )
      throw new Error("The referenced native gateway credential is unavailable or invalid.");
    if (
      [...HOST_AUTHORITY_KEYS, "HONUA_NATIVE_MODEL_API_KEY", "HONUA_STUDIOAI_NATIVE_API_KEY"].some(
        (name) => process.env[name] && process.env[name] === gatewayKey,
      )
    )
      throw new Error("The native gateway credential must be independent from other credentials.");
  }
  let localProcessKey: string | undefined;
  if (native?.localProcesses) {
    const local = native.localProcesses;
    let endpoint: URL;
    try {
      endpoint = new URL(local.url);
    } catch {
      throw new Error("Invalid local process origin.");
    }
    const host = endpoint.hostname.replace(/^\[|\]$/g, "");
    const octets = host.split(".").map(Number);
    const privateHost =
      host === "host.docker.internal" ||
      (isIP(host) === 4 &&
        (octets[0] === 10 ||
          (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
          (octets[0] === 192 && octets[1] === 168))) ||
      (isIP(host) === 6 && /^f[cd]/i.test(host));
    if (
      !privateHost ||
      /[\s"'`\\$#]/.test(local.url) ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        "The Docker local-process daemon requires an explicit private host origin reachable from the server container.",
      );
    const reference = local.keyEnvironmentVariable;
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference) ||
      [
        ...HOST_AUTHORITY_KEYS.filter((name) => name !== "HONUA_GP_WORKSPACE_KEY"),
        "HONUA_AGENT_GATEWAY_KEY",
        "HONUA_NATIVE_MODEL_API_KEY",
        "HONUA_STUDIOAI_NATIVE_API_KEY",
      ].some((name) => name === reference)
    )
      throw new Error("The local process daemon requires an independent credential environment reference.");
    localProcessKey = process.env[reference];
    if (
      !localProcessKey ||
      localProcessKey.length < 32 ||
      localProcessKey.length > 512 ||
      /[\s"'`\\$#\0]/.test(localProcessKey)
    )
      throw new Error("The referenced local process credential is unavailable or invalid.");
    assertIndependentLocalProcessKey(localProcessKey, process.env);
  }
  if (!native && !isAdminReleaseContractCompatible()) {
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
  const originalEnvText = await readEnvText(envFile);
  const existingEnv = await readEnv(envFile, originalEnvText);
  validateManagedEnv(originalEnvText);
  if (existingEnv.HONUA_CONSOLE_IMAGE && !native)
    throw new Error(
      "This directory has a native workspace preview; supply its explicit artifact configuration to reinstall.",
    );
  if (native && existingEnv.HONUA_AGENT_RELEASE_ID && existingEnv.HONUA_AGENT_RELEASE_ID !== native.releaseId)
    throw new Error(
      "A native preview release change requires a new install directory until upgrade qualification is available.",
    );
  const bootstrapFile = path.join(directory, "postgis-bootstrap.sql");
  await verifyInstallFiles(composeFile, bootstrapFile, existingEnv);
  const [hasMcpConfig, hasClaudeConfig] = await Promise.all([
    verifyPrivateFileIfPresent(mcpConfigFile),
    verifyPrivateFileIfPresent(claudeDesktopConfigFile),
  ]);
  if (!existingEnv.HONUA_ADMIN_KEY && (hasMcpConfig || hasClaudeConfig)) {
    throw new Error(
      "Refusing to overwrite an existing credential-bearing MCP config without its matching verified HONUA_ADMIN_KEY. Revoke or reconcile the prior local credential first.",
    );
  }
  const reused = Object.keys(existingEnv).length > 0;
  const secret = runtime.randomSecret ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const env: Record<string, string | undefined> & {
    HONUA_SERVER_IMAGE: string;
    HONUA_COMPOSE_PROJECT: string;
    HONUA_HTTP_PORT: string;
    POSTGRES_PASSWORD: string;
    HONUA_ADMIN_PASSWORD: string;
    HONUA_CONNECTION_ENCRYPTION_MASTER_KEY: string;
    HONUA_ADMIN_KEY: string | undefined;
  } = {
    ...existingEnv,
    HONUA_COMPOSE_PROJECT: existingEnv.HONUA_COMPOSE_PROJECT ?? `honua-local-${randomBytes(12).toString("hex")}`,
    HONUA_SERVER_IMAGE: native?.serverImage ?? LOCAL_INSTALL_SERVER_IMAGE,
    HONUA_AGENT_DEPLOYMENT_ID: existingEnv.HONUA_AGENT_DEPLOYMENT_ID ?? `local-${randomBytes(12).toString("hex")}`,
    HONUA_AGENT_RELEASE_ID: native?.releaseId ?? existingEnv.HONUA_AGENT_RELEASE_ID ?? ADMIN_RELEASE_SERVER_SHA,
    ...(native
      ? {
          HONUA_AGENT_GATEWAY_URL: native.gatewayHttp?.url ?? "",
          HONUA_AGENT_GATEWAY_KEY: gatewayKey ?? "",
          HONUA_GP_WORKSPACE_URL: native.localProcesses?.url ?? "",
          HONUA_GP_WORKSPACE_KEY: localProcessKey ?? "",
          HONUA_NATIVE_TRANSCRIPT_SEED: existingEnv.HONUA_NATIVE_TRANSCRIPT_SEED ?? randomBytes(32).toString("base64"),
          HONUA_NATIVE_MODEL_ENABLED: provider ? "true" : "false",
          HONUA_NATIVE_MODEL_KIND: provider?.kind ?? "openai",
          HONUA_NATIVE_MODEL_ENDPOINT: provider?.endpoint ?? "",
          HONUA_NATIVE_MODEL_NAME: provider?.model ?? "",
          HONUA_NATIVE_MODEL_REGION: provider?.region ?? "us-west-2",
          HONUA_NATIVE_MODEL_API_KEY: provider ? (providerKey ?? "") : "",
          HONUA_CONSOLE_IMAGE: native.consoleImage,
          HONUA_CONSOLE_PORT: String(native.consolePort ?? 8081),
          HONUA_LOCAL_HUMAN_BRIDGE_KEY: existingEnv.HONUA_LOCAL_HUMAN_BRIDGE_KEY ?? secret(32),
          HONUA_LOCAL_OPERATOR_SIGNING_KEY: existingEnv.HONUA_LOCAL_OPERATOR_SIGNING_KEY ?? secret(64),
        }
      : {}),
    HONUA_HTTP_PORT: String(httpPort),
    POSTGRES_PASSWORD: existingEnv.POSTGRES_PASSWORD ?? secret(24),
    HONUA_ADMIN_PASSWORD: existingEnv.HONUA_ADMIN_PASSWORD ?? secret(24),
    HONUA_CONNECTION_ENCRYPTION_MASTER_KEY: existingEnv.HONUA_CONNECTION_ENCRYPTION_MASTER_KEY ?? secret(32),
    HONUA_ADMIN_KEY: existingEnv.HONUA_ADMIN_KEY,
  };

  assertIndependentModelCredential(providerKey, existingEnv);
  assertIndependentLocalProcessKey(localProcessKey, existingEnv);
  assertIndependentGatewayKey(env);
  if (
    gatewayKey &&
    [...HOST_AUTHORITY_KEYS, "HONUA_NATIVE_MODEL_API_KEY", "HONUA_STUDIOAI_NATIVE_API_KEY"].some(
      (name) => existingEnv[name] && existingEnv[name] === gatewayKey,
    )
  )
    throw new Error("The native gateway credential must be independent from existing credentials.");
  const dockerCommand = runtime.run
    ? "docker"
    : await resolveExecutableFromPath("docker", { excludedDirectory: directory });
  const run = runtime.run ?? runCommand;
  // Preflight from an existing directory, including when the destination is new.
  await requireCommand(
    run,
    dockerCommand,
    ["version", "--format", "{{.Server.Version}}"],
    process.cwd(),
    "Docker Engine",
  );
  await requireCommand(run, dockerCommand, ["compose", "version"], process.cwd(), "Docker Compose v2");
  if (
    existingEnv.HONUA_SERVER_IMAGE &&
    (!existingEnv.HONUA_COMPOSE_PROJECT || existingEnv.HONUA_COMPOSE_PROJECT === "honua-local")
  ) {
    if (
      ![
        existingEnv.POSTGRES_PASSWORD,
        existingEnv.HONUA_ADMIN_PASSWORD,
        existingEnv.HONUA_CONNECTION_ENCRYPTION_MASTER_KEY,
      ].every(Boolean)
    ) {
      throw new Error(
        "Legacy installer credentials are incomplete. Restore the original .env before reusing honua-local volumes.",
      );
    }
    env.HONUA_COMPOSE_PROJECT = "honua-local";
  }
  // A copied .env must never let another directory operate the original project.
  if (existingEnv.HONUA_COMPOSE_PROJECT || existingEnv.HONUA_SERVER_IMAGE) {
    const project = env.HONUA_COMPOSE_PROJECT;
    const owners = await run(
      dockerCommand,
      [
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}',
      ],
      process.cwd(),
    );
    const ownerRows = owners.stdout.split(/\r?\n/);
    if (ownerRows.at(-1) === "") ownerRows.pop();
    if (
      owners.exitCode !== 0 ||
      ownerRows.some((row) => {
        const parts = row.split("\t");
        return parts.length !== 2 || !parts[0] || !parts[1] || path.resolve(parts[1]) !== directory;
      })
    ) {
      throw new Error(
        "Installer project belongs to another directory or could not be verified. Restore its original .env and directory before reinstalling.",
      );
    }
    if (ownerRows.length === 0) {
      // Compose volumes do not carry the container working-directory label. A
      // project with only volumes therefore cannot prove directory ownership.
      const volumes = await run(
        dockerCommand,
        ["volume", "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"],
        process.cwd(),
      );
      if (volumes.exitCode !== 0 || volumes.stdout.length > 0) {
        throw new Error(
          "Installer project volume ownership could not be verified. Start the existing project from its original directory before reinstalling; do not copy its .env to another directory.",
        );
      }
    }
  }
  await mkdir(directory, { recursive: true });
  await writePrivateFileAtomic(envFile, renderEnv(env, originalEnvText));
  await writeFile(composeFile, renderLocalCompose({ profile, nativeWorkspace: !!native }), "utf8");
  await writeFile(bootstrapFile, LOCAL_POSTGIS_BOOTSTRAP_SQL, "utf8");

  await requireCommand(
    run,
    dockerCommand,
    [
      "compose",
      "--project-name",
      env.HONUA_COMPOSE_PROJECT,
      "--project-directory",
      directory,
      "--file",
      composeFile,
      "up",
      "-d",
      "--wait",
    ],
    directory,
    "Honua local stack",
  );

  await waitForReady(`${baseUrl}/healthz/ready`, options.timeoutMs ?? 180_000, runtime);

  let credential: ProvisionedAdminCredential;
  let reissueReason: LocalCredentialReissueReason | undefined;
  if (!env.HONUA_ADMIN_KEY) {
    credential = await bootstrapAdminKey(baseUrl, env.HONUA_ADMIN_PASSWORD, runtime.fetchFn);
    try {
      env.HONUA_ADMIN_KEY = credential.material;
      await writePrivateFileAtomic(envFile, renderEnv(env, originalEnvText));
      const mcpConfig = native
        ? renderNativeWorkspaceMcpConfig(directory, native.gatewayCommand, native.gatewayArgs)
        : renderMcpConfig(baseUrl, credential.material);
      await writeMcpConfigs(mcpConfigFile, claudeDesktopConfigFile, mcpConfig);
    } catch (error) {
      env.HONUA_ADMIN_KEY = undefined;
      const client = new HonuaAdminClient({ baseUrl, adminKey: env.HONUA_ADMIN_PASSWORD, fetchFn: runtime.fetchFn });
      await revokeIssuedAdminKey(client, credential.id, error, async () => {
        await writePrivateFileAtomic(envFile, renderEnv(env, originalEnvText));
      });
    }
  } else {
    const existing = await resolveExistingAdminKey(baseUrl, env.HONUA_ADMIN_KEY, runtime.fetchFn);
    if (existing.kind === "current") {
      credential = existing.credential;
      const mcpConfig = native
        ? renderNativeWorkspaceMcpConfig(directory, native.gatewayCommand, native.gatewayArgs)
        : renderMcpConfig(baseUrl, credential.material);
      await writeMcpConfigs(mcpConfigFile, claudeDesktopConfigFile, mcpConfig);
    } else {
      credential = await reissueLegacyAdminKey({
        baseUrl,
        env,
        legacyId: existing.id,
        envFile,
        mcpConfigFile,
        claudeDesktopConfigFile,
        fetchFn: runtime.fetchFn,
        mcpConfig: native
          ? renderNativeWorkspaceMcpConfig(directory, native.gatewayCommand, native.gatewayArgs)
          : undefined,
      });
      reissueReason = "legacy-grants";
    }
  }

  let workspaceCredential: ProvisionedAdminCredential | undefined;
  if (native) {
    // A live server-owned target proves this image exposes the workspace route before issuance.
    const targetResponse = await (runtime.fetchFn ?? fetch)(`${baseUrl}/api/v1/agent/target`, {
      headers: { "X-API-Key": env.HONUA_ADMIN_KEY! },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const target = (await targetResponse.json()) as { targetId?: unknown };
    if (!targetResponse.ok || typeof target.targetId !== "string" || !target.targetId)
      throw new Error("Native workspace preview server does not expose a valid workspace target.");
    workspaceCredential = await ensureWorkspaceCredential(baseUrl, env, envFile, originalEnvText, runtime.fetchFn);
    env.HONUA_AGENT_PRINCIPAL_ID = `apikey:api-key:${workspaceCredential.id.toLowerCase()}`;
    await writePrivateFileAtomic(envFile, renderEnv(env, originalEnvText));
    // Recreate applies the newly issued principal binding; Console gets only its scoped key.
    await requireCommand(
      run,
      dockerCommand,
      [
        "compose",
        "--project-name",
        env.HONUA_COMPOSE_PROJECT,
        "--project-directory",
        directory,
        "--file",
        composeFile,
        "up",
        "-d",
        "--wait",
      ],
      directory,
      "Honua workspace binding",
    );
    await waitForReady(`${baseUrl}/healthz/ready`, options.timeoutMs ?? 180_000, runtime);
    await writeMcpConfigs(
      mcpConfigFile,
      claudeDesktopConfigFile,
      renderNativeWorkspaceMcpConfig(directory, native.gatewayCommand, native.gatewayArgs),
    );
  }

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
    ...(workspaceCredential
      ? {
          workspaceCredential: {
            id: workspaceCredential.id,
            name: workspaceCredential.name,
            status: "active" as const,
            requestedGrants: workspaceCredential.requestedGrants,
            effectiveGrants: workspaceCredential.effectiveGrants,
            canAuthenticate: true as const,
            referenceType: "private-env-file" as const,
            referenceDigestSha256: createHash("sha256").update(`file:${envFile}#HONUA_AGENT_API_KEY`).digest("hex"),
            provisioned: workspaceCredential.provisioned,
          },
          workspaceQualification: "preview-requires-human-pairing" as const,
          consoleUrl: `http://127.0.0.1:${native!.consolePort ?? 8081}`,
        }
      : {}),
    serverImage: env.HONUA_SERVER_IMAGE,
    reused,
    credentialReissued: reissueReason !== undefined,
    ...(reissueReason ? { reason: reissueReason } : {}),
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
  let compose: CommandResult;
  try {
    const dockerCommand = runtime.run
      ? "docker"
      : await resolveExecutableFromPath("docker", { excludedDirectory: resolved });
    compose = await run(
      dockerCommand,
      [
        "compose",
        "--project-name",
        env.HONUA_COMPOSE_PROJECT ?? "honua-local",
        "--project-directory",
        resolved,
        "--file",
        path.join(resolved, "compose.yaml"),
        "ps",
        "--format",
        "json",
      ],
      resolved,
    );
  } catch (error) {
    compose = { exitCode: 1, stdout: "", stderr: errorMessage(error) };
  }
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

/**
 * Render the local Docker compose file for an install profile.
 *
 * The 2026.1 bounded setup does not enable MCP profiles from this file.
 * `analysis` and `esri-gp` are not the first-cut gate, and a guessed
 * `Mcp__Profiles` value would silently do nothing. `honua admin qualify`
 * compares the server-authored workflow view with the pinned manifest instead.
 */
/** Extensions must live in public. The server resolves unqualified `geometry` there. */
export const LOCAL_POSTGIS_BOOTSTRAP_SQL = `DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'postgis' AND n.nspname <> 'public'
  ) THEN
    DROP EXTENSION IF EXISTS pgrouting;
    DROP EXTENSION postgis;
  END IF;
END
$$;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgrouting WITH SCHEMA public;
CREATE TABLE IF NOT EXISTS public.zero_to_map_parcels (
  parcel_id integer PRIMARY KEY,
  name text NOT NULL,
  geometry geometry(Polygon, 4326) NOT NULL
);
INSERT INTO public.zero_to_map_parcels (parcel_id, name, geometry)
VALUES (
  1,
  'origin',
  ST_SetSRID(ST_GeomFromText('POLYGON((-157.86 21.30, -157.85 21.30, -157.85 21.31, -157.86 21.31, -157.86 21.30))'), 4326)
)
ON CONFLICT (parcel_id) DO NOTHING;
`;

// Both supported local profiles follow the 2026.1 operator policy (honua-release#338).
export function renderLocalCompose(_options: {
  readonly profile: LocalInstallProfile;
  readonly nativeWorkspace?: boolean;
}): string {
  return `# Generated by @honua/sdk-js local installer
name: \${HONUA_COMPOSE_PROJECT:?Missing installer project identity}
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
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U honua -d honua"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped
  postgis-bootstrap:
    image: pgrouting/pgrouting:17-3.5-3.7.3
    environment:
      PGHOST: postgres
      PGUSER: honua
      PGDATABASE: honua
      PGPASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - ./postgis-bootstrap.sql:/bootstrap.sql:ro
    entrypoint: ["psql", "-v", "ON_ERROR_STOP=1", "-f", "/bootstrap.sql"]
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"
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
${_options.nativeWorkspace ? '    extra_hosts: ["host.docker.internal:host-gateway"]\n' : ""}    ports:
      - "127.0.0.1:\${HONUA_HTTP_PORT}:8080"
    environment:
      ASPNETCORE_ENVIRONMENT: Development
      AgentWorkspace__DeploymentId: \${HONUA_AGENT_DEPLOYMENT_ID}
      AgentWorkspace__ReleaseId: \${HONUA_AGENT_RELEASE_ID}
${
  _options.nativeWorkspace
    ? `      AgentWorkspace__LocalAgentPrincipalId: \${HONUA_AGENT_PRINCIPAL_ID:-}
      LocalProcesses__WorkspaceUrl: \${HONUA_GP_WORKSPACE_URL:-}
      HONUA_GP_WORKSPACE_KEY: \${HONUA_GP_WORKSPACE_KEY:-}
      Studio__EndUserAuthorization__Enabled: "true"
      AgentWorkspace__LocalHumanBridge__Enabled: "true"
      AgentWorkspace__LocalHumanBridge__Key: \${HONUA_LOCAL_HUMAN_BRIDGE_KEY}
      AgentWorkspace__LocalHumanBridge__TenantId: public
      Authentication__OperatorBearer__Enabled: "true"
      Authentication__OperatorBearer__SigningKey: \${HONUA_LOCAL_OPERATOR_SIGNING_KEY}
      StudioAiProxy__Enabled: \${HONUA_NATIVE_MODEL_ENABLED:-false}
      StudioAiProxy__DefaultProvider: native
      StudioAiProxy__Providers__native__Kind: \${HONUA_NATIVE_MODEL_KIND:-openai}
      StudioAiProxy__Providers__native__Endpoint: \${HONUA_NATIVE_MODEL_ENDPOINT:-}
      StudioAiProxy__Providers__native__Model: \${HONUA_NATIVE_MODEL_NAME:-}
      StudioAiProxy__Providers__native__Region: \${HONUA_NATIVE_MODEL_REGION:-us-west-2}
      StudioAiProxy__Providers__native__SupportsTools: "true"
      HONUA_STUDIOAI_NATIVE_API_KEY: \${HONUA_NATIVE_MODEL_API_KEY:-}
      StudioAiProxy__TranscriptSigning__KeyId: local-native-transcript
      StudioAiProxy__TranscriptSigning__PrivateKeyReference: env:HONUA_NATIVE_TRANSCRIPT_SEED
      HONUA_NATIVE_TRANSCRIPT_SEED: \${HONUA_NATIVE_TRANSCRIPT_SEED}
`
    : ""
}      ConnectionStrings__DefaultConnection: "Host=postgres;Database=honua;Username=honua;Password=\${POSTGRES_PASSWORD}"
      HONUA_LOCAL_DB_PASSWORD: "Host=postgres;Database=honua;Username=honua;Password=\${POSTGRES_PASSWORD}"
      Security__RequestSecretReferences__AllowedEnvironmentVariables__0: HONUA_LOCAL_DB_PASSWORD
      ConnectionStrings__Redis: redis:6379
      HONUA_ADMIN_PASSWORD: \${HONUA_ADMIN_PASSWORD}
      Security__ConnectionEncryption__MasterKey: \${HONUA_CONNECTION_ENCRYPTION_MASTER_KEY}
      Database__MigrationSafety__ContractApplyPolicy: Gate
      Licensing__Mode: "Disabled"
      FileStorage__Provider: Local
      FileStorage__LocalStorage__BasePath: /var/lib/honua/storage
      Kestrel__Endpoints__Http__Url: http://+:8080
      Kestrel__Endpoints__Http__Protocols: Http1
    depends_on:
      postgis-bootstrap:
        condition: service_completed_successfully
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
${
  _options.nativeWorkspace
    ? `  console:
    image: \${HONUA_CONSOLE_IMAGE}
    extra_hosts: ["host.docker.internal:host-gateway"]
    ports:
      - "127.0.0.1:\${HONUA_CONSOLE_PORT}:8080"
    environment:
      ASPNETCORE_ENVIRONMENT: Development
      ASPNETCORE_URLS: http://+:8080
      Studio__EmbedJsStudio: "true"
      HONUA_SERVER_BASE_URL: http://honua:8080
      HONUA_AGENT_SERVER_BASE_URL: http://honua:8080
      HONUA_AGENT_API_KEY: \${HONUA_AGENT_API_KEY:-}
      HONUA_AGENT_GATEWAY_URL: \${HONUA_AGENT_GATEWAY_URL:-}
      HONUA_AGENT_GATEWAY_KEY: \${HONUA_AGENT_GATEWAY_KEY:-}
      HONUA_AGENT_RELEASE_ID: \${HONUA_AGENT_RELEASE_ID}
      Honua__Console__Auth__Mode: Dev
      Honua__Console__Auth__LocalHumanBridge__Enabled: "true"
      HONUA_LOCAL_HUMAN_BRIDGE_KEY: \${HONUA_LOCAL_HUMAN_BRIDGE_KEY}
    depends_on:
      honua:
        condition: service_healthy
    restart: unless-stopped
`
    : ""
}volumes:
  postgres_data:
  redis_data:
  honua_storage:
`;
}

export function renderNativeWorkspaceMcpConfig(
  directory: string,
  command: string,
  args: readonly string[] = [],
): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        honua: { command, args: [...args], env: { HONUA_AGENT_INSTALL_DIRECTORY: path.resolve(directory) } },
      },
    },
    null,
    2,
  )}\n`;
}

export function renderMcpConfig(baseUrl: string, adminKey: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        honua: {
          command: "npx",
          args: ["-y", "--package", LOCAL_INSTALL_MCP_PACKAGE, "honua-mcp-proxy"],
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

async function writeMcpConfigs(mcpPath: string, claudePath: string, content: string): Promise<void> {
  const [previousMcp, previousClaude] = await Promise.all([
    readFile(mcpPath).catch((error: unknown) => (isMissingFile(error) ? undefined : Promise.reject(error))),
    readFile(claudePath).catch((error: unknown) => (isMissingFile(error) ? undefined : Promise.reject(error))),
  ]);
  try {
    await writePrivateFileAtomic(mcpPath, content);
    await writePrivateFileAtomic(claudePath, content);
  } catch (error) {
    await Promise.all([restorePrivateFile(mcpPath, previousMcp), restorePrivateFile(claudePath, previousClaude)]);
    throw error;
  }
}

async function restorePrivateFile(filePath: string, content: Buffer | undefined): Promise<void> {
  if (content === undefined) await rm(filePath, { force: true });
  else await writePrivateFileAtomic(filePath, content.toString("utf8"));
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
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
  name: string = LOCAL_AGENT_KEY_NAME,
  grants: readonly string[] = LOCAL_AGENT_GRANTS,
): Promise<ProvisionedAdminCredential> {
  const client = new HonuaAdminClient({ baseUrl, adminKey: rootKey, fetchFn });
  const result = await client.call("createAdminApiKey", {
    body: { name, permissions: [...grants] },
  });
  const issued = readIssuedAdminCredential(result.data);
  try {
    if (issued.name !== name) throw new Error("Admin key bootstrap identity did not match the requested name.");
    const effective = await readEffectiveAdminCredential(client, issued.id);
    if (!sameStrings(grants, effective.permissions)) {
      throw new Error("Admin key bootstrap effective grants did not match the requested grants.");
    }
    return {
      material: issued.material,
      id: issued.id,
      name: issued.name,
      requestedGrants: grants,
      effectiveGrants: effective.permissions,
      provisioned: true,
    };
  } catch (error) {
    return await revokeIssuedAdminKey(client, issued.id, error);
  }
}

/** Verify the preview credential independently; never use the operator key as a fallback. */
export async function inspectLocalWorkspaceAgentAccess(
  baseUrl: string,
  material: string,
  id: string,
  fetchFn: typeof fetch | undefined = undefined,
): Promise<LocalAccessCredentialReceipt> {
  if (!material || !id) throw new Error("Native workspace credential identity is incomplete.");
  const credential = await ensureWorkspaceCredential(
    baseUrl,
    {
      HONUA_AGENT_API_KEY: material,
      HONUA_AGENT_KEY_ID: id,
      HONUA_ADMIN_PASSWORD: material,
    },
    "",
    "",
    fetchFn,
  );
  return {
    id: credential.id,
    name: credential.name,
    status: "active",
    requestedGrants: credential.requestedGrants,
    effectiveGrants: credential.effectiveGrants,
    canAuthenticate: true,
    referenceType: "private-env-file",
    referenceDigestSha256: createHash("sha256").update(`workspace-key:${id}`).digest("hex"),
    provisioned: false,
  };
}

async function ensureWorkspaceCredential(
  baseUrl: string,
  env: Record<string, string | undefined>,
  envFile: string,
  original: string,
  fetchFn: typeof fetch | undefined,
): Promise<ProvisionedAdminCredential> {
  const root = new HonuaAdminClient({ baseUrl, adminKey: env.HONUA_ADMIN_PASSWORD!, fetchFn });
  if (env.HONUA_AGENT_API_KEY || env.HONUA_AGENT_KEY_ID) {
    if (
      !env.HONUA_AGENT_API_KEY ||
      !env.HONUA_AGENT_KEY_ID ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.HONUA_AGENT_KEY_ID)
    )
      throw new Error("Native workspace credential identity is incomplete; reconcile before reinstalling.");
    const result = await root.call("listAdminApiKeys", {});
    const data = isRecord(result.data) ? result.data.data : undefined;
    const matches = Array.isArray(data)
      ? data.filter(
          (value) =>
            isRecord(value) &&
            value.id === env.HONUA_AGENT_KEY_ID &&
            value.name === LOCAL_WORKSPACE_AGENT_KEY_NAME &&
            value.status === "active" &&
            typeof value.keyPrefix === "string" &&
            value.keyPrefix.length > 0 &&
            env.HONUA_AGENT_API_KEY!.startsWith(value.keyPrefix) &&
            isStringArray(value.permissions) &&
            sameStrings(value.permissions, LOCAL_WORKSPACE_AGENT_GRANTS),
        )
      : [];
    const effective = await readEffectiveAdminCredential(root, env.HONUA_AGENT_KEY_ID);
    if (matches.length !== 1 || !sameStrings(effective.permissions, LOCAL_WORKSPACE_AGENT_GRANTS))
      throw new Error("Native workspace credential grants or identity do not match the required scope.");
    return {
      material: env.HONUA_AGENT_API_KEY,
      id: env.HONUA_AGENT_KEY_ID,
      name: LOCAL_WORKSPACE_AGENT_KEY_NAME,
      requestedGrants: LOCAL_WORKSPACE_AGENT_GRANTS,
      effectiveGrants: effective.permissions,
      provisioned: false,
    };
  }
  const issued = await bootstrapAdminKey(
    baseUrl,
    env.HONUA_ADMIN_PASSWORD!,
    fetchFn,
    LOCAL_WORKSPACE_AGENT_KEY_NAME,
    LOCAL_WORKSPACE_AGENT_GRANTS,
  );
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(issued.id))
    return revokeIssuedAdminKey(
      root,
      issued.id,
      new Error("Native workspace credential ID is not a canonical API-key UUID."),
    );
  try {
    env.HONUA_AGENT_API_KEY = issued.material;
    env.HONUA_AGENT_KEY_ID = issued.id;
    await writePrivateFileAtomic(envFile, renderEnv(env, original));
  } catch (error) {
    delete env.HONUA_AGENT_API_KEY;
    delete env.HONUA_AGENT_KEY_ID;
    return revokeIssuedAdminKey(root, issued.id, error);
  }
  return issued;
}

async function revokeIssuedAdminKey(
  client: HonuaAdminClient,
  id: string,
  originalError: unknown,
  cleanup?: () => Promise<void>,
): Promise<never> {
  let revokeError: unknown;
  try {
    await client.call("revokeAdminApiKey", { path: { id } });
  } catch (error) {
    revokeError = error;
  }
  try {
    await cleanup?.();
  } catch {
    // The credential is already revoked (or the combined error below reports that it was not).
  }
  if (revokeError !== undefined) {
    throw new Error("Admin key bootstrap failed and rollback could not revoke the issued credential.", {
      cause: originalError,
    });
  }
  throw originalError;
}

/**
 * Replaces a legacy two-grant local-agent key: issue the new key with the root
 * credential, persist it to `.env` and both MCP configs, then revoke the legacy
 * key. Any failure revokes the new key and restores the files to the legacy
 * material, so a re-run starts from the same state.
 */
async function reissueLegacyAdminKey(args: {
  readonly baseUrl: string;
  readonly env: Record<string, string | undefined> & { HONUA_ADMIN_PASSWORD: string };
  readonly legacyId: string;
  readonly envFile: string;
  readonly mcpConfigFile: string;
  readonly claudeDesktopConfigFile: string;
  readonly fetchFn: typeof fetch | undefined;
  readonly mcpConfig?: string;
}): Promise<ProvisionedAdminCredential> {
  const { baseUrl, env, legacyId, envFile, mcpConfigFile, claudeDesktopConfigFile, fetchFn } = args;
  const originalEnvText = await readEnvText(envFile);
  const previousMaterial = env.HONUA_ADMIN_KEY;
  if (!previousMaterial) throw new Error("Legacy local-agent credential re-issue requires the existing key material.");
  const credential = await bootstrapAdminKey(baseUrl, env.HONUA_ADMIN_PASSWORD, fetchFn);
  const root = new HonuaAdminClient({ baseUrl, adminKey: env.HONUA_ADMIN_PASSWORD, fetchFn });
  const restorePrevious = async () => {
    env.HONUA_ADMIN_KEY = previousMaterial;
    await writePrivateFileAtomic(envFile, renderEnv(env, originalEnvText));
    await writeMcpConfigs(mcpConfigFile, claudeDesktopConfigFile, renderMcpConfig(baseUrl, previousMaterial));
  };
  try {
    env.HONUA_ADMIN_KEY = credential.material;
    await writePrivateFileAtomic(envFile, renderEnv(env, originalEnvText));
    await writeMcpConfigs(
      mcpConfigFile,
      claudeDesktopConfigFile,
      args.mcpConfig ?? renderMcpConfig(baseUrl, credential.material),
    );
  } catch (error) {
    return await revokeIssuedAdminKey(root, credential.id, error, restorePrevious);
  }
  try {
    await root.call("revokeAdminApiKey", { path: { id: legacyId } });
  } catch (error) {
    return await revokeIssuedAdminKey(
      root,
      credential.id,
      new Error(
        "The legacy local-agent credential could not be revoked; its replacement was rolled back and the legacy key left in place.",
        { cause: error },
      ),
      restorePrevious,
    );
  }
  return credential;
}

type ExistingAdminKeyResolution =
  | { readonly kind: "current"; readonly credential: ProvisionedAdminCredential }
  | { readonly kind: "legacy"; readonly id: string; readonly name: string };

async function resolveExistingAdminKey(
  baseUrl: string,
  material: string,
  fetchFn: typeof fetch | undefined,
): Promise<ExistingAdminKeyResolution> {
  const client = new HonuaAdminClient({ baseUrl, adminKey: material, fetchFn });
  const result = await client.call("listAdminApiKeys", {});
  const root = result.data;
  if (!isRecord(root) || !Array.isArray(root.data)) {
    throw new Error("Existing Admin credential could not be resolved to secret-safe server metadata.");
  }
  const active = root.data.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.name === LOCAL_AGENT_KEY_NAME && candidate.status === "active",
  );
  const matches = active.filter(
    (candidate) =>
      typeof candidate.keyPrefix === "string" &&
      candidate.keyPrefix.length > 0 &&
      isStringArray(candidate.permissions) &&
      (sameStrings(candidate.permissions, LOCAL_AGENT_GRANTS) ||
        sameStrings(candidate.permissions, LEGACY_LOCAL_AGENT_GRANTS)) &&
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
  if (sameStrings(LOCAL_AGENT_GRANTS, effective.permissions)) {
    return {
      kind: "current",
      credential: {
        material,
        id: match.id,
        name: match.name,
        requestedGrants: LOCAL_AGENT_GRANTS,
        effectiveGrants: effective.permissions,
        provisioned: false,
      },
    };
  }
  if (sameStrings(LEGACY_LOCAL_AGENT_GRANTS, effective.permissions)) {
    if (active.length !== 1) {
      throw new Error(
        "Existing Admin credential carries legacy local-agent grants, but more than one active local-agent identity exists. Revoke the extra honua-local-agent keys before re-running the installer.",
      );
    }
    return { kind: "legacy", id: match.id, name: match.name };
  }
  throw new Error("Existing Admin credential was not scoped to the required local-agent grants.");
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - now()));
      try {
        const response = await fetchFn(url, { signal: controller.signal });
        const body = await response.text();
        last = `HTTP ${response.status}: ${body}`;
        if (response.ok && body.trim().toLowerCase() === "ready") return;
      } finally {
        clearTimeout(timer);
      }
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

/** Read a local install env file after its private-file proof. Missing file is empty. */
export async function readVerifiedLocalEnv(directory: string): Promise<Record<string, string>> {
  return readEnv(path.join(path.resolve(directory), ".env"));
}

/**
 * Resolve the credential already written for this install and return only
 * secret-free identity and effective grants.
 */
export async function inspectLocalAgentAccess(
  baseUrl: string,
  material: string,
  fetchFn?: typeof fetch,
): Promise<{
  readonly id: string;
  readonly name: string;
  readonly requestedGrants: readonly string[];
  readonly effectiveGrants: readonly string[];
  readonly canAuthenticate: true;
}> {
  const resolution = await resolveExistingAdminKey(baseUrl, material, fetchFn);
  if (resolution.kind === "legacy") {
    throw new Error(
      `The local agent credential carries the legacy grants [${LEGACY_LOCAL_AGENT_GRANTS.join(", ")}] without read:*, so it cannot read layer data. Re-run \`honua admin install local\` to re-issue it.`,
    );
  }
  const credential = resolution.credential;
  return {
    id: credential.id,
    name: credential.name,
    requestedGrants: credential.requestedGrants,
    effectiveGrants: credential.effectiveGrants,
    canAuthenticate: true,
  };
}

export async function runLocalInstallCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return runCommand(command, args, cwd);
}

async function verifyInstallFiles(
  composeFile: string,
  bootstrapFile: string,
  env: Record<string, string>,
): Promise<void> {
  if (Object.keys(env).length > 0 && !env.HONUA_SERVER_IMAGE) {
    throw new Error(
      "Refusing to overwrite an existing .env not owned by the Honua installer. Choose a new install directory.",
    );
  }
  for (const [file, expected] of [
    [composeFile, renderLocalCompose({ profile: "quickstart" })],
    [bootstrapFile, LOCAL_POSTGIS_BOOTSTRAP_SQL],
  ] as const) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
      const content = await readFile(file, "utf8");
      const known =
        file === bootstrapFile
          ? content === expected
          : ["quickstart", "gp-dev"].some((profile) => {
              const current = renderLocalCompose({ profile: profile as LocalInstallProfile });
              // initdb's temporary server accepts Unix sockets before TCP bootstrap is safe.
              const beforeTcpReadiness = current.replace("pg_isready -h 127.0.0.1", "pg_isready");
              const beforeAllowlist = beforeTcpReadiness.replace(
                "      Security__RequestSecretReferences__AllowedEnvironmentVariables__0: HONUA_LOCAL_DB_PASSWORD\n",
                "",
              );
              const previous = beforeAllowlist.replace(
                'Licensing__Mode: "Disabled"',
                `Licensing__DevGrantEdition: "${profile === "gp-dev" ? "Pro" : ""}"`,
              );
              const preWorkspace = current.replace(
                "      AgentWorkspace__DeploymentId: ${HONUA_AGENT_DEPLOYMENT_ID}\n      AgentWorkspace__ReleaseId: ${HONUA_AGENT_RELEASE_ID}\n",
                "",
              );
              return [
                current,
                preWorkspace,
                renderLocalCompose({ profile: profile as LocalInstallProfile, nativeWorkspace: true }),
                renderLocalCompose({ profile: profile as LocalInstallProfile, nativeWorkspace: true })
                  .replaceAll('    extra_hosts: ["host.docker.internal:host-gateway"]\n', "")
                  .replace(
                    "      LocalProcesses__WorkspaceUrl: ${HONUA_GP_WORKSPACE_URL:-}\n      HONUA_GP_WORKSPACE_KEY: ${HONUA_GP_WORKSPACE_KEY:-}\n",
                    "",
                  ),
                beforeTcpReadiness,
                beforeAllowlist,
                previous,
              ].some((candidate) => {
                const legacy = candidate.replace(
                  "# Generated by @honua/sdk-js local installer\nname: ${HONUA_COMPOSE_PROJECT:?Missing installer project identity}",
                  "name: honua-local",
                );
                const withoutWorkspace = (value: string) =>
                  value.replace(
                    "      AgentWorkspace__DeploymentId: ${HONUA_AGENT_DEPLOYMENT_ID}\n      AgentWorkspace__ReleaseId: ${HONUA_AGENT_RELEASE_ID}\n",
                    "",
                  );
                return (
                  content === candidate ||
                  content === legacy ||
                  content === withoutWorkspace(candidate) ||
                  content === withoutWorkspace(legacy)
                );
              });
            });
      if (!env.HONUA_SERVER_IMAGE || !known) throw new Error("unrecognized installer content");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `Refusing to overwrite existing ${file}: ${errorMessage(error)}. Choose a new install directory or restore the installer-owned file.`,
      );
    }
  }
  if (env.HONUA_COMPOSE_PROJECT && !/^honua-local(?:-[a-f0-9]{24})?$/.test(env.HONUA_COMPOSE_PROJECT)) {
    throw new Error("Invalid installer compose project identity in .env.");
  }
}

async function readEnvText(filePath: string): Promise<string> {
  try {
    await verifyPrivateFile(filePath);
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(
      `Refusing to read local credentials from an unverified private file ${filePath}: ${errorMessage(error)}`,
    );
  }
}

async function readEnv(filePath: string, original?: string): Promise<Record<string, string>> {
  const raw = original ?? (await readEnvText(filePath));
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : [line, ""];
      }),
  );
}

const MANAGED_ENV_KEYS = [
  "HONUA_GP_WORKSPACE_URL",
  "HONUA_GP_WORKSPACE_KEY",
  "HONUA_AGENT_GATEWAY_URL",
  "HONUA_AGENT_GATEWAY_KEY",
  "HONUA_NATIVE_TRANSCRIPT_SEED",
  "HONUA_NATIVE_MODEL_ENABLED",
  "HONUA_NATIVE_MODEL_KIND",
  "HONUA_NATIVE_MODEL_ENDPOINT",
  "HONUA_NATIVE_MODEL_NAME",
  "HONUA_NATIVE_MODEL_REGION",
  "HONUA_NATIVE_MODEL_API_KEY",
  "HONUA_LOCAL_HUMAN_BRIDGE_KEY",
  "HONUA_LOCAL_OPERATOR_SIGNING_KEY",
  "HONUA_AGENT_DEPLOYMENT_ID",
  "HONUA_AGENT_RELEASE_ID",
  "HONUA_CONSOLE_IMAGE",
  "HONUA_CONSOLE_PORT",
  "HONUA_AGENT_API_KEY",
  "HONUA_AGENT_KEY_ID",
  "HONUA_AGENT_PRINCIPAL_ID",
  "HONUA_SERVER_IMAGE",
  "HONUA_COMPOSE_PROJECT",
  "HONUA_HTTP_PORT",
  "POSTGRES_PASSWORD",
  "HONUA_ADMIN_PASSWORD",
  "HONUA_CONNECTION_ENCRYPTION_MASTER_KEY",
  "HONUA_ADMIN_KEY",
] as const;

function validateManagedEnv(raw: string): void {
  const seen = new Set<string>();
  let quote: string | undefined;
  let continued = false;
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && MANAGED_ENV_KEYS.some((key) => key === match[1])) {
      const key = match[1];
      const value = line.slice(line.indexOf("=") + 1);
      if (quote || continued || seen.has(key) || !line.startsWith(`${key}=`) || /[\s"'`\\$#]/.test(value)) {
        throw new Error(
          `Refusing ambiguous installer-managed .env key ${key}. Restore one plain single-line assignment before reinstalling.`,
        );
      }
      seen.add(key);
    }
    // Track only leading quoted values and continuations to avoid rewriting a
    // managed-looking line inside unrelated multiline text.
    let start = 0;
    if (!quote) {
      const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(["'])/.exec(line);
      if (assignment) {
        quote = assignment[1];
        start = assignment[0].length;
      }
    }
    if (quote) {
      for (let index = start; index < line.length; index += 1) {
        if (line[index] === "\\" && quote === '"') index += 1;
        else if (line[index] === quote) {
          quote = undefined;
          break;
        }
      }
    }
    continued = !quote && (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;
  }
  if (quote || continued)
    throw new Error("Refusing ambiguous unterminated .env multiline value before appending installer keys.");
}

async function verifyPrivateFileIfPresent(filePath: string): Promise<boolean> {
  try {
    await verifyPrivateFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `Refusing to reuse local credentials after an unverified credential file ${filePath}: ${errorMessage(error)}`,
    );
  }
}

function assertIndependentModelCredential(key: string | undefined, env: Record<string, string | undefined>): void {
  if (key && [...HOST_AUTHORITY_KEYS, "HONUA_AGENT_GATEWAY_KEY"].some((name) => env[name] && env[name] === key))
    throw new Error("The native model credential must be independent from host authority credentials.");
}

function assertIndependentGatewayKey(env: Record<string, string | undefined>): void {
  assertIndependentModelCredential(env.HONUA_NATIVE_MODEL_API_KEY, env);
  assertIndependentLocalProcessKey(env.HONUA_GP_WORKSPACE_KEY, env);
  const bridge = env.HONUA_AGENT_GATEWAY_KEY;
  if (
    bridge &&
    [...HOST_AUTHORITY_KEYS, "HONUA_NATIVE_MODEL_API_KEY", "HONUA_STUDIOAI_NATIVE_API_KEY"].some(
      (name) => env[name] && env[name] === bridge,
    )
  )
    throw new Error("The native gateway credential must be independent from other credentials.");
}

function assertIndependentLocalProcessKey(key: string | undefined, env: Record<string, string | undefined>): void {
  if (
    key &&
    [
      ...HOST_AUTHORITY_KEYS.filter((name) => name !== "HONUA_GP_WORKSPACE_KEY"),
      "HONUA_AGENT_GATEWAY_KEY",
      "HONUA_NATIVE_MODEL_API_KEY",
      "HONUA_STUDIOAI_NATIVE_API_KEY",
    ].some((name) => env[name] && env[name] === key)
  )
    throw new Error("The local process credential must be independent from other credentials.");
}

function renderEnv(env: Record<string, string | undefined>, original: string): string {
  assertIndependentGatewayKey(env);
  const seen = new Set<string>();
  let content = original
    .split(/(?<=\n)/)
    .map((line) => {
      const key = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
      if (!key || !MANAGED_ENV_KEYS.some((managed) => managed === key)) return line;
      seen.add(key);
      return env[key] === undefined
        ? ""
        : `${key}=${env[key]}${line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""}`;
    })
    .join("");
  for (const key of MANAGED_ENV_KEYS) {
    if (seen.has(key) || env[key] === undefined) continue;
    if (content && !content.endsWith("\n")) content += "\n";
    content += `${key}=${env[key]}\n`;
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
