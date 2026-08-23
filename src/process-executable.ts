import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve a bare executable strictly from absolute PATH entries, never cwd. */
export async function resolveExecutableFromPath(
  command: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly excludedDirectory?: string;
  } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  if (path.isAbsolute(command)) return verifyExecutable(command, options.excludedDirectory);
  if (command.includes("/") || command.includes("\\")) {
    throw new Error(`Executable path must be absolute: ${command}`);
  }

  const names = process.platform === "win32" ? windowsExecutableNames(command, env.PATHEXT) : [command];
  for (const rawDirectory of (env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        return await verifyExecutable(path.join(directory, name), options.excludedDirectory);
      } catch {
        // Continue through the trusted absolute PATH roster.
      }
    }
  }
  throw new Error(`Required executable was not found in an absolute PATH entry: ${command}`);
}

function windowsExecutableNames(command: string, pathExt: string | undefined): readonly string[] {
  if (path.extname(command)) return [command];
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => /^\.[a-z0-9]+$/.test(extension));
  return [...new Set(extensions)].map((extension) => `${command}${extension}`);
}

async function verifyExecutable(candidate: string, excludedDirectory: string | undefined): Promise<string> {
  const resolved = await realpath(candidate);
  const metadata = await lstat(resolved);
  if (!metadata.isFile()) throw new Error("executable is not a regular file");
  if (
    excludedDirectory &&
    isWithin(resolved, await realpath(excludedDirectory).catch(() => path.resolve(excludedDirectory)))
  ) {
    throw new Error("refusing an executable from the selected working directory");
  }
  if (process.platform !== "win32") await access(resolved, constants.X_OK);
  return resolved;
}

function isWithin(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
