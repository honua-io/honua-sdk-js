const environmentKey = "HONUA_OUTER_KEY_URL";

function readShadowedKey(): string | undefined {
  const environmentKey = "HONUA_INNER_KEY_URL";
  return process.env[environmentKey];
}

export const shadowedKeyUrl = readShadowedKey();
