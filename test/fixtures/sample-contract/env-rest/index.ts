const { HONUA_BOUNDED_URL: boundedUrl, ...unboundedEnvironment } = process.env;

export const restEnvironmentFixture = { boundedUrl, unboundedEnvironment };
