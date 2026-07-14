const primaryEnvironmentKey = "HONUA_LEXICAL_CHAIN_URL";
const aliasedEnvironmentKey = primaryEnvironmentKey;

function readEnvironmentKey(key: string): string | undefined {
  return process["env"][key];
}

function forwardEnvironmentKey(key: string): string | undefined {
  return readEnvironmentKey(key);
}

export const lexicalChainUrl = forwardEnvironmentKey(aliasedEnvironmentKey);
export const literalChainUrl = forwardEnvironmentKey("HONUA_LITERAL_CHAIN_URL");
