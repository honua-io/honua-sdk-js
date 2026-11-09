import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PR_FAST_STEPS, commandInvocation, parseArgs, runSteps, runValidation } from "../scripts/run-pr-fast.mjs";

describe("PR-fast runner arguments", () => {
  it("keeps the monotonic timestamp and output arguments distinct", () => {
    expect(parseArgs(["--started-at-monotonic-ms", "123456", "--output", "test-results/pr-fast.json"])).toMatchObject({
      startedAtMonotonicMs: 123456,
      output: "test-results/pr-fast.json",
    });
  });

  it("rejects a missing timestamp before consuming the next flag", () => {
    expect(() => parseArgs(["--started-at-monotonic-ms", "--output", "test-results/pr-fast.json"])).toThrow(
      "--started-at-monotonic-ms requires a value",
    );
  });

  it("routes its bounded npm scripts through PATH without suppressing diagnostics", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const firstDirectory = String.raw`C:\fixtures\first PATH shim`;
    const secondDirectory = String.raw`C:\fixtures\second PATH shim`;
    const firstNpm = path.win32.join(firstDirectory, "npm.CMD");
    const secondNpm = path.win32.join(secondDirectory, "npm.CMD");
    const nodeExecutable = path.win32.join(secondDirectory, "node.exe");
    expect(
      commandInvocation("npm", ["run", "typecheck"], {
        env: {
          PATH: `${firstDirectory};${secondDirectory}`,
          PATHEXT: ".CMD",
        },
        cwd: String.raw`C:\workspace`,
        execPath: nodeExecutable,
        platform: "win32",
        existsSync: (candidate: string) =>
          candidate.toLowerCase() === firstNpm.toLowerCase() || candidate.toLowerCase() === secondNpm.toLowerCase(),
        statSync: () => ({ isFile: () => true }),
      }),
    ).toEqual({
      command: nodeExecutable,
      args: [path.join(projectRoot, "scripts", "lib", "path-cli-runner.mjs"), firstNpm, "run", "typecheck"],
    });
    expect(() => commandInvocation("npm", ["install"])).toThrow(
      "PR-fast npm commands must be bounded npm run invocations",
    );
  });

  // honua-io/honua-sdk-js#1266 REQ-003: `samples:verify` leads this tier because
  // it is cheap, not because the tests depend on it. When it failed the runner
  // used to stop, so a stale-evidence lapse nobody's branch caused silently cost
  // every pull request its correctness signal.
  it("runs every validation step even after an earlier one fails", async () => {
    const attempted: string[] = [];
    const results = await runSteps(PR_FAST_STEPS, async (command: string, args: readonly string[]) => {
      attempted.push([command, ...args].join(" "));
      return { command: args[1], exitCode: args[1] === "samples:verify" ? 1 : 0 };
    });

    expect(attempted).toEqual(PR_FAST_STEPS.map(([command, args]) => [command, ...args].join(" ")));
    expect(attempted).toContain("npm run test:pr-fast");
    expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1);
  });

  it("executes its CLI entrypoint from native Windows and POSIX paths", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts/run-pr-fast.mjs"), "--unknown"], {
      cwd: projectRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown argument: --unknown");
  });
});

describe("PR-fast timing policy", () => {
  it.each([0, 1, null])("keeps exit code %s blocking only when a command fails, even over budget", async (exitCode) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pr-fast-"));
    const output = path.join(directory, "report.json");
    try {
      const status = await runValidation(
        { budgetMs: 1, startedAtMonotonicMs: 1, output },
        async (command, args) => ({ command: [command, ...args].join(" "), durationMs: 0, exitCode }),
      );
      expect(status).toBe(exitCode === 0 ? 0 : 1);
      const report = JSON.parse(await readFile(output, "utf8"));
      expect(report.withinBudget).toBe(false);
      expect(report.elapsedMs).toBeGreaterThan(report.budgetMs);
      expect(report.commandsPassed).toBe(exitCode === 0);
      expect(report.steps).toHaveLength(PR_FAST_STEPS.length);
      expect(report.environment.cpuModel).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
