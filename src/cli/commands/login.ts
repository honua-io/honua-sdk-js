/**
 * `honua login` / `honua logout` / `honua whoami` — persist and inspect the
 * base URL + API key used for subsequent commands.
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import type { ParsedArgs } from "../args.js";
import { getString } from "../args.js";
import type { CommandContext } from "../command.js";
import { configPath, readConfig, resolveConnection, stripTrailingSlashes, writeConfig } from "../config.js";
import { printLine, renderDetail } from "../output.js";

export async function loginCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const baseUrl = getString(parsed, "base-url") ?? ctx.baseUrl;
  const apiKey = getString(parsed, "api-key") ?? ctx.apiKey;
  if (!baseUrl) {
    throw new Error("`honua login` requires --base-url <url> (and optionally --api-key <key>).");
  }
  const existing = readConfig();
  const normalizedBaseUrl = stripTrailingSlashes(baseUrl);
  const config = { ...existing, baseUrl: normalizedBaseUrl };
  if (apiKey) config.apiKey = apiKey;
  else if (existing.apiKey && stripTrailingSlashes(existing.baseUrl ?? "") !== normalizedBaseUrl) delete config.apiKey;
  const file = await writeConfig(config);
  printLine(
    renderDetail(
      { baseUrl: config.baseUrl, apiKey: config.apiKey ? "***saved***" : "(none — anonymous)", saved: file },
      { title: "Logged in" },
    ),
  );
}

export async function logoutCommand(_parsed: ParsedArgs, _ctx: CommandContext): Promise<void> {
  const file = configPath();
  try {
    fs.rmSync(file);
    printLine(`Removed ${file}`);
  } catch {
    printLine("No saved credentials to remove.");
  }
}

export async function whoamiCommand(_parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const conn = resolveConnection({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, profile: ctx.profile });
  printLine(
    renderDetail(
      {
        baseUrl: conn.baseUrl,
        source: conn.source,
        auth: conn.apiKey ? "api-key" : "anonymous",
      },
      { title: "Current connection" },
    ),
  );
}
