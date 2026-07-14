const service = {
  serviceEnv: "HONUA_PROPERTY_KEY_URL",
};

function readEnvironment(key: string): string | undefined {
  return process.env[key];
}

export const propertyKeyUrl = readEnvironment(service.serviceEnv);
