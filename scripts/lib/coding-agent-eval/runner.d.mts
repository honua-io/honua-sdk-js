import type { EvalAdapter } from "./adapters.mjs";
import type { AssertionCheck, EvalTask } from "./tasks.mjs";

export interface TaskScore {
  id: string;
  title: string;
  category: string;
  skipped?: boolean;
  reason?: string;
  generation?: { status: "ok" | "error"; bytes?: number; detail?: string };
  typecheck?: { pass: boolean; errors: string[] };
  runtime?: { pass: boolean; exitCode: number | null; durationMs: number; timedOut: boolean; detail?: string };
  assertions?: { pass: boolean; checks: AssertionCheck[] };
  pass?: boolean;
}

export interface LaneResult {
  adapter: { name: string; variant?: string; model: string; version: string };
  tasks: TaskScore[];
}

export declare function assertSdkBuilt(repoRoot: string): void;
export declare function materializeScaffold(options: {
  repoRoot: string;
  workDir: string;
  generations: Array<{ task: EvalTask; code: string }>;
}): Map<string, string>;
export declare function typecheckScaffold(options: {
  repoRoot: string;
  workDir: string;
  timeoutMs?: number;
}): Promise<{ perFile: Map<string, string[]>; global: string[]; exitCode: number }>;
export declare function executeTask(options: {
  task: EvalTask;
  workDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ runtime: TaskScore["runtime"]; assertions: TaskScore["assertions"] }>;
export declare function runEvalLane(options: {
  repoRoot: string;
  workDir: string;
  tasks: EvalTask[];
  adapter: EvalAdapter;
  baseUrl: string;
  taskFilter?: string[];
}): Promise<LaneResult>;
