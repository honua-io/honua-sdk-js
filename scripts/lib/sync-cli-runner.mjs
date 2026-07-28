#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { PATH_CLI_OWNER_GATE_FLAG } from "./path-cli-runner.mjs";
import {
  assignWindowsJobLease,
  captureProcessIdentity,
  disposeWindowsJobLease,
  observeWindowsJobLease,
  terminateOwnedProcessHandle,
  terminateProcessTree,
  waitForWindowsJobLease,
} from "./process-tree.mjs";

function decodePayload(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function serializableError(error) {
  if (!error) return undefined;
  const nested =
    error instanceof AggregateError
      ? [...error.errors]
          .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
          .filter(Boolean)
      : [];
  return {
    name: error.name,
    message: nested.length > 0 ? `${error.message}: ${nested.join("; ")}` : error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
    spawnargs: error.spawnargs,
  };
}

function writeControl(fd, result) {
  fs.writeSync(fd, JSON.stringify(result), null, "utf8");
}

export async function main(argv = process.argv.slice(2)) {
  const [controlFdValue, payloadValue] = argv;
  const controlFd = Number(controlFdValue);
  if (!Number.isSafeInteger(controlFd) || controlFd < 3 || !payloadValue) {
    throw new Error("Invalid synchronous CLI runner control arguments");
  }
  const payload = decodePayload(payloadValue);
  const childArgs = payload.ownerGate
    ? [payload.args[0], PATH_CLI_OWNER_GATE_FLAG, ...payload.args.slice(1)]
    : payload.args;
  const child = spawn(payload.command, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: [
      "inherit",
      payload.captureStdout ? "pipe" : "inherit",
      payload.captureStderr ? "pipe" : "inherit",
      ...(payload.ownerGate ? ["ipc"] : []),
    ],
    windowsHide: payload.windowsHide === true,
  });
  const identityAbort = new AbortController();
  const identityPromise = captureProcessIdentity(child, { signal: identityAbort.signal });
  void identityPromise.catch(() => undefined);
  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ kind: "spawn-error", error }));
    child.once("close", (status, signal) => resolve({ kind: "exit", status, signal }));
  });
  let resolveOverflow;
  const overflowPromise = new Promise((resolve) => {
    resolveOverflow = resolve;
  });
  let overflowChannel;
  const forwardOutput = (stream, destination, channel) => {
    if (!stream) return;
    let bytes = 0;
    stream.on("data", (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > payload.maxBuffer) {
        if (!overflowChannel) {
          overflowChannel = channel;
          resolveOverflow({ kind: "max-buffer", channel });
        }
        return;
      }
      destination.write(chunk);
    });
  };
  forwardOutput(child.stdout, process.stdout, "stdout");
  forwardOutput(child.stderr, process.stderr, "stderr");

  let timer;
  const timeoutPromise =
    payload.timeout > 0
      ? new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve({ kind: "timeout" });
            identityAbort.abort();
          }, payload.timeout);
        })
      : new Promise(() => {});
  let identity;
  let ownership;
  if (payload.ownerGate) {
    // The bootstrap waits on IPC before it starts the selected PATH shim.
    // Capture its creation identity first; if that cannot be done, its retained
    // process handle is the only owned process that needs to be terminated.
    const identityOutcome = await Promise.race([
      identityPromise.then(
        (value) => ({ kind: "identity", value }),
        (error) => ({ kind: "identity-error", error }),
      ),
      exitPromise,
      timeoutPromise,
    ]);
    if (identityOutcome.kind === "timeout" || identityOutcome.kind === "identity-error") {
      if (identityOutcome.kind === "identity-error" && payload.timeout <= 0) {
        let error = identityOutcome.error;
        try {
          await terminateOwnedProcessHandle(child, {
            signal: "SIGKILL",
            timeoutMs: Math.min(payload.terminationTimeout, 500),
          });
        } catch (cleanupError) {
          error = new AggregateError(
            [identityOutcome.error, cleanupError],
            "Windows owner bootstrap cleanup failed",
          );
        }
        clearTimeout(timer);
        writeControl(controlFd, {
          kind: "runner-error",
          pid: child.pid,
          error: serializableError(error),
        });
        return;
      }
      let primary = identityOutcome;
      if (identityOutcome.kind === "identity-error" && payload.timeout > 0) {
        primary = await Promise.race([timeoutPromise, exitPromise]);
      }
      if (primary.kind === "exit" || primary.kind === "spawn-error") {
        clearTimeout(timer);
        writeControl(controlFd, {
          ...primary,
          pid: child.pid,
          error: serializableError(primary.error),
        });
        return;
      }

      let terminationError =
        identityOutcome.kind === "identity-error" ? identityOutcome.error : undefined;
      try {
        await terminateOwnedProcessHandle(child, {
          signal: "SIGKILL",
          timeoutMs: Math.min(payload.terminationTimeout, 500),
        });
      } catch (error) {
        terminationError = terminationError
          ? new AggregateError(
              [terminationError, error],
              "Windows owner bootstrap cleanup failed",
            )
          : error;
      }
      clearTimeout(timer);
      writeControl(controlFd, {
        kind: "timeout",
        pid: child.pid,
        signal: payload.killSignal,
        terminationError: serializableError(terminationError),
      });
      return;
    }
    if (identityOutcome.kind === "exit" || identityOutcome.kind === "spawn-error") {
      clearTimeout(timer);
      writeControl(controlFd, {
        ...identityOutcome,
        pid: child.pid,
        error: serializableError(identityOutcome.error),
      });
      return;
    }
    identity = identityOutcome.value;
    const assignment = await Promise.race([
      assignWindowsJobLease(child, identity, {
        assignmentTimeoutMs: Math.min(
          payload.terminationTimeout,
          payload.timeout > 0 ? payload.timeout : payload.terminationTimeout,
        ),
        terminationTimeoutMs: payload.terminationTimeout,
        signal: identityAbort.signal,
      }).then(
        (value) => ({ kind: "assigned", value }),
        (error) => ({ kind: "assignment-error", error }),
      ),
      exitPromise,
      timeoutPromise,
    ]);
    if (assignment.kind !== "assigned") {
      clearTimeout(timer);
      let error = assignment.error;
      try {
        await terminateOwnedProcessHandle(child, {
          signal: "SIGKILL",
          timeoutMs: Math.min(payload.terminationTimeout, 500),
        });
      } catch (cleanupError) {
        error = error
          ? new AggregateError(
              [error, cleanupError],
              "Windows Job Object assignment cleanup failed",
            )
          : cleanupError;
      }
      if (assignment.kind === "timeout") {
        writeControl(controlFd, {
          kind: "timeout",
          pid: child.pid,
          signal: payload.killSignal,
          terminationError: serializableError(error),
        });
      } else if (assignment.kind === "exit" || assignment.kind === "spawn-error") {
        writeControl(controlFd, {
          ...assignment,
          pid: child.pid,
          error: serializableError(assignment.error ?? error),
        });
      } else {
        writeControl(controlFd, {
          kind: "runner-error",
          pid: child.pid,
          error: serializableError(error),
        });
      }
      return;
    }
    ownership = assignment.value;
    try {
      await new Promise((resolve, reject) => {
        child.send({ kind: "launch" }, (error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      clearTimeout(timer);
      let launchError = error;
      try {
        await disposeWindowsJobLease(ownership, {
          timeoutMs: payload.terminationTimeout,
        });
      } catch (cleanupError) {
        launchError = new AggregateError(
          [error, cleanupError],
          "Windows owner launch and cleanup failed",
        );
      }
      writeControl(controlFd, {
        kind: "runner-error",
        pid: child.pid,
        error: serializableError(launchError),
      });
      return;
    }
  }

  const jobOutcomePromise = ownership
    ? observeWindowsJobLease(ownership).then(
        (value) => ({ kind: "job-drained", value }),
        (error) => ({ kind: "keeper-error", error }),
      )
    : new Promise(() => {});
  let outcome = await Promise.race([
    exitPromise,
    timeoutPromise,
    overflowPromise,
    jobOutcomePromise,
  ]);
  if (outcome.kind === "job-drained") {
    try {
      await waitForWindowsJobLease(ownership, {
        timeoutMs: payload.terminationTimeout,
      });
      outcome = await exitPromise;
    } catch (error) {
      outcome = { kind: "keeper-error", error };
    }
  }
  clearTimeout(timer);

  if (outcome.kind === "timeout" || outcome.kind === "max-buffer") {
    identity ??= await identityPromise;
    let terminationError;
    try {
      const termination = await terminateProcessTree(child, ownership ?? identity, {
        signal: payload.killSignal,
        timeoutMs: payload.terminationTimeout,
      });
      if (termination.activeProcesses !== undefined && termination.activeProcesses !== 0) {
        throw new Error("Windows Job Object retained active processes");
      }
    } catch (error) {
      terminationError = error;
    }
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, payload.terminationTimeout))]);
    writeControl(controlFd, {
      kind: "timeout",
      ...(outcome.kind === "max-buffer" ? { kind: "max-buffer", channel: outcome.channel } : {}),
      pid: child.pid,
      signal: payload.killSignal,
      terminationError: serializableError(terminationError),
      jobActiveProcesses: terminationError ? undefined : 0,
    });
    return;
  }

  if (outcome.kind === "keeper-error") {
    let error = outcome.error;
    try {
      await disposeWindowsJobLease(ownership, {
        timeoutMs: payload.terminationTimeout,
      });
    } catch (cleanupError) {
      if (cleanupError !== error) {
        error = new AggregateError(
          [error, cleanupError],
          "Windows Job Object keeper cleanup failed",
        );
      }
    }
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, payload.terminationTimeout)),
    ]);
    writeControl(controlFd, {
      kind: "runner-error",
      pid: child.pid,
      error: serializableError(error),
    });
    return;
  }

  if (ownership) {
    try {
      const disposed = await disposeWindowsJobLease(ownership, {
        timeoutMs: payload.terminationTimeout,
      });
      if (disposed.activeProcesses !== 0) {
        throw new Error("Windows Job Object retained active processes");
      }
    } catch (error) {
      writeControl(controlFd, {
        kind: "runner-error",
        pid: child.pid,
        error: serializableError(error),
      });
      return;
    }
  }
  await identityPromise.catch(() => undefined);
  writeControl(controlFd, {
    ...outcome,
    pid: child.pid,
    error: serializableError(outcome.error),
    ...(ownership ? { jobActiveProcesses: 0 } : {}),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    try {
      const fd = Number(process.argv[2]);
      if (Number.isSafeInteger(fd) && fd >= 3) {
        writeControl(fd, { kind: "runner-error", error: serializableError(error) });
      }
    } finally {
      process.exitCode = 1;
    }
  });
}
