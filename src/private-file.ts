import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Refuse credential destinations that could redirect writes outside the selected path. */
export async function assertPrivateFileTarget(filePath: string): Promise<void> {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink()) throw new Error(`Refusing to replace symbolic-link credential file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Establish the platform's owner-only access boundary before credential bytes are written. */
export async function restrictPrivateFile(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    const handle = await open(filePath, "r+");
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  const directory = path.dirname(filePath);
  const sid = await windowsOwnerSid(directory);
  const acl = await runCommand("icacls", [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`], directory);
  if (acl.exitCode !== 0) throw new Error(`Could not establish an owner-only Windows ACL: ${acl.stderr || acl.stdout}`);
}

/** Prove that a credential path is regular and accessible only by the current owner. */
export async function verifyPrivateFile(filePath: string): Promise<void> {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Credential path is not a private regular file: ${filePath}`);
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error(`Credential file permissions are not owner-only: ${filePath}`);
    }
    return;
  }

  const directory = path.dirname(filePath);
  const sid = await windowsOwnerSid(directory);
  const script = [
    "& { param([string]$credentialPath, [string]$expectedSid)",
    "$acl = Get-Acl -LiteralPath $credentialPath",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "$full = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "$valid = $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and " +
      "$rules[0].IdentityReference.Value -eq $expectedSid -and -not $rules[0].IsInherited -and " +
      "$rules[0].AccessControlType -eq $allow -and (($rules[0].FileSystemRights -band $full) -eq $full)",
    "if (-not $valid) { Write-Error 'private ACL mismatch'; exit 1 }",
    "}",
  ].join("; ");
  const result = await runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath, sid],
    directory,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Windows credential ACL is not owner-only: ${result.stderr || result.stdout}`);
  }
}

/** Persist a secret-bearing file through an owner-only same-directory atomic replacement. */
export async function writePrivateFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await assertPrivateFileTarget(filePath);
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await restrictPrivateFile(temporary);
    await verifyPrivateFile(temporary);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertPrivateFileTarget(filePath);
    await rename(temporary, filePath);
    await verifyPrivateFile(filePath);
    await syncPrivateFileDirectory(filePath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function syncPrivateFileDirectory(filePath: string): Promise<void> {
  if (process.platform === "win32") return;
  const directoryHandle = await open(path.dirname(filePath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function windowsOwnerSid(directory: string): Promise<string> {
  const identity = await runCommand("whoami", ["/user", "/fo", "csv", "/nh"], directory);
  const sid = identity.stdout.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
  if (identity.exitCode !== 0 || !sid) throw new Error("Could not resolve the Windows owner SID for a private file.");
  return sid;
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}
