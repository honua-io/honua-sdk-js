function configuredName(): string {
  return `HONUA_${Date.now()}`;
}

const runtimeEnv = process.env;

export const unresolvedEnvironmentFixture = runtimeEnv[configuredName()];
