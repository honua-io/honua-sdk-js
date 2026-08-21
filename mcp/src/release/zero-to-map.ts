/**
 * Contract-first runner for the 2026.1 zero-to-map release journey.
 *
 * The runner is deliberately adapter based. The production adapter invokes the
 * existing `honua` control-plane CLI and talks to the server through the
 * existing `honua-mcp-proxy`; tests use an in-memory adapter. This module does
 * not contain a second installer, admin client, or MCP proxy.
 */

export const ZERO_TO_MAP_PLAN_SCHEMA = "honua.zero-to-map.plan/v1" as const;
export const ZERO_TO_MAP_RECEIPT_SCHEMA = "honua.zero-to-map.receipt/v1" as const;
export const ZERO_TO_MAP_CONSOLE_RECEIPT_SCHEMA = "honua.zero-to-map.console-receipt/v1" as const;
export const ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA = "honua.zero-to-map.console-receipt-request/v1" as const;

export type JourneyActionKind = "cli" | "mcp" | "mcp-resource" | "gpserver" | "receipt" | "http";
export type JourneyActionStatus = "passed" | "blocked" | "failed" | "skipped";
export type JourneyStatus = "passed" | "blocked" | "failed";

export interface JourneyCapture {
  readonly variable: string;
  /** Candidate JSON pointers, checked in order. */
  readonly pointers: readonly string[];
  /** Optional pointer(s) within a JSON document stored at a candidate pointer. */
  readonly parsedPointers?: readonly string[];
  /** Optional contract value that the captured response must equal. */
  readonly equals?: string | number | boolean;
}

interface JourneyActionBase {
  readonly id: string;
  readonly title: string;
  readonly kind: JourneyActionKind;
  readonly captures?: readonly JourneyCapture[];
  /** Response fields that must remain absent (for example pre-approval public URLs). */
  readonly forbiddenPointers?: readonly string[];
}

export interface JourneyCliAction extends JourneyActionBase {
  readonly kind: "cli";
  readonly args: readonly string[];
}

export interface JourneyMcpAction extends JourneyActionBase {
  readonly kind: "mcp";
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface JourneyResourceWait {
  /** JSON pointer inside the resource's JSON text body. */
  readonly pointer: string;
  /** The successful terminal value. */
  readonly equals: string;
  /** All terminal values; any terminal value other than equals fails immediately. */
  readonly terminal: readonly string[];
  readonly pollIntervalMs: number;
  readonly deadlineMs: number;
}

/** Read or poll one MCP resource and retain the unmodified resources/read envelope. */
export interface JourneyMcpResourceAction extends JourneyActionBase {
  readonly kind: "mcp-resource";
  readonly uri: string;
  readonly waitFor?: JourneyResourceWait;
}

/**
 * An Esri-compatible GPServer invocation through the SDK's unified process
 * runner. Parameters stay schema-driven: the Buffer alias keeps Honua's
 * advertised geometry.buffer parameter contract.
 */
export interface JourneyGpServerAction extends JourneyActionBase {
  readonly kind: "gpserver";
  readonly serviceId: string;
  readonly taskName: string;
  readonly processId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly resultNames: readonly string[];
}

export interface JourneyReceiptAction extends JourneyActionBase {
  readonly kind: "receipt";
  readonly receiptSchema: string;
  /** Receipt pointer -> journey template equality checks. */
  readonly matches: Readonly<Record<string, string>>;
  /** Receipt pointers that must resolve to non-empty identity/evidence values. */
  readonly requiredPointers: readonly string[];
  /** Pairs of receipt pointers whose values must be identical. */
  readonly equalPointers?: readonly (readonly [string, string])[];
}

export interface JourneyHttpAction extends JourneyActionBase {
  readonly kind: "http";
  readonly url: string;
  readonly expectedStatus: number;
}

export type JourneyAction =
  | JourneyCliAction
  | JourneyMcpAction
  | JourneyMcpResourceAction
  | JourneyGpServerAction
  | JourneyReceiptAction
  | JourneyHttpAction;

export interface JourneyStage {
  readonly number: number;
  readonly id: string;
  readonly title: string;
  readonly actions: readonly JourneyAction[];
}

export interface ZeroToMapPlan {
  readonly schemaVersion: typeof ZERO_TO_MAP_PLAN_SCHEMA;
  readonly journeyId: string;
  readonly releaseContract: string;
  readonly fixtures: readonly string[];
  /** Traceable dependencies; these are not runtime blockers by themselves. */
  readonly dependencyRefs: readonly string[];
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly stages: readonly JourneyStage[];
}

export interface JourneyExecutionResult {
  readonly value?: unknown;
  /** Safe, non-secret evidence suitable for the release receipt. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface JourneyMcpToolDescriptor {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface JourneyAdapter {
  runCli(args: readonly string[]): Promise<JourneyExecutionResult>;
  listTools(): Promise<readonly JourneyMcpToolDescriptor[]>;
  callTool(tool: string, args: Readonly<Record<string, unknown>>): Promise<JourneyExecutionResult>;
  readResource(action: JourneyMcpResourceAction): Promise<JourneyExecutionResult>;
  runGpServer(action: JourneyGpServerAction): Promise<JourneyExecutionResult>;
  readReceipt(actionId: string): Promise<JourneyExecutionResult | undefined>;
  checkHttp(url: string, expectedStatus: number): Promise<JourneyExecutionResult>;
  close?(): Promise<void>;
}

export interface RunJourneyOptions {
  /** Live mutations are refused unless this is explicitly true. */
  readonly execute: boolean;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly now?: () => Date;
  /** Previously completed live stages restored from a verified checkpoint. */
  readonly resume?: JourneyResumeState;
  /** Called only at the external Console receipt boundary, before later work is skipped. */
  readonly onExternalReceiptMissing?: (snapshot: JourneyPauseSnapshot) => Promise<void> | void;
}

export interface JourneyActionReceipt {
  readonly id: string;
  readonly kind: JourneyActionKind;
  readonly status: JourneyActionStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly code?: string;
  readonly message?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly captures?: Readonly<Record<string, unknown>>;
}

export interface JourneyStageReceipt {
  readonly number: number;
  readonly id: string;
  readonly title: string;
  readonly status: JourneyActionStatus;
  readonly actions: readonly JourneyActionReceipt[];
}

export interface JourneyResumePoint {
  readonly stageId: string;
  readonly actionId: string;
}

export interface JourneyReceiptRequest {
  readonly schemaVersion: typeof ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA;
  readonly actionId: string;
  readonly receiptSchema: string;
  readonly matches: Readonly<Record<string, unknown>>;
  readonly requiredPointers: readonly string[];
  readonly equalPointers: readonly (readonly [string, string])[];
}

/** Secret-free execution state nested inside the CLI checkpoint. */
export interface JourneyResumeState {
  readonly startedAt: string;
  readonly capturedVariables: Readonly<Record<string, unknown>>;
  readonly completedStages: readonly JourneyStageReceipt[];
  readonly resumeAt: JourneyResumePoint;
}

export interface JourneyPauseSnapshot extends JourneyResumeState {
  readonly consoleReceiptRequest: JourneyReceiptRequest;
}

export interface ZeroToMapReceipt {
  readonly schemaVersion: typeof ZERO_TO_MAP_RECEIPT_SCHEMA;
  readonly journeyId: string;
  readonly releaseContract: string;
  readonly mode: "contract" | "live";
  readonly status: JourneyStatus;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly dependencyRefs: readonly string[];
  /** Runtime blocking receipts only. Always empty when status is passed. */
  readonly blockers: readonly string[];
  readonly stages: readonly JourneyStageReceipt[];
}

export class JourneyBlockedError extends Error {
  constructor(
    message: string,
    readonly code = "dependency-unavailable",
  ) {
    super(message);
    this.name = "JourneyBlockedError";
  }
}

/** Parse and validate the checked-in release plan without executing it. */
export function parseZeroToMapPlan(value: unknown): ZeroToMapPlan {
  const plan = record(value, "plan");
  if (plan.schemaVersion !== ZERO_TO_MAP_PLAN_SCHEMA) {
    throw new Error(`plan.schemaVersion must be ${ZERO_TO_MAP_PLAN_SCHEMA}`);
  }
  const journeyId = nonEmptyString(plan.journeyId, "plan.journeyId");
  const releaseContract = nonEmptyString(plan.releaseContract, "plan.releaseContract");
  const fixtures = stringArray(plan.fixtures, "plan.fixtures");
  const dependencyRefs = stringArray(plan.dependencyRefs, "plan.dependencyRefs");
  if (!Array.isArray(plan.stages) || plan.stages.length !== 7) {
    throw new Error("plan.stages must contain the seven D9.3 stages");
  }

  const actionIds = new Set<string>();
  const stages = plan.stages.map((candidate, index) => {
    const stage = record(candidate, `plan.stages[${index}]`);
    const number = stage.number;
    if (number !== index + 1) throw new Error(`plan.stages[${index}].number must be ${index + 1}`);
    if (!Array.isArray(stage.actions) || stage.actions.length === 0) {
      throw new Error(`plan.stages[${index}].actions must not be empty`);
    }
    const actions = stage.actions.map((action, actionIndex) =>
      parseAction(action, `plan.stages[${index}].actions[${actionIndex}]`, actionIds),
    );
    return {
      number,
      id: nonEmptyString(stage.id, `plan.stages[${index}].id`),
      title: nonEmptyString(stage.title, `plan.stages[${index}].title`),
      actions,
    } satisfies JourneyStage;
  });

  const variables = plan.variables === undefined ? undefined : record(plan.variables, "plan.variables");
  return {
    schemaVersion: ZERO_TO_MAP_PLAN_SCHEMA,
    journeyId,
    releaseContract,
    fixtures,
    dependencyRefs,
    ...(variables ? { variables } : {}),
    stages,
  };
}

/**
 * Run a plan, recording every blocked/skipped step. Contract mode never calls
 * the adapter and therefore cannot be mistaken for a live release execution.
 */
export async function runZeroToMapJourney(
  plan: ZeroToMapPlan,
  adapter: JourneyAdapter,
  options: RunJourneyOptions,
): Promise<ZeroToMapReceipt> {
  const now = options.now ?? (() => new Date());
  if (options.resume && !options.execute) throw new Error("A journey checkpoint can be resumed only in live mode.");
  const configuredVariables: Record<string, unknown> = { ...plan.variables, ...options.variables };
  const checkpointSeeds = checkpointSeedVariables(configuredVariables);
  const resumeStageIndex = options.resume ? validateJourneyResume(plan, options.resume, options.variables) : 0;
  const startedAt = options.resume?.startedAt ?? now().toISOString();
  const capturedVariables: Record<string, unknown> = options.resume
    ? { ...options.resume.capturedVariables }
    : { ...checkpointSeeds };
  const variables: Record<string, unknown> = {
    ...configuredVariables,
    journeyId: plan.journeyId,
    releaseContract: plan.releaseContract,
    ...capturedVariables,
  };
  const stages: JourneyStageReceipt[] = [...(options.resume?.completedStages ?? [])];
  let stop: { status: "blocked" | "failed"; actionId: string } | undefined;
  let catalogChecked = false;

  try {
    for (let stageIndex = resumeStageIndex; stageIndex < plan.stages.length; stageIndex += 1) {
      const stage = plan.stages[stageIndex];
      if (!stage) throw new Error(`plan stage ${stageIndex + 1} disappeared during execution`);
      const actions: JourneyActionReceipt[] = [];
      for (let actionIndex = 0; actionIndex < stage.actions.length; actionIndex += 1) {
        const action = stage.actions[actionIndex];
        if (!action) throw new Error(`plan action ${stage.id}[${actionIndex}] disappeared during execution`);
        const actionStartedAt = now().toISOString();
        if (stop) {
          actions.push({
            id: action.id,
            kind: action.kind,
            status: "skipped",
            startedAt: actionStartedAt,
            finishedAt: now().toISOString(),
            code: "prerequisite-not-passed",
            message: `Skipped because ${stop.actionId} was ${stop.status}.`,
          });
          continue;
        }
        if (!options.execute) {
          actions.push({
            id: action.id,
            kind: action.kind,
            status: "blocked",
            startedAt: actionStartedAt,
            finishedAt: now().toISOString(),
            code: "live-execution-disabled",
            message: "Contract mode validated the plan but did not execute Docker, CLI, MCP, Console, or HTTP work.",
          });
          stop = { status: "blocked", actionId: action.id };
          continue;
        }

        try {
          if (action.kind === "mcp" && !catalogChecked) {
            await assertMcpCatalog(plan, adapter);
            catalogChecked = true;
          }
          const result = await executeAction(action, adapter, variables);
          for (const pointer of action.forbiddenPointers ?? []) {
            if (jsonPointer(result.value, pointer) !== undefined) {
              throw new Error(`${action.id} disclosed forbidden pre-approval evidence at ${pointer}`);
            }
          }
          const captures = captureValues(action.captures, result.value, variables);
          Object.assign(variables, captures);
          Object.assign(capturedVariables, captures);
          actions.push({
            id: action.id,
            kind: action.kind,
            status: "passed",
            startedAt: actionStartedAt,
            finishedAt: now().toISOString(),
            ...(result.evidence ? { evidence: result.evidence } : {}),
            ...(Object.keys(captures).length > 0 ? { captures } : {}),
          });
        } catch (error) {
          let effectiveError = error;
          if (
            error instanceof JourneyBlockedError &&
            error.code === "external-receipt-missing" &&
            options.onExternalReceiptMissing
          ) {
            try {
              if (action.kind !== "receipt") throw new Error("external receipt pause requires a receipt action");
              if (actionIndex !== 0) {
                throw new Error("external receipt pause must occur at a stage boundary to prevent partial replay");
              }
              await options.onExternalReceiptMissing({
                startedAt,
                capturedVariables: { ...capturedVariables },
                completedStages: [...stages],
                resumeAt: { stageId: stage.id, actionId: action.id },
                consoleReceiptRequest: resolveReceiptRequest(action, variables),
              });
            } catch (pauseError) {
              effectiveError = pauseError;
            }
          }
          const checkpointFailure = effectiveError !== error;
          const blocked = effectiveError instanceof JourneyBlockedError;
          const status = blocked ? "blocked" : "failed";
          actions.push({
            id: action.id,
            kind: action.kind,
            status,
            startedAt: actionStartedAt,
            finishedAt: now().toISOString(),
            code:
              effectiveError instanceof JourneyBlockedError
                ? effectiveError.code
                : checkpointFailure
                  ? "checkpoint-write-failed"
                  : "execution-failed",
            message: effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
          });
          stop = { status, actionId: action.id };
        }
      }
      stages.push({
        number: stage.number,
        id: stage.id,
        title: stage.title,
        status: summarizeActions(actions),
        actions,
      });
    }
  } finally {
    await adapter.close?.();
  }

  const blockers = stages
    .flatMap((stage) => stage.actions)
    .filter((action) => action.status === "blocked")
    .map((action) => `${action.id}: ${action.code ?? "blocked"}: ${action.message ?? "blocked"}`);
  const status = stop?.status ?? "passed";
  if (status === "passed" && blockers.length > 0) {
    throw new Error("internal receipt error: a passed journey cannot contain runtime blockers");
  }
  return {
    schemaVersion: ZERO_TO_MAP_RECEIPT_SCHEMA,
    journeyId: plan.journeyId,
    releaseContract: plan.releaseContract,
    mode: options.execute ? "live" : "contract",
    status,
    startedAt,
    finishedAt: now().toISOString(),
    dependencyRefs: plan.dependencyRefs,
    blockers,
    stages,
  };
}

/**
 * Validate that a checkpoint contains exactly the passed stage prefix for this
 * plan. Returning the resume stage index lets the executor preserve the prior
 * receipts without replaying any mutating action.
 */
export function validateJourneyResume(
  plan: ZeroToMapPlan,
  resume: JourneyResumeState,
  executionVariables: Readonly<Record<string, unknown>> = {},
): number {
  if (!Number.isFinite(Date.parse(resume.startedAt))) throw new Error("checkpoint startedAt must be an ISO timestamp");
  const stageIndex = plan.stages.findIndex((stage) => stage.id === resume.resumeAt.stageId);
  if (stageIndex < 0) throw new Error(`checkpoint resume stage is not in this plan: ${resume.resumeAt.stageId}`);
  const stage = plan.stages[stageIndex];
  if (!stage) throw new Error("checkpoint resume stage disappeared from the plan");
  const actionIndex = stage.actions.findIndex((action) => action.id === resume.resumeAt.actionId);
  if (actionIndex !== 0 || stage.actions[0]?.kind !== "receipt") {
    throw new Error("checkpoint resume action must be the first receipt action in its stage");
  }
  if (resume.completedStages.length !== stageIndex) {
    throw new Error("checkpoint completed stage prefix does not reach the declared resume point");
  }

  const restoredCaptures: Record<string, unknown> = checkpointSeedVariables({
    ...plan.variables,
    ...executionVariables,
  });
  for (let index = 0; index < resume.completedStages.length; index += 1) {
    const actualStage = resume.completedStages[index];
    const plannedStage = plan.stages[index];
    if (!actualStage || !plannedStage) throw new Error(`checkpoint completed stage ${index + 1} is missing`);
    if (
      actualStage.number !== plannedStage.number ||
      actualStage.id !== plannedStage.id ||
      actualStage.title !== plannedStage.title ||
      actualStage.status !== "passed" ||
      actualStage.actions.length !== plannedStage.actions.length
    ) {
      throw new Error(`checkpoint completed stage ${plannedStage.id} does not match the current plan`);
    }
    for (let actionIndex = 0; actionIndex < actualStage.actions.length; actionIndex += 1) {
      const actualAction = actualStage.actions[actionIndex];
      const plannedAction = plannedStage.actions[actionIndex];
      if (
        !actualAction ||
        !plannedAction ||
        actualAction.id !== plannedAction.id ||
        actualAction.kind !== plannedAction.kind ||
        actualAction.status !== "passed"
      ) {
        throw new Error(`checkpoint action ${plannedStage.id}[${actionIndex}] is not an exact passed plan action`);
      }
      const allowedCaptures = new Set((plannedAction.captures ?? []).map((capture) => capture.variable));
      for (const [name, value] of Object.entries(actualAction.captures ?? {})) {
        if (!allowedCaptures.has(name))
          throw new Error(`checkpoint action ${actualAction.id} has unknown capture ${name}`);
        if (Object.hasOwn(restoredCaptures, name)) throw new Error(`checkpoint capture ${name} is duplicated`);
        restoredCaptures[name] = value;
      }
    }
  }
  if (stableValue(restoredCaptures) !== stableValue(resume.capturedVariables)) {
    throw new Error("checkpoint captured variables do not match the completed action receipts");
  }
  return stageIndex;
}

/** Persist only the non-secret deterministic plan identity needed by external evidence producers. */
function checkpointSeedVariables(variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const serviceName = variables.serviceName;
  if (serviceName === undefined) return {};
  if (typeof serviceName !== "string" || serviceName.trim().length === 0) {
    throw new Error("serviceName must be a non-empty string when checkpointed");
  }
  return { serviceName };
}

function resolveReceiptRequest(
  action: JourneyReceiptAction,
  variables: Readonly<Record<string, unknown>>,
): JourneyReceiptRequest {
  return {
    schemaVersion: ZERO_TO_MAP_CONSOLE_RECEIPT_REQUEST_SCHEMA,
    actionId: action.id,
    receiptSchema: action.receiptSchema,
    matches: Object.fromEntries(
      Object.entries(action.matches).map(([pointer, template]) => [pointer, resolveTemplateValue(template, variables)]),
    ),
    requiredPointers: [...action.requiredPointers],
    equalPointers: (action.equalPointers ?? []).map(([left, right]) => [left, right] as const),
  };
}

function stableValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertMcpCatalog(plan: ZeroToMapPlan, adapter: JourneyAdapter): Promise<void> {
  const required = plan.stages.flatMap((stage) =>
    stage.actions.filter((action): action is JourneyMcpAction => action.kind === "mcp").map((action) => action.tool),
  );
  const catalog = await adapter.listTools();
  const advertised = new Map(catalog.map((tool) => [tool.name, tool]));
  const missing = [...new Set(required)].filter((tool) => !advertised.has(tool));
  if (missing.length > 0) {
    throw new JourneyBlockedError(
      `MCP catalog is missing required tools: ${missing.join(", ")}`,
      "mcp-catalog-incomplete",
    );
  }
  for (const action of plan.stages.flatMap((stage) => stage.actions)) {
    if (action.kind !== "mcp") continue;
    const descriptor = advertised.get(action.tool);
    if (!descriptor) continue;
    try {
      assertArgumentShape(action.arguments, descriptor.inputSchema, action.tool);
    } catch (error) {
      throw new JourneyBlockedError(
        `MCP input contract mismatch for ${action.tool}: ${error instanceof Error ? error.message : String(error)}`,
        "mcp-input-contract-mismatch",
      );
    }
  }
}

function assertArgumentShape(value: unknown, schemaValue: unknown, path: string): void {
  if (!schemaValue || typeof schemaValue !== "object" || Array.isArray(schemaValue)) return;
  const schema = schemaValue as Record<string, unknown>;
  if (typeof value === "string" && value.includes("${")) return;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.some((candidate) => {
      try {
        assertArgumentShape(value, candidate, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!matches) throw new Error(`${path} does not match any oneOf branch`);
    return;
  }
  if (schema.type === "object" || schema.properties) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
    const object = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const name of required) {
      if (!Object.hasOwn(object, name)) throw new Error(`${path}.${name} is required`);
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(object).filter((name) => !Object.hasOwn(properties, name));
      if (unexpected.length > 0) throw new Error(`${path} has unexpected properties: ${unexpected.join(", ")}`);
    }
    for (const [name, item] of Object.entries(object)) {
      if (properties[name] !== undefined) assertArgumentShape(item, properties[name], `${path}.${name}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    for (const [index, item] of value.entries()) assertArgumentShape(item, schema.items, `${path}[${index}]`);
    return;
  }
  if (schema.type === "string" && typeof value !== "string") throw new Error(`${path} must be a string`);
  if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  if (schema.type === "number" && typeof value !== "number") throw new Error(`${path} must be a number`);
  if (schema.type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    throw new Error(`${path} must be an integer`);
  }
}

async function executeAction(
  action: JourneyAction,
  adapter: JourneyAdapter,
  variables: Readonly<Record<string, unknown>>,
): Promise<JourneyExecutionResult> {
  switch (action.kind) {
    case "cli":
      return adapter.runCli(resolveTemplates(action.args, variables));
    case "mcp":
      return adapter.callTool(action.tool, resolveTemplates(action.arguments, variables));
    case "mcp-resource":
      return adapter.readResource({
        ...action,
        uri: resolveTemplateString(action.uri, variables),
      });
    case "gpserver":
      return adapter.runGpServer({
        ...action,
        serviceId: resolveTemplateString(action.serviceId, variables),
        taskName: resolveTemplateString(action.taskName, variables),
        processId: resolveTemplateString(action.processId, variables),
        parameters: resolveTemplates(action.parameters, variables),
        resultNames: resolveTemplates(action.resultNames, variables),
      });
    case "receipt": {
      const receipt = await adapter.readReceipt(action.id);
      if (!receipt) {
        throw new JourneyBlockedError(
          `No external receipt was supplied for ${action.id}; Console review/approval was not claimed.`,
          "external-receipt-missing",
        );
      }
      const body = record(receipt.value, `${action.id} receipt`);
      if (body.schemaVersion !== action.receiptSchema || body.status !== "passed") {
        throw new Error(`${action.id} receipt must use ${action.receiptSchema} and have status=passed`);
      }
      for (const [pointer, template] of Object.entries(action.matches)) {
        const actual = jsonPointer(body, pointer);
        const expected = resolveTemplateValue(template, variables);
        if (actual !== expected) {
          throw new Error(`${action.id} receipt identity mismatch at ${pointer}`);
        }
      }
      for (const pointer of action.requiredPointers) {
        const actual = jsonPointer(body, pointer);
        if (actual === undefined || actual === null || actual === "") {
          throw new Error(`${action.id} receipt is missing required evidence at ${pointer}`);
        }
      }
      for (const [leftPointer, rightPointer] of action.equalPointers ?? []) {
        if (jsonPointer(body, leftPointer) !== jsonPointer(body, rightPointer)) {
          throw new Error(`${action.id} receipt identity mismatch between ${leftPointer} and ${rightPointer}`);
        }
      }
      return receipt;
    }
    case "http":
      return adapter.checkHttp(resolveTemplateString(action.url, variables), action.expectedStatus);
  }
}

function parseAction(value: unknown, path: string, ids: Set<string>): JourneyAction {
  const action = record(value, path);
  const id = nonEmptyString(action.id, `${path}.id`);
  if (ids.has(id)) throw new Error(`${path}.id duplicates ${id}`);
  ids.add(id);
  const title = nonEmptyString(action.title, `${path}.title`);
  const kind = action.kind;
  if (
    kind !== "cli" &&
    kind !== "mcp" &&
    kind !== "mcp-resource" &&
    kind !== "gpserver" &&
    kind !== "receipt" &&
    kind !== "http"
  ) {
    throw new Error(`${path}.kind is not supported`);
  }
  const captures = parseCaptures(action.captures, `${path}.captures`);
  const forbiddenPointers =
    action.forbiddenPointers === undefined
      ? undefined
      : stringArray(action.forbiddenPointers, `${path}.forbiddenPointers`);
  const common = {
    id,
    title,
    kind,
    ...(captures ? { captures } : {}),
    ...(forbiddenPointers ? { forbiddenPointers } : {}),
  };
  switch (kind) {
    case "cli":
      return { ...common, kind, args: stringArray(action.args, `${path}.args`) };
    case "mcp":
      return {
        ...common,
        kind,
        tool: nonEmptyString(action.tool, `${path}.tool`),
        arguments: record(action.arguments, `${path}.arguments`),
      };
    case "mcp-resource":
      return {
        ...common,
        kind,
        uri: nonEmptyString(action.uri, `${path}.uri`),
        ...(action.waitFor === undefined ? {} : { waitFor: parseResourceWait(action.waitFor, `${path}.waitFor`) }),
      };
    case "gpserver":
      return {
        ...common,
        kind,
        serviceId: nonEmptyString(action.serviceId, `${path}.serviceId`),
        taskName: nonEmptyString(action.taskName, `${path}.taskName`),
        processId: nonEmptyString(action.processId, `${path}.processId`),
        parameters: record(action.parameters, `${path}.parameters`),
        resultNames: stringArray(action.resultNames, `${path}.resultNames`),
      };
    case "receipt":
      return {
        ...common,
        kind,
        receiptSchema: nonEmptyString(action.receiptSchema, `${path}.receiptSchema`),
        matches: stringRecord(action.matches, `${path}.matches`),
        requiredPointers: stringArray(action.requiredPointers, `${path}.requiredPointers`),
        ...(action.equalPointers === undefined
          ? {}
          : { equalPointers: pointerPairs(action.equalPointers, `${path}.equalPointers`) }),
      };
    case "http": {
      if (!Number.isInteger(action.expectedStatus)) throw new Error(`${path}.expectedStatus must be an integer`);
      return {
        ...common,
        kind,
        url: nonEmptyString(action.url, `${path}.url`),
        expectedStatus: action.expectedStatus as number,
      };
    }
  }
}

function parseResourceWait(value: unknown, path: string): JourneyResourceWait {
  const wait = record(value, path);
  const terminal = stringArray(wait.terminal, `${path}.terminal`);
  const equals = nonEmptyString(wait.equals, `${path}.equals`);
  if (!terminal.includes(equals)) throw new Error(`${path}.terminal must include ${equals}`);
  if (!Number.isInteger(wait.pollIntervalMs) || (wait.pollIntervalMs as number) < 1) {
    throw new Error(`${path}.pollIntervalMs must be a positive integer`);
  }
  if (!Number.isInteger(wait.deadlineMs) || (wait.deadlineMs as number) < 1) {
    throw new Error(`${path}.deadlineMs must be a positive integer`);
  }
  return {
    pointer: nonEmptyString(wait.pointer, `${path}.pointer`),
    equals,
    terminal,
    pollIntervalMs: wait.pollIntervalMs as number,
    deadlineMs: wait.deadlineMs as number,
  };
}

function pointerPairs(value: unknown, path: string): Array<readonly [string, string]> {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((candidate, index) => {
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      candidate.some((pointer) => typeof pointer !== "string" || !pointer.startsWith("/"))
    ) {
      throw new Error(`${path}[${index}] must contain two JSON pointers`);
    }
    return [candidate[0] as string, candidate[1] as string] as const;
  });
}

function parseCaptures(value: unknown, path: string): readonly JourneyCapture[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((candidate, index) => {
    const capture = record(candidate, `${path}[${index}]`);
    const pointers = stringArray(capture.pointers, `${path}[${index}].pointers`);
    if (pointers.length === 0) throw new Error(`${path}[${index}].pointers must not be empty`);
    const parsedPointers =
      capture.parsedPointers === undefined
        ? undefined
        : stringArray(capture.parsedPointers, `${path}[${index}].parsedPointers`);
    const equals = capture.equals;
    if (
      equals !== undefined &&
      typeof equals !== "string" &&
      typeof equals !== "number" &&
      typeof equals !== "boolean"
    ) {
      throw new Error(`${path}[${index}].equals must be a string, number, or boolean`);
    }
    return {
      variable: nonEmptyString(capture.variable, `${path}[${index}].variable`),
      pointers,
      ...(parsedPointers ? { parsedPointers } : {}),
      ...(equals !== undefined ? { equals } : {}),
    };
  });
}

function captureValues(
  captures: readonly JourneyCapture[] | undefined,
  value: unknown,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const capture of captures ?? []) {
    let captured: unknown;
    for (const pointer of capture.pointers) {
      const source = jsonPointer(value, pointer);
      if (source === undefined) continue;
      if (!capture.parsedPointers) {
        captured = source;
        break;
      }
      if (typeof source !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(source) as unknown;
      } catch {
        continue;
      }
      for (const parsedPointer of capture.parsedPointers) {
        captured = jsonPointer(parsed, parsedPointer);
        if (captured !== undefined) break;
      }
      if (captured !== undefined) break;
    }
    if (captured === undefined) {
      throw new Error(`response did not contain ${capture.variable} at ${capture.pointers.join(" or ")}`);
    }
    const expected =
      typeof capture.equals === "string" ? resolveTemplateValue(capture.equals, variables) : capture.equals;
    if (expected !== undefined && captured !== expected) {
      throw new Error(
        `response contract mismatch for ${capture.variable}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(captured)}`,
      );
    }
    result[capture.variable] = captured;
  }
  return result;
}

function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  let current = value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      current = current[Number(key)];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function resolveTemplates<T>(value: T, variables: Readonly<Record<string, unknown>>): T {
  if (typeof value === "string") return resolveTemplateValue(value, variables) as T;
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, variables)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplates(item, variables)]),
    ) as T;
  }
  return value;
}

function resolveTemplateValue(value: string, variables: Readonly<Record<string, unknown>>): unknown {
  const exact = /^\$\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
  if (exact) return requireVariable(exact[1] as string, variables);
  return value.replaceAll(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) =>
    String(requireVariable(name, variables)),
  );
}

function resolveTemplateString(value: string, variables: Readonly<Record<string, unknown>>): string {
  const resolved = resolveTemplateValue(value, variables);
  if (typeof resolved !== "string") throw new Error(`template ${value} did not resolve to a string`);
  return resolved;
}

function requireVariable(name: string, variables: Readonly<Record<string, unknown>>): unknown {
  if (!Object.hasOwn(variables, name) || variables[name] === undefined || variables[name] === "") {
    throw new JourneyBlockedError(`Required journey variable ${name} was not supplied.`, "journey-variable-missing");
  }
  return variables[name];
}

function summarizeActions(actions: readonly JourneyActionReceipt[]): JourneyActionStatus {
  if (actions.some((action) => action.status === "failed")) return "failed";
  if (actions.some((action) => action.status === "blocked")) return "blocked";
  if (actions.every((action) => action.status === "skipped")) return "skipped";
  if (actions.some((action) => action.status === "skipped")) return "skipped";
  return "passed";
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return value as string[];
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const candidate = record(value, path);
  if (Object.values(candidate).some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${path} values must be non-empty strings`);
  }
  return candidate as Record<string, string>;
}
