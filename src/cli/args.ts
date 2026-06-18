/**
 * Minimal, dependency-free flag parser for the `honua` CLI.
 *
 * Supports `--flag value`, `--flag=value`, repeated flags (collected into an
 * array), boolean flags, short aliases, and positional arguments. Kept tiny and
 * pure so argument handling is unit-testable without spawning a process.
 *
 * @packageDocumentation
 */

export interface FlagSpec {
  /** Long name without leading dashes, e.g. `"where"`. */
  name: string;
  /** Single-char alias without dash, e.g. `"o"`. */
  alias?: string;
  /** Boolean flags consume no value. */
  boolean?: boolean;
  /** Allow the flag to repeat; values collected into an array. */
  multiple?: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | string[] | boolean>;
}

export class ArgError extends Error {}

function findSpec(specs: ReadonlyArray<FlagSpec>, token: string): FlagSpec | undefined {
  if (token.startsWith("--")) {
    const name = token.slice(2);
    return specs.find((s) => s.name === name);
  }
  if (token.startsWith("-")) {
    const alias = token.slice(1);
    return specs.find((s) => s.alias === alias);
  }
  return undefined;
}

/**
 * Parse `argv` (already sliced past the command) against `specs`.
 *
 * @throws {ArgError} for unknown flags or flags missing a required value.
 */
export function parseArgs(argv: ReadonlyArray<string>, specs: ReadonlyArray<FlagSpec>): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      // Everything after `--` is positional.
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    // Handle `--flag=value`.
    let inlineValue: string | undefined;
    let lookup = token;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq !== -1) {
      lookup = token.slice(0, eq);
      inlineValue = token.slice(eq + 1);
    }

    const spec = findSpec(specs, lookup);
    if (!spec) {
      throw new ArgError(`Unknown option: ${lookup}`);
    }

    if (spec.boolean) {
      if (inlineValue !== undefined) {
        flags[spec.name] = inlineValue !== "false" && inlineValue !== "0";
      } else {
        flags[spec.name] = true;
      }
      continue;
    }

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new ArgError(`Option ${lookup} requires a value`);
      }
      value = next;
      i += 1;
    }

    if (spec.multiple) {
      const existing = flags[spec.name];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        flags[spec.name] = [value];
      }
    } else {
      flags[spec.name] = value;
    }
  }

  return { positionals, flags };
}

/** Read a string flag, or `undefined`. */
export function getString(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[v.length - 1];
  return undefined;
}

/** Read a boolean flag (defaults to `false`). */
export function getBoolean(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true;
}

/** Read a repeated flag as an array (always defined, possibly empty). */
export function getArray(parsed: ParsedArgs, name: string): string[] {
  const v = parsed.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

/** Read and parse a numeric flag. @throws {ArgError} when not a finite number. */
export function getNumber(parsed: ParsedArgs, name: string): number | undefined {
  const v = getString(parsed, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new ArgError(`Option --${name} must be a number, got: ${v}`);
  }
  return n;
}

/**
 * Parse a `bbox` flag of the form `minx,miny,maxx,maxy` into a 4-tuple.
 *
 * @throws {ArgError} when malformed.
 */
export function parseBbox(value: string): [number, number, number, number] {
  const parts = value.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new ArgError(`--bbox must be "minx,miny,maxx,maxy", got: ${value}`);
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

/**
 * Split a `service/layer` reference into its parts.
 *
 * @throws {ArgError} when the layer id is missing or not an integer.
 */
export function parseServiceLayer(ref: string): { service: string; layer: number } {
  const slash = ref.lastIndexOf("/");
  if (slash === -1) {
    throw new ArgError(`Expected "<service>/<layer>", got: ${ref}`);
  }
  const service = ref.slice(0, slash);
  const layerRaw = ref.slice(slash + 1);
  const layer = Number(layerRaw);
  if (service.trim() === "" || !Number.isInteger(layer)) {
    throw new ArgError(`Expected "<service>/<layer>" with an integer layer id, got: ${ref}`);
  }
  return { service, layer };
}
