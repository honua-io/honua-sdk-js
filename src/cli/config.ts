/**
 * Configuration + credential resolution for the `honua` CLI.
 *
 * Precedence (highest first):
 *   1. Explicit `--base-url` / `--api-key` flags.
 *   2. Environment variables `HONUA_BASE_URL` / `HONUA_API_KEY`.
 *   3. A saved config file written by `honua login` (`~/.config/honua/config.json`,
 *      overridable with `HONUA_CONFIG_HOME`).
 *
 * Secrets are only ever persisted by an explicit `honua login`; nothing else
 * writes the config file.
 *
 * @packageDocumentation
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HonuaCliConfig {
  baseUrl?: string;
  apiKey?: string;
  locatorName?: string;
}

export interface ResolvedConnection {
  baseUrl: string;
  apiKey?: string;
  /** Where `baseUrl` came from, for diagnostics. */
  source: "flag" | "env" | "config";
}

/** Directory that holds the persisted CLI config. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HONUA_CONFIG_HOME && env.HONUA_CONFIG_HOME.trim() !== "") {
    return env.HONUA_CONFIG_HOME;
  }
  const base =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== "" ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
  return path.join(base, "honua");
}

/** Absolute path of the persisted CLI config file. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), "config.json");
}

/** Read the persisted config, returning `{}` when absent or unreadable. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): HonuaCliConfig {
  const file = configPath(env);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as HonuaCliConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the config file (used by `honua login`). Returns the path written. */
export function writeConfig(config: HonuaCliConfig, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(env);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on platforms without POSIX modes
  }
  return file;
}

export interface ResolveOptions {
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the base URL + API key from flags, env, then saved config.
 *
 * @throws {Error} when no base URL can be determined.
 */
export function resolveConnection(options: ResolveOptions = {}): ResolvedConnection {
  const env = options.env ?? process.env;
  const saved = readConfig(env);

  let baseUrl: string | undefined;
  let source: ResolvedConnection["source"] = "config";
  if (options.baseUrl && options.baseUrl.trim() !== "") {
    baseUrl = options.baseUrl;
    source = "flag";
  } else if (env.HONUA_BASE_URL && env.HONUA_BASE_URL.trim() !== "") {
    baseUrl = env.HONUA_BASE_URL;
    source = "env";
  } else if (saved.baseUrl && saved.baseUrl.trim() !== "") {
    baseUrl = saved.baseUrl;
    source = "config";
  }

  if (!baseUrl) {
    throw new Error(
      "No Honua base URL configured. Pass --base-url, set HONUA_BASE_URL, or run `honua login --base-url <url>`.",
    );
  }

  const apiKey =
    (options.apiKey && options.apiKey.trim() !== "" ? options.apiKey : undefined) ??
    (env.HONUA_API_KEY && env.HONUA_API_KEY.trim() !== "" ? env.HONUA_API_KEY : undefined) ??
    (saved.apiKey && saved.apiKey.trim() !== "" ? saved.apiKey : undefined);

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, source };
}
