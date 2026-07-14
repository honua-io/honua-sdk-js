function readSetting(settings: NodeJS.ProcessEnv, key: string): string | undefined {
  return settings[key];
}

function forwardSetting(configuration: NodeJS.ProcessEnv, key: string): string | undefined {
  return readSetting(configuration, key);
}

export const forwardedUrl = forwardSetting(process.env, "HONUA_FORWARDED_URL");
