import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

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
  });
});
