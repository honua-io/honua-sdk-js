import { writeFileSync } from "node:fs";
import { createClientFromEnv, createServer } from "../index.js";
import { type CertificationReport, certify } from "./certifier.js";
import { createFixtureClient } from "./fixture-client.js";
import { renderMarkdown } from "./report.js";

/**
 * Programmatic certification runner.
 *
 * Backend selection is deterministic and offline-first:
 *   - If `HONUA_BASE_URL` is set (CI live path), the certifier drives a real
 *     `HonuaClient` over the configured Honua transport (grpc-web/rest).
 *   - Otherwise it uses the offline fixture client — no network, no model calls.
 *
 * In both cases the MCP transport is in-memory and fully deterministic.
 */

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Force the fixture backend even when HONUA_BASE_URL is present (tests). */
  forceFixture?: boolean;
}

export async function runCertification(options: RunOptions = {}): Promise<CertificationReport> {
  const env = options.env ?? process.env;
  const live = !options.forceFixture && typeof env.HONUA_BASE_URL === "string" && env.HONUA_BASE_URL.length > 0;

  const client = live ? createClientFromEnv(env) : createFixtureClient();
  const server = createServer(client);
  const honuaTransport = live ? (env.HONUA_TRANSPORT ?? "grpc-web") : null;

  return certify({
    server,
    backend: live ? "live" : "fixture",
    honuaTransport,
    env,
  });
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
