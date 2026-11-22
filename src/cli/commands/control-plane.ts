/**
 * `honua connection test` and `honua import create` — the first two legs of the
 * terminal release journey, as thin transport adapters over the shared
 * control-plane command layer (`src/control-plane/commands/`).
 *
 * Before these verbs existed the terminal reached the same two routes through
 * `honua admin connect testConnection` / `honua admin import createImport`: the
 * generic escape hatch over the pinned Admin OpenAPI contract. That path is a
 * surface-specific shortcut in three ways the command layer removes — it wants
 * a separate root **administrator** credential (`--admin-key`) rather than the
 * caller's own, it takes a hand-rolled `--body` document instead of the shared
 * command input, and it produces no receipt, so a terminal invocation and the
 * equivalent MCP / Studio / JS invocation share no `auditKey`. The escape hatch
 * stays for the other ~394 operations; the journey no longer needs it.
 *
 * Like `honua map publish`, these verbs parse flags into the command's declared
 * input plus a `HonuaCommandInvocation` and render the receipt. Everything else
 * — validation, the current endpoint's `sourceUrl` requirement, idempotency
 * derivation, dry run, the typed error taxonomy — belongs to the command.
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import type {
  ConnectionTestInput,
  HonuaCommandInvocation,
  HonuaCommandStatus,
  ImportCreateInput,
} from "../../control-plane/index.js";
import { connectionTestCommand, importCreateCommand } from "../../control-plane/index.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getBoolean, getString } from "../args.js";
import { cliCommandInvocation, runCommandVerb } from "../command-adapter.js";
import type { CommandContext } from "../command.js";
import { resolveConnection } from "../config.js";
import { printLine, renderDetail, renderJson } from "../output.js";

const CONNECTION_USAGE =
  "Usage:\n" +
  "  honua connection test <connectionId> [--dry-run] [--yes]\n" +
  "  honua connection add --kind object-storage [--id <connectionId>] [--bucket <name>] [--prefix <path>] [--region <region>] [--endpoint <url>] [--dry-run] [--yes]";
const IMPORT_USAGE =
  "Usage: honua import create --source-kind <kind> --source-url <url> " +
  "[--workspace <id>] [--title <text>] [--options <json|@file>] [--dry-run] [--yes]";

/**
 * Translate `honua connection test` flags into the shared command's input and
 * invocation.
 *
 * @internal
 */
export function connectionTestInvocation(parsed: ParsedArgs): {
  readonly input: ConnectionTestInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const connectionId = parsed.positionals[0];
  if (!connectionId) throw new ArgError(CONNECTION_USAGE);
  return {
    input: { connectionId },
    invocation: cliCommandInvocation(parsed),
  };
}

/**
 * Translate `honua import create` flags into the shared command's input and
 * invocation. `--source-url` remains optional here so the shared command can
 * report the typed validation error; `--connection` is retained as a
 * compatibility input and is rejected because the current server route is
 * URL-only.
 *
 * @internal
 */
export function importCreateInvocation(parsed: ParsedArgs): {
  readonly input: ImportCreateInput;
  readonly invocation: HonuaCommandInvocation;
} {
  const sourceKind = getString(parsed, "source-kind");
  if (!sourceKind) throw new ArgError(IMPORT_USAGE);
  const sourceUrl = getString(parsed, "source-url");
  const connectionId = getString(parsed, "connection");
  const workspaceId = getString(parsed, "workspace");
  const title = getString(parsed, "title");
  const optionsRaw = getString(parsed, "options");
  return {
    input: {
      sourceKind,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(title ? { title } : {}),
      ...(optionsRaw ? { options: readJsonObject(optionsRaw, "options") } : {}),
    },
    invocation: cliCommandInvocation(parsed),
  };
}

/** Build the non-secret quick-create console URL for adding an object-storage connection. */
export function buildObjectStorageQuickCreateUrl(baseUrl: string, parsed: ParsedArgs): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  const url = new URL(`${normalized}/console/connections/new`);
  url.searchParams.set("kind", "object-storage");
  for (const key of ["bucket", "prefix", "region", "endpoint", "workspace"] as const) {
    const value = getString(parsed, key);
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function connectionAddCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const kind = getString(parsed, "kind");
  if (kind !== "object-storage") {
    throw new ArgError("honua connection add currently supports `--kind object-storage`.");
  }
  const resolved = resolveConnection(ctx);
  const quickCreateUrl = buildObjectStorageQuickCreateUrl(resolved.baseUrl, parsed);
  const connectionId = getString(parsed, "id") ?? parsed.positionals[0];
  const json = getBoolean(parsed, "json");

  if (!json) {
    printLine(
      renderDetail(
        {
          kind: "object-storage",
          quickCreateUrl,
          ...(connectionId ? { connectionId } : {}),
        },
        { title: "Add object-storage connection" },
      ),
    );
  }

  if (!connectionId) {
    if (json) {
      printLine(renderJson({ kind: "object-storage", quickCreateUrl, tested: false }));
    } else {
      printLine(
        "\nOpen the quick-create link to authorize object storage, then test it with:\n  honua connection test <connectionId> --yes",
      );
    }
    return;
  }

  const probeParsed: ParsedArgs = { positionals: [connectionId], flags: parsed.flags };
  const { input, invocation } = connectionTestInvocation(probeParsed);
  if (json) {
    const runtime = (await import("../client.js")).createCommandRuntime(ctx);
    if (!invocation.dryRun && !getBoolean(parsed, "yes")) {
      throw new ArgError(
        "honua connection add --id <connectionId> probes the connection. Re-run with --yes, or preview with --dry-run.",
      );
    }
    const receipt = await runtime.execute(connectionTestCommand, input, invocation);
    printLine(renderJson({ kind: "object-storage", quickCreateUrl, tested: true, receipt }));
    return;
  }

  await runCommandVerb({
    command: connectionTestCommand,
    input,
    invocation,
    parsed: probeParsed,
    ctx,
    heading: connectionTestHeading,
    confirm:
      "honua connection add --id <connectionId> issues a server-side probe. Re-run with --yes, or preview with --dry-run.",
    detail: (receipt) => ({
      connection: receipt.resourceRef?.id ?? "(unknown)",
      reachable: reachabilityLabel(receipt.status),
    }),
  });
}

export async function connectionCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };
  if (sub === "add") {
    await connectionAddCommand(rest, ctx);
    return;
  }
  if (sub !== "test") throw new ArgError(CONNECTION_USAGE);
  const { input, invocation } = connectionTestInvocation(rest);
  await runCommandVerb({
    command: connectionTestCommand,
    input,
    invocation,
    parsed,
    ctx,
    heading: connectionTestHeading,
    confirm: "honua connection test issues a server-side probe. Re-run with --yes, or preview the plan with --dry-run.",
    detail: (receipt) => ({
      connection: receipt.resourceRef?.id ?? "(unknown)",
      // A dry run deliberately skips the probe, so it has established nothing
      // about reachability. Folding it in with the non-denied statuses printed
      // "reachable: yes" for a connection the terminal never contacted, which
      // is the one claim a preview must not make.
      reachable: reachabilityLabel(receipt.status),
    }),
  });
}

/**
 * Headings that do not overclaim.
 *
 * The shared adapter used to pair a fixed title with a dry-run special case,
 * so `denied`, `cancelled` and `error` all rendered the completed-invocation
 * heading -- a refused probe announced itself as a successful one. Each status
 * a verb can reach gets its own heading instead.
 */
function connectionTestHeading(status: HonuaCommandStatus): string {
  switch (status) {
    case "ok":
      return "Connection probed";
    case "dry-run":
      return "Connection probe (dry run)";
    case "denied":
      return "Connection probe denied";
    case "cancelled":
      return "Connection probe cancelled";
    default:
      return "Connection probe failed";
  }
}

function importCreateHeading(status: HonuaCommandStatus): string {
  switch (status) {
    case "ok":
      return "Import job created";
    case "dry-run":
      return "Import job (dry run)";
    case "denied":
      return "Import job denied";
    case "cancelled":
      return "Import job cancelled";
    default:
      return "Import job failed";
  }
}

/**
 * Reachability as the receipt actually establishes it.
 *
 * `dry-run` means the probe never ran; `cancelled` and `error` mean it did not
 * complete. None of those license a "yes", and none of them are a "no" either
 * -- the connection may be perfectly reachable and simply untested.
 */
function reachabilityLabel(status: HonuaCommandStatus): string {
  switch (status) {
    case "ok":
      return "yes";
    case "denied":
      return "no";
    case "dry-run":
      return "not probed";
    default:
      return "unknown";
  }
}

export async function importCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const sub = parsed.positionals[0];
  if (sub !== "create") throw new ArgError(IMPORT_USAGE);
  const rest: ParsedArgs = { positionals: parsed.positionals.slice(1), flags: parsed.flags };
  const { input, invocation } = importCreateInvocation(rest);
  await runCommandVerb({
    command: importCreateCommand,
    input,
    invocation,
    parsed,
    ctx,
    heading: importCreateHeading,
    confirm: "honua import create mutates state. Re-run with --yes, or preview the plan with --dry-run.",
    detail: (receipt) => ({
      job: receipt.resourceRef?.id ?? "(not assigned)",
      workspace: receipt.resourceRef?.workspaceId ?? "(default)",
      jobStatus: receipt.output?.status ?? "(unreported)",
    }),
  });
}

/** `--options '<json>'` or `--options @file.json`. */
function readJsonObject(value: string, flag: string): Record<string, unknown> {
  const raw = value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf8") : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArgError(`--${flag} must be JSON or @file containing JSON.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ArgError(`--${flag} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}
