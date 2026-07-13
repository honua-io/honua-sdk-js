import type { EvalTask } from "./tasks.mjs";

export interface EvalAdapter {
  name: string;
  variant?: string;
  describe(): Promise<{ model: string; version: string }>;
  generate(task: EvalTask): Promise<{ code: string } | { error: string } | undefined>;
}

export interface GenerationManifest {
  adapter: string;
  model: string;
  version: string;
  description: string;
  knownBad: Record<string, { failsAt: "typecheck" | "runtime" | "assertions"; reason: string }>;
}

export declare const GENERATIONS_DIR: string;
export declare const FIXTURE_VARIANTS: string[];
export declare function readGenerationManifest(repoRoot: string): GenerationManifest;
export declare function createFixtureAdapter(options: { repoRoot: string; variant?: string }): EvalAdapter;
export declare function findOnPath(command: string): string | undefined;
export declare function buildAgentPrompt(repoRoot: string, task: EvalTask, options?: { maxContextBytes?: number }): string;
export declare function createClaudeCliAdapter(options: { repoRoot: string; env?: NodeJS.ProcessEnv }): EvalAdapter;
export declare function createAdapter(name: string, options: { repoRoot: string; variant?: string }): EvalAdapter;
