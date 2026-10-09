import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Smoke test for the leaderboard generator: it renders Markdown + HTML from the
 * committed run corpus without throwing, and the output reflects the real seed
 * data (the 2026-07-05 cross-model run). Rendered into a temp dir so the test
 * never mutates the committed leaderboard.
 */

const scriptUrl = new URL("../scripts/render-leaderboard.mjs", import.meta.url);
const runsDir = fileURLToPath(new URL("../evals/runs", import.meta.url));
const outDir = mkdtempSync(`${tmpdir()}/mcp-leaderboard-`);
const fixtureDir = mkdtempSync(`${tmpdir()}/mcp-leaderboard-fixture-`);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

function render(runs: string, out: string): string {
  execFileSync(process.execPath, [fileURLToPath(scriptUrl)], {
    env: { ...process.env, HONUA_LEADERBOARD_OUT_DIR: out, HONUA_LEADERBOARD_RUNS_DIR: runs },
    stdio: "pipe",
  });
  return readFileSync(`${out}/LEADERBOARD.md`, "utf8");
}

function certReport(generatedAt: string, pass: boolean, authMode: string, surface: string) {
  return {
    schemaVersion: 2,
    generatedAt,
    protocol: { surface, targetMode: "remote" },
    provenance: { authMode, suiteGitSha: "abc1234567" },
    summary: { pass, failures: pass ? 0 : 3, contractsBlocked: pass ? 0 : 1 },
    tools: [],
    contracts: [],
  };
}

describe("leaderboard generator", () => {
  it("renders Markdown + HTML from the committed run corpus", () => {
    execFileSync(process.execPath, [fileURLToPath(scriptUrl)], {
      env: { ...process.env, HONUA_LEADERBOARD_OUT_DIR: outDir, HONUA_LEADERBOARD_RUNS_DIR: runsDir },
      stdio: "pipe",
    });

    const md = readFileSync(`${outDir}/LEADERBOARD.md`, "utf8");
    expect(md).toContain("# Honua MCP Evals — Leaderboard");
    expect(md).toContain("Cross-model leaderboard");
    // Real seed data: Opus 4.6 8/8 and Nova 2 Lite 5/8 on the operator corpus.
    expect(md).toContain("us.anthropic.claude-opus-4-6-v1");
    expect(md).toContain("us.amazon.nova-2-lite-v1:0");
    expect(md).toContain("8/8");
    expect(md).toContain("5/8");
    expect(md).toMatch(/deterministic.*control/);
    // The certification run is summarized too.
    expect(md).toContain("Certification runs");

    const html = readFileSync(`${outDir}/leaderboard.html`, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Honua MCP Evals");
    expect(html).toContain("us.amazon.nova-2-lite-v1:0");
    expect(html).toContain("Latest scheduled certification");
  });

  it("headlines the latest scheduled-cert verdict above the leaderboard tables", () => {
    const md = readFileSync(`${outDir}/LEADERBOARD.md`, "utf8");
    const verdictAt = md.indexOf("## Latest scheduled certification");
    expect(verdictAt).toBeGreaterThan(0);
    expect(verdictAt).toBeLessThan(md.indexOf("## Cross-model leaderboard"));
    // The committed corpus has never certified the candidate: the header must say
    // so and mark the cross-model rows as history, not a current pass.
    expect(md).toMatch(/\*\*Verdict: ❌ FAIL\*\* \(\d{4}-\d{2}-\d{2}, demo target/);
    expect(md).toContain("No scheduled run has certified the pinned candidate image yet");
    expect(md).toMatch(/cross-model rows below are history/);
  });

  it("prefers the candidate verdict when a run certified both candidate and demo", () => {
    const day = `${fixtureDir}/runs/2026-10-12`;
    mkdirSync(day, { recursive: true });
    const older = `${fixtureDir}/runs/2026-10-05`;
    mkdirSync(older, { recursive: true });
    writeFileSync(
      `${older}/cert-demo.json`,
      JSON.stringify(certReport("2026-10-05T07:00:00Z", false, "anonymous", "demo")),
    );
    writeFileSync(
      `${day}/cert-demo.json`,
      JSON.stringify(certReport("2026-10-12T07:05:00Z", false, "anonymous", "demo")),
    );
    writeFileSync(
      `${day}/cert-candidate.json`,
      JSON.stringify(
        certReport("2026-10-12T07:00:00Z", true, "api-key", "live honua /mcp (http://localhost:8080/mcp)"),
      ),
    );
    const out = `${fixtureDir}/out`;
    mkdirSync(out, { recursive: true });
    const md = render(`${fixtureDir}/runs`, out);
    expect(md).toContain(
      "**Verdict: ✅ PASS** (2026-10-12, pinned candidate live honua /mcp (http://localhost:8080/mcp)",
    );
    expect(md).toContain("auth `api-key`");
    expect(md).not.toContain("No scheduled run has certified the pinned candidate image yet");
  });

  it("reports no verdict rather than a pass when no scheduled certification exists", () => {
    const empty = `${fixtureDir}/empty`;
    mkdirSync(`${empty}/runs`, { recursive: true });
    const md = render(`${empty}/runs`, empty);
    expect(md).toContain("**Verdict: ➖ NONE**");
  });
});
