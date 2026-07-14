export function loadUnboundedEnvironment(
  { HONUA_PARAMETER_BOUNDED_URL: boundedUrl, ...unboundedEnvironment } = process.env,
): Record<string, string | undefined> {
  return { ...unboundedEnvironment, HONUA_PARAMETER_BOUNDED_URL: boundedUrl };
}
