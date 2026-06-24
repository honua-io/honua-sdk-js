#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ArtifactPaths, runCertification, writeArtifacts } from "./run.js";

/**
 * MCP certification CLI.
 *
 * Modes (selected by flag):
 *   (default)          Run certification, write artifacts, exit non-zero on any
 *                      conformance/round-trip failure. Drives the `test:certification`
 *                      gate in CI.
 *   --artifact-only    Run certification, write artifacts, ALWAYS exit 0. Drives
 *                      the `test:certification:artifact` evidence step in CI (it
 *                      runs with `always()` and must upload artifacts even when
 *                      the gate above failed).
 *
 * Artifact paths default to the package root so CI can upload
 * `mcp-certification-results.{json,md}` from `honua-sdk-js/mcp`. Override with
 * `--out-dir <dir>`.
 *
 * Deterministic and offline by default: zero model/API calls. Uses a live
 * honua-server only when `HONUA_BASE_URL` is set (CI integration path).
 */

interface CliOptions {
  artifactOnly: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  let artifactOnly = false;
  // Default to the package root (two levels up from dist/src/certification/).
  let outDir = fileURLToPath(new URL("../../../", import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact-only") {
      artifactOnly = true;
    } else if (arg === "--out-dir") {
      const value = argv[++i];
      if (!value) {
        throw new Error("--out-dir requires a directory argument");
      }
      outDir = resolve(value);
    }
  }
  return { artifactOnly, outDir };
}

function artifactPaths(outDir: string): ArtifactPaths {
  return {
    json: resolve(outDir, "mcp-certification-results.json"),
    markdown: resolve(outDir, "mcp-certification-results.md"),
  };
}

async function main(): Promise<void> {
  const { artifactOnly, outDir } = parseArgs(process.argv.slice(2));
  const report = await runCertification();
  const paths = artifactPaths(outDir);
  writeArtifacts(report, paths);

  const s = report.summary;
  const status = s.pass ? "PASS" : "FAIL";
  process.stdout.write(
    `MCP certification ${status}: ${s.toolsConformant}/${s.toolsConformanceChecked} conformant, ` +
      `${s.toolsRoundTripped} round-tripped, ${s.knownGaps} known gaps, ${s.failures} failures.\n`,
  );
  process.stdout.write(`Artifacts: ${paths.json}\n           ${paths.markdown}\n`);

  if (!artifactOnly && !report.summary.pass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`Certification error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
