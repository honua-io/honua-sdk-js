import { execFileSync } from "node:child_process";

/**
 * Self-proving provenance for certification & eval artifacts (A5 provability).
 *
 * A published report is only evidence if a reader can verify WHAT was tested and
 * WITH WHICH code. Every artifact carries a `provenance` block naming the target
 * surface, the negotiated MCP protocol version, the advertised tool count, the
 * auth mode, the git SHA of the certification/eval suite, and a timestamp. That
 * turns "we pass" into "here is the exact, reproducible run that passed".
 */

/** How the eval/cert authenticated to the surface (proves the run was authed). */
export type AuthMode = "bearer" | "api-key" | "anonymous" | "none" | "unknown";

/** The reproducibility fingerprint attached to every artifact. */
export interface SuiteProvenance {
  /** Git SHA of the certification/eval suite that produced this artifact. */
  suiteGitSha: string;
  /** Where the SHA came from (CI env, local git, or unresolved). */
  suiteGitShaSource: "env" | "git" | "unknown";
  /** Human-readable target surface / URL under test. */
  targetUrl: string;
  /** MCP protocol version negotiated with the surface, when observable. */
  protocolVersion: string | null;
  /** Number of tools the surface advertised. */
  toolCount: number;
  /** How the run authenticated to the surface. */
  authMode: AuthMode;
}

/**
 * Resolve the git SHA of the running suite. Prefers the CI-provided `GITHUB_SHA`
 * (or an explicit `HONUA_SUITE_GIT_SHA` override), then falls back to
 * `git rev-parse HEAD`, then to `"unknown"` so an artifact is always self-labeled
 * even outside a git checkout.
 */
export function resolveSuiteGitSha(env: NodeJS.ProcessEnv = process.env): {
  sha: string;
  source: SuiteProvenance["suiteGitShaSource"];
} {
  const fromEnv = (env.HONUA_SUITE_GIT_SHA ?? env.GITHUB_SHA ?? "").trim();
  if (fromEnv.length > 0) {
    return { sha: fromEnv, source: "env" };
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (sha.length > 0) {
      return { sha, source: "git" };
    }
  } catch {
    // not a git checkout / git unavailable
  }
  return { sha: "unknown", source: "unknown" };
}

/**
 * Read the negotiated MCP protocol version off a connected client, if its
 * transport exposes one (the streamable-HTTP client transport does after
 * `initialize`). Returns `null` for transports that do not surface it
 * (stdio / in-memory), so the field is honest rather than fabricated.
 */
export function readNegotiatedProtocolVersion(client: unknown): string | null {
  const transport = (client as { transport?: { protocolVersion?: unknown } }).transport;
  const version = transport?.protocolVersion;
  return typeof version === "string" && version.length > 0 ? version : null;
}
