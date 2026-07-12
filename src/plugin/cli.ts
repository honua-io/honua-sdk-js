/**
 * Independently runnable certification kit for third-party Honua plugins.
 *
 * This module is the runnable half of {@link certifyHonuaPluginManifest}: it
 * reads a plugin manifest and a host snapshot as JSON text, certifies the
 * manifest against the host, prints the deterministic machine-readable report,
 * and resolves a POSIX-style exit code. A plugin author outside this repository
 * can run it through the `honua-plugin-certify` bin without importing any SDK
 * internals or executing the plugin's own entrypoint.
 *
 * The core is transport-free: every side effect (reading files, writing output)
 * is injected through {@link PluginCertificationCliIo}, so the same logic is
 * unit-tested and driven by the Node bin shim.
 *
 * @packageDocumentation
 */

import { certifyHonuaPluginManifest, verifyHonuaPluginCertificationReport } from "./certification.js";
import type { HonuaPluginCertificationReport, HonuaPluginReportVerification } from "./types.js";

/** Injected I/O boundary. The pure CLI never touches `process` or `fs` directly. */
export interface PluginCertificationCliIo {
  /** Read a UTF-8 text file. Rejections are reported as usage errors. */
  readonly readFile: (path: string) => Promise<string>;
  /** Persist the report instead of writing it to stdout. Optional. */
  readonly writeFile?: (path: string, data: string) => Promise<void>;
  /** Write human/report output. */
  readonly stdout: (text: string) => void;
  /** Write diagnostics and usage. */
  readonly stderr: (text: string) => void;
}

/** Result of one CLI invocation: an exit code and, when produced, the report. */
export interface PluginCertificationCliResult {
  /** `0` certified/verified, `1` rejected/tampered, `2` usage/input error. */
  readonly exitCode: number;
  readonly report?: HonuaPluginCertificationReport;
  readonly verification?: HonuaPluginReportVerification;
}

const USAGE = `honua-plugin-certify — certify a Honua plugin manifest against a host snapshot.

Usage:
  honua-plugin-certify --manifest <file> --host <file> [--out <file>] [--pretty]
  honua-plugin-certify --verify <report-file>

Options:
  --manifest, -m <file>  Path to the plugin manifest JSON (required to certify).
  --host, -H <file>      Path to the certification host snapshot JSON (required to certify).
  --verify, -V <file>    Re-check an archived report's integrity digests instead of certifying.
  --out, -o <file>       Write the report JSON to <file> instead of stdout.
  --pretty               Pretty-print the report with two-space indentation.
  --help                 Show this help and exit 0.

Exit codes:
  0  Manifest certified for the supplied host, or report verified intact.
  1  Manifest rejected, or report failed verification (tampered).
  2  Usage or input error (missing/unreadable arguments).

The manifest, host, and report are read as inert JSON text; the plugin
entrypoint is never resolved or executed.
`;

interface ParsedArgs {
  manifest?: string;
  host?: string;
  verify?: string;
  out?: string;
  pretty: boolean;
  help: boolean;
  error?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { pretty: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--pretty":
        parsed.pretty = true;
        break;
      case "--manifest":
      case "-m":
        parsed.manifest = argv[++index];
        if (parsed.manifest === undefined) parsed.error = "--manifest requires a file path.";
        break;
      case "--host":
      case "-H":
        parsed.host = argv[++index];
        if (parsed.host === undefined) parsed.error = "--host requires a file path.";
        break;
      case "--verify":
      case "-V":
        parsed.verify = argv[++index];
        if (parsed.verify === undefined) parsed.error = "--verify requires a file path.";
        break;
      case "--out":
      case "-o":
        parsed.out = argv[++index];
        if (parsed.out === undefined) parsed.error = "--out requires a file path.";
        break;
      default:
        parsed.error = `Unknown argument: ${arg}`;
    }
    if (parsed.error) break;
  }
  return parsed;
}

async function readInput(
  label: string,
  path: string | undefined,
  io: PluginCertificationCliIo,
): Promise<{ text: string } | { error: string }> {
  if (path === undefined) return { error: `Missing required --${label} <file>.` };
  try {
    return { text: await io.readFile(path) };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { error: `Could not read --${label} file "${path}": ${message}` };
  }
}

/**
 * Run the certification kit once. Returns an exit code and, on success, the
 * deterministic report. All I/O flows through {@link PluginCertificationCliIo}.
 */
export async function runPluginCertificationCli(
  argv: readonly string[],
  io: PluginCertificationCliIo,
): Promise<PluginCertificationCliResult> {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout(USAGE);
    return { exitCode: 0 };
  }
  if (args.error) {
    io.stderr(`${args.error}\n\n${USAGE}`);
    return { exitCode: 2 };
  }

  if (args.verify !== undefined) {
    const report = await readInput("verify", args.verify, io);
    if ("error" in report) {
      io.stderr(`${report.error}\n`);
      return { exitCode: 2 };
    }
    const verification = verifyHonuaPluginCertificationReport(report.text);
    io.stdout(`${JSON.stringify(verification, null, args.pretty ? 2 : undefined)}\n`);
    return { exitCode: verification.ok ? 0 : 1, verification };
  }

  const manifest = await readInput("manifest", args.manifest, io);
  if ("error" in manifest) {
    io.stderr(`${manifest.error}\n`);
    return { exitCode: 2 };
  }
  const host = await readInput("host", args.host, io);
  if ("error" in host) {
    io.stderr(`${host.error}\n`);
    return { exitCode: 2 };
  }

  const report = certifyHonuaPluginManifest(manifest.text, host.text);
  const serialized = `${JSON.stringify(report, null, args.pretty ? 2 : undefined)}\n`;
  if (args.out !== undefined && io.writeFile) {
    try {
      await io.writeFile(args.out, serialized);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      io.stderr(`Could not write --out file "${args.out}": ${message}\n`);
      return { exitCode: 2, report };
    }
  } else {
    io.stdout(serialized);
  }
  return { exitCode: report.status === "certified" ? 0 : 1, report };
}
