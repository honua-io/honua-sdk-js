/**
 * Objective scoring runner for the coding-agent eval harness (REQ-002).
 *
 * For every task the adapter produces a TypeScript file; the runner then
 * scores it in three objective stages — no string similarity anywhere:
 *
 *   1. typecheck — one `tsc` pass over the whole scaffold against the BUILT
 *      SDK (`dist/`), diagnostics attributed per task file;
 *   2. runtime  — the emitted JS runs under Node against the deterministic
 *      fixture server (see fixture-server.mjs);
 *   3. assertions — the program's single JSON output line is checked against
 *      the task's committed expected values.
 *
 * The scaffold is a throwaway package whose `node_modules/@honua/sdk-js`
 * links back to the repo root, so generated code imports the SDK exactly the
 * way a consumer would (`exports` map -> `dist/`).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { evaluateAssertions, parseProgramOutput } from "./tasks.mjs";

const SCAFFOLD_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    jsx: "react-jsx",
    skipLibCheck: true,
    noEmitOnError: false,
    outDir: "out",
    rootDir: "src",
    declaration: false,
    sourceMap: false,
    types: ["node"],
  },
  include: ["src"],
};

/** Ensure the SDK has been built; the scaffold typechecks/executes against dist/. */
export function assertSdkBuilt(repoRoot) {
  const entry = path.join(repoRoot, "dist", "src", "index.js");
  if (!existsSync(entry)) {
    throw new Error(`Built SDK not found at ${entry}; run "npm run build" before the eval lane.`);
  }
}

/**
 * Materialize the scaffold package for one lane: generated sources under
 * `src/`, a tsconfig, and a node_modules link back to the repo root.
 */
export function materializeScaffold({ repoRoot, workDir, generations }) {
  // The scaffold must live inside the repo: generated programs resolve their
  // ambient dependencies (react, @types/node, typescript) through the repo's
  // node_modules via Node's parent-directory lookup.
  const relative = path.relative(repoRoot, workDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`workDir must live inside the repo (got ${workDir})`);
  }
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(path.join(workDir, "src"), { recursive: true });
  writeFileSync(
    path.join(workDir, "package.json"),
    `${JSON.stringify({ name: "coding-agent-eval-scaffold", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(path.join(workDir, "tsconfig.json"), `${JSON.stringify(SCAFFOLD_TSCONFIG, null, 2)}\n`);
  const moduleDir = path.join(workDir, "node_modules", "@honua");
  mkdirSync(moduleDir, { recursive: true });
  // "junction" works without elevation on Windows and degrades to a normal
  // directory symlink elsewhere.
  symlinkSync(repoRoot, path.join(moduleDir, "sdk-js"), "junction");
  const files = new Map();
  for (const { task, code } of generations) {
    const fileName = `${task.id}.${task.artifact}`;
    writeFileSync(path.join(workDir, "src", fileName), code);
    files.set(task.id, fileName);
  }
  return files;
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });
  });
}

/**
 * Run one `tsc` pass over the scaffold and attribute diagnostics per task
 * file. Returns `{ perFile: Map<fileName, string[]>, global: string[] }`.
 */
export async function typecheckScaffold({ repoRoot, workDir, timeoutMs = 300_000 }) {
  const tscJs = path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js");
  const result = await runProcess(process.execPath, [tscJs, "-p", "tsconfig.json", "--pretty", "false"], {
    cwd: workDir,
    env: process.env,
    timeoutMs,
  });
  const perFile = new Map();
  const global = [];
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/);
    if (!match) {
      if (/error TS\d+/.test(line)) global.push(line.trim());
      continue;
    }
    const fileName = path.basename(match[1].replaceAll("\\", "/"));
    const list = perFile.get(fileName) ?? [];
    list.push(`${fileName}(${match[2]},${match[3]}): ${match[4]}`);
    perFile.set(fileName, list);
  }
  if (result.timedOut) global.push("tsc timed out");
  return { perFile, global, exitCode: result.exitCode };
}

/** Execute one emitted task program and score its runtime + assertions. */
export async function executeTask({ task, workDir, env }) {
  const emitted = path.join(workDir, "out", `${task.id}.js`);
  if (!existsSync(emitted)) {
    return {
      runtime: { pass: false, exitCode: null, durationMs: 0, timedOut: false, detail: "no emitted output (typecheck emit failed)" },
      assertions: { pass: false, checks: [] },
    };
  }
  const startedAt = performance.now();
  const result = await runProcess(process.execPath, [emitted], {
    cwd: workDir,
    env,
    timeoutMs: task.execution.timeoutMs,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const runtimePass = result.exitCode === 0 && !result.timedOut;
  const runtime = {
    pass: runtimePass,
    exitCode: result.exitCode,
    durationMs,
    timedOut: result.timedOut,
    ...(runtimePass ? {} : { detail: result.stderr.trim().split(/\r?\n/).slice(-5).join("\n").slice(0, 2000) }),
  };
  if (!runtimePass) {
    return { runtime, assertions: { pass: false, checks: [] } };
  }
  const output = parseProgramOutput(result.stdout);
  if (output === undefined) {
    return {
      runtime: { ...runtime, pass: false, detail: "program printed no JSON output line" },
      assertions: { pass: false, checks: [] },
    };
  }
  return { runtime, assertions: evaluateAssertions(task, output) };
}

/**
 * Run a full eval lane: generate (via adapter), typecheck once, execute each
 * task, and score. Returns per-task results plus adapter metadata.
 */
export async function runEvalLane({ repoRoot, workDir, tasks, adapter, baseUrl, taskFilter }) {
  assertSdkBuilt(repoRoot);
  const selected = taskFilter ? tasks.filter((task) => taskFilter.includes(task.id)) : tasks;

  const generations = [];
  const results = new Map();
  for (const task of selected) {
    const generated = await adapter.generate(task);
    if (generated === undefined) {
      results.set(task.id, { skipped: true, reason: "adapter has no generation for this task" });
      continue;
    }
    if (generated.error) {
      results.set(task.id, {
        generation: { status: "error", detail: generated.error },
        typecheck: { pass: false, errors: [] },
        runtime: { pass: false, exitCode: null, durationMs: 0, timedOut: false },
        assertions: { pass: false, checks: [] },
        pass: false,
      });
      continue;
    }
    generations.push({ task, code: generated.code });
  }

  if (generations.length > 0) {
    const files = materializeScaffold({ repoRoot, workDir, generations });
    const { perFile, global } = await typecheckScaffold({ repoRoot, workDir });

    for (const { task, code } of generations) {
      const fileName = files.get(task.id);
      const errors = [...(perFile.get(fileName) ?? []), ...global];
      const typecheck = { pass: errors.length === 0, errors };
      let runtime = { pass: false, exitCode: null, durationMs: 0, timedOut: false, detail: "skipped: typecheck failed" };
      let assertions = { pass: false, checks: [] };
      if (typecheck.pass) {
        const env = {
          ...process.env,
          HONUA_EVAL_BASE_URL: baseUrl,
          HONUA_EVAL_CLI: path.join(repoRoot, "dist", "src", "cli", "bin.js"),
        };
        ({ runtime, assertions } = await executeTask({ task, workDir, env }));
      }
      results.set(task.id, {
        generation: { status: "ok", bytes: Buffer.byteLength(code, "utf8") },
        typecheck,
        runtime,
        assertions,
        pass: typecheck.pass && runtime.pass && assertions.pass,
      });
    }
  }

  const metadata = await adapter.describe();
  return {
    adapter: { name: adapter.name, ...(adapter.variant ? { variant: adapter.variant } : {}), ...metadata },
    tasks: selected.map((task) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      ...results.get(task.id),
    })),
  };
}
