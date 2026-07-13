/**
 * Agent invocation adapters for the coding-agent eval harness.
 *
 * An adapter answers one question — "generate TypeScript for task X given the
 * published docs context" — behind a uniform interface:
 *
 *   { name, variant?, describe(): Promise<{model, version}>, generate(task): Promise<{code} | {error}> }
 *
 *  - `fixture` replays committed generations from
 *    `eval/coding-agents/fixtures/generations/<variant>/` (known-good is the
 *    deterministic CI control; known-bad powers the test-of-the-test).
 *  - `claude-cli` shells out to Claude Code headless (`claude -p`). It is only
 *    constructed when HONUA_EVAL_AGENTS=1 and `claude` is on PATH, and never
 *    runs in the deterministic lane.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const GENERATIONS_DIR = path.join("eval", "coding-agents", "fixtures", "generations");
export const FIXTURE_VARIANTS = ["known-good", "known-bad"];

/** Read the committed fixture-generation manifest. */
export function readGenerationManifest(repoRoot) {
  return JSON.parse(readFileSync(path.join(repoRoot, GENERATIONS_DIR, "manifest.json"), "utf8"));
}

/** Create the deterministic fixture adapter. */
export function createFixtureAdapter({ repoRoot, variant = "known-good" }) {
  if (!FIXTURE_VARIANTS.includes(variant)) {
    throw new Error(`Unknown fixture variant "${variant}"; expected one of ${FIXTURE_VARIANTS.join(", ")}`);
  }
  const manifest = readGenerationManifest(repoRoot);
  return {
    name: "fixture",
    variant,
    async describe() {
      return { model: manifest.model, version: manifest.version };
    },
    /** Returns undefined when the variant has no generation for the task. */
    async generate(task) {
      const file = path.join(repoRoot, GENERATIONS_DIR, variant, `${task.id}.${task.artifact}`);
      if (!existsSync(file)) return undefined;
      return { code: readFileSync(file, "utf8") };
    },
  };
}

/** Locate an executable on PATH (cross-platform). */
export function findOnPath(command) {
  const probe = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(probe, [command], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const first = (result.stdout ?? "").split(/\r?\n/).find((line) => line.trim() !== "");
  return first?.trim();
}

function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return fenced ? fenced[1] : trimmed;
}

function buildDocsContext(repoRoot, task, maxBytes) {
  const parts = [];
  for (const doc of task.context.docs) {
    const file = path.join(repoRoot, doc);
    if (!existsSync(file)) continue;
    parts.push(`===== ${doc} =====\n${readFileSync(file, "utf8")}`);
  }
  const joined = parts.join("\n\n");
  return joined.length > maxBytes ? joined.slice(0, maxBytes) : joined;
}

export function buildAgentPrompt(repoRoot, task, { maxContextBytes = 120_000 } = {}) {
  const docs = buildDocsContext(repoRoot, task, maxContextBytes);
  return [
    "You are generating integration code for the @honua/sdk-js TypeScript SDK.",
    "Use ONLY the documentation below as context; do not invent APIs that are not documented.",
    "",
    docs,
    "",
    "===== TASK =====",
    task.prompt,
    "",
    "Output contract: reply with ONLY the complete TypeScript source file, no prose,",
    "no markdown fences. The file must be a standalone ESM program.",
  ].join("\n");
}

/**
 * Create the live Claude Code headless adapter. Opt-in only: requires
 * HONUA_EVAL_AGENTS=1 and the `claude` CLI on PATH.
 */
export function createClaudeCliAdapter({ repoRoot, env = process.env }) {
  if (env.HONUA_EVAL_AGENTS !== "1") {
    throw new Error("The claude-cli adapter is opt-in: set HONUA_EVAL_AGENTS=1 to enable live agent generation.");
  }
  const claudePath = findOnPath("claude");
  if (!claudePath) {
    throw new Error("The claude-cli adapter requires the `claude` CLI on PATH (Claude Code headless).");
  }
  const model = env.HONUA_EVAL_CLAUDE_MODEL;
  return {
    name: "claude-cli",
    async describe() {
      const version = spawnSync(claudePath, ["--version"], { encoding: "utf8", timeout: 30_000 });
      return {
        model: model ?? "claude-cli-default",
        version: version.status === 0 ? (version.stdout ?? "").trim() : "unknown",
      };
    },
    async generate(task) {
      const prompt = buildAgentPrompt(repoRoot, task);
      const args = ["-p", prompt, "--output-format", "text"];
      if (model) args.push("--model", model);
      const result = spawnSync(claudePath, args, {
        encoding: "utf8",
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.error) return { error: String(result.error) };
      if (result.status !== 0) {
        return { error: `claude exited ${result.status}: ${(result.stderr ?? "").slice(0, 2000)}` };
      }
      const code = stripCodeFences(result.stdout ?? "");
      if (code.trim() === "") return { error: "claude produced empty output" };
      return { code };
    },
  };
}

/** Resolve an adapter by name. */
export function createAdapter(name, options) {
  switch (name) {
    case "fixture":
      return createFixtureAdapter(options);
    case "claude-cli":
      return createClaudeCliAdapter(options);
    default:
      throw new Error(`Unknown adapter "${name}"; expected "fixture" or "claude-cli"`);
  }
}
