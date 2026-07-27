import { spawn } from "node:child_process";

import { windowsPowerShellPath } from "./windows-path-cli.mjs";

const IDENTITY_TIMEOUT_MS = 5_000;
const TERMINATION_TIMEOUT_MS = 5_000;

function encodedPowerShell(source) {
  return Buffer.from(source, "utf16le").toString("base64");
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
  } catch {
    if (child.exitCode !== null || child.signalCode !== null) return undefined;
    throw new Error(`Unable to capture process identity for PID ${child.pid}`);
  }
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

export async function terminateProcessTree(
  child,
  identity,
  { platform = process.platform, signal = "SIGTERM", timeoutMs = TERMINATION_TIMEOUT_MS } = {},
) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return { state: "already-exited" };
  }
  if (platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    return { state: "signaled" };
  }
  if (!identity || identity.pid !== child.pid) {
    throw new Error(`Refusing to terminate Windows PID ${child.pid} without its creation identity`);
  }
  const output = await runPowerShell(windowsTerminationSource(identity, timeoutMs), {
    timeoutMs: timeoutMs + 1_000,
  });
  const result = JSON.parse(output);
  const closed = await waitForChildClose(child, Math.min(timeoutMs, 2_000));
  if (!closed) {
    throw new Error(`Windows process tree rooted at PID ${child.pid} did not close`);
  }
  return result;
}
