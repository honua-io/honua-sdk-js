const environmentKey = "HONUA_OUTER_CONST_KEY_URL";

function configuredKey(): string {
  return `HONUA_${Date.now()}`;
}

function readFunctionScopedKey(): string | undefined {
  if (Date.now() > 0) {
    var environmentKey = configuredKey();
  }
  return process.env[environmentKey];
}

export const functionScopedKeyUrl = readFunctionScopedKey();
