import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { commandInvocation, parseArgs } from "../scripts/run-pr-fast.mjs";

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
    const firstDirectory = path.join(projectRoot, "test", "fixtures", "first PATH shim");
    const secondDirectory = path.join(projectRoot, "test", "fixtures", "second PATH shim");
    const firstNpm = path.join(firstDirectory, "npm.CMD");
    const secondNpm = path.join(secondDirectory, "npm.CMD");
    const nodeExecutable = path.join(secondDirectory, "node.exe");
    expect(
      commandInvocation("npm", ["run", "typecheck"], {
        env: {
          PATH: `${firstDirectory};${secondDirectory}`,
          PATHEXT: ".CMD",
        },
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
