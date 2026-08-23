/**
 * Shared types for `honua` CLI command handlers.
 *
 * @packageDocumentation
 */

import type { ParsedArgs } from "./args.js";

/** Connection context resolved once from global flags and passed to every command. */
export interface CommandContext {
  baseUrl?: string;
  apiKey?: string;
  adminKey?: string;
  profile?: string;
}

export type CommandHandler = (parsed: ParsedArgs, ctx: CommandContext) => Promise<void>;
