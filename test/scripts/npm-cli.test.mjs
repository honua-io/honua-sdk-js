import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  npmExecLocalArgs,
  npmInvocation,
  npmScriptInvocation,
  npxInvocation,
  runNpmScriptSync,
  runNpmSync,
} from "../../scripts/lib/npm-cli.mjs";
import {
  captureProcessIdentity,
  terminateProcessTree,
} from "../../scripts/lib/process-tree.mjs";

const WINDOWS_SYSTEM_ROOT = String.raw`C:\Windows`;

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntilNotAlive(pids, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(pidIsAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pids.filter(pidIsAlive);
}

function windowsRuntime(name = "npm") {
  const directory = String.raw`C:\host build lock`;
  const resolved = path.join(directory, `${name}.CMD`);
  return {
    directory,
    resolved,
    runtime: {
      cwd: String.raw`C:\work tree`,
      env: {
        PATH: `${directory};${String.raw`C:\portable-node`}`,
        PATHEXT: ".CMD;.EXE",
        SYSTEMROOT: WINDOWS_SYSTEM_ROOT,
      },
      execPath: String.raw`C:\portable-node\node.exe`,
      platform: "win32",
      existsSync: (candidate) => candidate.toLowerCase() === resolved.toLowerCase(),
      statSync: () => ({ isFile: () => true }),
    },
  };
}

test("resolves the exact first Windows PATH npm shim through a Node owner", () => {
  const { resolved, runtime } = windowsRuntime();
  const invocation = npmInvocation(["run", "build", "--", "--fixture=argument with spaces"], runtime);

  assert.equal(invocation.command, runtime.execPath);
  assert.match(invocation.args[0], /scripts[\\/]lib[\\/]path-cli-runner\.mjs$/);
  assert.deepEqual(invocation.args.slice(1), [resolved, "run", "build", "--", "--fixture=argument with spaces"]);
});

test("runs the Windows owner synchronously and preserves target status and output", () => {
  const { resolved, runtime } = windowsRuntime();
  const calls = [];
  const result = runNpmSync(
    ["run", "build", "--silent"],
    { cwd: runtime.cwd },
    {
      ...runtime,
      spawnSync: (...args) => {
        calls.push(args);
        return {
          pid: 100,
          status: 0,
          signal: null,
          output: [
            null,
            Buffer.from("ok"),
            Buffer.from(""),
            Buffer.from(
              JSON.stringify({
                kind: "exit",
                pid: 200,
                status: 23,
                signal: null,
              }),
            ),
          ],
          stdout: Buffer.from("ok"),
          stderr: Buffer.from(""),
        };
      },
    },
  );

  assert.equal(result.pid, 200);
  assert.equal(result.status, 23);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.toString(), "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], runtime.execPath);
  assert.match(calls[0][1][0], /scripts[\\/]lib[\\/]sync-cli-runner\.mjs$/);
  assert.equal(calls[0][1][1], "3");
  const payload = JSON.parse(Buffer.from(calls[0][1][2], "base64").toString("utf8"));
  assert.equal(payload.command, runtime.execPath);
  assert.match(payload.args[0], /scripts[\\/]lib[\\/]path-cli-runner\.mjs$/);
  assert.deepEqual(payload.args.slice(1), [resolved, "run", "build", "--silent"]);
  assert.equal(payload.ownerGate, true);
  assert.deepEqual(calls[0][2].stdio, ["pipe", "pipe", "pipe", "pipe"]);
  assert.equal(calls[0][2].shell, false);
});

test("fails closed when no Windows PATH command can be resolved", () => {
  assert.throws(
    () =>
      npmInvocation(["run", "build"], {
        env: { PATH: "", PATHEXT: ".CMD" },
        execPath: String.raw`C:\node\node.exe`,
        platform: "win32",
        existsSync: () => false,
      }),
    /Unable to locate npm through the target Windows PATH/,
  );
});

test("resolves npx from the target Windows PATH", () => {
  const { resolved, runtime } = windowsRuntime("npx");
  const invocation = npxInvocation(["--yes", "typedoc"], runtime);
  assert.equal(invocation.command, runtime.execPath);
  assert.deepEqual(invocation.args.slice(1), [resolved, "--yes", "typedoc"]);
});

test("rejects non-string arguments, shell execution, and Windows AbortSignal before launch", () => {
  assert.throws(() => npmInvocation(["run", 42]), /array of strings/);
  assert.throws(() => runNpmSync(["run", "build"], { shell: true }), /do not allow shell/);

  const { runtime } = windowsRuntime();
  let launches = 0;
  assert.throws(
    () =>
      runNpmSync(
        ["run", "build"],
        { signal: new AbortController().signal },
        {
          ...runtime,
          spawnSync: () => {
            launches += 1;
          },
        },
      ),
    /reject AbortSignal before launch/,
  );
  assert.equal(launches, 0);
});

test("rejects unsafe Windows batch controls before starting an owner or PATH shim", () => {
  const { runtime } = windowsRuntime();
  for (const value of ["secret\0value", "secret\rvalue", "secret\nvalue"]) {
    let launches = 0;
    assert.throws(
      () =>
        runNpmSync(
          ["run", "build", "--", value],
          {},
          {
            ...runtime,
            spawnSync: () => {
              launches += 1;
            },
          },
        ),
      (error) => {
        assert.match(error.message, /unsupported NUL, CR, or LF control character/);
        assert.doesNotMatch(error.message, /secret|value/);
        return true;
      },
    );
    assert.equal(launches, 0);
  }
});

test("uses platform PATH commands directly without a shell on non-Windows", () => {
  assert.deepEqual(
    npmInvocation(["run", "check"], {
      platform: "linux",
    }),
    { command: "npm", args: ["run", "check"] },
  );
  assert.deepEqual(
    npxInvocation(["vitest", "run"], {
      platform: "linux",
    }),
    { command: "npx", args: ["vitest", "run"] },
  );
});

test("routes bounded Windows npm scripts through the exact PATH shim", () => {
  const { resolved, runtime } = windowsRuntime();
  const invocation = npmScriptInvocation("demo:fixture:build", runtime);
  assert.equal(invocation.command, runtime.execPath);
  assert.deepEqual(invocation.args.slice(1), [resolved, "run", "demo:fixture:build", "--silent"]);
});

test("can preserve bounded npm run diagnostics without adding silent mode", () => {
  assert.deepEqual(
    npmScriptInvocation("typecheck", {
      platform: "linux",
      silent: false,
    }),
    {
      command: "npm",
      args: ["run", "typecheck"],
    },
  );
  assert.throws(() => npmScriptInvocation("typecheck", { silent: "false" }), /silent mode must be a boolean/);
});

test("uses PATH npm directly for bounded non-Windows scripts", () => {
  assert.deepEqual(npmScriptInvocation("build", { platform: "linux" }), {
    command: "npm",
    args: ["run", "build", "--silent"],
  });
});

test("rejects command syntax in bounded npm script names", () => {
  for (const script of ["build & whoami", "build -- --watch", "Build", "../build", "demo::build"]) {
    assert.throws(() => npmScriptInvocation(script), /npm script names/);
  }
});

test("constructs an offline local-bin execution without flattening arguments", () => {
  assert.deepEqual(npmExecLocalArgs("honua", ["doctor", "--output", String.raw`C:\work tree\bundle.json`]), [
    "exec",
    "--offline",
    "--yes=false",
    "--ignore-scripts",
    "--",
    "honua",
    "doctor",
    "--output",
    String.raw`C:\work tree\bundle.json`,
  ]);
  assert.throws(() => npmExecLocalArgs("../honua", []), /npm bin names/);
  assert.throws(() => npmExecLocalArgs("honua", ["doctor", 42]), /array of strings/);
});

test(
  "native Windows refuses to terminate a reused PID with a different creation identity",
  { skip: process.platform !== "win32" || process.versions.node !== "20.19.0" },
  async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      const identity = await captureProcessIdentity(child);
      assert.ok(identity);
      await assert.rejects(
        terminateProcessTree(
          child,
          {
            ...identity,
            startedAtFileTimeUtc: String(BigInt(identity.startedAtFileTimeUtc) + 1n),
          },
          { timeoutMs: 100 },
        ),
        /did not close/,
      );
      assert.equal(pidIsAlive(child.pid), true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close").catch(() => undefined);
      }
    }
  },
);

test(
  "native Windows Node 20 preserves adversarial arguments, invokes one PATH shim, and tears down exact timeout trees",
  { skip: process.platform !== "win32" || process.versions.node !== "20.19.0" },
  async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "honua-npm-cli-"));
    const controlRoot = await mkdtemp(path.join(os.tmpdir(), "honua-npm-cli-control-"));
    const root = `${temporary} Windows Ω & ! ^ % (probe)`;
    await rename(temporary, root);
    const shimDirectory = path.join(root, "PATH shim & Ω");
    const countPath = path.join(controlRoot, "shim-count.txt");
    const parentPidPath = path.join(root, "parent pid.txt");
    const leafPidPath = path.join(root, "leaf pid.txt");
    const noisyParentPidPath = path.join(root, "noisy parent pid.txt");
    const noisyLeafPidPath = path.join(root, "noisy leaf pid.txt");
    const fakeNpmRunner = path.join(root, "fake npm runner.mjs");
    const nodeDirectory = path.dirname(process.execPath);
    const npmCli = path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js");
    assert.ok(existsSync(npmCli), `expected pinned npm CLI at ${npmCli}`);
    await mkdir(shimDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        path.join(shimDirectory, "npm.cmd"),
        [
          "@ECHO OFF",
          "SETLOCAL DisableDelayedExpansion",
          '"%HONUA_PINNED_NODE%" "%HONUA_FAKE_NPM_RUNNER%" %*',
          "EXIT /B %ERRORLEVEL%",
          "",
        ].join("\r\n"),
      ),
      writeFile(
        fakeNpmRunner,
        [
          'import { spawnSync } from "node:child_process";',
          'import { appendFileSync } from "node:fs";',
          "appendFileSync(process.env.HONUA_NPM_SHIM_COUNT, 'invoked\\n');",
          "process.env.HONUA_FAKE_NPM_ACTIVE = 'true';",
          "if (process.argv[2] === '__roundtrip') {",
          "  process.stdout.write(`${JSON.stringify(process.argv.slice(3))}\\n`);",
          "} else {",
          "  const result = spawnSync(process.execPath, [process.env.HONUA_REAL_NPM_CLI, ...process.argv.slice(2)], { stdio: 'inherit' });",
          "  if (result.error) throw result.error;",
          "  process.exitCode = result.status ?? 1;",
          "}",
          "",
        ].join("\n"),
      ),
      writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          private: true,
          scripts: {
            probe: "node probe.mjs",
            stdin: "node stdin.mjs",
            "exit-code": "node exit-code.mjs",
            hang: "node hang-parent.mjs",
            noisy: "node noisy-parent.mjs",
          },
        }),
      ),
      writeFile(
        path.join(root, "probe.mjs"),
        "console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), value: process.env.HONUA_EXACT_VALUE, shim: process.env.HONUA_FAKE_NPM_ACTIVE }));\n",
      ),
      writeFile(path.join(root, "exit-code.mjs"), "process.exit(23);\n"),
      writeFile(
        path.join(root, "stdin.mjs"),
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "for await (const chunk of process.stdin) input += chunk;",
          "process.stderr.write('exact-stderr Ω & !\\n');",
          "console.log(JSON.stringify({ input }));",
          "",
        ].join("\n"),
      ),
      writeFile(
        path.join(root, "hang-parent.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.HONUA_PARENT_PID_PATH, String(process.pid));",
          "spawn(process.execPath, ['leaf.mjs'], { stdio: 'inherit' });",
          "setInterval(() => spawn(process.execPath, ['leaf.mjs'], { stdio: 'inherit' }), 75);",
          "",
        ].join("\n"),
      ),
      writeFile(
        path.join(root, "leaf.mjs"),
        [
          'import { appendFileSync } from "node:fs";',
          "appendFileSync(process.env.HONUA_LEAF_PID_PATH, `${process.pid}\\n`);",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      ),
      writeFile(
        path.join(root, "noisy-parent.mjs"),
        [
          'import { spawn } from "node:child_process";',
          'import { existsSync, writeFileSync } from "node:fs";',
          "writeFileSync(process.env.HONUA_NOISY_PARENT_PID_PATH, String(process.pid));",
          "spawn(process.execPath, ['noisy-leaf.mjs'], { stdio: 'inherit' });",
          "while (!existsSync(process.env.HONUA_NOISY_LEAF_PID_PATH)) {",
          "  await new Promise((resolve) => setTimeout(resolve, 10));",
          "}",
          "for (;;) {",
          "  process.stdout.write('x'.repeat(4096));",
          "  await new Promise((resolve) => setImmediate(resolve));",
          "}",
          "",
        ].join("\n"),
      ),
      writeFile(
        path.join(root, "noisy-leaf.mjs"),
        [
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.HONUA_NOISY_LEAF_PID_PATH, String(process.pid));",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      ),
      writeFile(countPath, ""),
    ]);
    const exactArgument = 'Ω & ! ^ % (argument) "quoted" \\ trailing';
    const env = {
      ...process.env,
      PATH: `${shimDirectory};${nodeDirectory};${process.env.PATH}`,
      PATHEXT: ".CMD;.EXE;.BAT;.COM",
      HONUA_NPM_SHIM_COUNT: countPath,
      HONUA_PINNED_NODE: process.execPath,
      HONUA_REAL_NPM_CLI: npmCli,
      HONUA_FAKE_NPM_RUNNER: fakeNpmRunner,
      HONUA_EXACT_VALUE: exactArgument,
      HONUA_PARENT_PID_PATH: parentPidPath,
      HONUA_LEAF_PID_PATH: leafPidPath,
      HONUA_NOISY_PARENT_PID_PATH: noisyParentPidPath,
      HONUA_NOISY_LEAF_PID_PATH: noisyLeafPidPath,
    };
    const invocationCount = async () => (await readFile(countPath, "utf8")).split(/\r?\n/).filter(Boolean).length;
    let knownPids = [];
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      unrelated.once("spawn", resolve);
      unrelated.once("error", reject);
    });
    try {
      const resolvedProbe = npmInvocation(["run", "probe"], {
        cwd: root,
        env,
      });
      assert.equal(resolvedProbe.args[1].toLowerCase(), path.join(shimDirectory, "npm.cmd").toLowerCase());
      const probe = runNpmSync(["run", "probe", "--", "argument with spaces", exactArgument], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(probe.error, undefined);
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stderr, "");
      const payload = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(payload.cwd, root);
      assert.deepEqual(payload.argv, ["argument with spaces", exactArgument]);
      assert.equal(payload.value, exactArgument);
      assert.equal(payload.shim, "true");
      assert.equal(await invocationCount(), 1);

      await writeFile(countPath, "");
      const adversarialArguments = [
        "",
        "plain",
        exactArgument,
        'a"b',
        String.raw`a\"b`,
        String.raw`a\\"b`,
        `a${"\\".repeat(3)}"b`,
        `a${"\\".repeat(4)}"b`,
        String.raw`two trailing\\`,
        `three trailing${"\\".repeat(3)}`,
        `four trailing${"\\".repeat(4)}`,
        String.raw`C:\space & unicode Ω\tree\\`,
        '"quoted"',
        "%PATH%",
        "!HONUA_PINNED_NODE!",
        "left\tright",
        "* ? [brackets] `tick`",
        "pipe|redirect<in>out,comma;semicolon",
      ];
      const roundTrip = runNpmSync(["__roundtrip", ...adversarialArguments], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(roundTrip.error, undefined);
      assert.equal(roundTrip.status, 0, roundTrip.stderr);
      assert.deepEqual(JSON.parse(roundTrip.stdout.trim()), adversarialArguments);
      assert.equal(await invocationCount(), 1);

      await writeFile(countPath, "");
      for (const value of ["private\0argument", "private\rargument", "private\nargument"]) {
        assert.throws(
          () =>
            runNpmSync(["__roundtrip", value], {
              cwd: root,
              env,
              encoding: "utf8",
              timeout: 10_000,
            }),
          (error) => {
            assert.match(error.message, /unsupported NUL, CR, or LF control character/);
            assert.doesNotMatch(error.message, /private/);
            return true;
          },
        );
      }
      assert.equal(await invocationCount(), 0);

      await writeFile(countPath, "");
      const stdin = runNpmSync(["run", "stdin", "--silent"], {
        cwd: root,
        env,
        encoding: "utf8",
        input: exactArgument,
        timeout: 10_000,
      });
      assert.equal(stdin.error, undefined);
      assert.equal(stdin.status, 0);
      assert.match(stdin.stderr, /exact-stderr Ω & !/);
      assert.equal(JSON.parse(stdin.stdout.trim()).input, exactArgument);
      assert.equal(await invocationCount(), 1);

      await writeFile(countPath, "");
      const failed = runNpmScriptSync("exit-code", {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(failed.error, undefined);
      assert.equal(failed.status, 23);
      assert.equal(failed.signal, null);
      assert.equal(await invocationCount(), 1);

      await writeFile(countPath, "");
      assert.throws(
        () =>
          runNpmScriptSync("probe", {
            cwd: root,
            env,
            signal: new AbortController().signal,
          }),
        /reject AbortSignal before launch/,
      );
      assert.equal(await invocationCount(), 0);

      const identityFailureStartedAt = performance.now();
      const identityFailure = runNpmScriptSync(
        "hang",
        {
          cwd: root,
          env: {
            ...env,
            SYSTEMROOT: path.join(root, "missing-system-root"),
          },
          stdio: "ignore",
          timeout: 100,
        },
        {
          terminationTimeout: 100,
        },
      );
      const identityFailureDurationMs = performance.now() - identityFailureStartedAt;
      assert.equal(identityFailure.status, null);
      assert.equal(identityFailure.signal, "SIGTERM");
      assert.equal(identityFailure.error?.code, "ETIMEDOUT");
      assert.match(identityFailure.error?.cause?.message ?? "", /Unable to capture process identity/);
      assert.ok(
        identityFailureDurationMs < 1_500,
        `identity-capture fallback took ${identityFailureDurationMs}ms`,
      );
      assert.equal(await invocationCount(), 0);
      assert.equal(existsSync(parentPidPath), false);
      assert.equal(existsSync(leafPidPath), false);
      assert.equal(pidIsAlive(unrelated.pid), true);

      const timedOut = runNpmScriptSync("hang", {
        cwd: root,
        env,
        stdio: "ignore",
        timeout: 1_500,
      });
      knownPids = [
        Number(await readFile(parentPidPath, "utf8")),
        ...(await readFile(leafPidPath, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .map(Number),
      ];
      assert.equal(timedOut.status, null);
      assert.equal(timedOut.signal, "SIGTERM");
      assert.equal(timedOut.error?.code, "ETIMEDOUT", timedOut.error?.cause?.stack);
      assert.equal(await invocationCount(), 1);
      assert.deepEqual(await waitUntilNotAlive(knownPids), []);
      assert.equal(pidIsAlive(unrelated.pid), true);

      await writeFile(countPath, "");
      const overflow = runNpmScriptSync("noisy", {
        cwd: root,
        env,
        encoding: "utf8",
        maxBuffer: 4_096,
        timeout: 10_000,
      });
      const noisyPids = [
        Number(await readFile(noisyParentPidPath, "utf8")),
        Number(await readFile(noisyLeafPidPath, "utf8")),
      ];
      knownPids.push(...noisyPids);
      assert.equal(overflow.status, null);
      assert.equal(overflow.signal, "SIGTERM");
      assert.equal(overflow.error?.code, "ENOBUFS", overflow.error?.cause?.stack);
      assert.ok(overflow.stdout.length <= 4_096);
      assert.equal(await invocationCount(), 1);
      assert.deepEqual(await waitUntilNotAlive(noisyPids), []);
    } finally {
      for (const pid of knownPids.filter(pidIsAlive)) {
        process.kill(pid, "SIGKILL");
      }
      if (pidIsAlive(unrelated.pid)) unrelated.kill("SIGKILL");
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
      await rm(controlRoot, { recursive: true, force: true });
    }
  },
);
