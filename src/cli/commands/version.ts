/**
 * `honua --version`: the CLI's own semver plus the Honua platform version of
 * the server it is connected to.
 *
 * The CLI keeps its own release line and is never stamped with the platform
 * version. When a connection is configured it reads the anonymous
 * `GET /api/v1/admin/capabilities` contract and reports the platform version
 * beside its own, so an operator can see both in one place.
 *
 * @packageDocumentation
 */

import { HonuaClient } from "../../core/client.js";
import type { ParsedArgs } from "../args.js";
import { getBoolean } from "../args.js";
import type { CommandContext } from "../command.js";
import { resolveBaseUrl } from "../config.js";
import { printLine, renderJson } from "../output.js";

const PACKAGE_NAME = "@honua/sdk-js";
const PROBE_TIMEOUT_MS = 5_000;

/** The platform half of the version report. */
export interface PlatformVersionReport {
  server: string | null;
  platformVersion: string | null;
  platformError?: string;
}

/** Strip semver build metadata: the server reports `2026.1.0+<revision>`. */
export function platformVersionOf(serverVersion: string): string {
  return serverVersion.split("+", 1)[0]?.trim() ?? "";
}

/** Read the connected server's platform version; never throws for an unreachable server. */
export async function probePlatformVersion(ctx: CommandContext): Promise<PlatformVersionReport> {
  let server: string | null;
  try {
    // Only the server is resolved: a version check never selects or validates a credential.
    server = resolveBaseUrl({ baseUrl: ctx.baseUrl, profile: ctx.profile }) ?? null;
  } catch (err) {
    return { server: null, platformVersion: null, platformError: errorText(err) };
  }
  if (!server) return { server: null, platformVersion: null };
  try {
    // The contract is anonymous: no caller credential is sent for a version check.
    const client = new HonuaClient({ baseUrl: server, timeoutMs: PROBE_TIMEOUT_MS, retry: { maxRetries: 0 } });
    const platformVersion = platformVersionOf((await client.getCompatibility()).serverVersion);
    if (!platformVersion) return { server, platformVersion: null, platformError: "server reported an empty version" };
    return { server, platformVersion };
  } catch (err) {
    return { server, platformVersion: null, platformError: errorText(err) };
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Print the CLI version and, when connected, the server's platform version. */
export async function versionCommand(parsed: ParsedArgs, ctx: CommandContext, cliVersion: string): Promise<void> {
  const report = await probePlatformVersion(ctx);
  if (getBoolean(parsed, "json")) {
    printLine(renderJson({ name: PACKAGE_NAME, version: cliVersion, ...report }));
    return;
  }
  printLine(`honua CLI ${cliVersion}`);
  if (report.platformVersion) {
    printLine(`Honua platform ${report.platformVersion} (${report.server})`);
  } else if (report.server || report.platformError) {
    const where = report.server ? ` (${report.server})` : "";
    printLine(`Honua platform unknown${where}: ${report.platformError}`);
  } else {
    printLine("Honua platform: not connected (pass --base-url or --profile, set HONUA_BASE_URL, or run honua login)");
  }
}
