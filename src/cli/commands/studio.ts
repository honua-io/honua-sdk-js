/** Terminal argument and output adaptation for the shared Studio draft command. */
import { type HonuaCommandStatus, studioDraftSaveVersionCommand } from "../../control-plane/index.js";
import { ArgError, type ParsedArgs, getString } from "../args.js";
import { cliCommandInvocation, runCommandVerb } from "../command-adapter.js";
import type { CommandContext } from "../command.js";

/** Only a completed shared receipt may claim that a version was saved. */
export function studioSaveVersionHeading(status: HonuaCommandStatus): string {
  switch (status) {
    case "ok":
      return "Studio draft version saved";
    case "dry-run":
      return "Studio draft save-version (dry run)";
    case "denied":
      return "Studio draft save-version denied";
    case "cancelled":
      return "Studio draft save-version cancelled";
    default:
      return "Studio draft save-version failed";
  }
}

export async function studioCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const [resource, action, draftId] = parsed.positionals;
  if (resource !== "draft" || action !== "save-version" || !draftId?.trim() || parsed.positionals.length !== 3) {
    throw new ArgError("Usage: honua studio draft save-version <draftId> [--generation <nonnegative integer>]");
  }
  const rawGeneration = getString(parsed, "generation");
  const generation = rawGeneration === undefined ? undefined : Number(rawGeneration);
  if (rawGeneration !== undefined && (!/^\d+$/.test(rawGeneration) || !Number.isSafeInteger(generation))) {
    throw new ArgError("--generation must be a nonnegative safe integer.");
  }
  await runCommandVerb({
    command: studioDraftSaveVersionCommand,
    input: { draftId, ...(generation === undefined ? {} : { generation }) },
    invocation: cliCommandInvocation(parsed),
    parsed,
    ctx,
    heading: studioSaveVersionHeading,
    confirm: "honua studio draft save-version mutates state. Re-run with --yes, or preview with --dry-run.",
    detail: (receipt) => ({ draft: draftId, version: receipt.resourceRef?.id ?? "(not assigned)" }),
  });
}
