import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".d.ts"]);

/**
 * Relative import specifiers in one module. Package names and non-literal
 * dynamic imports are ignored. Comments are not imports.
 */
export function relativeImportSpecifiers(source) {
  const code = stripComments(source);
  const specifiers = new Set();
  for (const pattern of [
    /\bfrom\s*(['"])(\.[^'"]+)\1/g,
    /\bimport\s*(['"])(\.[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier.startsWith("./") || specifier.startsWith("../")) specifiers.add(specifier);
    }
  }
  return [...specifiers];
}

/**
 * Relative imports whose target file is not inside the copied package.
 * A specifier that resolves outside the package root is missing too: the
 * published tarball would not contain it.
 */
export function missingRelativeImports(packageRoot) {
  const missing = [];
  for (const file of javascriptFiles(packageRoot)) {
    const source = fs.readFileSync(file, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      if (!relativeTargetExists(packageRoot, file, specifier)) {
        missing.push({ file: path.relative(packageRoot, file), specifier });
      }
    }
  }
  missing.sort((left, right) => left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier));
  return missing;
}

function javascriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...javascriptFiles(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name)) || entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeTargetExists(packageRoot, fromFile, specifier) {
  const clean = specifier.split(/[?#]/, 1)[0];
  const resolved = path.resolve(path.dirname(fromFile), clean);
  const relative = path.relative(packageRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (isFile(resolved)) return true;
  if (isDirectory(resolved)) return isFile(path.join(resolved, "index.js")) || isFile(path.join(resolved, "index.d.ts"));
  return false;
}

function isFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function isDirectory(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
}

function stripComments(source) {
  let out = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      out += current;
      if (current === "\\") {
        out += next ?? "";
        index += 1;
        continue;
      }
      if (current === quote) quote = "";
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      out += current;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      out += " ";
      continue;
    }
    out += current;
  }
  return out;
}
