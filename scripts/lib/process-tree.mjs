import { spawn } from "node:child_process";

import { windowsPowerShellPath } from "./windows-path-cli.mjs";

const IDENTITY_TIMEOUT_MS = 5_000;
const JOB_ASSIGNMENT_TIMEOUT_MS = 5_000;
const TERMINATION_TIMEOUT_MS = 5_000;
const JOB_PROTOCOL_MAX_BYTES = 4_096;
const WINDOWS_JOB_OWNERSHIP_KIND = "honua.windows-job-ownership.v1";
const windowsJobLeaseStates = new WeakMap();

function encodedPowerShell(source) {
  return Buffer.from(source, "utf16le").toString("base64");
}

function boundedTimeout(value, fallback = TERMINATION_TIMEOUT_MS) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 60_000) : fallback;
}

function runPowerShell(source, { timeoutMs, windowsHide = true, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Windows process-tree helper was aborted");
      error.code = "ABORT_ERR";
      reject(error);
      return;
    }
    const child = spawn(
      windowsPowerShellPath(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-InputFormat",
        "None",
        "-OutputFormat",
        "Text",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedPowerShell(source),
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide,
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      const error = new Error("Windows process-tree helper was aborted");
      error.code = "ABORT_ERR";
      reject(error);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`Windows process-tree helper exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exited ${code}`));
    });
  });
}

export async function captureProcessIdentity(
  child,
  { platform = process.platform, timeoutMs = IDENTITY_TIMEOUT_MS, signal } = {},
) {
  if (platform !== "win32" || !child.pid) return undefined;
  const source = String.raw`
$ErrorActionPreference = "Stop"
$process = [Diagnostics.Process]::GetProcessById(${child.pid})
$null = $process.Handle
[Console]::Out.WriteLine(
  $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(
    [Globalization.CultureInfo]::InvariantCulture
  )
)
`;
  try {
    const startedAtFileTimeUtc = await runPowerShell(source, { timeoutMs, signal });
    if (!/^[1-9][0-9]+$/.test(startedAtFileTimeUtc)) return undefined;
    return Object.freeze({
      pid: child.pid,
      startedAtFileTimeUtc,
    });
  } catch (error) {
    if (child.exitCode !== null || child.signalCode !== null) return undefined;
    if (error?.code === "ABORT_ERR") throw error;
    throw new Error(`Unable to capture process identity for PID ${child.pid}`);
  }
}

function windowsJobKeeperSource(identity, terminationTimeoutMs) {
  return String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class HonuaWindowsJobKeeper
{
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_SET_QUOTA = 0x0100;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint WAIT_TIMEOUT = 0x00000102;
    private const uint WAIT_FAILED = 0xffffffff;
    private const uint INFINITE = 0xffffffff;
    private const int STD_INPUT_HANDLE = -10;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        internal uint Low;
        internal uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        internal IO_COUNTERS IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        internal long TotalUserTime;
        internal long TotalKernelTime;
        internal long ThisPeriodTotalUserTime;
        internal long ThisPeriodTotalKernelTime;
        internal uint TotalPageFaultCount;
        internal uint TotalProcesses;
        internal uint ActiveProcesses;
        internal uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count,
        [In] IntPtr[] handles,
        bool waitAll,
        uint milliseconds
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static long FileTimeValue(FILETIME value)
    {
        return ((long)value.High << 32) | value.Low;
    }

    private static void WriteAssigned()
    {
        Console.Out.WriteLine("{\"kind\":\"assigned\"}");
        Console.Out.Flush();
    }

    private static void WriteDrained(string reason, uint activeProcesses)
    {
        Console.Out.WriteLine(
            "{\"kind\":\"drained\",\"reason\":\"" + reason +
            "\",\"activeProcesses\":" +
            activeProcesses.ToString(CultureInfo.InvariantCulture) + "}"
        );
        Console.Out.Flush();
    }

    private static void WriteError(string stage, int error)
    {
        Console.Out.WriteLine(
            "{\"kind\":\"error\",\"stage\":\"" + stage +
            "\",\"win32Error\":" + error.ToString(CultureInfo.InvariantCulture) + "}"
        );
        Console.Out.Flush();
    }

    private static int ParseTimeout(string line, int fallback)
    {
        int separator = line.IndexOf(':');
        if (separator < 0) return fallback;
        int parsed;
        if (!Int32.TryParse(
            line.Substring(separator + 1),
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out parsed
        )) return fallback;
        return Math.Max(1, Math.Min(parsed, 60000));
    }

    private static int Drain(IntPtr job, int timeoutMs, out uint activeProcesses)
    {
        int failure = 0;
        if (!TerminateJobObject(job, 1))
        {
            failure = Marshal.GetLastWin32Error();
        }
        uint waited = WaitForSingleObject(job, (uint)Math.Max(1, timeoutMs));
        if (waited == WAIT_FAILED && failure == 0)
        {
            failure = Marshal.GetLastWin32Error();
        }
        else if (waited == WAIT_TIMEOUT && failure == 0)
        {
            failure = 1460;
        }
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
        if (!QueryInformationJobObject(
            job,
            JobObjectBasicAccountingInformation,
            out accounting,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)),
            IntPtr.Zero
        ))
        {
            activeProcesses = UInt32.MaxValue;
            return failure != 0 ? failure : Marshal.GetLastWin32Error();
        }
        activeProcesses = accounting.ActiveProcesses;
        if (activeProcesses != 0 && failure == 0) failure = 1460;
        return failure;
    }

    public static int Run(uint processId, long expectedCreation, int defaultTerminationTimeoutMs)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        bool assigned = false;
        string reason = "keeper-failure";
        int drainTimeoutMs = defaultTerminationTimeoutMs;
        int error = 0;
        string errorStage = "keeper";
        uint activeProcesses = UInt32.MaxValue;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                WriteError("create", Marshal.GetLastWin32Error());
                return 20;
            }
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
                new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))
            ))
            {
                WriteError("limits", Marshal.GetLastWin32Error());
                return 21;
            }
            process = OpenProcess(
                PROCESS_TERMINATE | PROCESS_SET_QUOTA |
                PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                false,
                processId
            );
            if (process == IntPtr.Zero)
            {
                WriteError("identity", Marshal.GetLastWin32Error());
                return 22;
            }
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            {
                WriteError("identity", Marshal.GetLastWin32Error());
                return 23;
            }
            if (
                FileTimeValue(creation) != expectedCreation ||
                WaitForSingleObject(process, 0) != WAIT_TIMEOUT
            )
            {
                WriteError("identity", 0);
                return 24;
            }
            if (!AssignProcessToJobObject(job, process))
            {
                WriteError("assign", Marshal.GetLastWin32Error());
                return 25;
            }
            assigned = true;
            WriteAssigned();

            IntPtr input = GetStdHandle(STD_INPUT_HANDLE);
            if (input == IntPtr.Zero || input == new IntPtr(-1))
            {
                errorStage = "control";
                error = Marshal.GetLastWin32Error();
            }
            else
            {
                IntPtr[] handles = new IntPtr[] { process, input };
                uint waited = WaitForMultipleObjects(2, handles, false, INFINITE);
                if (waited == WAIT_OBJECT_0)
                {
                    reason = "root-exit";
                }
                else if (waited == WAIT_OBJECT_0 + 1)
                {
                    string line = Console.In.ReadLine();
                    if (line == null)
                    {
                        reason = "parent-eof";
                    }
                    else if (line == "dispose" || line.StartsWith("dispose:", StringComparison.Ordinal))
                    {
                        reason = "dispose";
                        drainTimeoutMs = ParseTimeout(line, defaultTerminationTimeoutMs);
                    }
                    else if (line == "terminate" || line.StartsWith("terminate:", StringComparison.Ordinal))
                    {
                        reason = "terminate";
                        drainTimeoutMs = ParseTimeout(line, defaultTerminationTimeoutMs);
                    }
                    else
                    {
                        errorStage = "control";
                        error = 87;
                    }
                }
                else
                {
                    errorStage = "wait";
                    error = waited == WAIT_FAILED ? Marshal.GetLastWin32Error() : 87;
                }
            }
        }
        catch
        {
            errorStage = "keeper";
            error = 1;
        }
        finally
        {
            if (assigned && job != IntPtr.Zero)
            {
                int drainError = Drain(job, drainTimeoutMs, out activeProcesses);
                if (error == 0 && drainError != 0)
                {
                    errorStage = "drain";
                    error = drainError;
                }
            }
            if (process != IntPtr.Zero) CloseHandle(process);
            if (job != IntPtr.Zero) CloseHandle(job);
        }

        if (error != 0)
        {
            WriteError(errorStage, error);
            return 26;
        }
        WriteDrained(reason, activeProcesses);
        return 0;
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
exit [HonuaWindowsJobKeeper]::Run(
  [uint32]${identity.pid},
  [long]${identity.startedAtFileTimeUtc},
  [int]${terminationTimeoutMs}
)
`;
}

function jobProtocolError(message, details = {}) {
  const error = new Error(message);
  error.code = "ERR_WINDOWS_JOB_OBJECT";
  if (details.stage) error.stage = details.stage;
  if (Number.isSafeInteger(details.win32Error)) error.errno = details.win32Error;
  return error;
}

function promiseWithTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(jobProtocolError(message));
    }, boundedTimeout(timeoutMs) + 1_000);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function waitForChildClose(child, timeoutMs) {
  const streamsClosed = child.stdio.filter(Boolean).every((stream) => stream.destroyed || stream.closed);
  if ((child.exitCode !== null || child.signalCode !== null) && streamsClosed) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

export function isWindowsJobOwnership(value) {
  return (
    value?.kind === WINDOWS_JOB_OWNERSHIP_KIND &&
    windowsJobLeaseStates.has(value)
  );
}

export async function assignWindowsJobLease(
  child,
  identity,
  {
    platform = process.platform,
    assignmentTimeoutMs = JOB_ASSIGNMENT_TIMEOUT_MS,
    terminationTimeoutMs = TERMINATION_TIMEOUT_MS,
    signal,
    spawnImpl = spawn,
    powerShellPath,
  } = {},
) {
  if (platform !== "win32") return identity;
  if (
    !child.pid ||
    !identity ||
    identity.pid !== child.pid ||
    !/^[1-9][0-9]+$/.test(identity.startedAtFileTimeUtc)
  ) {
    throw jobProtocolError("Refusing to assign a Windows process without its exact creation identity", {
      stage: "identity",
    });
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    throw jobProtocolError("Windows owner exited before Job Object assignment", {
      stage: "identity",
    });
  }
  if (signal?.aborted) {
    const error = jobProtocolError("Windows Job Object assignment was aborted", {
      stage: "assign",
    });
    error.code = "ABORT_ERR";
    throw error;
  }

  const keeper = spawnImpl(
    powerShellPath ?? windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "None",
      "-OutputFormat",
      "Text",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedPowerShell(
        windowsJobKeeperSource(identity, boundedTimeout(terminationTimeoutMs)),
      ),
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  const ownership = Object.freeze({
    kind: WINDOWS_JOB_OWNERSHIP_KIND,
    pid: identity.pid,
    startedAtFileTimeUtc: identity.startedAtFileTimeUtc,
  });
  let protocolBytes = 0;
  let protocolBuffer = "";
  let assigned = false;
  let terminalMessage;
  let assignmentSettled = false;
  let completionSettled = false;
  let resolveAssignment;
  let rejectAssignment;
  let resolveCompletion;
  let rejectCompletion;
  const assignment = new Promise((resolve, reject) => {
    resolveAssignment = resolve;
    rejectAssignment = reject;
  });
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completion.catch(() => undefined);
  const rejectPending = (error) => {
    if (!assignmentSettled) {
      assignmentSettled = true;
      rejectAssignment(error);
    }
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(error);
    }
  };
  const parseMessage = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      rejectPending(jobProtocolError("Windows Job Object keeper returned invalid control data"));
      keeper.kill("SIGKILL");
      return;
    }
    if (message?.kind === "assigned" && !assigned) {
      assigned = true;
      if (!assignmentSettled) {
        assignmentSettled = true;
        resolveAssignment();
      }
      return;
    }
    if (
      message?.kind === "drained" &&
      assigned &&
      message.activeProcesses === 0
    ) {
      terminalMessage = Object.freeze({
        state: "terminated",
        reason: message.reason,
        activeProcesses: 0,
      });
      return;
    }
    if (
      message?.kind === "error" &&
      typeof message.stage === "string" &&
      message.stage.length <= 16 &&
      Number.isSafeInteger(message.win32Error)
    ) {
      const error = jobProtocolError(
        `Windows Job Object ${message.stage} failed (Win32 ${message.win32Error})`,
        message,
      );
      rejectPending(error);
      return;
    }
    rejectPending(jobProtocolError("Windows Job Object keeper returned invalid control data"));
    keeper.kill("SIGKILL");
  };
  keeper.stdout.setEncoding("utf8");
  keeper.stdout.on("data", (chunk) => {
    protocolBytes += Buffer.byteLength(chunk);
    if (protocolBytes > JOB_PROTOCOL_MAX_BYTES) {
      rejectPending(jobProtocolError("Windows Job Object keeper exceeded its control-data limit"));
      keeper.kill("SIGKILL");
      return;
    }
    protocolBuffer += chunk;
    for (;;) {
      const newline = protocolBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = protocolBuffer.slice(0, newline).trim();
      protocolBuffer = protocolBuffer.slice(newline + 1);
      if (line) parseMessage(line);
    }
  });
  keeper.stdin.on("error", () => {
    // Keeper close is authoritative and produces the bounded protocol error.
  });
  keeper.once("error", () => {
    rejectPending(jobProtocolError("Unable to start the Windows Job Object keeper"));
  });
  keeper.once("close", (code) => {
    if (!assignmentSettled) {
      assignmentSettled = true;
      rejectAssignment(jobProtocolError("Windows Job Object keeper exited before assignment"));
    }
    if (completionSettled) return;
    completionSettled = true;
    if (code === 0 && terminalMessage) resolveCompletion(terminalMessage);
    else rejectCompletion(jobProtocolError("Windows Job Object keeper failed before the owned job drained"));
  });
  const state = {
    child,
    keeper,
    completion,
    terminalCommand: undefined,
    terminalPromise: undefined,
  };
  windowsJobLeaseStates.set(ownership, state);

  let assignmentTimer;
  const abortAssignment = () => {
    rejectPending(
      Object.assign(
        jobProtocolError("Windows Job Object assignment was aborted", {
          stage: "assign",
        }),
        { code: "ABORT_ERR" },
      ),
    );
    keeper.kill("SIGKILL");
  };
  const handshake = Promise.race([
    assignment,
    new Promise((_, reject) => {
      assignmentTimer = setTimeout(() => {
        const error = jobProtocolError("Windows Job Object assignment handshake timed out", {
          stage: "assign",
        });
        rejectPending(error);
        keeper.kill("SIGKILL");
        reject(error);
      }, boundedTimeout(assignmentTimeoutMs));
    }),
  ]);
  signal?.addEventListener("abort", abortAssignment, { once: true });
  try {
    await handshake;
    return ownership;
  } finally {
    clearTimeout(assignmentTimer);
    signal?.removeEventListener("abort", abortAssignment);
  }
}

function windowsJobLeaseState(ownership) {
  const state = windowsJobLeaseStates.get(ownership);
  if (!state) {
    throw jobProtocolError("Invalid or expired Windows Job Object ownership token");
  }
  return state;
}

export function observeWindowsJobLease(ownership) {
  return windowsJobLeaseState(ownership).completion;
}

export async function waitForWindowsJobLease(
  ownership,
  { timeoutMs = TERMINATION_TIMEOUT_MS } = {},
) {
  const state = windowsJobLeaseState(ownership);
  const result = await promiseWithTimeout(
    state.completion,
    timeoutMs,
    "Windows Job Object keeper did not report a drained job",
  );
  const closed = await waitForChildClose(
    state.child,
    boundedTimeout(timeoutMs),
  );
  if (!closed) {
    throw jobProtocolError("Windows Job Object drained but the owned process stdio did not close", {
      stage: "stdio",
    });
  }
  return result;
}

async function finishWindowsJobLease(ownership, command, timeoutMs) {
  const state = windowsJobLeaseState(ownership);
  state.terminalPromise ??= (async () => {
    state.terminalCommand = command;
    if (state.keeper.exitCode === null && state.keeper.signalCode === null) {
      await new Promise((resolve, reject) => {
        state.keeper.stdin.write(
          `${command}:${boundedTimeout(timeoutMs)}\n`,
          (error) => (error ? reject(error) : resolve()),
        );
      }).catch(() => {
        // Keeper completion reports whether KILL_ON_JOB_CLOSE drained the job.
      });
    }
    return await waitForWindowsJobLease(ownership, { timeoutMs });
  })();
  return await state.terminalPromise;
}

export async function terminateWindowsJobLease(
  ownership,
  { timeoutMs = TERMINATION_TIMEOUT_MS } = {},
) {
  return await finishWindowsJobLease(ownership, "terminate", timeoutMs);
}

export async function disposeWindowsJobLease(
  ownership,
  { timeoutMs = TERMINATION_TIMEOUT_MS } = {},
) {
  return await finishWindowsJobLease(ownership, "dispose", timeoutMs);
}

/**
 * Terminate only the exact process represented by Node's retained child
 * handle. This is safe for an owner-gated bootstrap that has not launched its
 * target yet: no PID lookup or process-tree traversal is involved.
 */
export async function terminateOwnedProcessHandle(
  child,
  { signal = "SIGKILL", timeoutMs = TERMINATION_TIMEOUT_MS } = {},
) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return { state: "already-exited" };
  }
  const signaled = child.kill(signal);
  if (!signaled && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Unable to signal owned Windows process handle for PID ${child.pid}`);
  }
  const closed = await waitForChildClose(child, timeoutMs);
  if (!closed) {
    throw new Error(`Owned Windows process handle for PID ${child.pid} did not close`);
  }
  return { state: "terminated" };
}

function windowsTerminationSource(identity, timeoutMs) {
  return String.raw`
$ErrorActionPreference = "Stop"
$rootPid = [int]${identity.pid}
$expectedRootStart = [long]${identity.startedAtFileTimeUtc}
$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
$owned = @{}

function Open-ExactProcess([int]$processId, [long]$expectedStart, [int]$parentId, [int]$depth) {
  try {
    $process = [Diagnostics.Process]::GetProcessById($processId)
    $null = $process.Handle
    $started = $process.StartTime.ToUniversalTime().ToFileTimeUtc()
    if ($expectedStart -gt 0 -and $started -ne $expectedStart) {
      $process.Dispose()
      return $null
    }
    return [pscustomobject]@{
      Process = $process
      Pid = $processId
      ParentPid = $parentId
      Started = $started
      Depth = $depth
    }
  } catch {
    return $null
  }
}

$root = Open-ExactProcess $rootPid $expectedRootStart 0 0
if ($null -eq $root) {
  [Console]::Out.WriteLine('{"state":"already-exited","captured":0,"survivors":0}')
  exit 0
}
$owned[$rootPid] = $root
$rootKilled = $false
$stablePasses = 0

while ([DateTime]::UtcNow -lt $deadline -and $stablePasses -lt 2) {
  $snapshot = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
  $addedThisPass = 0
  $madeProgress = $true
  while ($madeProgress) {
    $madeProgress = $false
    foreach ($entry in $snapshot) {
      $candidatePid = [int]$entry.ProcessId
      $parentPid = [int]$entry.ParentProcessId
      if ($owned.ContainsKey($candidatePid) -or -not $owned.ContainsKey($parentPid)) {
        continue
      }
      $parent = $owned[$parentPid]
      $candidate = Open-ExactProcess $candidatePid 0 $parentPid ($parent.Depth + 1)
      if ($null -eq $candidate) {
        continue
      }
      $creation = $entry.CreationDate.ToUniversalTime().ToFileTimeUtc()
      # CIM rounds the same kernel creation timestamp by a few 100ns ticks.
      # A ten-tick comparison keeps the identity check below one microsecond.
      if (
        [Math]::Abs($candidate.Started - $creation) -gt 10 -or
        $candidate.Started -lt $parent.Started
      ) {
        $candidate.Process.Dispose()
        continue
      }
      if ($parent.Process.HasExited) {
        $parentExit = $parent.Process.ExitTime.ToUniversalTime().ToFileTimeUtc()
        if ($candidate.Started -gt $parentExit) {
          $candidate.Process.Dispose()
          continue
        }
      }
      $owned[$candidatePid] = $candidate
      $addedThisPass += 1
      $madeProgress = $true
    }
  }

  if (-not $rootKilled) {
    try {
      if (-not $root.Process.HasExited) {
        $root.Process.Kill()
      }
    } catch {
      if (-not $root.Process.HasExited) { throw }
    }
    $rootKilled = $true
  }

  foreach ($record in @($owned.Values | Sort-Object Depth -Descending)) {
    try {
      if (-not $record.Process.HasExited) {
        $record.Process.Kill()
      }
    } catch {
      if (-not $record.Process.HasExited) { throw }
    }
  }

  foreach ($record in @($owned.Values)) {
    if ([DateTime]::UtcNow -ge $deadline) { break }
    if (-not $record.Process.HasExited) {
      $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
      $record.Process.WaitForExit([Math]::Min(250, $remaining)) | Out-Null
    }
  }
  if ($addedThisPass -eq 0) {
    $stablePasses += 1
  } else {
    $stablePasses = 0
  }
  if ($stablePasses -lt 2) {
    Start-Sleep -Milliseconds 50
  }
}

$survivors = @($owned.Values | Where-Object { -not $_.Process.HasExited })
foreach ($record in @($owned.Values)) {
  $record.Process.Dispose()
}
if ($survivors.Count -gt 0) {
  throw "Exact Windows process tree retained $($survivors.Count) survivor(s)"
}
[Console]::Out.WriteLine(
  '{"state":"terminated","captured":' + $owned.Count + ',"survivors":0}'
)
`;
}

export async function terminateProcessTree(
  child,
  ownership,
  { platform = process.platform, signal = "SIGTERM", timeoutMs = TERMINATION_TIMEOUT_MS } = {},
) {
  if (!child.pid) return { state: "already-exited" };
  if (platform !== "win32") {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { state: "already-exited" };
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return { state: "signaled" };
  }
  if (isWindowsJobOwnership(ownership)) {
    if (ownership.pid !== child.pid) {
      throw jobProtocolError("Windows Job Object ownership token does not match the owned process");
    }
    return await terminateWindowsJobLease(ownership, { timeoutMs });
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { state: "already-exited" };
  }
  if (!ownership || ownership.pid !== child.pid) {
    throw new Error(`Refusing to terminate Windows PID ${child.pid} without its creation identity`);
  }
  const output = await runPowerShell(windowsTerminationSource(ownership, timeoutMs), {
    timeoutMs: timeoutMs + 1_000,
  });
  const result = JSON.parse(output);
  const closed = await waitForChildClose(child, Math.min(timeoutMs, 2_000));
  if (!closed) {
    throw new Error(`Windows process tree rooted at PID ${child.pid} did not close`);
  }
  return result;
}
