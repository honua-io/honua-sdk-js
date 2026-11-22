import { openAsBlob } from "node:fs";
import path from "node:path";
import {
  type HonuaCommand,
  type HonuaCommandInvocation,
  type HonuaCommandStatus,
  type HonuaControlPlaneJob,
  type SceneIdCommandInput,
  type SceneJobStatusInput,
  pollSceneJobUntilTerminal,
  sceneJobStatusCommand,
  sceneResolveCommand,
  sceneRetireCommand,
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
  honua scene import <file> --format <3d-tiles|gltf|glb|obj> [--longitude <degrees> --latitude <degrees>] [--scene-id <id>] [--async [--wait]] [--timeout-ms <ms>] [--dry-run] [--yes] [--json]
  honua scene status <jobId> [--wait] [--timeout-ms <ms>] [--json]
  honua scene retire <datasetId> [--dry-run] [--yes] [--json]`;

/** Parse `honua scene status` flags into shared command input + invocation. */
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
      throw new ArgError("Use honua scene import <file> to submit an archive or model.");
    case "import":
      await handleSceneImport(rest, ctx);
      return;
    case "status":
      await handleSceneStatus(rest, ctx);
      return;
    case "cancel":
      throw new ArgError("This server API does not support cancelling scene jobs.");
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

async function handleSceneImport(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const filePath = parsed.positionals[0];
  if (!filePath) throw new ArgError(SCENE_USAGE);
  const format = getString(parsed, "format");
  if (format !== "3d-tiles" && format !== "gltf" && format !== "glb" && format !== "obj") {
    throw new ArgError("--format must be one of 3d-tiles, gltf, glb, or obj.");
  }
  if (["upload-id", "source-url", "workspace", "resume", "chunk-bytes"].some((flag) => flag in parsed.flags)) {
    throw new ArgError("Provide a local file and remove upload, remote source, or workspace flags.");
  }
  const archive = format === "3d-tiles";
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  const supportedExtensions = archive ? [".zip", ".3tz"] : [`.${format}`];
  if (!supportedExtensions.includes(extension)) {
    throw new ArgError(`File extension must be ${supportedExtensions.join(" or ")}.`);
  }
  const fields: Record<string, string> = {};
  if (getBoolean(parsed, "async")) fields.async = "true";
  for (const [flag, field] of [
    ["scene-id", "sceneId"],
    ["title", "displayName"],
    ["description", "description"],
  ] as const) {
    const value = getString(parsed, flag);
    if (value !== undefined) fields[field] = value;
  }
  if (getBoolean(parsed, "requires-auth")) fields.requiresAuth = "true";
  if (archive && ("longitude" in parsed.flags || "latitude" in parsed.flags)) {
    throw new ArgError("Longitude and latitude apply to models. A tiles archive supplies its own placement.");
  }
  if (!archive) {
    const longitude = getNumber(parsed, "longitude");
    const latitude = getNumber(parsed, "latitude");
    if (
      longitude === undefined ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180 ||
      latitude === undefined ||
      !Number.isFinite(latitude) ||
      Math.abs(latitude) > 90
    ) {
      throw new ArgError("Model imports require --longitude from -180 to 180 and --latitude from -90 to 90.");
    }
    fields.longitude = String(longitude);
    fields.latitude = String(latitude);
  }
  const invocation = cliCommandInvocation(parsed);
  if (!invocation.dryRun && !getBoolean(parsed, "yes")) {
    throw new ArgError("honua scene import mutates state. Re-run with --yes, or preview with --dry-run.");
  }
  const endpoint = `/api/v1/admin/scenes/ingest/${archive ? "archive" : "model"}`;
  const input = { fileName, ...fields };
  interface AcceptedJob {
    jobId: string;
    status: string;
    sceneId?: string;
    statusUrl: string;
  }
  interface CreatedScene {
    jobId?: undefined;
    status?: undefined;
    sceneId: string;
    tilesetUrl: string;
  }
  const command: HonuaCommand<typeof input, AcceptedJob | CreatedScene> = {
    id: "scene.import.submit",
    title: "Submit a scene import",
    description: "Upload a tiles archive or a georeferenced model using scene ingest.",
    mode: "action",
    resourceKind: "scene-import-job",
    inputSchema: { type: "object", additionalProperties: true },
    plan: () => ({ method: "POST", path: endpoint, summary: `Import ${fileName}` }),
    async execute(context) {
      const payload = new FormData();
      payload.append("file", await openAsBlob(filePath), fileName);
      for (const [key, value] of Object.entries(fields)) payload.append(key, value);
      const client = createClient(ctx);
      const output = await client.pipelineRequestJson<AcceptedJob | CreatedScene>(
        "POST",
        endpoint,
        {
          headers: { "X-Correlation-ID": context.correlationId, "Idempotency-Key": context.idempotencyKey },
          body: payload,
        },
        context.requestOptions().signal,
      );
      if (output?.jobId && typeof output.status === "string") {
        return { output, resourceRef: { type: "scene-import-job", id: output.jobId } };
      }
      if (output?.sceneId && "tilesetUrl" in output && typeof output.tilesetUrl === "string") {
        return { output, resourceRef: { type: "scene", id: output.sceneId } };
      }
      throw new Error("Server did not return a created scene or an accepted scene job.");
    },
  };
  const runtime = createCommandRuntime(ctx);
  const receipt = await runtime.execute(command, input, invocation);
  const waitForCompletion = getBoolean(parsed, "wait");
  let finalJob: HonuaControlPlaneJob | undefined;
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
  } else {
    printLine(
      renderDetail(
        {
          command: receipt.commandId,
          status: finalJob?.status ?? receipt.output?.status ?? receipt.status,
          ...(receipt.output?.jobId ? { jobId: receipt.output.jobId } : {}),
          sceneId: receipt.output?.sceneId ?? fields.sceneId ?? "(pending)",
          correlationId: receipt.correlationId,
          auditKey: receipt.auditKey,
        },
        {
          title: statusHeading(
            finalJob || !receipt.output?.jobId ? "Scene import completed" : "Scene import submitted",
            "Scene import",
          )(receipt.status),
        },
      ),
    );
  }
  if (finalJob && ["failed", "cancelled", "canceled"].includes(finalJob.status.toLowerCase())) {
    throw new Error(`Scene job ${finalJob.id} ended with status ${finalJob.status}.`);
  }
}

async function handleSceneStatus(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const { input, invocation } = sceneJobInvocation(parsed);
  const wait = getBoolean(parsed, "wait");
  if (!wait || invocation.dryRun) {
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

async function handleSceneRetire(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  if ("if-match" in parsed.flags) throw new ArgError("The scene retirement API does not support --if-match.");
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
