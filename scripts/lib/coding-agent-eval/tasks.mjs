/**
 * Task corpus loading + validation and the objective assertion evaluator for
 * the coding-agent eval harness. Tasks are committed JSON documents under
 * `eval/coding-agents/tasks/`; every check here is structural or value-exact —
 * no string similarity anywhere.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const TASKS_DIR = path.join("eval", "coding-agents", "tasks");
export const MIN_TASK_COUNT = 15;

const VALID_OPS = new Set(["equals", "gte", "lte", "contains", "defined"]);
const VALID_ARTIFACTS = new Set(["ts", "tsx"]);
const VALID_KINDS = new Set(["node"]);

/** Validate a single parsed task document. Throws with a precise message. */
export function validateTask(task, origin = "<task>") {
  const fail = (message) => {
    throw new Error(`${origin}: ${message}`);
  };
  if (typeof task !== "object" || task === null) fail("task must be an object");
  for (const field of ["id", "title", "category", "tier", "artifact", "prompt"]) {
    if (typeof task[field] !== "string" || task[field].trim() === "") fail(`missing string field "${field}"`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id)) fail(`task id "${task.id}" must be kebab-case`);
  if (!VALID_ARTIFACTS.has(task.artifact)) fail(`artifact must be one of ${[...VALID_ARTIFACTS].join(", ")}`);
  if (typeof task.context !== "object" || task.context === null) fail("missing context object");
  if (!Array.isArray(task.context.docs) || task.context.docs.length === 0) {
    fail("context.docs must be a non-empty array of repo-relative doc paths");
  }
  if (typeof task.execution !== "object" || task.execution === null) fail("missing execution object");
  if (!VALID_KINDS.has(task.execution.kind)) fail(`execution.kind must be one of ${[...VALID_KINDS].join(", ")}`);
  if (!Number.isInteger(task.execution.timeoutMs) || task.execution.timeoutMs <= 0) {
    fail("execution.timeoutMs must be a positive integer");
  }
  if (!Array.isArray(task.execution.env)) fail("execution.env must be an array");
  if (!Array.isArray(task.assertions) || task.assertions.length === 0) {
    fail("assertions must be a non-empty array");
  }
  for (const assertion of task.assertions) {
    if (typeof assertion.path !== "string" || assertion.path.trim() === "") fail("assertion.path must be a string");
    if (!VALID_OPS.has(assertion.op)) fail(`assertion.op "${assertion.op}" must be one of ${[...VALID_OPS].join(", ")}`);
    if (assertion.op !== "defined" && !("value" in assertion)) fail(`assertion on "${assertion.path}" needs a value`);
  }
  return task;
}

/** Load and validate the whole committed corpus. */
export function loadTasks(repoRoot) {
  const dir = path.join(repoRoot, TASKS_DIR);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const tasks = files.map((name) => {
    const task = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    validateTask(task, name);
    if (`${task.id}.json` !== name) {
      throw new Error(`${name}: task id "${task.id}" must match the file name`);
    }
    return task;
  });
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("duplicate task ids in corpus");
  if (tasks.length < MIN_TASK_COUNT) {
    throw new Error(`corpus has ${tasks.length} tasks; at least ${MIN_TASK_COUNT} required (REQ-001)`);
  }
  return tasks;
}

/** Resolve a dot path (e.g. "summary.count") against a parsed JSON value. */
export function resolvePath(value, dotPath) {
  let current = value;
  for (const segment of dotPath.split(".")) {
    if (typeof current !== "object" || current === null || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function deepEquals(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || typeof a !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => deepEquals(a[key], b[key]));
}

/**
 * Evaluate one objective assertion against the task program's parsed JSON
 * output. Returns `{ pass, actual }`.
 */
export function evaluateAssertion(assertion, output) {
  const actual = resolvePath(output, assertion.path);
  switch (assertion.op) {
    case "equals":
      return { pass: deepEquals(actual, assertion.value), actual };
    case "gte":
      return { pass: typeof actual === "number" && actual >= assertion.value, actual };
    case "lte":
      return { pass: typeof actual === "number" && actual <= assertion.value, actual };
    case "contains":
      if (typeof actual === "string") return { pass: actual.includes(assertion.value), actual };
      if (Array.isArray(actual)) return { pass: actual.some((item) => deepEquals(item, assertion.value)), actual };
      return { pass: false, actual };
    case "defined":
      return { pass: actual !== undefined && actual !== null, actual };
    default:
      return { pass: false, actual };
  }
}

/** Evaluate all of a task's assertions. */
export function evaluateAssertions(task, output) {
  const checks = task.assertions.map((assertion) => {
    const { pass, actual } = evaluateAssertion(assertion, output);
    return {
      path: assertion.path,
      op: assertion.op,
      expected: assertion.op === "defined" ? undefined : assertion.value,
      actual,
      pass,
    };
  });
  return { pass: checks.every((check) => check.pass), checks };
}

/**
 * Parse the task program's stdout: the last line that parses as a JSON object
 * wins (programs are told to print exactly one JSON line, but incidental
 * logging above it must not break scoring).
 */
export function parseProgramOutput(stdout) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // keep scanning upward
    }
  }
  return undefined;
}
