const runtimeEnv = process.env;
const { HONUA_DESTRUCTURED_URL: destructuredUrl } = runtimeEnv;

function readEnvironment(name: string): string | undefined {
  return runtimeEnv[name];
}

export const staticEnvironmentFixture = {
  aliased: runtimeEnv.HONUA_ALIASED_URL,
  destructuredUrl,
  dynamic: readEnvironment("HONUA_DYNAMIC_URL"),
};
