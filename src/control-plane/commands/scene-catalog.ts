/** Scene catalog and asynchronous job commands over the shared command runtime. */
import type { QueryMethod } from "../../core/types.js";
import { type HonuaSceneResolution, resolveScene } from "../../scene-workspace/scene-discovery.js";
import type { HonuaControlPlaneJob, HonuaControlPlaneResult, HonuaEntityValidators } from "../types.js";
import { HonuaCommandError } from "./errors.js";
import type { HonuaAnyCommand, HonuaCommand, HonuaCommandContext, HonuaCommandResourceRef } from "./types.js";

/** Input for {@link sceneJobStatusCommand}. */
export interface SceneJobStatusInput {
  readonly jobId: string;
}

/** `GET /scenes/jobs/{jobId}` — inspect an async `202` scene import/generation job. */
export const sceneJobStatusCommand: HonuaCommand<SceneJobStatusInput, HonuaControlPlaneJob> = {
  id: "scene.job.status",
  title: "Inspect a scene job",
  description: "Read the status, progress, and resulting asset reference of a scene job.",
  mode: "read",
  resourceKind: "scene-import-job",
  inputSchema: {
    type: "object",
    description: "Identifies the scene job to inspect.",
    properties: {
      jobId: { type: "string", minLength: 1, description: "Scene job identifier." },
    },
    required: ["jobId"],
    additionalProperties: false,
  },
  plan(context) {
    return {
      method: "GET",
      path: `/scenes/jobs/${encodeURIComponent(context.input.jobId)}`,
      summary: `Inspect scene job ${context.input.jobId}`,
      resourceRef: { type: "scene-import-job", id: context.input.jobId },
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<HonuaControlPlaneJob & { jobId: string }>({
      method: "GET",
      path: `/scenes/jobs/${encodeURIComponent(context.input.jobId)}`,
      ...context.requestOptions(),
    });
    const payload = unwrapControlPlaneResult(result, this.id, context);
    const job: HonuaControlPlaneJob = { ...payload, id: payload.jobId };
    return {
      output: job,
      resourceRef: {
        type: "scene-import-job",
        id: job.id ?? context.input.jobId,
        ...(job.links?.self ? { href: job.links.self } : {}),
      },
      ...(validatorsOf(job) ? { validators: validatorsOf(job) } : {}),
      ...(job.problem ? { problem: job.problem } : {}),
    };
  },
};

/** Input identifying one scene dataset. */
export interface SceneIdCommandInput {
  readonly sceneId: string;
}

/** Credential-free scene endpoint resolution output. */
export type SceneResolveCommandOutput = HonuaSceneResolution;

/** `GET /scenes/{sceneId}/resolve` — resolve credential-free scene endpoints and POST session affordance. */
export const sceneResolveCommand: HonuaCommand<SceneIdCommandInput, SceneResolveCommandOutput> = {
  id: "scene.resolve",
  title: "Resolve scene endpoints",
  description: "Resolve a scene's credential-free renderer endpoints and access-envelope POST affordance.",
  mode: "read",
  resourceKind: "scene",
  inputSchema: {
    type: "object",
    description: "Identifies the scene to resolve.",
    properties: {
      sceneId: { type: "string", minLength: 1, description: "Scene identifier." },
    },
    required: ["sceneId"],
    additionalProperties: false,
  },
  plan(context) {
    return {
      method: "GET",
      path: `/api/scenes/${encodeURIComponent(context.input.sceneId)}/resolve`,
      summary: `Resolve endpoints for scene ${context.input.sceneId}`,
      resourceRef: sceneRef(context.input.sceneId),
    };
  },
  async execute(context) {
    const resolved = await resolveScene(async <T>(method: QueryMethod, path: string) => {
      const result = await context.controlPlane.raw<T>({ method, path, ...context.requestOptions() });
      return unwrapControlPlaneResult(result, this.id, context);
    }, context.input.sceneId);
    return {
      output: resolved,
      resourceRef: sceneRef(resolved.sceneId ?? context.input.sceneId),
    };
  },
};

/** Output returned after retiring/deactivating a scene. */
export interface SceneRetireOutput {
  readonly sceneId: string;
  readonly retired: boolean;
}

/** `DELETE /scenes/{sceneId}` — retire/deactivate a scene dataset. */
export const sceneRetireCommand: HonuaCommand<SceneIdCommandInput, SceneRetireOutput> = {
  id: "scene.retire",
  title: "Retire a scene",
  description: "Deactivate or retire a hosted scene dataset.",
  mode: "action",
  resourceKind: "scene",
  inputSchema: {
    type: "object",
    description: "Identifies the scene to retire.",
    properties: {
      sceneId: { type: "string", minLength: 1, description: "Scene dataset UUID." },
    },
    required: ["sceneId"],
    additionalProperties: false,
  },
  validate(input) {
    return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.sceneId)
      ? []
      : [{ path: "sceneId", message: "Provide the dataset UUID returned by the server." }];
  },
  plan(context) {
    return {
      method: "DELETE",
      path: `/scenes/${encodeURIComponent(context.input.sceneId)}`,
      summary: `Retire scene ${context.input.sceneId}`,
      resourceRef: sceneRef(context.input.sceneId),
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<unknown>({
      method: "DELETE",
      path: `/scenes/${encodeURIComponent(context.input.sceneId)}`,
      ...context.requestOptions(),
    });
    unwrapControlPlaneResult(result, this.id, context);
    return {
      output: { sceneId: context.input.sceneId, retired: true },
      resourceRef: sceneRef(context.input.sceneId),
    };
  },
};

// ---------------------------------------------------------------------------
// Async 202 polling
// ---------------------------------------------------------------------------

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "completed", "failed", "cancelled", "canceled"]);
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_TIMEOUT_MS = 60_000;

/** Options for {@link pollSceneJobUntilTerminal}. */
export interface PollSceneJobOptions {
  readonly fetchStatus: (signal?: AbortSignal) => Promise<HonuaControlPlaneJob>;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (job: HonuaControlPlaneJob) => void;
}

/** Poll a `202 Accepted` scene job until it reaches a terminal status or deadline. */
export async function pollSceneJobUntilTerminal(options: PollSceneJobOptions): Promise<HonuaControlPlaneJob> {
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);

  for (;;) {
    options.signal?.throwIfAborted();
    const job = await options.fetchStatus(options.signal);
    options.onProgress?.(job);
    const status = String(job.status ?? "").toLowerCase();
    if (TERMINAL_JOB_STATUSES.has(status)) {
      return job;
    }
    if (Date.now() >= deadline) {
      throw new HonuaCommandError("transport", "scene.job.status", `Timed out waiting for scene job ${job.id}.`, {
        correlationId: "poll-timeout",
      });
    }
    await sleepWithSignal(intervalMs, options.signal);
  }
}

/** Every scene workflow command id, in registry order. */
export const HONUA_SCENE_COMMAND_IDS = ["scene.job.status", "scene.resolve", "scene.retire"] as const;

/** One of {@link HONUA_SCENE_COMMAND_IDS}. */
export type HonuaSceneCommandId = (typeof HONUA_SCENE_COMMAND_IDS)[number];

/** Shared scene command registry dispatched through {@link HonuaCommandRuntime}. */
export const HONUA_SCENE_COMMANDS = {
  "scene.job.status": sceneJobStatusCommand,
  "scene.resolve": sceneResolveCommand,
  "scene.retire": sceneRetireCommand,
} as const satisfies Record<HonuaSceneCommandId, HonuaAnyCommand>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sceneRef(sceneId: string): HonuaCommandResourceRef {
  return { type: "scene", id: sceneId };
}

function unwrapControlPlaneResult<T>(
  result: HonuaControlPlaneResult<T>,
  commandId: string,
  context: HonuaCommandContext<unknown>,
): T {
  if (result.supported) return result.value;
  throw new HonuaCommandError("transport", commandId, result.reason, {
    correlationId: context.correlationId,
    idempotencyKey: context.idempotencyKey,
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
    ...(result.problem ? { problem: result.problem } : {}),
  });
}

function validatorsOf(value: HonuaEntityValidators | undefined): HonuaEntityValidators | undefined {
  if (!value) return undefined;
  const { etag, lastModified } = value;
  if (!etag && !lastModified) return undefined;
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
