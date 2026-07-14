const processAlias = process;
const { env: destructuredEnvironment } = process;

export const processAliasUrl = processAlias.env.HONUA_PROCESS_ALIAS_URL;
export const destructuredEnvironmentUrl = destructuredEnvironment.HONUA_DESTRUCTURED_ENV_URL;
