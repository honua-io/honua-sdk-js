export const ERROR_LEAF_FORBIDDEN_MODULES = Object.freeze([
  "dist/src/core/error-classifications.js",
  "dist/src/core/error-code-registry.js",
  "dist/src/core/error-envelope.js",
]);

export const ERROR_TREE_SHAKE_FIXTURES = Object.freeze([
  Object.freeze({
    key: "tree-shake:error-leaf",
    entry: "scripts/bundle-size-fixtures/tree-shake-error-leaf.mjs",
    requiredModules: ["dist/src/core/error-base.js"],
    forbiddenModules: ERROR_LEAF_FORBIDDEN_MODULES,
  }),
  Object.freeze({
    key: "tree-shake:error-registry",
    entry: "scripts/bundle-size-fixtures/tree-shake-error-registry.mjs",
    requiredModules: ["dist/src/core/error-code-registry.js"],
    forbiddenModules: ["dist/src/core/error-classifications.js", "dist/src/core/error-envelope.js"],
  }),
  Object.freeze({
    key: "tree-shake:error-serializer",
    entry: "scripts/bundle-size-fixtures/tree-shake-error-serializer.mjs",
    requiredModules: ["dist/src/core/error-base.js", "dist/src/core/error-classifications.js", "dist/src/core/error-envelope.js"],
    forbiddenModules: ["dist/src/core/error-code-registry.js"],
  }),
]);

export function normalizeRetainedModule(input) {
  const normalized = input.replaceAll("\\", "/");
  for (const marker of ["dist/", "scripts/"]) {
    const index = normalized.lastIndexOf(`/${marker}`);
    if (index >= 0) return normalized.slice(index + 1);
    if (normalized.startsWith(marker)) return normalized;
  }
  return normalized.split("/").at(-1) ?? normalized;
}

export function retainedMetafileInputs(metafile) {
  const retained = new Set();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs ?? {})) {
      if (contribution.bytesInOutput > 0) retained.add(input);
    }
  }
  return [...retained];
}

export function retainedMetafileContributions(metafile) {
  const contributions = new Map();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs ?? {})) {
      if (contribution.bytesInOutput <= 0) continue;
      const module = normalizeRetainedModule(input);
      contributions.set(module, (contributions.get(module) ?? 0) + contribution.bytesInOutput);
    }
  }
  return Array.from(contributions, ([module, bytes]) => ({ module, bytes })).sort(
    (left, right) => right.bytes - left.bytes || left.module.localeCompare(right.module),
  );
}

export function errorModulePolicyFailures(key, inputs, requiredModules = [], forbiddenModules = []) {
  const retained = [...new Set(inputs.map(normalizeRetainedModule))].sort();
  const failures = [];
  for (const required of requiredModules) {
    if (!retained.includes(required)) failures.push(`${key}: required module was tree-shaken: ${required}`);
  }
  for (const forbidden of forbiddenModules) {
    if (retained.includes(forbidden)) failures.push(`${key}: retained forbidden module: ${forbidden}`);
  }
  return { retained, failures };
}
