import fs from "node:fs";
import path from "node:path";

export function supportedEntrypoints(surface) {
  return surface.entrypoints.filter(
    (entrypoint) => entrypoint.tier === "stable" || entrypoint.tier === "experimental",
  );
}

export function packageSpecifier(packageName, subpath) {
  return subpath === "." ? packageName : `${packageName}${subpath.slice(1)}`;
}

function exportTarget(exported, condition) {
  if (condition === "default" && typeof exported === "string") return exported;
  return exported && typeof exported === "object" ? exported[condition] : undefined;
}

function escapesPackage(relativePath) {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

export function validateInstalledManifest({ packageRoot, packageJson, entrypoints }) {
  const failures = [];

  for (const entrypoint of entrypoints) {
    const exported = packageJson.exports?.[entrypoint.subpath];
    for (const condition of ["default", "types"]) {
      const target = exportTarget(exported, condition);
      if (typeof target !== "string") {
        failures.push(`${entrypoint.subpath} installed export has no ${condition} target`);
        continue;
      }
      const resolved = path.resolve(packageRoot, target);
      const relative = path.relative(packageRoot, resolved);
      if (escapesPackage(relative)) {
        failures.push(
          `${entrypoint.subpath} installed ${condition} target escapes the package: ${target}`,
        );
      } else if (!fs.existsSync(resolved)) {
        failures.push(`${entrypoint.subpath} installed ${condition} target is missing: ${target}`);
      }
    }
  }

  const binTarget = packageJson.bin?.honua;
  if (typeof binTarget !== "string") {
    failures.push('installed package has no "honua" bin target');
  } else {
    const resolved = path.resolve(packageRoot, binTarget);
    const relative = path.relative(packageRoot, resolved);
    if (escapesPackage(relative)) {
      failures.push(`installed honua bin target escapes the package: ${binTarget}`);
    } else if (!fs.existsSync(resolved)) {
      failures.push(`installed honua bin target is missing: ${binTarget}`);
    }
  }

  return failures;
}

export function runtimeSmokeSource(packageName, entrypoints) {
  const specifiers = entrypoints.map((entrypoint) =>
    packageSpecifier(packageName, entrypoint.subpath),
  );
  return `${specifiers
    .map(
      (specifier) =>
        `try {\n  await import(${JSON.stringify(specifier)});\n  process.stdout.write(${JSON.stringify(
          `${specifier}=ok\n`,
        )});\n} catch (error) {\n  process.stderr.write(${JSON.stringify(
          `${specifier} installed runtime import failed: `,
        )} + (error instanceof Error ? error.stack ?? error.message : String(error)) + "\\n");\n  process.exitCode = 1;\n}`,
    )
    .join("\n")}
`;
}

export function typeSmokeSource(packageName, entrypoints) {
  return `${entrypoints
    .map((entrypoint, index) => {
      const specifier = packageSpecifier(packageName, entrypoint.subpath);
      return `import type * as Entrypoint${index} from ${JSON.stringify(specifier)};\nexport type Entrypoint${index}Surface = typeof Entrypoint${index};`;
    })
    .join("\n")}
`;
}
