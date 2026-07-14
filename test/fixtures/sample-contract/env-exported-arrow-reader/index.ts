export const readEnvironment = (key: string): string | undefined => process.env[key];

export const exportedArrowUrl = readEnvironment("HONUA_EXPORTED_ARROW_URL");
