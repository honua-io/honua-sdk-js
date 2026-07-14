export function loadDefaultedEnvironment(settings: NodeJS.ProcessEnv = process.env): string | undefined {
  return settings.HONUA_DEFAULTED_URL;
}
