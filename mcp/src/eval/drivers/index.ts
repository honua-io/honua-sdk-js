import type { ModelDriver } from "../types.js";
import { AnthropicDriver } from "./anthropic.js";
import { DeterministicDriver } from "./deterministic.js";
import { OpenAiDriver } from "./openai.js";

export { AnthropicDriver, DeterministicDriver, OpenAiDriver };

export interface ResolveDriversOptions {
  env?: NodeJS.ProcessEnv;
  /** Include live drivers even if their key is absent (they will record driverError). */
  includeUnavailable?: boolean;
}

/**
 * Resolve the set of model drivers to run.
 *
 * The deterministic control is always included. Claude and GPT drivers are added
 * when their API keys are present (live cross-model mode), gating live runs
 * behind env vars without hardcoding any credentials. CI runs the deterministic
 * driver only — a green, reproducible artifact with no model/API calls.
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

  return drivers;
}
