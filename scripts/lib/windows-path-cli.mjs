import fs from "node:fs";
import path from "node:path";

const DEFAULT_WINDOWS_PATH_EXTENSIONS = Object.freeze([".COM", ".EXE", ".BAT", ".CMD"]);

function environmentValue(env, name) {
  if (Object.hasOwn(env, name)) return env[name];
  const keys = Object.keys(env);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    if (keys[index].toUpperCase() === name) return env[keys[index]];
  }
  return undefined;
}

function pathExtensions(env) {
  const configured = environmentValue(env, "PATHEXT");
  const extensions = (configured ? configured.split(";") : DEFAULT_WINDOWS_PATH_EXTENSIONS)
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith(".") ? extension : `.${extension}`));
  return [...new Set(extensions.map((extension) => extension.toUpperCase()))];
}

function isWindowsAbsolutePath(entry) {
  return (
    /^[a-zA-Z]:[\\/]/.test(entry) ||
    entry.startsWith("\\\\") ||
    entry.startsWith("//")
  );
}

function candidateDirectories(env, cwd) {
  const configured = environmentValue(env, "PATH");
  if (configured === undefined) return [];
  return configured.split(";").map((entry) => {
    const unquoted = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (isWindowsAbsolutePath(unquoted)) return path.win32.normalize(unquoted || ".");
    return path.win32.resolve(cwd, unquoted || ".");
  });
}

/**
 * Resolve the exact executable or script that Windows command lookup would
 * select from PATH. The resolved path is then invoked exactly once by the
 * launcher; this keeps host build-lock shims observable.
 */
export function resolveWindowsPathCommand(
  name,
  { cwd = process.cwd(), env = process.env, existsSync = fs.existsSync, statSync = fs.statSync } = {},
) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    throw new TypeError("Windows PATH command names must contain only alphanumerics and hyphens");
  }
  const extensions = path.win32.extname(name) ? [""] : pathExtensions(env);
  for (const directory of candidateDirectories(env, cwd)) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, `${name}${extension}`);
      if (!existsSync(candidate)) continue;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // A PATH entry can disappear between the existence and type checks.
      }
    }
  }
  throw new Error(`Unable to locate ${name} through the target Windows PATH`);
}

export function windowsPowerShellPath(env = process.env) {
  const systemRoot = environmentValue(env, "SYSTEMROOT") ?? environmentValue(env, "WINDIR");
  if (!systemRoot) throw new Error("SYSTEMROOT is required to launch a Windows PATH command");
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const CMD_META_CHARACTER = /([()[\]%!^"`<>&|;, *?])/g;
const UNSUPPORTED_BATCH_CONTROL = /[\0\r\n]/;

export function assertWindowsBatchBoundaryValue(value, label = "argument") {
  if (typeof value !== "string") {
    throw new TypeError(`Windows batch ${label} must be a string`);
  }
  if (UNSUPPORTED_BATCH_CONTROL.test(value)) {
    throw new TypeError(
      `Windows batch ${label} contains an unsupported NUL, CR, or LF control character`,
    );
  }
}

function escapeCmdCommand(value) {
  return value.replace(CMD_META_CHARACTER, "^$1");
}

// Match the Windows argv quoting used by established cmd-shim launchers:
// double backslashes before quotes and at the end, then protect cmd.exe
// metacharacters after wrapping the complete argument. A .cmd shim reparses
// `%*`, so its arguments need two metacharacter-escaping passes.
function escapeCmdArgument(value) {
  const escaped = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(
    CMD_META_CHARACTER,
    "^$1",
  );
  return escaped.replace(CMD_META_CHARACTER, "^$1");
}

/**
 * Invoke a resolved .cmd/.bat shim with the same two-layer escaping required
 * by Windows cmd shims. `windowsVerbatimArguments` prevents Node from applying
 * a third quoting pass; every target argument remains a distinct argv value.
 */
export function windowsScriptInvocation(command, args, { env = process.env } = {}) {
  assertWindowsBatchBoundaryValue(command, "command");
  for (let index = 0; index < args.length; index += 1) {
    assertWindowsBatchBoundaryValue(args[index], `argument ${index + 1}`);
  }
  const commandLine = [escapeCmdCommand(command), ...args.map(escapeCmdArgument)].join(" ");
  return {
    command:
      environmentValue(env, "COMSPEC") ??
      path.win32.join(
        environmentValue(env, "SYSTEMROOT") ?? environmentValue(env, "WINDIR") ?? String.raw`C:\Windows`,
        "System32",
        "cmd.exe",
      ),
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export function windowsPathCommandInvocation(command, args, options = {}) {
  const resolved = resolveWindowsPathCommand(command, options);
  if (/\.(?:cmd|bat)$/i.test(resolved)) {
    return windowsScriptInvocation(resolved, args, options);
  }
  return { command: resolved, args: [...args] };
}
