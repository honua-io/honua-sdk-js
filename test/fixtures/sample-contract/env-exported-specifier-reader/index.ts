function readEnvironment(key: string): string | undefined {
  return process.env[key];
}

export { readEnvironment };
export const exportedSpecifierUrl = readEnvironment("HONUA_EXPORTED_SPECIFIER_URL");
