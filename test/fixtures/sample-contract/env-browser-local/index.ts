function readLocalEnvironment(settings: Record<string, string | undefined>): string | undefined {
  return settings.VITE_LOCAL_URL;
}

const aliasedEnvironment = import.meta.env;

export const aliasedUrl = aliasedEnvironment.VITE_LOCAL_URL;
export const calledUrl = readLocalEnvironment(import.meta.env);
