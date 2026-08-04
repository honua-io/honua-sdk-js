// Filesystem half of `create-honua-app`: copy one template into a new project
// directory, renaming the files npm cannot publish under their real names and
// stamping the project's own package name.
//
// Everything here is exported as a plain function so the repository test suite
// can scaffold into a temporary directory without spawning a process.

import fs from "node:fs";
import path from "node:path";

import { PACKAGE_ROOT, loadTemplateManifest, templateById, templateRoot } from "./templates.mjs";

/** npm strips a published `.gitignore`, so templates carry it under a safe name. */
export const RENAMED_TEMPLATE_FILES = new Map([["_gitignore", ".gitignore"]]);

/** Files that configure the zero-install playground hosts, not the scaffolded app. */
export const PLAYGROUND_ONLY_FILES = new Set([".stackblitzrc"]);

/** npm package-name grammar, narrowed to the unscoped names a directory can produce. */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Directory entries that do not make a target directory "non-empty" for scaffolding. */
const IGNORED_TARGET_ENTRIES = new Set([".git", ".DS_Store"]);

/** Derive (and validate) the npm package name a target directory implies. */
export function projectNameFromDirectory(directory) {
  const base = path.basename(path.resolve(directory));
  const name = base.toLowerCase();
  if (name.length === 0 || name.length > 214) {
    throw new Error(`Project name ${JSON.stringify(base)} must be between 1 and 214 characters.`);
  }
  if (!PROJECT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Project name ${JSON.stringify(base)} is not a valid npm package name. Use lowercase letters, digits, "-", "_" or "." and start with a letter or digit.`,
    );
  }
  return name;
}

/** Recursively list a template's files as sorted, POSIX-style relative paths. */
export function collectTemplateFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Template entry ${relative} is not a regular file.`);
      files.push(relative);
    }
  };
  walk(root, "");
  return files;
}

/** Map a template-relative path onto the path the scaffolded project uses. */
export function scaffoldedPath(relativePath) {
  const segments = relativePath.split("/");
  const last = segments[segments.length - 1];
  const renamed = RENAMED_TEMPLATE_FILES.get(last);
  if (!renamed) return relativePath;
  return [...segments.slice(0, -1), renamed].join("/");
}

/** True when a template file exists only to configure a playground host. */
export function isPlaygroundOnlyFile(relativePath) {
  return PLAYGROUND_ONLY_FILES.has(relativePath.split("/").pop());
}

/** Rewrite a template `package.json` so the scaffolded app carries its own name. */
export function renderProjectManifest(source, projectName) {
  const manifest = JSON.parse(source);
  manifest.name = projectName;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function assertWritableTarget(targetRoot, force) {
  if (!fs.existsSync(targetRoot)) return;
  const stats = fs.statSync(targetRoot);
  if (!stats.isDirectory()) throw new Error(`${targetRoot} exists and is not a directory.`);
  if (force) return;
  const entries = fs.readdirSync(targetRoot).filter((entry) => !IGNORED_TARGET_ENTRIES.has(entry));
  if (entries.length > 0) {
    throw new Error(`${targetRoot} is not empty. Choose another directory or pass --force.`);
  }
}

/**
 * Copy `templateId` into `directory`, returning the scaffold receipt the CLI
 * prints. `directory` is resolved against `cwd` so tests never depend on the
 * process working directory.
 */
export function scaffoldProject({
  templateId,
  directory,
  force = false,
  cwd = process.cwd(),
  packageRoot = PACKAGE_ROOT,
}) {
  const manifest = loadTemplateManifest(packageRoot);
  const template = templateById(manifest, templateId);
  const sourceRoot = templateRoot(manifest, template.id, packageRoot);
  const targetRoot = path.resolve(cwd, directory);
  const projectName = projectNameFromDirectory(targetRoot);
  assertWritableTarget(targetRoot, force);

  const written = [];
  for (const relativePath of collectTemplateFiles(sourceRoot)) {
    if (isPlaygroundOnlyFile(relativePath)) continue;
    const destinationRelative = scaffoldedPath(relativePath);
    const source = path.join(sourceRoot, relativePath);
    const destination = path.join(targetRoot, destinationRelative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (destinationRelative === "package.json") {
      fs.writeFileSync(destination, renderProjectManifest(fs.readFileSync(source, "utf8"), projectName));
    } else {
      fs.copyFileSync(source, destination);
    }
    written.push(destinationRelative);
  }

  return {
    templateId: template.id,
    templateTitle: template.title,
    projectName,
    targetRoot,
    sdk: { ...manifest.sdk },
    files: written,
  };
}
