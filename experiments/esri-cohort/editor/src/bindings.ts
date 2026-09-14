/** Writable experiment bindings must stay within the disposable local workspace. */
export function localLayerUrl(value: string | undefined, origin: string): URL {
  if (!value) throw new Error("Bind all three imported editor layer URLs before starting.");
  const base = new URL(origin);
  const url = new URL(value, origin);
  if (
    !["127.0.0.1", "localhost"].includes(base.hostname) ||
    url.origin !== base.origin ||
    !/^\/rest\/services\/onboarding-editor-[a-z0-9-]+\/FeatureServer\/\d+$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error("Editor bindings must identify this workspace's local onboarding imports.");
  }
  return url;
}
