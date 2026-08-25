/**
 * The one place a command actually runs.
 *
 * `HonuaCommandRuntime.execute` owns everything that must be identical across
 * transports: authority-header refusal, schema validation, idempotency-key and
 * correlation-id derivation, dry-run short-circuiting, cancellation, error
 * normalization, and receipt assembly. A transport contributes argument
 * parsing on the way in and rendering on the way out — nothing else.
 *
 * ## Security contract
 *
 * - **No shared administrator credential.** The runtime is built from a
 *   {@link HonuaControlPlaneClient} (and optionally a Studio lifecycle client),
 *   both of which carry the *caller's own* credential from the `HonuaClient`
 *   they were constructed with. There is no admin-key path here and no
 *   `HonuaAdminClient` dependency.
 * - **No client-side authorization bypass.** Caller-supplied per-call headers
 *   are screened against {@link HONUA_COMMAND_RESERVED_HEADERS}; any attempt to
 *   set a credential, actor, tenant, policy, or approver header fails with an
 *   `authorization` {@link HonuaCommandError} *before* the command runs, on
 *   every transport. The claimed {@link HonuaCommandIdentity} is echoed onto
 *   the receipt and never placed on the wire.
 * - **No self-approval.** Command input schemas are closed, so no transport can
 *   introduce an approval field the others lack; every receipt records
 *   `authorization: "server-enforced"`.
 *
 * @experimental
 * @module
 */

import type { HonuaClient } from "../../core/client.js";
import type { HonuaStudioLifecycleClient } from "../../studio/lifecycle-client.js";
import { HonuaControlPlaneClient } from "../client.js";
import type { HonuaControlPlaneRequestOptions } from "../types.js";
import { HonuaCommandError, toHonuaCommandError } from "./errors.js";
import {
  canonicalCommandJson,
  commandDigest,
  deriveCorrelationId,
  deriveIdempotencyKey,
  normalizeCommandIdentity,
} from "./identity.js";
import {
  HONUA_COMMAND_RECEIPT_KIND,
  HONUA_COMMAND_TRANSPORTS,
  type HonuaCommand,
  type HonuaCommandContext,
  type HonuaCommandIdentity,
  type HonuaCommandReceipt,
  type HonuaCommandStatus,
  type HonuaCommandTransport,
} from "./types.js";
import { validateCommandInput } from "./validate.js";

/**
 * Headers a caller may never set on a command invocation.
 *
 * Two families: credential headers (which would let a transport swap in a
 * different — possibly shared administrator — identity) and authority headers
 * (which would let a transport assert an actor, tenant, policy decision, or
 * approval the server did not derive itself). Compared case-insensitively.
 */
export const HONUA_COMMAND_RESERVED_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-honua-api-key",
  "x-honua-admin-key",
  "x-honua-actor",
  "x-honua-act-as",
  "x-honua-impersonate",
  "x-honua-tenant",
  "x-honua-tenant-id",
  "x-honua-scope",
  "x-honua-scopes",
  "x-honua-policy-decision",
  "x-honua-approver",
  "x-honua-approved-by",
  "x-forwarded-user",
  "x-forwarded-access-token",
] as const;

const RESERVED_HEADER_SET: ReadonlySet<string> = new Set<string>(HONUA_COMMAND_RESERVED_HEADERS);

/** Options accepted by every {@link HonuaCommandRuntime.execute} call. */
export interface HonuaCommandInvocation {
  /** Surface issuing the call. Recorded on the receipt; never trusted. */
  readonly transport: HonuaCommandTransport;
  /** Acting identity and tenant echo. Never sent as headers. */
  readonly identity?: HonuaCommandIdentity;
  /** Explicit `Idempotency-Key`; derived deterministically from the input when omitted. */
  readonly idempotencyKey?: string;
  /** Explicit correlation id; derived from the idempotency key when omitted. */
  readonly correlationId?: string;
  /** Preview only — the runtime returns the plan and never calls `execute`. */
  readonly dryRun?: boolean;
  /** Optimistic-concurrency validator, sent as `If-Match`. */
  readonly ifMatch?: string;
  /** Cancellation. An abort surfaces as a `cancelled` {@link HonuaCommandError}. */
  readonly signal?: AbortSignal;
  /** Extra request headers. Reserved credential/authority headers are refused. */
  readonly headers?: HeadersInit;
}

/** Constructor options for {@link createHonuaCommandRuntime}. */
export interface HonuaCommandRuntimeOptions {
  /**
   * Transport client. Its credential *is* the acting identity — the runtime
   * never adds one of its own.
   */
  readonly client?: HonuaClient;
  /** Pre-built control-plane client; constructed from `client` when omitted. */
  readonly controlPlane?: HonuaControlPlaneClient;
  /**
   * Studio lifecycle client. Supplied by the host because Studio ships in a
   * different split package; `studio.*` commands fail with a `transport` error
   * when it is absent.
   */
  readonly studio?: HonuaStudioLifecycleClient;
  /** Default identity echo, overridable per invocation. */
  readonly identity?: HonuaCommandIdentity;
}

/** Build a {@link HonuaCommandRuntime}. */
export function createHonuaCommandRuntime(options: HonuaCommandRuntimeOptions): HonuaCommandRuntime {
  return new HonuaCommandRuntime(options);
}

/**
 * Executes {@link HonuaCommand}s. One instance per connection; share it across
 * every transport a process hosts.
 *
 * @experimental
 */
export class HonuaCommandRuntime {
  readonly #controlPlane: HonuaControlPlaneClient;
  readonly #studio: HonuaStudioLifecycleClient | undefined;
  readonly #identity: HonuaCommandIdentity;

  public constructor(options: HonuaCommandRuntimeOptions) {
    const controlPlane =
      options.controlPlane ?? (options.client ? new HonuaControlPlaneClient({ client: options.client }) : undefined);
    if (!controlPlane) {
      throw new TypeError("createHonuaCommandRuntime requires either a `client` or a prebuilt `controlPlane`.");
    }
    this.#controlPlane = controlPlane;
    this.#studio = options.studio;
    this.#identity = normalizeCommandIdentity(options.identity);
  }

  public get controlPlane(): HonuaControlPlaneClient {
    return this.#controlPlane;
  }

  public get studio(): HonuaStudioLifecycleClient | undefined {
    return this.#studio;
  }

  /**
   * Validate, plan, and (unless `dryRun`) execute `command`, returning a
   * deterministic {@link HonuaCommandReceipt}.
   *
   * @throws {HonuaCommandError} for every failure mode, already classified.
   */
  public async execute<TInput, TOutput>(
    command: HonuaCommand<TInput, TOutput>,
    input: TInput,
    invocation: HonuaCommandInvocation,
  ): Promise<HonuaCommandReceipt<TOutput>> {
    const transport = assertTransport(command.id, invocation.transport);
    const identity = normalizeCommandIdentity({ ...this.#identity, ...invocation.identity });
    const idempotencyKey = invocation.idempotencyKey?.trim() || deriveIdempotencyKey(command.id, input, identity);
    const correlationId = invocation.correlationId?.trim() || deriveCorrelationId(command.id, idempotencyKey);
    const failureContext = { correlationId, idempotencyKey, signal: invocation.signal } as const;

    assertNoAuthorityOverride(command.id, invocation.headers, { correlationId, idempotencyKey });

    const issues = validateCommandInput(command.inputSchema, input);
    if (issues.length > 0) {
      throw new HonuaCommandError(
        "validation",
        command.id,
        `Command ${command.id} received invalid input: ${issues.map((issue) => `${issue.path || "(root)"} ${issue.message}`).join("; ")}.`,
        { ...failureContext, issues },
      );
    }

    if (invocation.signal?.aborted) {
      throw new HonuaCommandError("cancelled", command.id, `Command ${command.id} was cancelled before it started.`, {
        ...failureContext,
        cause: invocation.signal.reason,
      });
    }

    const context: HonuaCommandContext<TInput> = {
      input,
      controlPlane: this.#controlPlane,
      ...(this.#studio ? { studio: this.#studio } : {}),
      identity,
      transport,
      idempotencyKey,
      correlationId,
      dryRun: invocation.dryRun === true,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      requestOptions: (overrides: HonuaControlPlaneRequestOptions = {}) => ({
        ...(invocation.signal ? { signal: invocation.signal } : {}),
        ...(command.mode === "action" ? { idempotencyKey } : {}),
        ...(invocation.ifMatch ? { ifMatch: invocation.ifMatch } : {}),
        ...(invocation.headers ? { headers: invocation.headers } : {}),
        ...overrides,
      }),
    };

    let plan: ReturnType<typeof command.plan>;
    try {
      plan = command.plan(context);
    } catch (error) {
      throw toHonuaCommandError(error, command.id, failureContext);
    }

    if (context.dryRun) {
      return buildReceipt({
        command,
        status: "dry-run",
        idempotencyKey,
        correlationId,
        identity,
        transport,
        plan,
        ...(plan.resourceRef ? { resourceRef: plan.resourceRef } : {}),
      });
    }

    try {
      const outcome = await command.execute(context);
      return buildReceipt<TInput, TOutput>({
        command,
        status: outcome.status ?? "ok",
        idempotencyKey,
        correlationId,
        identity,
        transport,
        plan,
        ...((outcome.resourceRef ?? plan.resourceRef) ? { resourceRef: outcome.resourceRef ?? plan.resourceRef } : {}),
        ...(outcome.validators ? { validators: outcome.validators } : {}),
        ...(outcome.problem ? { problem: outcome.problem } : {}),
        output: outcome.output,
      });
    } catch (error) {
      throw toHonuaCommandError(error, command.id, failureContext);
    }
  }
}

/**
 * Refuse a caller-supplied credential or authority header.
 *
 * Exported so a transport can screen its own header pass-through before it
 * builds an invocation, but the runtime applies it unconditionally — a
 * transport that forgets cannot weaken the guarantee.
 */
export function assertNoAuthorityOverride(
  commandId: string,
  headers: HeadersInit | undefined,
  context: { readonly correlationId?: string; readonly idempotencyKey?: string } = {},
): void {
  const offending = headerNames(headers).filter((name) => RESERVED_HEADER_SET.has(name));
  if (offending.length === 0) return;
  const named = offending.sort().join(", ");
  throw new HonuaCommandError(
    "authorization",
    commandId,
    `Command ${commandId} refused caller-supplied authority header(s): ${named}. Authorization is derived server-side from the connection credential; no transport may assert it.`,
    context,
  );
}

function headerNames(headers: HeadersInit | undefined): string[] {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.keys()].map((name) => name.toLowerCase());
  if (Array.isArray(headers)) return headers.map(([name]) => String(name).toLowerCase());
  return Object.keys(headers).map((name) => name.toLowerCase());
}

function assertTransport(commandId: string, transport: HonuaCommandTransport): HonuaCommandTransport {
  if ((HONUA_COMMAND_TRANSPORTS as readonly string[]).includes(transport)) return transport;
  throw new HonuaCommandError(
    "validation",
    commandId,
    `Unknown command transport "${String(transport)}"; expected one of ${HONUA_COMMAND_TRANSPORTS.join(", ")}.`,
  );
}

function buildReceipt<TInput, TOutput>(parts: {
  readonly command: HonuaCommand<TInput, TOutput>;
  readonly status: HonuaCommandStatus;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly identity: HonuaCommandIdentity;
  readonly transport: HonuaCommandTransport;
  readonly plan: HonuaCommandReceipt["plan"];
  readonly resourceRef?: HonuaCommandReceipt["resourceRef"];
  readonly validators?: HonuaCommandReceipt["validators"];
  readonly problem?: HonuaCommandReceipt["problem"];
  readonly output?: TOutput;
}): HonuaCommandReceipt<TOutput> {
  const projection = {
    kind: HONUA_COMMAND_RECEIPT_KIND,
    commandId: parts.command.id,
    mode: parts.command.mode,
    status: parts.status,
    idempotencyKey: parts.idempotencyKey,
    correlationId: parts.correlationId,
    identity: parts.identity,
    authorization: "server-enforced",
    plan: parts.plan,
    ...(parts.resourceRef ? { resourceRef: parts.resourceRef } : {}),
    ...(parts.validators ? { validators: parts.validators } : {}),
    ...(parts.problem ? { problem: parts.problem } : {}),
    ...(parts.output !== undefined ? { output: parts.output } : {}),
  } as const;
  return {
    ...projection,
    transport: parts.transport,
    auditKey: commandDigest(canonicalCommandJson(projection)),
  } as HonuaCommandReceipt<TOutput>;
}
