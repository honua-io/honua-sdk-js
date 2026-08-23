import { createHash } from "node:crypto";

import {
  type JourneyActionReceipt,
  type JourneyPauseSnapshot,
  type JourneyReceiptRequest,
  type JourneyResumePoint,
  type JourneyResumeState,
  type JourneyStageReceipt,
  ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA,
} from "./zero-to-map.js";

export const ZERO_TO_MAP_CHECKPOINT_SCHEMA = "honua.zero-to-map.checkpoint/v1" as const;
export const ZERO_TO_MAP_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ZeroToMapCheckpointBindings {
  readonly journeyId: string;
  readonly releaseContract: string;
  readonly target: "local-docker" | "aws-ecs";
  readonly planSha256: string;
  readonly sourceRevision: string;
  readonly mcpEndpointSha256: string;
  readonly candidateId: string;
  readonly releaseId: string;
  readonly provisionReceiptSha256?: string;
}

export interface ZeroToMapCheckpoint extends ZeroToMapCheckpointBindings {
  readonly schemaVersion: typeof ZERO_TO_MAP_CHECKPOINT_SCHEMA;
  readonly state: "paused" | "consumed";
  readonly createdAt: string;
  readonly resume: JourneyResumeState;
  readonly consoleReceiptRequest: JourneyReceiptRequest;
  readonly consumedAt?: string;
  readonly finalReceiptSha256?: string;
  readonly integrity: {
    readonly algorithm: "sha256";
    readonly digest: string;
  };
}

type CheckpointPayload = Omit<ZeroToMapCheckpoint, "integrity">;

export function createZeroToMapCheckpoint(
  bindings: ZeroToMapCheckpointBindings,
  snapshot: JourneyPauseSnapshot,
  createdAt = new Date().toISOString(),
): ZeroToMapCheckpoint {
  assertTargetBinding(bindings);
  const payload: CheckpointPayload = {
    schemaVersion: ZERO_TO_MAP_CHECKPOINT_SCHEMA,
    state: "paused",
    createdAt,
    ...bindings,
    resume: {
      startedAt: snapshot.startedAt,
      capturedVariables: snapshot.capturedVariables,
      completedStages: snapshot.completedStages,
      resumeAt: snapshot.resumeAt,
    },
    consoleReceiptRequest: snapshot.consoleReceiptRequest,
  };
  assertSecretFree(payload);
  return seal(payload);
}

export function consumeZeroToMapCheckpoint(
  checkpoint: ZeroToMapCheckpoint,
  finalReceiptSha256: string,
  consumedAt = new Date().toISOString(),
): ZeroToMapCheckpoint {
  if (checkpoint.state !== "paused") throw new Error("checkpoint has already been consumed");
  const { integrity: _integrity, ...prior } = checkpoint;
  return seal({ ...prior, state: "consumed", consumedAt, finalReceiptSha256 });
}

export function parseZeroToMapCheckpoint(value: unknown): ZeroToMapCheckpoint {
  const checkpoint = object(value, "checkpoint");
  exactKeys(
    checkpoint,
    [
      "schemaVersion",
      "state",
      "createdAt",
      "journeyId",
      "releaseContract",
      "target",
      "planSha256",
      "sourceRevision",
      "mcpEndpointSha256",
      "candidateId",
      "releaseId",
      "provisionReceiptSha256",
      "resume",
      "consoleReceiptRequest",
      "consumedAt",
      "finalReceiptSha256",
      "integrity",
    ],
    "checkpoint",
  );
  if (checkpoint.schemaVersion !== ZERO_TO_MAP_CHECKPOINT_SCHEMA) {
    throw new Error(`checkpoint.schemaVersion must be ${ZERO_TO_MAP_CHECKPOINT_SCHEMA}`);
  }
  if (checkpoint.state !== "paused" && checkpoint.state !== "consumed") {
    throw new Error("checkpoint.state must be paused or consumed");
  }
  const createdAt = timestamp(checkpoint.createdAt, "checkpoint.createdAt");
  const bindings: ZeroToMapCheckpointBindings = {
    journeyId: text(checkpoint.journeyId, "checkpoint.journeyId"),
    releaseContract: text(checkpoint.releaseContract, "checkpoint.releaseContract"),
    target: target(checkpoint.target),
    planSha256: sha256(checkpoint.planSha256, "checkpoint.planSha256"),
    sourceRevision: revision(checkpoint.sourceRevision, "checkpoint.sourceRevision"),
    mcpEndpointSha256: sha256(checkpoint.mcpEndpointSha256, "checkpoint.mcpEndpointSha256"),
    candidateId: text(checkpoint.candidateId, "checkpoint.candidateId"),
    releaseId: text(checkpoint.releaseId, "checkpoint.releaseId"),
    ...(checkpoint.provisionReceiptSha256 === undefined
      ? {}
      : {
          provisionReceiptSha256: sha256(checkpoint.provisionReceiptSha256, "checkpoint.provisionReceiptSha256"),
        }),
  };
  assertTargetBinding(bindings);
  const resume = parseResume(checkpoint.resume);
  const consoleReceiptRequest = parseReceiptRequest(checkpoint.consoleReceiptRequest);
  const integrity = object(checkpoint.integrity, "checkpoint.integrity");
  exactKeys(integrity, ["algorithm", "digest"], "checkpoint.integrity");
  if (integrity.algorithm !== "sha256") throw new Error("checkpoint.integrity.algorithm must be sha256");
  const digest = sha256(integrity.digest, "checkpoint.integrity.digest");
  const state = checkpoint.state;
  const consumedAt = checkpoint.consumedAt;
  const finalReceiptSha256 = checkpoint.finalReceiptSha256;
  if (state === "paused" && (consumedAt !== undefined || finalReceiptSha256 !== undefined)) {
    throw new Error("paused checkpoint cannot carry consumed receipt fields");
  }
  if (state === "consumed" && (consumedAt === undefined || finalReceiptSha256 === undefined)) {
    throw new Error("consumed checkpoint must carry consumedAt and finalReceiptSha256");
  }

  const payload: CheckpointPayload = {
    schemaVersion: ZERO_TO_MAP_CHECKPOINT_SCHEMA,
    state,
    createdAt,
    ...bindings,
    resume,
    consoleReceiptRequest,
    ...(state === "consumed"
      ? {
          consumedAt: timestamp(consumedAt, "checkpoint.consumedAt"),
          finalReceiptSha256: sha256(finalReceiptSha256, "checkpoint.finalReceiptSha256"),
        }
      : {}),
  };
  assertSecretFree(payload);
  const expected = digestPayload(payload);
  if (digest !== expected) throw new Error("checkpoint integrity digest does not match its canonical payload");
  return { ...payload, integrity: { algorithm: "sha256", digest } };
}

export function assertZeroToMapCheckpointFresh(checkpoint: ZeroToMapCheckpoint, now = new Date()): void {
  const age = now.getTime() - Date.parse(checkpoint.createdAt);
  if (age < 0 || age > ZERO_TO_MAP_CHECKPOINT_MAX_AGE_MS) {
    throw new Error("checkpoint is stale or has a future creation time");
  }
}

export function assertZeroToMapCheckpointDigest(checkpoint: ZeroToMapCheckpoint, expectedDigest: string): void {
  if (!/^[0-9a-f]{64}$/.test(expectedDigest) || checkpoint.integrity.digest !== expectedDigest) {
    throw new Error("externally carried checkpoint digest does not match");
  }
}

export function assertZeroToMapCheckpointBindings(
  checkpoint: ZeroToMapCheckpoint,
  expected: ZeroToMapCheckpointBindings,
): void {
  for (const key of Object.keys(expected) as Array<keyof ZeroToMapCheckpointBindings>) {
    if (checkpoint[key] !== expected[key]) throw new Error(`checkpoint binding mismatch: ${key}`);
  }
}

function assertTargetBinding(bindings: ZeroToMapCheckpointBindings): void {
  if (bindings.target === "aws-ecs" && bindings.provisionReceiptSha256 === undefined) {
    throw new Error("AWS ECS checkpoint must bind provisionReceiptSha256");
  }
  if (bindings.target === "local-docker" && bindings.provisionReceiptSha256 !== undefined) {
    throw new Error("local Docker checkpoint cannot bind an AWS provision receipt");
  }
}

function seal(payload: CheckpointPayload): ZeroToMapCheckpoint {
  return { ...payload, integrity: { algorithm: "sha256", digest: digestPayload(payload) } };
}

function digestPayload(payload: CheckpointPayload): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Checkpoints are an allowlisted release handoff, never a credential transport. */
function assertSecretFree(value: unknown, path = "checkpoint"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretFree(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:password|authorization|api[-_]?key|access[-_]?key|secret(?:[-_]?key)?|bearer|token|material)/i.test(key)) {
      throw new Error(`checkpoint contains a forbidden credential field at ${path}.${key}`);
    }
    assertSecretFree(item, `${path}.${key}`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return `{${Object.keys(candidate)
      .filter((key) => candidate[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(candidate[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("checkpoint contains a non-JSON value");
  return encoded;
}

function parseResume(value: unknown): JourneyResumeState {
  const resume = object(value, "checkpoint.resume");
  exactKeys(resume, ["startedAt", "capturedVariables", "completedStages", "resumeAt"], "checkpoint.resume");
  const capturedVariables = object(resume.capturedVariables, "checkpoint.resume.capturedVariables");
  if (!Array.isArray(resume.completedStages)) throw new Error("checkpoint.resume.completedStages must be an array");
  return {
    startedAt: timestamp(resume.startedAt, "checkpoint.resume.startedAt"),
    capturedVariables,
    completedStages: resume.completedStages.map(parseStageReceipt),
    resumeAt: parseResumePoint(resume.resumeAt),
  };
}

function parseResumePoint(value: unknown): JourneyResumePoint {
  const point = object(value, "checkpoint.resume.resumeAt");
  exactKeys(point, ["stageId", "actionId"], "checkpoint.resume.resumeAt");
  return {
    stageId: text(point.stageId, "checkpoint.resume.resumeAt.stageId"),
    actionId: text(point.actionId, "checkpoint.resume.resumeAt.actionId"),
  };
}

function parseReceiptRequest(value: unknown): JourneyReceiptRequest {
  const request = object(value, "checkpoint.consoleReceiptRequest");
  exactKeys(
    request,
    ["schemaVersion", "actionId", "receiptSchema", "matches", "requiredPointers", "equalPointers"],
    "checkpoint.consoleReceiptRequest",
  );
  if (request.schemaVersion !== ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA) {
    throw new Error(
      `checkpoint.consoleReceiptRequest.schemaVersion must be ${ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA}`,
    );
  }
  const matches = object(request.matches, "checkpoint.consoleReceiptRequest.matches");
  const requiredPointers = stringList(request.requiredPointers, "checkpoint.consoleReceiptRequest.requiredPointers");
  if (!Array.isArray(request.equalPointers)) {
    throw new Error("checkpoint.consoleReceiptRequest.equalPointers must be an array");
  }
  const equalPointers = request.equalPointers.map((value, index) => {
    if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "string" || !item)) {
      throw new Error(`checkpoint.consoleReceiptRequest.equalPointers[${index}] must be a pointer pair`);
    }
    return [value[0] as string, value[1] as string] as const;
  });
  return {
    schemaVersion: ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA,
    actionId: text(request.actionId, "checkpoint.consoleReceiptRequest.actionId"),
    receiptSchema: text(request.receiptSchema, "checkpoint.consoleReceiptRequest.receiptSchema"),
    matches,
    requiredPointers,
    equalPointers,
  };
}

function parseStageReceipt(value: unknown, index: number): JourneyStageReceipt {
  const path = `checkpoint.resume.completedStages[${index}]`;
  const stage = object(value, path);
  exactKeys(stage, ["number", "id", "title", "status", "actions"], path);
  if (!Number.isInteger(stage.number) || (stage.number as number) < 1)
    throw new Error(`${path}.number must be positive`);
  if (!Array.isArray(stage.actions)) throw new Error(`${path}.actions must be an array`);
  return {
    number: stage.number as number,
    id: text(stage.id, `${path}.id`),
    title: text(stage.title, `${path}.title`),
    status: actionStatus(stage.status, `${path}.status`),
    actions: stage.actions.map((action, actionIndex) => parseActionReceipt(action, `${path}.actions[${actionIndex}]`)),
  };
}

function parseActionReceipt(value: unknown, path: string): JourneyActionReceipt {
  const action = object(value, path);
  exactKeys(
    action,
    ["id", "kind", "status", "startedAt", "finishedAt", "code", "message", "evidence", "captures"],
    path,
  );
  const kind = action.kind;
  if (!["cli", "mcp", "mcp-resource", "gpserver", "receipt", "http"].includes(String(kind))) {
    throw new Error(`${path}.kind is invalid`);
  }
  return {
    id: text(action.id, `${path}.id`),
    kind: kind as JourneyActionReceipt["kind"],
    status: actionStatus(action.status, `${path}.status`),
    startedAt: timestamp(action.startedAt, `${path}.startedAt`),
    finishedAt: timestamp(action.finishedAt, `${path}.finishedAt`),
    ...(action.code === undefined ? {} : { code: text(action.code, `${path}.code`) }),
    ...(action.message === undefined ? {} : { message: text(action.message, `${path}.message`) }),
    ...(action.evidence === undefined ? {} : { evidence: object(action.evidence, `${path}.evidence`) }),
    ...(action.captures === undefined ? {} : { captures: object(action.captures, `${path}.captures`) }),
  };
}

function actionStatus(value: unknown, path: string): JourneyActionReceipt["status"] {
  if (value !== "passed" && value !== "blocked" && value !== "failed" && value !== "skipped") {
    throw new Error(`${path} is invalid`);
  }
  return value;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${path} has unknown fields: ${extras.join(", ")}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${path} must be an ISO timestamp`);
  return result;
}

function sha256(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function revision(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${path} must be a full lowercase git SHA`);
  return result;
}

function target(value: unknown): ZeroToMapCheckpointBindings["target"] {
  if (value !== "local-docker" && value !== "aws-ecs") {
    throw new Error("checkpoint.target must be local-docker or aws-ecs");
  }
  return value;
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value as string[];
}
