import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyBuiltEntrypoints({
  entrypoints,
  packageJson,
  projectRoot,
  rootRuntimeExportCeiling,
}) {
  const failures = [];
  let importCount = 0;

  for (const entrypoint of entrypoints) {
    const mapping = packageJson.exports?.[entrypoint.subpath];
    const targetMapping = mapping?.node ?? mapping?.default;
    if (typeof targetMapping !== "string") {
      failures.push(`${entrypoint.subpath} package export has no Node or default target`);
      continue;
    }

    const target = path.join(projectRoot, targetMapping);
    if (!fs.existsSync(target)) {
      failures.push(`${entrypoint.subpath} built-entrypoint target is missing: ${targetMapping}`);
      continue;
    }

    try {
      const imported = await import(pathToFileURL(target).href);
      if (entrypoint.subpath === "." && Object.keys(imported).length > rootRuntimeExportCeiling) {
        failures.push(
          `root runtime exports ${Object.keys(imported).length} exceed reviewed ceiling ${rootRuntimeExportCeiling}`,
        );
      }
      importCount += 1;
    } catch (error) {
      failures.push(
        `${entrypoint.subpath} built-entrypoint import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { failures, importCount };
}
