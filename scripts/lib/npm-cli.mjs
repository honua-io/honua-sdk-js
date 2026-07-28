import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertWindowsBatchBoundaryValue,
  resolveWindowsPathCommand,
} from "./windows-path-cli.mjs";

const LIB_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PATH_CLI_RUNNER = path.join(LIB_DIRECTORY, "path-cli-runner.mjs");
const SYNC_CLI_RUNNER = path.join(LIB_DIRECTORY, "sync-cli-runner.mjs");
const WINDOWS_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

function assertStringArguments(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("CLI arguments must be an array of strings");
  }
}

function assertNpmScriptName(script) {
  if (typeof script !== "string" || !/^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/.test(script)) {
    throw new TypeError("npm script names must contain only lowercase alphanumerics, hyphens, and colons");
  }
}

function assertNpmBinName(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new TypeError("npm bin names must contain only lowercase alphanumerics and hyphens");
  }
}

/**
 * Construct a shell-free PATH command invocation.
 *
 * On Windows, resolve the exact first PATH entry up front so a host build-lock
 * shim remains authoritative. A small Node runner owns the resulting process
 * tree and applies Windows cmd-shim argv escaping because supported Node
 * releases reject direct .cmd spawn with EINVAL.
 */
function cliInvocation(
  name,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    execPath = process.execPath,
    platform = process.platform,
    existsSync,
    statSync,
  } = {},
) {
  assertStringArguments(args);

  if (platform !== "win32") {
    return {
      command: name,
      args: [...args],
    };
  }

  const resolved = resolveWindowsPathCommand(name, {
    cwd,
    env,
    ...(existsSync ? { existsSync } : {}),
    ...(statSync ? { statSync } : {}),
  });
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    for (let index = 0; index < args.length; index += 1) {
      assertWindowsBatchBoundaryValue(args[index], `argument ${index + 1}`);
    }
  }
  return {
    command: execPath,
    args: [PATH_CLI_RUNNER, resolved, ...args],
  };
}

export function npmInvocation(args, runtime = {}) {
  return cliInvocation("npm", args, runtime);
}

export function npxInvocation(args, runtime = {}) {
  return cliInvocation("npx", args, runtime);
}

export function npmExecLocalArgs(name, args = []) {
  assertNpmBinName(name);
  assertStringArguments(args);
  return ["exec", "--offline", "--yes=false", "--ignore-scripts", "--", name, ...args];
}

export function npmScriptInvocation(
  script,
  { cwd = process.cwd(), env = process.env, platform = process.platform, silent = true, ...runtime } = {},
) {
  assertNpmScriptName(script);
  if (typeof silent !== "boolean") {
    throw new TypeError("npm script silent mode must be a boolean");
  }
  return cliInvocation("npm", ["run", script, ...(silent ? ["--silent"] : [])], { cwd, env, platform, ...runtime });
}

function expandedStdio(stdio) {
  if (Array.isArray(stdio)) return [...stdio];
  if (stdio === undefined || stdio === "pipe") return ["pipe", "pipe", "pipe"];
  if (stdio === "ignore") return ["ignore", "ignore", "ignore"];
  if (stdio === "inherit") return ["inherit", "inherit", "inherit"];
  throw new TypeError(`Unsupported synchronous stdio mode: ${String(stdio)}`);
}

function deserializeError(serialized, fallbackMessage) {
  const error = new Error(serialized?.message ?? fallbackMessage);
  if (serialized?.name) error.name = serialized.name;
  for (const property of ["code", "errno", "syscall", "path", "spawnargs"]) {
    if (serialized?.[property] !== undefined) error[property] = serialized[property];
  }
  return error;
}

function parseControlOutput(value, encoding) {
  if (value === null || value === undefined) return undefined;
  const text = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : Buffer.from(
        String(value),
        typeof encoding === "string" && encoding !== "buffer" ? encoding : "utf8",
      ).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Windows synchronous CLI runner returned invalid control data", {
      cause: error,
    });
  }
}

function runWindowsCliSync(invocation, options, runtime) {
  // spawnSync cannot notify JavaScript when an AbortSignal fires. Forwarding
  // the signal would let Node kill only this helper and orphan the owned tree,
  // so reject it before any process exists. Timeouts and output limits are
  // enforced inside sync-cli-runner, which owns and terminates the whole tree.
  if (options.signal !== undefined) {
    throw new TypeError("Windows synchronous npm CLI helpers reject AbortSignal before launch");
  }
  const spawn = runtime.spawnSync ?? spawnSync;
  const stdio = expandedStdio(options.stdio);
  while (stdio.length < 3) stdio.push("pipe");
  const controlFd = stdio.length;
  stdio.push("pipe");
  const timeout = options.timeout ?? 0;
  const killSignal = options.killSignal ?? "SIGTERM";
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new TypeError("timeout must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
    throw new TypeError("maxBuffer must be a nonnegative safe integer");
  }
  const payload = Buffer.from(
    JSON.stringify({
      command: invocation.command,
      args: invocation.args,
      timeout,
      killSignal,
      terminationTimeout: runtime.terminationTimeout ?? WINDOWS_TERMINATION_TIMEOUT_MS,
      windowsHide: options.windowsHide === true,
      maxBuffer,
      captureStdout: stdio[1] === "pipe" || stdio[1] == null,
      captureStderr: stdio[2] === "pipe" || stdio[2] == null,
      ownerGate: true,
    }),
    "utf8",
  ).toString("base64");
  const {
    timeout: _timeout,
    killSignal: _killSignal,
    shell: _shell,
    signal: _signal,
    stdio: _stdio,
    maxBuffer: _maxBuffer,
    ...forwardedOptions
  } = options;
  const outer = spawn(runtime.execPath ?? process.execPath, [SYNC_CLI_RUNNER, String(controlFd), payload], {
    ...forwardedOptions,
    maxBuffer: Math.min(Number.MAX_SAFE_INTEGER, maxBuffer + DEFAULT_MAX_BUFFER),
    shell: false,
    stdio,
  });
  if (outer.error) return outer;

  const control = parseControlOutput(outer.output?.[controlFd], options.encoding);
  const output = outer.output?.slice(0, controlFd);
  const result = {
    ...outer,
    output,
    stdout: output?.[1] ?? null,
    stderr: output?.[2] ?? null,
    pid: control?.pid ?? outer.pid,
    ...(control?.jobActiveProcesses !== undefined
      ? { jobActiveProcesses: control.jobActiveProcesses }
      : {}),
  };
  if (!control) {
    return {
      ...result,
      status: null,
      signal: null,
      error: new Error("Windows synchronous CLI runner returned no control data"),
    };
  }
  if (control.kind === "exit") {
    return {
      ...result,
      status: control.status,
      signal: control.signal,
      error: undefined,
    };
  }
  if (control.kind === "spawn-error") {
    return {
      ...result,
      status: null,
      signal: null,
      error: deserializeError(control.error, `spawnSync ${invocation.command} failed`),
    };
  }
  if (control.kind === "timeout") {
    const error = deserializeError(
      {
        name: "Error",
        message: `spawnSync ${invocation.command} ETIMEDOUT`,
        code: "ETIMEDOUT",
        syscall: `spawnSync ${invocation.command}`,
      },
      `spawnSync ${invocation.command} ETIMEDOUT`,
    );
    if (control.terminationError) {
      error.cause = deserializeError(control.terminationError, "Windows process-tree termination failed");
    }
    return {
      ...result,
      status: null,
      signal: control.signal,
      error,
    };
  }
  if (control.kind === "max-buffer") {
    const error = deserializeError(
      {
        name: "Error",
        message: `spawnSync ${invocation.command} ENOBUFS`,
        code: "ENOBUFS",
        syscall: `spawnSync ${invocation.command}`,
      },
      `spawnSync ${invocation.command} ENOBUFS`,
    );
    if (control.terminationError) {
      error.cause = deserializeError(control.terminationError, "Windows process-tree termination failed");
    }
    return {
      ...result,
      status: null,
      signal: control.signal,
      error,
    };
  }
  return {
    ...result,
    status: null,
    signal: null,
    error: deserializeError(control.error, "Windows synchronous CLI runner failed"),
  };
}

function runCliSync(invocation, options, runtime) {
  if (options.shell && options.shell !== false) {
    throw new TypeError("npm CLI helpers do not allow shell execution");
  }
  if ((runtime.platform ?? process.platform) === "win32") {
    return runWindowsCliSync(invocation, options, runtime);
  }
  const spawn = runtime.spawnSync ?? spawnSync;
  return spawn(invocation.command, invocation.args, {
    ...options,
    shell: false,
  });
}

function invocationRuntime(options, runtime) {
  return {
    ...runtime,
    cwd: options.cwd ?? runtime.cwd ?? process.cwd(),
    env: options.env ?? runtime.env ?? process.env,
  };
}

export function runNpmSync(args, options = {}, runtime = {}) {
  const selectedRuntime = invocationRuntime(options, runtime);
  return runCliSync(npmInvocation(args, selectedRuntime), options, selectedRuntime);
}

export function runNpxSync(args, options = {}, runtime = {}) {
  const selectedRuntime = invocationRuntime(options, runtime);
  return runCliSync(npxInvocation(args, selectedRuntime), options, selectedRuntime);
}

export function runNpmScriptSync(script, options = {}, runtime = {}) {
  const selectedRuntime = invocationRuntime(options, runtime);
  return runCliSync(npmScriptInvocation(script, selectedRuntime), options, selectedRuntime);
}
