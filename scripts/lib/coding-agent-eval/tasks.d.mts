export interface EvalAssertion {
  path: string;
  op: "equals" | "gte" | "lte" | "contains" | "defined";
  value?: unknown;
}

export interface EvalTask {
  id: string;
  title: string;
  category: string;
  tier: string;
  artifact: "ts" | "tsx";
  prompt: string;
  context: { docs: string[]; notes?: string };
  execution: { kind: "node"; timeoutMs: number; env: string[] };
  assertions: EvalAssertion[];
}

export interface AssertionCheck {
  path: string;
  op: string;
  expected?: unknown;
  actual: unknown;
  pass: boolean;
}

export declare const TASKS_DIR: string;
export declare const MIN_TASK_COUNT: number;
export declare function validateTask(task: unknown, origin?: string): EvalTask;
export declare function loadTasks(repoRoot: string): EvalTask[];
export declare function resolvePath(value: unknown, dotPath: string): unknown;
export declare function evaluateAssertion(assertion: EvalAssertion, output: unknown): { pass: boolean; actual: unknown };
export declare function evaluateAssertions(task: EvalTask, output: unknown): { pass: boolean; checks: AssertionCheck[] };
export declare function parseProgramOutput(stdout: string): Record<string, unknown> | undefined;
