import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface PrivateFileWriteHooks {
  readonly afterPrepared?: () => Promise<void>;
  readonly afterRename?: () => Promise<void>;
  readonly afterVerify?: () => Promise<void>;
}

interface PrivateFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

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

  const system32 = await trustedWindowsSystem32();
  const sid = await windowsOwnerSid(system32);
  const icacls = await trustedWindowsExecutable(system32, "icacls.exe");
  const acl = await runCommand(icacls, [filePath, "/inheritance:r", "/grant:r", `*${sid}:(F)`], system32);
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

  const system32 = await trustedWindowsSystem32();
  const sid = await windowsOwnerSid(system32);
  const script = windowsAclVerificationScript();
  const powershell = await trustedWindowsExecutable(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await runCommand(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath, sid],
    system32,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Windows credential ACL is not owner-only: ${result.stderr || result.stdout}`);
  }
}

/** Synchronous read-side verification for the existing synchronous CLI config contract. */
export function verifyPrivateFileSync(filePath: string): void {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Credential path is not a private regular file: ${filePath}`);
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error(`Credential file permissions are not owner-only: ${filePath}`);
    }
    return;
  }

  const system32 = trustedWindowsSystem32Sync();
  const sid = windowsOwnerSidSync(system32);
  const powershell = trustedWindowsExecutableSync(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = windowsAclVerificationScript();
  const result = runCommandSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath, sid],
    system32,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Windows credential ACL is not owner-only: ${result.stderr || result.stdout}`);
  }
}

/** Persist a secret-bearing file through an owner-only same-directory atomic replacement. */
export async function writePrivateFileAtomic(
  filePath: string,
  content: string,
  hooks: PrivateFileWriteHooks = {},
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await assertPrivateFileTarget(filePath);
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${randomBytes(16).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let installedIdentity: PrivateFileIdentity | undefined;
  let completed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    installedIdentity = await handleIdentity(handle);
    await restrictPrivateFile(temporary);
    await verifyPrivateFile(temporary);
    await requirePrivateFileIdentity(temporary, installedIdentity, 1n);
    await hooks.afterPrepared?.();
    await requirePrivateFileIdentity(temporary, installedIdentity, 1n);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await requirePrivateFileIdentity(temporary, installedIdentity, 1n);
    await handle.close();
    handle = undefined;
    await assertPrivateFileTarget(filePath);
    await requirePrivateFileIdentity(temporary, installedIdentity, 1n);
    await rename(temporary, filePath);
    await hooks.afterRename?.();
    await verifyPrivateFile(filePath);
    await requirePrivateFileIdentity(filePath, installedIdentity, 1n);
    await hooks.afterVerify?.();
    await syncPrivateFileDirectory(filePath);
    completed = true;
  } finally {
    await handle?.close().catch(() => {});
    if (!completed && installedIdentity && (await hasPrivateFileIdentity(filePath, installedIdentity))) {
      await rm(filePath, { force: true }).catch(() => {});
      await syncPrivateFileDirectory(filePath).catch(() => {});
    }
    if (installedIdentity && (await hasPrivateFileIdentity(temporary, installedIdentity))) {
      await rm(temporary, { force: true }).catch(() => {});
    }
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

async function trustedWindowsSystem32(): Promise<string> {
  const systemRoot = process.env.SystemRoot;
  const windowsDirectory = process.env.WINDIR;
  if (
    !systemRoot ||
    !windowsDirectory ||
    !path.win32.isAbsolute(systemRoot) ||
    !path.win32.isAbsolute(windowsDirectory)
  ) {
    throw new Error("Could not resolve the trusted Windows system directory for private-file enforcement.");
  }
  const [resolvedRoot, resolvedWindows] = await Promise.all([realpath(systemRoot), realpath(windowsDirectory)]);
  if (resolvedRoot.toLowerCase() !== resolvedWindows.toLowerCase()) {
    throw new Error("Windows system-directory environment values do not identify the same trusted root.");
  }
  const system32 = await realpath(path.join(resolvedRoot, "System32"));
  if (path.dirname(system32).toLowerCase() !== resolvedRoot.toLowerCase()) {
    throw new Error("The Windows System32 directory escaped the trusted system root.");
  }
  const kernel = await lstat(path.join(system32, "kernel32.dll"));
  if (!kernel.isFile()) throw new Error("The trusted Windows system directory is incomplete.");
  return system32;
}

function trustedWindowsSystem32Sync(): string {
  const systemRoot = process.env.SystemRoot;
  const windowsDirectory = process.env.WINDIR;
  if (
    !systemRoot ||
    !windowsDirectory ||
    !path.win32.isAbsolute(systemRoot) ||
    !path.win32.isAbsolute(windowsDirectory)
  ) {
    throw new Error("Could not resolve the trusted Windows system directory for private-file enforcement.");
  }
  const resolvedRoot = realpathSync(systemRoot);
  const resolvedWindows = realpathSync(windowsDirectory);
  if (resolvedRoot.toLowerCase() !== resolvedWindows.toLowerCase()) {
    throw new Error("Windows system-directory environment values do not identify the same trusted root.");
  }
  const system32 = realpathSync(path.join(resolvedRoot, "System32"));
  if (path.dirname(system32).toLowerCase() !== resolvedRoot.toLowerCase()) {
    throw new Error("The Windows System32 directory escaped the trusted system root.");
  }
  const kernel = lstatSync(path.join(system32, "kernel32.dll"));
  if (!kernel.isFile()) throw new Error("The trusted Windows system directory is incomplete.");
  return system32;
}

async function trustedWindowsExecutable(system32: string, ...segments: readonly string[]): Promise<string> {
  const candidate = await realpath(path.join(system32, ...segments));
  const relative = path.relative(system32, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("A Windows security utility escaped the trusted System32 directory.");
  }
  const metadata = await lstat(candidate);
  if (!metadata.isFile()) throw new Error("A required Windows security utility is not a regular file.");
  return candidate;
}

function trustedWindowsExecutableSync(system32: string, ...segments: readonly string[]): string {
  const candidate = realpathSync(path.join(system32, ...segments));
  const relative = path.relative(system32, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("A Windows security utility escaped the trusted System32 directory.");
  }
  const metadata = lstatSync(candidate);
  if (!metadata.isFile()) throw new Error("A required Windows security utility is not a regular file.");
  return candidate;
}

async function privateFileIdentity(filePath: string): Promise<PrivateFileIdentity & { readonly links: bigint }> {
  const metadata = await lstat(filePath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("private file identity is not regular");
  return { dev: metadata.dev, ino: metadata.ino, links: metadata.nlink };
}

async function handleIdentity(handle: Awaited<ReturnType<typeof open>>): Promise<PrivateFileIdentity> {
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isFile()) throw new Error("private file handle is not regular");
  return { dev: metadata.dev, ino: metadata.ino };
}

async function requirePrivateFileIdentity(
  filePath: string,
  expected: PrivateFileIdentity,
  expectedLinks: bigint,
): Promise<void> {
  const actual = await privateFileIdentity(filePath);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.links !== expectedLinks) {
    throw new Error("Private-file pathname identity changed during the atomic write.");
  }
}

async function hasPrivateFileIdentity(filePath: string, expected: PrivateFileIdentity): Promise<boolean> {
  try {
    const actual = await privateFileIdentity(filePath);
    return actual.dev === expected.dev && actual.ino === expected.ino;
  } catch {
    return false;
  }
}

async function windowsOwnerSid(system32: string): Promise<string> {
  const whoami = await trustedWindowsExecutable(system32, "whoami.exe");
  const identity = await runCommand(whoami, ["/user", "/fo", "csv", "/nh"], system32);
  const sid = identity.stdout.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
  if (identity.exitCode !== 0 || !sid) throw new Error("Could not resolve the Windows owner SID for a private file.");
  return sid;
}

function windowsOwnerSidSync(system32: string): string {
  const whoami = trustedWindowsExecutableSync(system32, "whoami.exe");
  const identity = runCommandSync(whoami, ["/user", "/fo", "csv", "/nh"], system32);
  const sid = identity.stdout.match(/"(S-\d+(?:-\d+)+)"/i)?.[1];
  if (identity.exitCode !== 0 || !sid) throw new Error("Could not resolve the Windows owner SID for a private file.");
  return sid;
}

function windowsAclVerificationScript(): string {
  return [
    "& { param([string]$credentialPath, [string]$expectedSid)",
    "$sections = [System.Security.AccessControl.AccessControlSections]::Access",
    "$acl = [System.Security.AccessControl.FileSecurity]::new($credentialPath, $sections)",
    "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "$full = [System.Security.AccessControl.FileSystemRights]::FullControl",
    "$allow = [System.Security.AccessControl.AccessControlType]::Allow",
    "$valid = $acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and " +
      "$rules[0].IdentityReference.Value -eq $expectedSid -and -not $rules[0].IsInherited -and " +
      "$rules[0].AccessControlType -eq $allow -and (($rules[0].FileSystemRights -band $full) -eq $full)",
    "if (-not $valid) { Write-Error 'private ACL mismatch'; exit 1 }",
    "}",
  ].join("; ");
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

function runCommandSync(
  command: string,
  args: readonly string[],
  cwd: string,
): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, [...args], { cwd, windowsHide: true, shell: false, encoding: "utf8" });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
