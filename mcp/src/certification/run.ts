import { writeFileSync } from "node:fs";
import { type CertificationReport, certify } from "./certifier.js";
import { renderMarkdown } from "./report.js";
import { type CertificationTarget, openCertificationTarget } from "./target.js";

/**
 * Programmatic certification runner.
 *
 * The certifier connects to one of three targets (selected by
 * `HONUA_MCP_CERT_TARGET`) and certifies the honua `/mcp` OPERATOR surface — the
 * real ~20-tool catalog with output schemas, structured errors, cursor
 * pagination, and an auth boundary — never the retired 9-tool static server:
 *
 *   - `offline`     (default): an in-process streamable-HTTP mock of `/mcp`.
 *                    Deterministic, zero network, gates every PR.
 *   - `remote`      : a live `/mcp` (HONUA_MCP_REMOTE_URL + auth). workflow_dispatch.
 *   - `stdio-proxy` : the `honua-mcp-proxy` binary against an upstream, over stdio.
 */

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
}

export async function runCertification(options: RunOptions = {}): Promise<CertificationReport> {
  const env = options.env ?? process.env;
  const target = await openCertificationTarget(env);
  return certifyTarget(target, env);
}

/** Certify an already-opened target, closing it when done. */
export async function certifyTarget(
  target: CertificationTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CertificationReport> {
  try {
    return await certify({
      client: target.client,
      targetMode: target.mode,
      backend: target.backend,
      surface: target.serverLabel,
      honuaTransport: target.honuaTransport,
      authMode: target.authMode,
      connectUnauthenticated: target.supportsUnauthenticatedPass ? () => target.connectUnauthenticated() : undefined,
      env,
    });
  } finally {
    await target.close();
  }
}

export interface ArtifactPaths {
  json: string;
  markdown: string;
}

/** Write the JSON + Markdown certification artifacts to disk. */
export function writeArtifacts(report: CertificationReport, paths: ArtifactPaths): void {
  writeFileSync(paths.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(paths.markdown, renderMarkdown(report), "utf8");
}
