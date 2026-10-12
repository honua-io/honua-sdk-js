export function evaluateRuntimeTarball(packed, policy) {
  const metadata = new Set(policy.metadata);
  const present = new Set(packed.files.map((file) => file.path));
  const owners = {};
  const forbidden = [];
  for (const file of packed.files) {
    const name = file.path;
    const runtime = name.startsWith("dist/src/") && /\.(?:js|d\.ts|d\.ts\.map)$/.test(name) && !name.startsWith("dist/src/migration/");
    const browser = /^dist\/browser\/[^/]+\.js$/.test(name);
    if (!runtime && !browser && !metadata.has(name)) forbidden.push(name);
    const owner = runtime ? name.split("/")[2] : browser ? "browser" : metadata.has(name) ? "metadata" : "forbidden";
    owners[owner] = (owners[owner] ?? 0) + file.size;
  }
  const missing = [...metadata, "dist/src/index.js", "dist/src/index.d.ts", "dist/browser/honua-sdk.min.js", "dist/browser/honua-sdk.esm.js"]
    .filter((name) => !present.has(name));
  const measurement = { compressedBytes: packed.size, unpackedBytes: packed.unpackedSize, fileCount: packed.files.length };
  const validSizes = Object.entries(policy.ceiling).every(([key, limit]) => Number.isSafeInteger(measurement[key]) && measurement[key] > 0 && measurement[key] <= limit);
  return { status: forbidden.length || missing.length || !validSizes ? "failed" : "passed", measurement, owners, forbidden, missing };
}

/** Published browser inventory refers only to files in the packed runtime. */
export function missingBrowserArtifactFiles(packed, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Browser artifact manifest must list shipped files");
  }
  const present = new Set(packed.files.map((file) => file.path));
  return manifest.files.map((file) => file.path).filter((file) => !present.has(file));
}
