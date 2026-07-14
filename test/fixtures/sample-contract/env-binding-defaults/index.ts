const { HONUA_BINDING_DEFAULT_URL: nodeUrl = "https://example.test" } = process["env"];

export function loadParameterUrl(
  { HONUA_PARAMETER_DEFAULT_URL: parameterUrl = "https://parameter.example.test" } = process["env"],
): string {
  return parameterUrl;
}

export const defaultedNodeUrl = nodeUrl;
