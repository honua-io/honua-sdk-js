/**
 * Terminal-first scene workflow commands over the shared control-plane command
 * layer: durable resumable upload, archive/model/point-cloud import, async
 * `202` job status polling & cancellation, scene list/get/resolve, and scene
 * retirement.
 *
 * Every command uses a closed input schema (`additionalProperties: false`),
 * produces deterministic {@link HonuaCommandReceipt} audit keys across CLI,
 * SDK, MCP, and Studio transports, and never serializes credentials or signed
 * URLs into resume state or receipts.
 *
 * @experimental
 * @module
 */

import type { HonuaControlPlaneJob, HonuaControlPlaneResult, HonuaEntityValidators } from "../types.js";
import { HonuaCommandError } from "./errors.js";
import type { HonuaAnyCommand, HonuaCommand, HonuaCommandContext, HonuaCommandResourceRef } from "./types.js";

/** Supported scene source asset formats for terminal upload and import. */
export type SceneAssetSourceFormat = "3d-tiles" | "gltf" | "glb" | "citygml" | "las" | "laz" | "copc";

// ---------------------------------------------------------------------------
// scene.upload.create
// ---------------------------------------------------------------------------

/** Input for {@link sceneUploadCreateCommand}. */
export interface SceneUploadCreateInput {
  readonly fileName: string;
  readonly format: SceneAssetSourceFormat;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly chunkBytes?: number;
  readonly sceneId?: string;
  readonly workspaceId?: string;
}

/** Credential-free upload session metadata safe to store in a resume file. */
export interface SceneUploadSessionView {
  readonly uploadId: string;
  readonly status: "open" | "completed" | "aborted";
  readonly sceneId?: string;
  readonly fileName: string;
  readonly format: SceneAssetSourceFormat;
  readonly totalBytes: number;
  readonly chunkBytes: number;
  readonly sha256: string;
  readonly acknowledgedChunks: readonly number[];
  readonly links?: { readonly self?: string };
}

/** `POST /scenes/uploads` — create or reattach a durable resumable upload session. */
export const sceneUploadCreateCommand: HonuaCommand<SceneUploadCreateInput, SceneUploadSessionView> = {
  id: "scene.upload.create",
  title: "Create a scene asset upload session",
  description: "Open or reattach a durable chunked upload session for a 3D Tiles archive, model, or point cloud.",
  mode: "action",
  resourceKind: "scene-upload",
  inputSchema: {
    type: "object",
    description: "Describes the local asset to upload.",
    properties: {
      fileName: { type: "string", minLength: 1, description: "Base filename of the uploaded asset." },
      format: {
        type: "string",
        enum: ["3d-tiles", "gltf", "glb", "citygml", "las", "laz", "copc"],
        description: "Source asset format.",
      },
      totalBytes: { type: "integer", minimum: 1, description: "Total byte length of the asset." },
      sha256: {
        type: "string",
        minLength: 64,
        maxLength: 64,
        description: "Lowercase hex SHA-256 digest of the asset.",
      },
      chunkBytes: { type: "integer", minimum: 1024, description: "Chunk size in bytes." },
      sceneId: { type: "string", minLength: 1, description: "Target scene identifier." },
      workspaceId: { type: "string", minLength: 1, description: "Owning workspace." },
    },
    required: ["fileName", "format", "totalBytes", "sha256"],
    additionalProperties: false,
  },
  validate(input) {
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) {
      return [{ path: "sha256", message: "sha256 must be a 64-character hex digest" }];
    }
    return [];
  },
  plan(context) {
    return {
      method: "POST",
      path: "/scenes/uploads",
      summary: `Create ${context.input.format} upload session for ${context.input.fileName} (${context.input.totalBytes} bytes)`,
      resourceRef: {
        type: "scene-upload",
        ...(context.input.workspaceId ? { workspaceId: context.input.workspaceId } : {}),
      },
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<SceneUploadSessionView>({
      method: "POST",
      path: "/scenes/uploads",
      body: context.input,
      ...context.requestOptions(),
    });
    const session = unwrapControlPlaneResult(result, this.id, context);
    return {
      output: sanitizeUploadSession(session),
      resourceRef: {
        type: "scene-upload",
        ...(session.uploadId ? { id: session.uploadId } : {}),
        ...(context.input.workspaceId ? { workspaceId: context.input.workspaceId } : {}),
        ...(session.links?.self ? { href: session.links.self } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// scene.import.submit
// ---------------------------------------------------------------------------

/** Input for {@link sceneImportSubmitCommand}. */
export interface SceneImportSubmitInput {
  readonly format: SceneAssetSourceFormat;
  readonly uploadId?: string;
  readonly sourceUrl?: string;
  readonly sceneId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly workspaceId?: string;
  readonly requiresAuth?: boolean;
}

/** Response returned when submitting a scene import (synchronous `201` or async `202` job). */
export interface SceneImportSubmissionOutput {
  readonly accepted: boolean;
  readonly status: string;
  readonly jobId?: string;
  readonly sceneId?: string;
  readonly tilesetUrl?: string;
  readonly progressPercent?: number;
  readonly links?: { readonly self?: string; readonly job?: string };
  readonly etag?: string;
  readonly lastModified?: string;
}

/** `POST /scenes/imports` — submit a 3D Tiles archive, model, CityGML, or point-cloud import. */
export const sceneImportSubmitCommand: HonuaCommand<SceneImportSubmitInput, SceneImportSubmissionOutput> = {
  id: "scene.import.submit",
  title: "Submit a scene import or publish job",
  description: "Publish an uploaded 3D Tiles archive or submit a model, CityGML, or point-cloud generation job.",
  mode: "action",
  resourceKind: "scene-import-job",
  inputSchema: {
    type: "object",
    description: "Identifies the uploaded or remote scene asset to import.",
    properties: {
      format: {
        type: "string",
        enum: ["3d-tiles", "gltf", "glb", "citygml", "las", "laz", "copc"],
        description: "Source asset format.",
      },
      uploadId: { type: "string", minLength: 1, description: "Completed durable upload session identifier." },
      sourceUrl: { type: "string", minLength: 1, description: "Source URL when importing from a remote archive." },
      sceneId: { type: "string", minLength: 1, description: "Desired target scene identifier." },
      title: { type: "string", minLength: 1, description: "Display title for the published scene." },
      description: { type: "string", description: "Optional scene description." },
      workspaceId: { type: "string", minLength: 1, description: "Owning workspace." },
      requiresAuth: { type: "boolean", description: "Whether the published scene requires authenticated access." },
    },
    required: ["format"],
    additionalProperties: false,
  },
  validate(input) {
    if (!input.uploadId && !input.sourceUrl) {
      return [{ path: "uploadId", message: "provide either `uploadId` or `sourceUrl`" }];
    }
    if (input.uploadId && input.sourceUrl) {
      return [{ path: "", message: "provide only one of `uploadId` or `sourceUrl`" }];
    }
    return [];
  },
  plan(context) {
    const target = context.input.sceneId ? ` as scene ${context.input.sceneId}` : "";
    return {
      method: "POST",
      path: "/scenes/imports",
      summary: `Submit ${context.input.format} scene import${target}`,
      resourceRef: {
        type: "scene-import-job",
        ...(context.input.workspaceId ? { workspaceId: context.input.workspaceId } : {}),
      },
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<SceneImportSubmissionOutput>({
      method: "POST",
      path: "/scenes/imports",
      body: context.input,
      ...context.requestOptions(),
    });
    const output = unwrapControlPlaneResult(result, this.id, context);
    const id = output.jobId ?? output.sceneId;
    const href = output.links?.job ?? output.links?.self;
    return {
      output,
      resourceRef: {
        type: output.jobId ? "scene-import-job" : "scene",
        ...(id ? { id } : {}),
        ...(context.input.workspaceId ? { workspaceId: context.input.workspaceId } : {}),
        ...(href ? { href } : {}),
      },
      ...(validatorsOf(output) ? { validators: validatorsOf(output) } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// scene.job.status & scene.job.cancel
// ---------------------------------------------------------------------------

/** Input for {@link sceneJobStatusCommand}. */
export interface SceneJobStatusInput {
  readonly jobId: string;
}

/** `GET /scenes/jobs/{jobId}` — inspect an async `202` scene import/generation job. */
export const sceneJobStatusCommand: HonuaCommand<SceneJobStatusInput, HonuaControlPlaneJob> = {
  id: "scene.job.status",
  title: "Inspect a scene job",
  description: "Read the durable status, progress, and resulting asset reference of a scene job.",
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
    const result = await context.controlPlane.raw<HonuaControlPlaneJob>({
      method: "GET",
      path: `/scenes/jobs/${encodeURIComponent(context.input.jobId)}`,
      ...context.requestOptions(),
    });
    const job = unwrapControlPlaneResult(result, this.id, context);
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

/** `POST /scenes/jobs/{jobId}/cancel` — cancel an active scene job. */
export const sceneJobCancelCommand: HonuaCommand<SceneJobStatusInput, HonuaControlPlaneJob> = {
  id: "scene.job.cancel",
  title: "Cancel a scene job",
  description: "Request cancellation of an active scene import or generation job.",
  mode: "action",
  resourceKind: "scene-import-job",
  inputSchema: {
    type: "object",
    description: "Identifies the scene job to cancel.",
    properties: {
      jobId: { type: "string", minLength: 1, description: "Scene job identifier." },
    },
    required: ["jobId"],
    additionalProperties: false,
  },
  plan(context) {
    return {
      method: "POST",
      path: `/scenes/jobs/${encodeURIComponent(context.input.jobId)}/cancel`,
      summary: `Cancel scene job ${context.input.jobId}`,
      resourceRef: { type: "scene-import-job", id: context.input.jobId },
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<HonuaControlPlaneJob>({
      method: "POST",
      path: `/scenes/jobs/${encodeURIComponent(context.input.jobId)}/cancel`,
      ...context.requestOptions(),
    });
    const job = unwrapControlPlaneResult(result, this.id, context);
    return {
      output: job,
      resourceRef: { type: "scene-import-job", id: job.id ?? context.input.jobId },
    };
  },
};

// ---------------------------------------------------------------------------
// scene.resolve & scene.retire
// ---------------------------------------------------------------------------

/** Input identifying one scene dataset. */
export interface SceneIdCommandInput {
  readonly sceneId: string;
}

/** Credential-free scene endpoint resolution output. */
export interface SceneResolveCommandOutput {
  readonly sceneId: string;
  readonly tilesetUrl?: string;
  readonly copcUrl?: string;
  readonly terrainUrl?: string;
  readonly endpoints: readonly Readonly<Record<string, unknown>>[];
  readonly capabilities: readonly string[];
  readonly auth: Readonly<Record<string, unknown>>;
  readonly accessAffordance?: Readonly<Record<string, unknown>>;
}

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
      path: `/scenes/${encodeURIComponent(context.input.sceneId)}/resolve`,
      summary: `Resolve endpoints for scene ${context.input.sceneId}`,
      resourceRef: sceneRef(context.input.sceneId),
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<SceneResolveCommandOutput>({
      method: "GET",
      path: `/scenes/${encodeURIComponent(context.input.sceneId)}/resolve`,
      ...context.requestOptions(),
    });
    const resolved = unwrapControlPlaneResult(result, this.id, context);
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
      sceneId: { type: "string", minLength: 1, description: "Scene identifier." },
    },
    required: ["sceneId"],
    additionalProperties: false,
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
// Async 202 polling & non-secret resume helpers
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

/** Validate a non-secret resume checkpoint against local file metadata before resuming upload. */
export function validateSceneUploadResumeState(
  saved: SceneUploadSessionView,
  current: { readonly sha256: string; readonly totalBytes: number; readonly sceneId?: string },
): void {
  if (saved.sha256.toLowerCase() !== current.sha256.toLowerCase()) {
    throw new Error("Resume conflict: local asset SHA-256 does not match the saved upload session.");
  }
  if (saved.totalBytes !== current.totalBytes) {
    throw new Error("Resume conflict: local asset size does not match the saved upload session.");
  }
  if (current.sceneId && saved.sceneId && saved.sceneId !== current.sceneId) {
    throw new Error(`Resume conflict: target sceneId "${current.sceneId}" does not match saved "${saved.sceneId}".`);
  }
}

/** Compute remaining unacknowledged chunk indices for a resumable scene upload. */
export function pendingSceneUploadChunks(session: SceneUploadSessionView): number[] {
  const totalChunks = Math.max(1, Math.ceil(session.totalBytes / Math.max(1, session.chunkBytes)));
  const acked = new Set(session.acknowledgedChunks);
  const pending: number[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    if (!acked.has(index)) pending.push(index);
  }
  return pending;
}

/** Every scene workflow command id, in registry order. */
export const HONUA_SCENE_COMMAND_IDS = [
  "scene.upload.create",
  "scene.import.submit",
  "scene.job.status",
  "scene.job.cancel",
  "scene.resolve",
  "scene.retire",
] as const;

/** One of {@link HONUA_SCENE_COMMAND_IDS}. */
export type HonuaSceneCommandId = (typeof HONUA_SCENE_COMMAND_IDS)[number];

/** Shared scene command registry dispatched through {@link HonuaCommandRuntime}. */
export const HONUA_SCENE_COMMANDS = {
  "scene.upload.create": sceneUploadCreateCommand,
  "scene.import.submit": sceneImportSubmitCommand,
  "scene.job.status": sceneJobStatusCommand,
  "scene.job.cancel": sceneJobCancelCommand,
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

function sanitizeUploadSession(session: SceneUploadSessionView): SceneUploadSessionView {
  return {
    uploadId: session.uploadId,
    status: session.status,
    ...(session.sceneId ? { sceneId: session.sceneId } : {}),
    fileName: session.fileName,
    format: session.format,
    totalBytes: session.totalBytes,
    chunkBytes: session.chunkBytes,
    sha256: session.sha256,
    acknowledgedChunks: [...(session.acknowledgedChunks ?? [])],
    ...(session.links?.self ? { links: { self: session.links.self } } : {}),
  };
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
