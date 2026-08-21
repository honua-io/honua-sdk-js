#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HonuaClient } from "@honua/sdk-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateAgainstSchema } from "../certification/json-schema.js";
import {
  type ZeroToMapCheckpoint,
  type ZeroToMapCheckpointBindings,
  assertZeroToMapCheckpointBindings,
  assertZeroToMapCheckpointDigest,
  assertZeroToMapCheckpointFresh,
  consumeZeroToMapCheckpoint,
  createZeroToMapCheckpoint,
  parseZeroToMapCheckpoint,
} from "./zero-to-map-checkpoint.js";
import {
  type AwsEcsProvisionBinding,
  assertAwsEcsProvisionBindings,
  parseAwsEcsProvisionBinding,
} from "./zero-to-map-provision.js";
import {
  type JourneyAdapter,
  JourneyBlockedError,
  type JourneyExecutionResult,
  type JourneyGpServerAction,
  type JourneyMcpResourceAction,
  parseZeroToMapPlan,
  runZeroToMapJourney,
} from "./zero-to-map.js";

type JourneyTarget = "local-docker" | "aws-ecs";

export interface CliOptions {
  readonly execute: boolean;
  readonly confirmed: boolean;
  readonly planPath: string;
  readonly outputPath: string;
  readonly honuaCommand: string;
  readonly target: JourneyTarget;
  readonly mcpUrl?: string;
  readonly checkpointPath?: string;
  readonly checkpointDigest?: string;
  readonly provisionReceiptPath?: string;
  readonly consoleReceiptPath?: string;
  readonly provisionBinding?: AwsEcsProvisionBinding;
  readonly provisionReceiptSha256?: string;
  readonly sourceRevision?: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly receiptPaths: Readonly<Record<string, string>>;
}

class ContractAdapter implements JourneyAdapter {
  runCli(): Promise<never> {
    return Promise.reject(new Error("contract adapter must not execute CLI work"));
  }
  listTools(): Promise<never> {
    return Promise.reject(new Error("contract adapter must not connect to MCP"));
  }
  callTool(): Promise<never> {
    return Promise.reject(new Error("contract adapter must not call MCP tools"));
  }
  readResource(): Promise<never> {
    return Promise.reject(new Error("contract adapter must not read MCP resources"));
  }
  runGpServer(): Promise<never> {
    return Promise.reject(new Error("contract adapter must not execute GPServer jobs"));
  }
  readReceipt(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
  checkHttp(): Promise<never> {
    return Promise.reject(new Error("contract adapter must not make HTTP requests"));
  }
}

class LiveAdapter implements JourneyAdapter {
  #client: Client | undefined;

  constructor(
    private readonly options: CliOptions,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  async runCli(args: readonly string[]): Promise<JourneyExecutionResult> {
    if (this.options.target === "aws-ecs") return this.awsProvisionEvidence(args);
    const result = await runProcess(this.options.honuaCommand, args, this.env);
    if (result.exitCode !== 0) {
      throw new Error(`honua CLI exited ${result.exitCode}; see stderr from the driver process`);
    }
    return { evidence: { command: "honua", args: redactCliArgs(args), exitCode: result.exitCode } };
  }

  private awsProvisionEvidence(args: readonly string[]): JourneyExecutionResult {
    const binding = this.options.provisionBinding;
    if (!binding) throw new Error("AWS ECS target has no verified provision binding");
    if (args[0] !== "admin" || args[1] !== "install") {
      throw new Error("AWS ECS target can replace only the Stage 1 install actions");
    }
    if (args[2] === "local") {
      return {
        evidence: {
          target: binding.target,
          candidateId: binding.candidateId,
          releaseId: binding.releaseId,
          serverImage: binding.serverImage,
          components: binding.components,
          terraformPlan: binding.checks["terraform-plan"],
          terraformApply: binding.checks["terraform-apply"],
          producerEvidenceUrl: binding.evidence.url,
          producerEvidenceSha256: binding.evidence.sha256,
        },
      };
    }
    if (args[2] === "status") {
      return {
        evidence: {
          target: binding.target,
          endpoint: binding.endpoint,
          mcpUrl: this.options.mcpUrl,
          readiness: binding.checks.readiness,
          adminMcpHandoff: binding.checks["admin-mcp-handoff"],
          credentialReferencePresent: binding.adminKeySecretRef.length > 0,
        },
      };
    }
    throw new Error("AWS ECS target encountered an unknown Stage 1 install action");
  }

  async listTools(): Promise<readonly { name: string; inputSchema: Readonly<Record<string, unknown>> }[]> {
    const client = await this.client();
    const tools: { name: string; inputSchema: Readonly<Record<string, unknown>> }[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...result.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(tool: string, args: Readonly<Record<string, unknown>>): Promise<JourneyExecutionResult> {
    const result = await (await this.client()).callTool({ name: tool, arguments: args });
    if ((result as { isError?: boolean }).isError === true) {
      throw new Error(`${tool} returned isError=true: ${toolErrorMessage(result)}`);
    }
    const operation = requireCompletedPublishedOperation(tool, result);
    return {
      value: result,
      evidence: {
        tool,
        isError: false,
        ...(operation
          ? {
              operationId: operation.operationId,
              status: operation.status,
              handleId: operation.handleId,
              metadataRevision: operation.metadataRevision,
            }
          : {}),
      },
    };
  }

  async readResource(action: JourneyMcpResourceAction): Promise<JourneyExecutionResult> {
    const client = await this.client();
    return readJourneyMcpResource(action, (uri) => client.readResource({ uri }));
  }

  async runGpServer(action: JourneyGpServerAction): Promise<JourneyExecutionResult> {
    const mcpUrl = this.options.mcpUrl;
    if (!mcpUrl) {
      throw new JourneyBlockedError(
        "The GPServer run requires --mcp-url to identify the Honua deployment.",
        "mcp-url-missing",
      );
    }
    const endpoint = new URL(mcpUrl);
    endpoint.pathname = endpoint.pathname.replace(/\/mcp\/?$/, "") || "/";
    endpoint.search = "";
    endpoint.hash = "";
    const client = new HonuaClient({
      baseUrl: endpoint.toString(),
      apiKey: this.env.HONUA_API_KEY,
      bearerToken: this.env.HONUA_MCP_AUTH_TOKEN,
    });
    const runner = client.geoprocessingRunner(action.serviceId, action.taskName);
    const job = await runner.execute<Record<string, unknown>>({
      processId: action.processId,
      parameters: action.parameters,
      resultNames: action.resultNames,
    });
    const result = await job.results({ pollIntervalMs: 500, deadlineMs: 120_000 });
    return {
      value: { jobId: job.id, jobType: job.type, status: job.status, outputs: result.outputs },
      evidence: {
        protocol: runner.protocol,
        processId: action.processId,
        serviceId: action.serviceId,
        taskName: action.taskName,
        jobId: job.id,
        status: job.status,
        resultNames: Object.keys(result.outputs),
      },
    };
  }

  async readReceipt(actionId: string): Promise<JourneyExecutionResult | undefined> {
    const path = this.options.receiptPaths[actionId];
    if (!path) return undefined;
    const bytes = await readFile(path);
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (actionId === "console-approval") {
      const schemaPath = fileURLToPath(
        new URL("../../../release/zero-to-map/contracts/console-receipt.schema.json", import.meta.url),
      );
      const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
      const validation = validateAgainstSchema(schema, value);
      if (!validation.valid) {
        throw new Error(`Console receipt failed its strict schema: ${validation.errors.join("; ")}`);
      }
    }
    return {
      value,
      evidence: {
        source: "external-receipt",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }

  async checkHttp(url: string, expectedStatus: number): Promise<JourneyExecutionResult> {
    const requested = new URL(url);
    if (requested.protocol !== "https:" || requested.username || requested.password) {
      throw new Error("published artifact URL must be HTTPS and must not embed credentials");
    }
    const response = await fetch(url, { method: "GET", redirect: "follow" });
    if (response.status !== expectedStatus) {
      throw new Error(`GET ${url} returned ${response.status}; expected ${expectedStatus}`);
    }
    if (normalizeEndpoint(response.url) !== normalizeEndpoint(url)) {
      throw new Error(`GET ${url} resolved to a different published identity: ${response.url}`);
    }
    const contentType = response.headers.get("content-type");
    if (!contentType) throw new Error(`GET ${url} returned no content type`);
    return {
      evidence: {
        requestedUrl: url,
        url: response.url,
        status: response.status,
        contentType,
        identityMatched: true,
      },
    };
  }

  async close(): Promise<void> {
    await this.#client?.close();
  }

  private async client(): Promise<Client> {
    if (this.#client) return this.#client;
    const mcpUrl = this.options.mcpUrl;
    if (!mcpUrl) {
      throw new JourneyBlockedError(
        "HONUA_MCP_REMOTE_URL (or --mcp-url) is required for a live journey.",
        "mcp-url-missing",
      );
    }
    const proxyEntry = fileURLToPath(new URL("../proxy.js", import.meta.url));
    const childEnv: Record<string, string> = {
      ...(this.env as Record<string, string>),
      HONUA_MCP_REMOTE_URL: mcpUrl,
    };
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [proxyEntry],
      env: childEnv,
      stderr: "inherit",
    });
    const client = new Client({ name: "honua-zero-to-map-release", version: "1.0.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new JourneyBlockedError(
        `Could not connect through honua-mcp-proxy: ${error instanceof Error ? error.message : String(error)}`,
        "mcp-proxy-unavailable",
      );
    }
    this.#client = client;
    return client;
  }
}

export async function runZeroToMapCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseZeroToMapCliArgs(argv, env);
  if (options.execute && !options.confirmed) {
    throw new Error("--execute requires --yes because the journey creates and publishes server state");
  }
  if (options.execute && !options.checkpointPath) {
    throw new Error("--execute requires --checkpoint so Console approval cannot replay prior mutations");
  }
  const planBytes = await readFile(options.planPath);
  const plan = parseZeroToMapPlan(JSON.parse(planBytes.toString("utf8")) as unknown);
  const liveOptions = options.execute ? await prepareLiveOptions(options) : options;
  const bindings = options.execute
    ? checkpointBindings(liveOptions, plan.journeyId, plan.releaseContract, planBytes)
    : undefined;
  let checkpoint: ZeroToMapCheckpoint | undefined;
  let claimPath: string | undefined;
  if (options.execute && options.checkpointPath) {
    checkpoint = await readCheckpointIfPresent(options.checkpointPath);
    if (checkpoint) {
      if (!options.consoleReceiptPath) throw new Error("a paused checkpoint requires --console-receipt to resume");
      if (!options.checkpointDigest) throw new Error("--checkpoint-digest is required to resume");
      assertZeroToMapCheckpointDigest(checkpoint, options.checkpointDigest);
      if (checkpoint.state !== "paused") throw new Error("checkpoint has already been consumed");
      assertZeroToMapCheckpointFresh(checkpoint);
      if (!bindings) throw new Error("internal checkpoint binding error");
      assertZeroToMapCheckpointBindings(checkpoint, bindings);
      claimPath = await claimZeroToMapCheckpoint(options.checkpointPath, checkpoint.integrity.digest);
    } else if (options.consoleReceiptPath || options.checkpointDigest) {
      throw new Error("--console-receipt and --checkpoint-digest require an existing paused checkpoint");
    }
  }

  const adapter = options.execute ? new LiveAdapter(liveOptions, env) : new ContractAdapter();
  const receipt = await runZeroToMapJourney(plan, adapter, {
    execute: options.execute,
    variables: options.variables,
    ...(checkpoint ? { resume: checkpoint.resume } : {}),
    ...(!checkpoint && bindings && options.checkpointPath
      ? {
          onExternalReceiptMissing: async (snapshot) => {
            await writeJsonNew(options.checkpointPath as string, createZeroToMapCheckpoint(bindings, snapshot));
          },
        }
      : {}),
  });
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(options.outputPath, receiptBytes, "utf8");
  if (checkpoint && claimPath && options.checkpointPath) {
    if (receipt.status === "passed") {
      const consumed = consumeZeroToMapCheckpoint(checkpoint, createHash("sha256").update(receiptBytes).digest("hex"));
      await writeFile(claimPath, `${JSON.stringify(consumed, null, 2)}\n`, "utf8");
      await rename(claimPath, options.checkpointPath);
    }
  }
  process.stdout.write(`${receipt.mode} journey ${receipt.status}; receipt written to ${options.outputPath}\n`);
  return receipt.status === "passed" ? 0 : receipt.status === "blocked" ? 2 : 1;
}

export function parseZeroToMapCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  let execute = false;
  let confirmed = false;
  let planPath = fileURLToPath(new URL("../../../release/zero-to-map/journey.v1.json", import.meta.url));
  let outputPath = "zero-to-map-receipt.json";
  let honuaCommand = env.HONUA_CLI_COMMAND ?? "honua";
  let mcpUrl = env.HONUA_MCP_REMOTE_URL ?? env.HONUA_MCP_URL;
  let target: JourneyTarget = "local-docker";
  let checkpointPath: string | undefined;
  let checkpointDigest: string | undefined;
  let provisionReceiptPath: string | undefined;
  let consoleReceiptPath: string | undefined;
  const variables: Record<string, unknown> = {};
  const receiptPaths: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--execute":
        execute = true;
        break;
      case "--yes":
        confirmed = true;
        break;
      case "--plan":
        planPath = requireNext(argv, ++index, arg);
        break;
      case "--output":
        outputPath = requireNext(argv, ++index, arg);
        break;
      case "--honua-command":
        honuaCommand = requireNext(argv, ++index, arg);
        break;
      case "--mcp-url":
        mcpUrl = requireNext(argv, ++index, arg);
        break;
      case "--target": {
        const value = requireNext(argv, ++index, arg);
        if (value !== "local-docker" && value !== "aws-ecs") {
          throw new Error("--target must be local-docker or aws-ecs");
        }
        target = value;
        break;
      }
      case "--checkpoint":
        checkpointPath = requireNext(argv, ++index, arg);
        break;
      case "--checkpoint-digest":
        checkpointDigest = requireNext(argv, ++index, arg);
        if (!/^[0-9a-f]{64}$/.test(checkpointDigest)) {
          throw new Error("--checkpoint-digest must be a lowercase SHA-256 digest");
        }
        break;
      case "--provision-receipt":
        provisionReceiptPath = requireNext(argv, ++index, arg);
        break;
      case "--var": {
        const pair = requireNext(argv, ++index, arg);
        const separator = pair.indexOf("=");
        if (separator < 1) throw new Error("--var requires name=value");
        variables[pair.slice(0, separator)] = parseVariable(pair.slice(separator + 1));
        break;
      }
      case "--var-env": {
        const pair = requireNext(argv, ++index, arg);
        const separator = pair.indexOf("=");
        if (separator < 1) throw new Error("--var-env requires name=ENV_NAME");
        const name = pair.slice(0, separator);
        const envName = pair.slice(separator + 1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error("--var-env requires a valid environment name");
        const value = env[envName];
        if (!value) throw new Error(`--var-env ${name} references a missing or empty environment value`);
        variables[name] = parseVariable(value);
        break;
      }
      case "--console-receipt": {
        consoleReceiptPath = requireNext(argv, ++index, arg);
        receiptPaths["console-approval"] = consoleReceiptPath;
        break;
      }
      case "--help":
        printHelp();
        throw new HelpRequested();
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    execute,
    confirmed,
    planPath,
    outputPath,
    honuaCommand,
    target,
    ...(mcpUrl ? { mcpUrl } : {}),
    ...(checkpointPath ? { checkpointPath } : {}),
    ...(checkpointDigest ? { checkpointDigest } : {}),
    ...(provisionReceiptPath ? { provisionReceiptPath } : {}),
    ...(consoleReceiptPath ? { consoleReceiptPath } : {}),
    ...(env.HONUA_SOURCE_REVISION ? { sourceRevision: env.HONUA_SOURCE_REVISION } : {}),
    variables,
    receiptPaths,
  };
}

async function prepareLiveOptions(options: CliOptions): Promise<CliOptions> {
  if (!options.sourceRevision || !/^[0-9a-f]{40}$/.test(options.sourceRevision)) {
    throw new Error("HONUA_SOURCE_REVISION must be the exact 40-character SDK candidate SHA");
  }
  if (!options.mcpUrl) throw new Error("--mcp-url is required for live execution");
  requireBindingVariable(options.variables, "candidateId");
  requireBindingVariable(options.variables, "releaseId");
  if (options.target === "local-docker") {
    if (options.provisionReceiptPath) throw new Error("--provision-receipt is valid only with --target aws-ecs");
    return options;
  }
  if (!options.provisionReceiptPath) throw new Error("--target aws-ecs requires --provision-receipt");
  const provisionBytes = await readFile(options.provisionReceiptPath);
  const provisionBinding = parseAwsEcsProvisionBinding(JSON.parse(provisionBytes.toString("utf8")) as unknown);
  assertAwsEcsProvisionBindings(provisionBinding, {
    candidateId: requireBindingVariable(options.variables, "candidateId"),
    releaseId: requireBindingVariable(options.variables, "releaseId"),
    mcpUrl: options.mcpUrl,
  });
  return {
    ...options,
    provisionBinding,
    provisionReceiptSha256: createHash("sha256").update(provisionBytes).digest("hex"),
  };
}

function checkpointBindings(
  options: CliOptions,
  journeyId: string,
  releaseContract: string,
  planBytes: Uint8Array,
): ZeroToMapCheckpointBindings {
  if (!options.sourceRevision || !options.mcpUrl) throw new Error("live checkpoint bindings are incomplete");
  return {
    journeyId,
    releaseContract,
    target: options.target,
    planSha256: createHash("sha256").update(planBytes).digest("hex"),
    sourceRevision: options.sourceRevision,
    mcpEndpointSha256: createHash("sha256").update(normalizeEndpoint(options.mcpUrl)).digest("hex"),
    candidateId: requireBindingVariable(options.variables, "candidateId"),
    releaseId: requireBindingVariable(options.variables, "releaseId"),
    ...(options.provisionReceiptSha256 ? { provisionReceiptSha256: options.provisionReceiptSha256 } : {}),
  };
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requireBindingVariable(variables: Readonly<Record<string, unknown>>, name: string): string {
  const value = variables[name];
  if (typeof value !== "string" || !value) throw new Error(`--var ${name}=... is required for live execution`);
  return value;
}

async function readCheckpointIfPresent(path: string): Promise<ZeroToMapCheckpoint | undefined> {
  try {
    return parseZeroToMapCheckpoint(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonNew(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

/** Atomically transfer one paused checkpoint to a single resume owner. */
export async function claimZeroToMapCheckpoint(path: string, digest: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("checkpoint claim digest must be a lowercase SHA-256");
  const checkpoint = await readCheckpointIfPresent(path);
  if (!checkpoint) throw new Error("checkpoint is already claimed by another resume");
  if (checkpoint.state !== "paused") throw new Error("checkpoint has already been consumed");
  assertZeroToMapCheckpointDigest(checkpoint, digest);
  const claimPath = `${path}.claimed-${digest}`;
  const lockPath = `${claimPath}.lock`;
  try {
    const lock = await open(lockPath, "wx");
    await lock.close();
    await rename(path, claimPath);
    return claimPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT" || code === "EEXIST"
        ? "checkpoint is already claimed by another resume"
        : `could not atomically claim checkpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function runProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(
          new JourneyBlockedError(`Control-plane CLI command was not found: ${command}`, "control-plane-cli-missing"),
        );
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
}

function toolErrorMessage(value: unknown): string {
  if (value && typeof value === "object") {
    const result = value as { structuredContent?: unknown; content?: unknown };
    if (result.structuredContent) return JSON.stringify(result.structuredContent);
    if (Array.isArray(result.content)) {
      const text = result.content.find(
        (block): block is { type: "text"; text: string } =>
          Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text",
      );
      if (text && typeof text.text === "string") return text.text;
    }
  }
  return "no structured error was returned";
}

/** Poll one MCP job resource to its declared successful terminal state. */
export async function readJourneyMcpResource(
  action: JourneyMcpResourceAction,
  read: (uri: string) => Promise<unknown>,
): Promise<JourneyExecutionResult> {
  const startedAt = Date.now();
  for (;;) {
    const result = await read(action.uri);
    const body = readJsonResource(result, action.uri);
    const wait = action.waitFor;
    if (!wait) return { value: result, evidence: { uri: action.uri } };
    const actual = resourceJsonPointer(body, wait.pointer);
    if (wait.terminal.includes(String(actual))) {
      if (actual !== wait.equals) {
        throw new Error(`${action.uri} reached terminal ${String(actual)}; expected ${wait.equals}`);
      }
      return {
        value: result,
        evidence: { uri: action.uri, [wait.pointer.slice(1) || "value"]: actual },
      };
    }
    if (Date.now() - startedAt >= wait.deadlineMs) {
      throw new Error(`${action.uri} did not reach ${wait.equals} within ${wait.deadlineMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait.pollIntervalMs));
  }
}

function readJsonResource(value: unknown, uri: string): unknown {
  if (!value || typeof value !== "object") throw new Error(`${uri} returned an invalid resources/read response`);
  const contents = (value as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) throw new Error(`${uri} returned no resource contents`);
  const content = contents.find(
    (candidate): candidate is { text: string } =>
      Boolean(candidate) && typeof candidate === "object" && typeof (candidate as { text?: unknown }).text === "string",
  );
  if (!content) throw new Error(`${uri} returned no JSON text content`);
  try {
    return JSON.parse(content.text) as unknown;
  } catch {
    throw new Error(`${uri} returned invalid JSON text content`);
  }
}

function resourceJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error(`invalid resource JSON pointer: ${pointer}`);
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function requireCompletedPublishedOperation(
  tool: string,
  value: unknown,
):
  | {
      operationId: string;
      status: string;
      handleId?: string;
      approvalLane?: string;
      jobId?: string;
      metadataRevision?: number;
    }
  | undefined {
  const operation = publishedOperation(value);
  if (!operation) return undefined;
  const status = operation.status.toLowerCase();
  if (status === "requiresapproval" || status === "queued") {
    throw new JourneyBlockedError(
      `${tool} returned ${operation.status}; handle=${operation.handleId ?? "unknown"}, approvalLane=${operation.approvalLane ?? "none"}, job=${operation.jobId ?? "none"}.`,
      status === "requiresapproval" ? "operation-approval-required" : "operation-queued",
    );
  }
  if (status !== "completed") {
    throw new Error(`${tool} operation ${operation.operationId} returned status ${operation.status}`);
  }
  return operation;
}

function publishedOperation(value: unknown):
  | {
      operationId: string;
      status: string;
      handleId?: string;
      approvalLane?: string;
      jobId?: string;
      metadataRevision?: number;
    }
  | undefined {
  if (!value || typeof value !== "object") return undefined;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const body = structured as Record<string, unknown>;
  if (typeof body.operationId !== "string" || !body.operationId.startsWith("admin.")) return undefined;
  if (typeof body.status !== "string") throw new Error(`${body.operationId} omitted its published-operation status`);
  return {
    operationId: body.operationId,
    status: body.status,
    ...(typeof body.handleId === "string" ? { handleId: body.handleId } : {}),
    ...(typeof body.approvalLane === "string" ? { approvalLane: body.approvalLane } : {}),
    ...(typeof body.jobId === "string" ? { jobId: body.jobId } : {}),
    ...(typeof body.metadataRevision === "number" ? { metadataRevision: body.metadataRevision } : {}),
  };
}

function redactCliArgs(args: readonly string[]): readonly string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    if (["--api-key", "--password", "--token"].includes(redacted[index] ?? "")) {
      if (index + 1 < redacted.length) redacted[index + 1] = "[REDACTED]";
    }
  }
  return redacted;
}

function parseVariable(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function requireNext(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function printHelp(): void {
  process.stdout.write("Usage: honua-zero-to-map-release [options]\n\n");
  process.stdout.write("Without --execute, validates the plan and writes an explicitly blocked contract receipt.\n\n");
  process.stdout.write("  --execute --yes           Run the state-changing candidate journey\n");
  process.stdout.write("  --plan <path>             Override the checked-in journey plan\n");
  process.stdout.write("  --output <path>           Receipt output (default zero-to-map-receipt.json)\n");
  process.stdout.write("  --mcp-url <url>           Server /mcp URL consumed through honua-mcp-proxy\n");
  process.stdout.write("  --target <name>           local-docker (default) or aws-ecs\n");
  process.stdout.write("  --provision-receipt <p>   Required pre-teardown binding for aws-ecs\n");
  process.stdout.write("  --honua-command <path>    Control-plane CLI executable (default honua)\n");
  process.stdout.write("  --var name=value          Supply a journey variable; repeat as needed\n");
  process.stdout.write("  --var-env name=ENV_NAME   Read a secret variable from the child environment\n");
  process.stdout.write("  --checkpoint <path>       Persist the secret-free Console pause/resume boundary\n");
  process.stdout.write("  --checkpoint-digest <sha> Externally carried digest required to claim a resume\n");
  process.stdout.write("  --console-receipt <path>  Import the separately captured Console gate receipt\n");
}

class HelpRequested extends Error {}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runZeroToMapCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      if (error instanceof HelpRequested) {
        process.exitCode = 0;
        return;
      }
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
