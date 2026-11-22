/**
 * `honua scene` — terminal-first scene upload, import, job status/wait/cancel,
 * catalog discovery, resolution, and retirement commands.
 *
 * Wraps the shared control-plane scene commands (`src/control-plane/commands/scene-catalog.ts`)
 * and public scene discovery (`src/scene-workspace/scene-discovery.ts`) so CLI,
 * MCP, Studio, and direct JS produce identical receipts and audit keys without
 * ever persisting credentials or signed URLs in resume files or logs.
 *
 * @packageDocumentation
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type HonuaCommandInvocation,
  type HonuaCommandStatus,
  type SceneAssetSourceFormat,
  type SceneIdCommandInput,
  type SceneImportSubmitInput,
  type SceneJobStatusInput,
  type SceneUploadCreateInput,
  type SceneUploadSessionView,
  pendingSceneUploadChunks,
  pollSceneJobUntilTerminal,
  sceneImportSubmitCommand,
  sceneJobCancelCommand,
  sceneJobStatusCommand,
  sceneResolveCommand,
  sceneRetireCommand,
  sceneUploadCreateCommand,
  validateSceneUploadResumeState,
} from "../../control-plane/index.js";
import { getScene, listScenes } from "../../scene-workspace/scene-discovery.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getNumber, getString } from "../args.js";
import { createClient, createCommandRuntime } from "../client.js";
import { cliCommandInvocation, runCommandVerb } from "../command-adapter.js";
import type { CommandContext } from "../command.js";
import { printLine, renderDetail, renderJson, renderTable } from "../output.js";

const SCENE_USAGE = `Usage:
  honua scene list [--json]
  honua scene get <sceneId> [--json]
  honua scene resolve <sceneId> [--json]
  honua scene upload <file> --format <3d-tiles|gltf|glb|citygml|las|laz|copc> [--scene-id <id>] [--resume <file>] [--chunk-bytes <n>] [--dry-run] [--yes] [--json]
  honua scene import --format <format> (--upload-id <id> | --source-url <url>) [--scene-id <id>] [--title <text>] [--wait] [--timeout-ms <ms>] [--dry-run] [--yes] [--json]
  honua scene status <jobId> [--wait] [--timeout-ms <ms>] [--json]
  honua scene cancel <jobId> [--dry-run] [--yes] [--json]
  honua scene retire <sceneId> [--if-match <etag>] [--dry-run] [--yes] [--json]`;

const VALID_FORMATS = new Set<SceneAssetSourceFormat>(["3d-tiles", "gltf", "glb", "citygml", "las", "laz", "copc"]);
const DEFAULT_CHUNK_BYTES = 5 * 1024 * 1024;

/** Parse `honua scene upload` flags into shared command input + invocation. */
export function sceneUploadInvocation(parsed: ParsedArgs): {
  readonly filePath: string;
  readonly resumeFile?: string;
  readonly input: SceneUploadCreateInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const filePath = parsed.positionals[0];
  const format = requireSceneFormat(getString(parsed, "format"));
  if (!filePath) throw new ArgError(SCENE_USAGE);
  const stat = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const chunkBytes = getNumber(parsed, "chunk-bytes") ?? DEFAULT_CHUNK_BYTES;
  const sceneId = getString(parsed, "scene-id");
  const workspaceId = getString(parsed, "workspace");
  const resumeFile = getString(parsed, "resume");
  return {
    filePath,
    ...(resumeFile ? { resumeFile } : {}),
    input: {
      fileName: path.basename(filePath),
      format,
      totalBytes: stat.size,
      sha256,
      chunkBytes,
      ...(sceneId ? { sceneId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    },
    invocation: cliCommandInvocation(parsed),
  };
}

/** Parse `honua scene import` flags into shared command input + invocation. */
export function sceneImportInvocation(parsed: ParsedArgs): {
  readonly input: SceneImportSubmitInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const format = requireSceneFormat(getString(parsed, "format"));
  const uploadId = getString(parsed, "upload-id");
  const sourceUrl = getString(parsed, "source-url");
  const sceneId = getString(parsed, "scene-id");
  const title = getString(parsed, "title");
  const description = getString(parsed, "description");
  const workspaceId = getString(parsed, "workspace");
  const requiresAuth = parsed.flags["requires-auth"] === true ? true : undefined;
  return {
    input: {
      format,
      ...(uploadId ? { uploadId } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(sceneId ? { sceneId } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(requiresAuth !== undefined ? { requiresAuth } : {}),
    },
    invocation: cliCommandInvocation(parsed),
  };
}

/** Parse `honua scene status|cancel` flags into shared command input + invocation. */
export function sceneJobInvocation(parsed: ParsedArgs): {
  readonly input: SceneJobStatusInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const jobId = parsed.positionals[0];
  if (!jobId) throw new ArgError(SCENE_USAGE);
  return {
    input: { jobId },
    invocation: cliCommandInvocation(parsed),
  };
}

/** Parse `honua scene resolve|retire` flags into shared command input + invocation. */
export function sceneIdInvocation(parsed: ParsedArgs): {
  readonly input: SceneIdCommandInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const sceneId = parsed.positionals[0];
  if (!sceneId) throw new ArgError(SCENE_USAGE);
  return {
    input: { sceneId },
    invocation: cliCommandInvocation(parsed),
  };
}

/** Main entrypoint for `honua scene <subcommand>`. */
export async function sceneCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };

  switch (sub) {
    case "list":
      await handleSceneList(rest, ctx);
      return;
    case "get":
      await handleSceneGet(rest, ctx);
      return;
    case "resolve":
      await handleSceneResolve(rest, ctx);
      return;
    case "upload":
      await handleSceneUpload(rest, ctx);
      return;
    case "import":
      await handleSceneImport(rest, ctx);
      return;
    case "status":
      await handleSceneStatus(rest, ctx);
      return;
    case "cancel":
      await handleSceneCancel(rest, ctx);
      return;
    case "retire":
      await handleSceneRetire(rest, ctx);
      return;
    default:
      throw new ArgError(SCENE_USAGE);
  }
}

async function handleSceneList(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const client = createClient(ctx);
  const scenes = await listScenes((method, p, init, signal) => client.pipelineRequestJson(method, p, init, signal));
  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ scenes }));
    return;
  }
  const rows = scenes.map((scene) => ({
    id: scene.sceneId,
    title: scene.title ?? scene.name ?? "",
    format: scene.servingFormat ?? scene.capabilities.join(","),
    auth: scene.auth?.requiresAuthentication ? "protected" : "public",
  }));
  printLine(
    renderTable(rows, [
      { key: "id", header: "ID" },
      { key: "title", header: "Title" },
      { key: "format", header: "Format" },
      { key: "auth", header: "Auth" },
    ]),
  );
}

async function handleSceneGet(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sceneId = parsed.positionals[0];
  if (!sceneId) throw new ArgError(SCENE_USAGE);
  const client = createClient(ctx);
  const scene = await getScene(
    (method, p, init, signal) => client.pipelineRequestJson(method, p, init, signal),
    sceneId,
  );
  if (getBoolean(parsed, "json")) {
    printLine(renderJson(scene));
    return;
  }
  printLine(
    renderDetail(
      {
        sceneId: scene.sceneId,
        title: scene.title ?? scene.name ?? "(untitled)",
        tilesetUrl: scene.tilesetUrl ?? "(none)",
        auth: scene.auth?.requiresAuthentication ? "protected" : "public",
        capabilities: scene.capabilities.join(", ") || "(none)",
      },
      { title: "Scene metadata" },
    ),
  );
}

async function handleSceneResolve(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = sceneIdInvocation(parsed);
  await runCommandVerb({
    command: sceneResolveCommand,
    input,
    invocation,
    parsed,
    ctx,
    heading: statusHeading("Scene resolved", "Scene resolve"),
    detail: (receipt) => ({
      scene: receipt.output?.sceneId ?? input.sceneId,
      tilesetUrl: receipt.output?.tilesetUrl ?? "(none)",
      copcUrl: receipt.output?.copcUrl ?? "(none)",
      accessAffordance: receipt.output?.accessAffordance ? "POST" : "none",
    }),
  });
}

async function handleSceneUpload(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { resumeFile, input, invocation } = sceneUploadInvocation(parsed);
  if (resumeFile && fs.existsSync(resumeFile)) {
    const saved = JSON.parse(fs.readFileSync(resumeFile, "utf8")) as SceneUploadSessionView;
    validateSceneUploadResumeState(saved, {
      sha256: input.sha256,
      totalBytes: input.totalBytes,
      ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    });
  }
  if (!invocation.dryRun && !getBoolean(parsed, "yes")) {
    throw new ArgError(
      "honua scene upload creates a durable upload session. Re-run with --yes, or preview with --dry-run.",
    );
  }
  const runtime = createCommandRuntime(ctx);
  const receipt = await runtime.execute(sceneUploadCreateCommand, input, invocation);
  if (resumeFile && receipt.status === "ok" && receipt.output) {
    // Persist strictly non-secret upload metadata only.
    fs.writeFileSync(resumeFile, JSON.stringify(receipt.output, null, 2), "utf8");
  }
  const pending = receipt.output ? pendingSceneUploadChunks(receipt.output) : [];
  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ ...receipt, pendingChunks: pending }));
    return;
  }
  printLine(
    renderDetail(
      {
        command: receipt.commandId,
        status: receipt.status,
        uploadId: receipt.output?.uploadId ?? "(dry-run)",
        pendingChunks: String(pending.length),
        correlationId: receipt.correlationId,
        auditKey: receipt.auditKey,
      },
      { title: statusHeading("Scene upload session ready", "Scene upload")(receipt.status) },
    ),
  );
}

async function handleSceneImport(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = sceneImportInvocation(parsed);
  if (!invocation.dryRun && !getBoolean(parsed, "yes")) {
    throw new ArgError("honua scene import mutates state. Re-run with --yes, or preview with --dry-run.");
  }
  const runtime = createCommandRuntime(ctx);
  const receipt = await runtime.execute(sceneImportSubmitCommand, input, invocation);
  const waitForCompletion = getBoolean(parsed, "wait");
  let finalJob: unknown;
  if (waitForCompletion && receipt.status === "ok" && receipt.output?.jobId) {
    const jobId = receipt.output.jobId;
    finalJob = await pollSceneJobUntilTerminal({
      timeoutMs: getNumber(parsed, "timeout-ms"),
      fetchStatus: async () => {
        const pollReceipt = await runtime.execute(sceneJobStatusCommand, { jobId }, { transport: "cli" });
        if (!pollReceipt.output) throw new Error(`Scene job ${jobId} returned empty status.`);
        return pollReceipt.output;
      },
    });
  }
  if (getBoolean(parsed, "json")) {
    printLine(renderJson(finalJob ? { ...receipt, finalJob } : receipt));
    return;
  }
  printLine(
    renderDetail(
      {
        command: receipt.commandId,
        status: receipt.status,
        jobId: receipt.output?.jobId ?? "(sync)",
        sceneId: receipt.output?.sceneId ?? input.sceneId ?? "(pending)",
        correlationId: receipt.correlationId,
        auditKey: receipt.auditKey,
      },
      { title: statusHeading("Scene import submitted", "Scene import")(receipt.status) },
    ),
  );
}

async function handleSceneStatus(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = sceneJobInvocation(parsed);
  const wait = getBoolean(parsed, "wait");
  if (!wait) {
    await runCommandVerb({
      command: sceneJobStatusCommand,
      input,
      invocation,
      parsed,
      ctx,
      heading: statusHeading("Scene job status", "Scene job status"),
      detail: (receipt) => ({
        jobId: receipt.output?.id ?? input.jobId,
        jobStatus: receipt.output?.status ?? "(unknown)",
      }),
    });
    return;
  }
  const runtime = createCommandRuntime(ctx);
  const finalJob = await pollSceneJobUntilTerminal({
    timeoutMs: getNumber(parsed, "timeout-ms"),
    fetchStatus: async () => {
      const pollReceipt = await runtime.execute(sceneJobStatusCommand, input, invocation);
      if (!pollReceipt.output) throw new Error(`Scene job ${input.jobId} returned empty status.`);
      return pollReceipt.output;
    },
  });
  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ job: finalJob }));
    return;
  }
  printLine(
    renderDetail(
      {
        jobId: finalJob.id,
        jobStatus: finalJob.status,
      },
      { title: "Scene job completed" },
    ),
  );
}

async function handleSceneCancel(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = sceneJobInvocation(parsed);
  await runCommandVerb({
    command: sceneJobCancelCommand,
    input,
    invocation,
    parsed,
    ctx,
    heading: statusHeading("Scene job cancelled", "Scene job cancel"),
    confirm: "honua scene cancel stops a running scene job. Re-run with --yes, or preview with --dry-run.",
    detail: (receipt) => ({
      jobId: receipt.output?.id ?? input.jobId,
      jobStatus: receipt.output?.status ?? "(unknown)",
    }),
  });
}

async function handleSceneRetire(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = sceneIdInvocation(parsed);
  await runCommandVerb({
    command: sceneRetireCommand,
    input,
    invocation,
    parsed,
    ctx,
    heading: statusHeading("Scene retired", "Scene retire"),
    confirm: "honua scene retire deactivates a published scene. Re-run with --yes, or preview with --dry-run.",
    detail: (receipt) => ({
      sceneId: receipt.output?.sceneId ?? input.sceneId,
      retired: receipt.output?.retired ? "yes" : "no",
    }),
  });
}

function requireSceneFormat(raw: string | undefined): SceneAssetSourceFormat {
  if (!raw || !VALID_FORMATS.has(raw as SceneAssetSourceFormat)) {
    throw new ArgError(`--format must be one of: ${[...VALID_FORMATS].join(", ")}.`);
  }
  return raw as SceneAssetSourceFormat;
}

function statusHeading(okTitle: string, base: string): (status: HonuaCommandStatus) => string {
  return (status) => {
    switch (status) {
      case "ok":
        return okTitle;
      case "dry-run":
        return `${base} (dry run)`;
      case "denied":
        return `${base} denied`;
      case "cancelled":
        return `${base} cancelled`;
      default:
        return `${base} failed`;
    }
  };
}
