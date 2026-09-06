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
import { verifyPrivateFileSync, writePrivateFileAtomic } from "../private-file.js";

export interface HonuaCliConfig {
  baseUrl?: string;
  apiKey?: string;
  locatorName?: string;
  profiles?: Record<
    string,
    {
      baseUrl?: string;
      apiKey?: string;
      adminKey?: string;
    }
  >;
}

export interface ResolvedConnection {
  baseUrl: string;
  apiKey?: string;
  /** Where `baseUrl` came from, for diagnostics. */
  source: "flag" | "env" | "config";
}

/**
 * Strip any trailing `/` characters from a base URL.
 *
 * Implemented as a linear scan rather than a `/\/+$/` regex so it is not
 * susceptible to polynomial backtracking on attacker- or library-controlled
 * input (CodeQL js/redos).
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
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

/** Read the persisted config, returning `{}` only when absent or privately stored but malformed. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): HonuaCliConfig {
  const file = configPath(env);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    verifyPrivateFileSync(file);
  } catch (error) {
    throw new Error(
      `Refusing to read CLI credentials from an unverified private file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as HonuaCliConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the config file (used by `honua login`). Returns the path written. */
export async function writeConfig(config: HonuaCliConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = configDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(env);
  await writePrivateFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

export interface ResolveOptions {
  baseUrl?: string;
  apiKey?: string;
  profile?: string;
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
  const profile = options.profile ? saved.profiles?.[options.profile] : undefined;
  if (options.profile && !profile) {
    throw new Error(`Honua profile "${options.profile}" was not found in ${configPath(env)}.`);
  }

  let baseUrl: string | undefined;
  let source: ResolvedConnection["source"] = "config";
  if (options.baseUrl && options.baseUrl.trim() !== "") {
    baseUrl = options.baseUrl;
    source = "flag";
  } else if (env.HONUA_BASE_URL && env.HONUA_BASE_URL.trim() !== "") {
    baseUrl = env.HONUA_BASE_URL;
    source = "env";
  } else if (profile?.baseUrl && profile.baseUrl.trim() !== "") {
    baseUrl = profile.baseUrl;
    source = "config";
  } else if (saved.baseUrl && saved.baseUrl.trim() !== "") {
    baseUrl = saved.baseUrl;
    source = "config";
  }

  if (!baseUrl) {
    throw new Error(
      "No Honua base URL configured. Pass --base-url, set HONUA_BASE_URL, or run `honua login --base-url <url>`.",
    );
  }

  const savedKeyIsBoundToBaseUrl =
    !options.profile &&
    typeof saved.baseUrl === "string" &&
    stripTrailingSlashes(saved.baseUrl) === stripTrailingSlashes(baseUrl);
  const apiKey =
    (options.apiKey && options.apiKey.trim() !== "" ? options.apiKey : undefined) ??
    (env.HONUA_API_KEY && env.HONUA_API_KEY.trim() !== "" ? env.HONUA_API_KEY : undefined) ??
    (profile?.apiKey && profile.apiKey.trim() !== "" ? profile.apiKey : undefined) ??
    (savedKeyIsBoundToBaseUrl && saved.apiKey && saved.apiKey.trim() !== "" ? saved.apiKey : undefined);

  return { baseUrl: stripTrailingSlashes(baseUrl), apiKey, source };
}

export interface ResolvedAdminConnection extends ResolvedConnection {
  adminKey?: string;
}

/** Resolve admin auth, preferring the dedicated root key over the general API key. */
export function resolveAdminConnection(options: ResolveOptions & { adminKey?: string } = {}): ResolvedAdminConnection {
  const env = options.env ?? process.env;
  const saved = readConfig(env);
  const profile = options.profile ? saved.profiles?.[options.profile] : undefined;
  const connection = resolveConnection(options);
  const adminKey =
    (options.adminKey && options.adminKey.trim() !== "" ? options.adminKey : undefined) ??
    (env.HONUA_ADMIN_KEY && env.HONUA_ADMIN_KEY.trim() !== "" ? env.HONUA_ADMIN_KEY : undefined) ??
    (profile?.adminKey && profile.adminKey.trim() !== "" ? profile.adminKey : undefined) ??
    connection.apiKey;
  return { ...connection, adminKey };
}
