/**
 * Shared application-command contract for the Honua control plane.
 *
 * Every surface — the `honua` CLI, the MCP server, Studio, and direct JS —
 * invokes the *same* {@link HonuaCommand} objects. A transport adapts input
 * and output only: it parses its own argument shape into the command's
 * declared JSON-schema input, hands the result to
 * `HonuaCommandRuntime.execute`, and renders the returned
 * {@link HonuaCommandReceipt}. Domain sequencing (read-modify-write,
 * optimistic-concurrency checks, job hand-off) and the dry-run projection live
 * on the command, never on the transport.
 *
 * Authorization is deliberately **not** modelled here beyond an echo. The
 * command layer carries no administrator credential of its own, refuses
 * caller-supplied authority headers and the request-identity headers it derives
 * itself (see `assertNoAuthorityOverride` and `assertNoCommandKeyOverride` in
 * `./runtime.js`), and stamps every receipt `authorization:
 * "server-enforced"`. A client cannot approve its own publication by choosing
 * a different transport because no transport can express approval at all —
 * the shared command inputs have no approval field and every command input
 * schema is closed (`additionalProperties: false`).
 *
 * @experimental Part of the `@honua/sdk-js/control-plane` experimental
 *   entrypoint; not yet covered by the SDK's semver contract.
 * @module
 */

import type { QueryMethod } from "../../core/types.js";
import type { HonuaStudioLifecycleClient } from "../../studio/lifecycle-client.js";
import type { HonuaControlPlaneClient } from "../client.js";
import type { HonuaControlPlaneRequestOptions, HonuaEntityValidators, HonuaProblemDetails } from "../types.js";
import type { HonuaCommandValidationIssue } from "./errors.js";

/**
 * JSON-Schema subset used to describe a command's input.
 *
 * Structurally the same dialect `HonuaAgentToolDefinition.inputSchema` uses
 * (`src/agent-tools/index.ts`) so MCP tool schemas, CLI help, and Studio forms
 * can all project from one description. It is redeclared here rather than
 * imported so the control-plane split package does not pull in the agent-tool
 * runtime. `src/` is deliberately zod-free.
 */
export interface HonuaCommandJsonSchema {
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly properties?: Readonly<Record<string, HonuaCommandJsonSchema>>;
  readonly items?: HonuaCommandJsonSchema;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | HonuaCommandJsonSchema;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: unknown;
}

/**
 * `read` commands never mutate and never carry an idempotency key on the
 * wire; `action` commands do both. Mirrors `HonuaAgentToolMode`.
 */
export type HonuaCommandMode = "read" | "action";

/**
 * Terminal state recorded on a {@link HonuaCommandReceipt}. Mirrors
 * `HonuaAgentToolStatus` and adds `cancelled` for `AbortSignal` aborts.
 */
export type HonuaCommandStatus = "ok" | "dry-run" | "denied" | "cancelled" | "error";

/** Surfaces that may invoke a command. Recorded, never trusted. */
export const HONUA_COMMAND_TRANSPORTS = ["cli", "mcp", "studio", "sdk"] as const;

/** One of {@link HONUA_COMMAND_TRANSPORTS}. */
export type HonuaCommandTransport = (typeof HONUA_COMMAND_TRANSPORTS)[number];

/**
 * Acting identity and tenant, as the *caller claims them*.
 *
 * These values are echoed onto the receipt so a downstream audit join can line
 * a receipt up with the server-side record. They are never sent as request
 * headers and never used to make a local authorization decision — the server
 * derives the real acting identity from the credential on the
 * {@link HonuaControlPlaneClient}'s underlying `HonuaClient`.
 */
export interface HonuaCommandIdentity {
  /** Acting principal id as claimed by the caller. */
  readonly actor?: string;
  /** Tenant / workspace-owner echo. */
  readonly tenantId?: string;
  /** OAuth scope ceiling the caller believes it holds, sorted for determinism. */
  readonly scopes?: readonly string[];
}

/** Stable pointer to the resource a command read or affected. */
export interface HonuaCommandResourceRef {
  /** Resource kind, e.g. `map-package`, `import-job`, `connection`. */
  readonly type: string;
  /** Server-assigned identifier, when the server returned one. */
  readonly id?: string;
  /** Owning workspace, when scoped. */
  readonly workspaceId?: string;
  /** Absolute or root-relative link the server returned for the resource. */
  readonly href?: string;
}

/**
 * The request a command *would* issue. Produced by {@link HonuaCommand.plan},
 * recorded on every receipt, and the only thing a dry run evaluates — a dry
 * run never reaches {@link HonuaCommand.execute}, so no transport can
 * accidentally execute while previewing.
 *
 * Deliberately carries no request body: command inputs can contain connection
 * credentials, and a plan is rendered to terminals and logs.
 *
 * It also carries no **resource link**. `resourceRef.href` is dropped by the
 * runtime before the plan reaches a receipt, so a dry run — which is nothing
 * but this plan — cannot print a URL for a resource that was never created or
 * published (honua-sdk-js#1426). A link appears on a receipt only when the
 * *server* returned one to {@link HonuaCommand.execute}.
 */
export interface HonuaCommandPlan {
  readonly method: QueryMethod;
  /** Path relative to the client's base path, exactly as the command will call it. */
  readonly path: string;
  /**
   * One-line human summary for CLI/Studio previews.
   *
   * A command builds this from its own input, so it can name a source URL. The
   * runtime passes it through the SDK's credential recognizer before it reaches
   * a receipt, so a presigned URL or an embedded secret is withheld rather than
   * persisted into an audit record. Commands should still prefer identifiers to
   * URLs here.
   */
  readonly summary: string;
  /** Resource this request addresses. Any `href` is stripped by the runtime. */
  readonly resourceRef?: HonuaCommandResourceRef;
}

/** What {@link HonuaCommand.execute} returns to the runtime. */
export interface HonuaCommandOutcome<TOutput> {
  readonly output: TOutput;
  /** Overrides `ok`; use `denied` when the server durably recorded a refusal. */
  readonly status?: Extract<HonuaCommandStatus, "ok" | "denied">;
  readonly resourceRef?: HonuaCommandResourceRef;
  readonly validators?: HonuaEntityValidators;
  readonly problem?: HonuaProblemDetails;
}

/** Discriminating tag on {@link HonuaCommandReceipt}. */
export const HONUA_COMMAND_RECEIPT_KIND = "honua.command.receipt.v1" as const;

/**
 * Deterministic, serializable record of one command invocation.
 *
 * Two equivalent calls made from different transports produce identical
 * receipts apart from {@link HonuaCommandReceipt.transport}; `auditKey` hashes
 * the transport-independent projection so a server-side audit join can match
 * them. Nothing here is time-, host-, or random-dependent: `idempotencyKey`
 * and `correlationId` are derived from the command id, the canonicalized
 * input, and the tenant unless the caller supplies them. Read commands omit
 * `idempotencyKey` because no such key is sent to the server.
 */
export interface HonuaCommandReceipt<TOutput = unknown> {
  readonly kind: typeof HONUA_COMMAND_RECEIPT_KIND;
  readonly commandId: string;
  readonly mode: HonuaCommandMode;
  readonly status: HonuaCommandStatus;
  readonly idempotencyKey?: string;
  readonly correlationId: string;
  readonly identity: HonuaCommandIdentity;
  /** Surface that issued the call. Recorded for audit; excluded from `auditKey`. */
  readonly transport: HonuaCommandTransport;
  /** Always `server-enforced`: the command layer makes no authorization decision. */
  readonly authorization: "server-enforced";
  readonly plan: HonuaCommandPlan;
  readonly resourceRef?: HonuaCommandResourceRef;
  readonly validators?: HonuaEntityValidators;
  readonly problem?: HonuaProblemDetails;
  readonly output?: TOutput;
  /** Hash of the transport-independent projection. Equal across transports. */
  readonly auditKey: string;
}

/** Per-invocation context handed to {@link HonuaCommand.plan} and `execute`. */
export interface HonuaCommandContext<TInput> {
  /** Input after schema validation. */
  readonly input: TInput;
  readonly controlPlane: HonuaControlPlaneClient;
  /**
   * Studio lifecycle client, present only when the host supplied one. Commands
   * in the `studio.*` namespace throw a `transport` `HonuaCommandError` when it
   * is absent rather than reaching for a second credential.
   */
  readonly studio?: HonuaStudioLifecycleClient;
  readonly identity: HonuaCommandIdentity;
  readonly transport: HonuaCommandTransport;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly dryRun: boolean;
  readonly signal?: AbortSignal;
  /**
   * Request options for the underlying resource client, with `Idempotency-Key`
   * (action commands only), `If-Match`, the caller's `AbortSignal`, and the
   * caller's remaining headers already threaded. The headers that reach here
   * can carry neither an authority claim nor a command-owned key: both
   * families are refused before `plan` runs.
   */
  requestOptions(overrides?: HonuaControlPlaneRequestOptions): HonuaControlPlaneRequestOptions;
}

/**
 * One idempotent application command, shared verbatim by every transport.
 *
 * @typeParam TInput - Validated input shape, described by `inputSchema`.
 * @typeParam TOutput - Value carried on the receipt's `output`.
 */
export interface HonuaCommand<TInput, TOutput> {
  /** Stable dotted id, e.g. `map-package.publish`. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly mode: HonuaCommandMode;
  /** Resource kind this command addresses; used for the receipt's `resourceRef`. */
  readonly resourceKind: string;
  readonly inputSchema: HonuaCommandJsonSchema;
  /**
   * Cross-field checks the JSON schema cannot express ("one of these two is
   * required"). Called by the runtime after schema validation and **before**
   * `plan`, so a dry run can never approve an input the real invocation would
   * reject. Must be pure. Return an empty array when the input is valid.
   */
  validate?(input: TInput): readonly HonuaCommandValidationIssue[];
  /** Describe the request without issuing it. Must be pure and side-effect free. */
  plan(context: HonuaCommandContext<TInput>): HonuaCommandPlan;
  /** Issue the request. Never called during a dry run. */
  execute(context: HonuaCommandContext<TInput>): Promise<HonuaCommandOutcome<TOutput>>;
}

/** Any command, for registries and transport dispatch tables. */
// biome-ignore lint/suspicious/noExplicitAny: registry storage erases the per-command generic arity.
export type HonuaAnyCommand = HonuaCommand<any, any>;
