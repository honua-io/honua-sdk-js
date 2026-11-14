const APP_PLATFORM_PREFIX = "@honua/app-platform/";
const compiledSourceRoot = new URL("../../dist/src/", import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(APP_PLATFORM_PREFIX)) return nextResolve(specifier, context);
  const subpath = specifier.slice(APP_PLATFORM_PREFIX.length);
  return nextResolve(new URL(`${subpath}/index.js`, compiledSourceRoot).href, context);
}
