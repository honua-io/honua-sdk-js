import type { ModelDriver } from "../types.js";
import { AnthropicDriver } from "./anthropic.js";
import { BedrockDriver } from "./bedrock.js";
import { DeterministicDriver } from "./deterministic.js";
import { OpenAiDriver } from "./openai.js";

export { AnthropicDriver, BedrockDriver, DeterministicDriver, OpenAiDriver };

/** Names accepted by `selectDrivers` / the CLI `--driver` flag. */
export type DriverName = "deterministic" | "anthropic" | "openai" | "bedrock";

export interface ResolveDriversOptions {
  env?: NodeJS.ProcessEnv;
  /** Include live drivers even if their key/opt-in is absent (they record driverError). */
  includeUnavailable?: boolean;
}

/**
 * Resolve the set of model drivers to run.
 *
 * The deterministic control is always included. Claude (Anthropic API) and GPT
 * drivers are added when their API keys are present; the Claude-via-Bedrock driver
 * is added when `HONUA_EVAL_BEDROCK` is set (its auth comes from the AWS credential
 * chain, which can't be sniffed from a single env var). This gates live runs behind
 * env without hardcoding any credentials. CI runs the deterministic driver only —
 * a green, reproducible artifact with no model/API calls.
 */
export function resolveDrivers(options: ResolveDriversOptions = {}): ModelDriver[] {
  const env = options.env ?? process.env;
  const drivers: ModelDriver[] = [new DeterministicDriver()];

  const anthropic = new AnthropicDriver({ apiKey: env.ANTHROPIC_API_KEY, model: env.HONUA_EVAL_ANTHROPIC_MODEL });
  if (options.includeUnavailable || anthropic.isAvailable()) {
    drivers.push(anthropic);
  }

  const openai = new OpenAiDriver({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });
  if (options.includeUnavailable || openai.isAvailable()) {
    drivers.push(openai);
  }

  const bedrock = new BedrockDriver({
    enabled: env.HONUA_EVAL_BEDROCK,
    model: env.HONUA_EVAL_BEDROCK_MODEL,
    region: env.AWS_REGION,
  });
  if (options.includeUnavailable || bedrock.isAvailable()) {
    drivers.push(bedrock);
  }

  return drivers;
}

/**
 * Build the driver set for an explicit `--driver` selection. The deterministic
 * control is always included (it is the CI gate). Named live drivers are always
 * constructed and run — even if their key/opt-in is absent — so an explicit
 * request surfaces an honest `driverError` rather than being silently dropped.
 */
export function selectDrivers(names: DriverName[], options: ResolveDriversOptions = {}): ModelDriver[] {
  const env = options.env ?? process.env;
  const drivers: ModelDriver[] = [new DeterministicDriver()];
  for (const name of names) {
    switch (name) {
      case "deterministic":
        break; // already included
      case "anthropic":
        drivers.push(new AnthropicDriver({ apiKey: env.ANTHROPIC_API_KEY, model: env.HONUA_EVAL_ANTHROPIC_MODEL }));
        break;
      case "openai":
        drivers.push(new OpenAiDriver({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL }));
        break;
      case "bedrock":
        drivers.push(new BedrockDriver({ enabled: "1", model: env.HONUA_EVAL_BEDROCK_MODEL, region: env.AWS_REGION }));
        break;
      default: {
        const exhaustive: never = name;
        throw new Error(`unknown driver: ${String(exhaustive)}`);
      }
    }
  }
  return drivers;
}

/** Parse/validate a `--driver` value into a known driver name. */
export function parseDriverName(value: string): DriverName {
  const known: DriverName[] = ["deterministic", "anthropic", "openai", "bedrock"];
  if ((known as string[]).includes(value)) {
    return value as DriverName;
  }
  throw new Error(`unknown --driver "${value}" (expected one of: ${known.join(", ")})`);
}
