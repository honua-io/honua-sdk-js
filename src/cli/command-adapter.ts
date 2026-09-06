/**
 * The one place the `honua` CLI adapts flags into a control-plane command
 * invocation and renders the receipt back out.
 *
 * Every command-layer verb (`honua connection test`, `honua import create`,
 * `honua map publish`) funnels through {@link runCommandVerb}, so the terminal
 * cannot grow a per-verb shortcut: identity echo, `--idempotency-key`,
 * `--if-match`, `--dry-run`, the `--yes` confirmation gate, the error mapping,
 * and the receipt rendering are written once and shared. Domain sequencing,
 * validation, idempotency derivation, and the typed error taxonomy stay on the
 * command layer (`src/control-plane/commands/`); this module contributes
 * argument adaptation and rendering only.
 *
 * Nothing here builds request headers. The CLI has no header pass-through onto
 * a command invocation at all, which is why no terminal verb can smuggle an
 * authority claim or a forged `Idempotency-Key` / `If-Match` past the runtime's
 * screens — the values the receipt records are the values that travel.
 *
 * @packageDocumentation
 */

import type { HonuaCommand, HonuaCommandInvocation, HonuaCommandReceipt } from "../control-plane/index.js";
import { HonuaCommandError } from "../control-plane/index.js";
import type { ParsedArgs } from "./args.js";
import { ArgError, getBoolean, getString } from "./args.js";
import { createCommandRuntime } from "./client.js";
import type { CommandContext } from "./command.js";
import type { Cell } from "./output.js";
import { printLine, renderDetail, renderJson } from "./output.js";

/**
 * Project the shared invocation flags onto a {@link HonuaCommandInvocation}.
 *
 * Exported so a test can assert that a verb contributes argument adaptation
 * only — the returned invocation is exactly what a direct JS caller would pass.
 *
 * @internal
 */
export function cliCommandInvocation(parsed: ParsedArgs): HonuaCommandInvocation {
  const actor = getString(parsed, "actor");
  const tenantId = getString(parsed, "tenant");
  const idempotencyKey = getString(parsed, "idempotency-key");
  const ifMatch = getString(parsed, "if-match");
  const identity = {
    ...(actor ? { actor } : {}),
    ...(tenantId ? { tenantId } : {}),
  };
  return {
    transport: "cli",
    ...(Object.keys(identity).length > 0 ? { identity } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(ifMatch ? { ifMatch } : {}),
    ...(getBoolean(parsed, "dry-run") ? { dryRun: true } : {}),
  };
}

/** Receipt fields every command-layer verb prints, in a stable order. */
function baseDetail(receipt: HonuaCommandReceipt): Record<string, Cell> {
  return {
    command: receipt.commandId,
    status: receipt.status,
    request: `${receipt.plan.method} ${receipt.plan.path}`,
    ...(receipt.idempotencyKey ? { idempotencyKey: receipt.idempotencyKey } : {}),
    correlationId: receipt.correlationId,
    authorization: receipt.authorization,
    auditKey: receipt.auditKey,
  };
}

/** Options for {@link runCommandVerb}. */
export interface RunCommandVerbOptions<TInput, TOutput> {
  readonly command: HonuaCommand<TInput, TOutput>;
  readonly input: TInput;
  readonly invocation: HonuaCommandInvocation;
  readonly parsed: ParsedArgs;
  readonly ctx: CommandContext;
  /**
   * Heading for the rendered receipt, chosen from the status the command
   * actually reached.
   *
   * A fixed title plus a dry-run special case was not enough: `denied`,
   * `cancelled` and `error` all fell through to the completed-invocation
   * heading, so a refused publish printed "Map package published". Every
   * status a verb can reach needs a heading that does not overclaim.
   */
  readonly heading: (status: HonuaCommandReceipt["status"]) => string;
  /**
   * Terminal confirmation message. When present, a non-dry-run invocation
   * requires `--yes`. This is terminal UX — it decides whether this terminal
   * issues the command — and is deliberately not domain sequencing or an
   * authorization decision, which stay in the command layer and on the server.
   */
  readonly confirm?: string;
  /** Verb-specific rows merged ahead of the shared receipt rows. */
  readonly detail?: (receipt: HonuaCommandReceipt<TOutput>) => Record<string, Cell>;
}

/**
 * Execute one command through the shared runtime and render its receipt.
 *
 * @throws {ArgError} for a missing confirmation, or for a `validation` /
 *   `authorization` {@link HonuaCommandError} so the terminal reports caller
 *   mistakes without a stack trace. The taxonomy is the command layer's; this
 *   only chooses how the terminal presents it.
 */
export async function runCommandVerb<TInput, TOutput>(options: RunCommandVerbOptions<TInput, TOutput>): Promise<void> {
  const { command, input, invocation, parsed, ctx } = options;
  if (options.confirm && !invocation.dryRun && !getBoolean(parsed, "yes")) {
    throw new ArgError(options.confirm);
  }
  const runtime = createCommandRuntime({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, profile: ctx.profile });

  let receipt: HonuaCommandReceipt<TOutput>;
  try {
    receipt = await runtime.execute(command, input, invocation);
  } catch (error) {
    if (error instanceof HonuaCommandError && (error.kind === "validation" || error.kind === "authorization")) {
      throw new ArgError(error.message);
    }
    throw error;
  }

  if (getBoolean(parsed, "json")) {
    printLine(renderJson(receipt));
    return;
  }
  printLine(
    renderDetail(
      { ...baseDetail(receipt), ...(options.detail?.(receipt) ?? {}) },
      { title: options.heading(receipt.status) },
    ),
  );
}
