import process from "node:process";

const VITE_ENVIRONMENT_NAME = /^VITE_[A-Z0-9_]+$/;

/**
 * Build a child-process environment for deterministic Vite fixture builds.
 *
 * Vite gives existing process variables precedence over values loaded from
 * `.env` files. Strip every inherited browser-public variable first, then add
 * only the fixture values declared by the harness. Non-Vite variables such as
 * PATH, npm configuration, and SDK build controls remain available.
 */
export function createFixtureBuildEnvironment(overrides = {}, inherited = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (/^VITE_/i.test(name) || value === undefined) continue;
    environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!VITE_ENVIRONMENT_NAME.test(name)) {
      throw new Error(`Fixture build overrides must use uppercase VITE_* names: ${name}`);
    }
    if (value !== undefined) environment[name] = String(value);
  }
  return environment;
}
