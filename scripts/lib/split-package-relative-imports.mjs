import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".d.ts"]);

/**
 * Relative import specifiers in one module. Package names, non-literal
 * dynamic imports, comments, and quoted or template text are ignored.
 * A real import inside a template substitution still counts.
 */
export function relativeImportSpecifiers(source) {
  const specifiers = new Set();
  scanCode(source, 0, source.length, false, specifiers);
  return [...specifiers];
}

/**
 * Relative imports whose target file is not inside the copied package.
 * A specifier that resolves outside the package root is missing too: the
 * published tarball would not contain it. An import in a declaration file
 * needs the declaration sibling, because NodeNext resolves `./file.js` to
 * `file.d.ts`.
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

function scanCode(source, start, end, inSubstitution, specifiers) {
  let index = start;
  let braceDepth = 0;
  while (index < end) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "}") {
      if (inSubstitution && braceDepth === 0) return index + 1;
      if (braceDepth > 0) braceDepth -= 1;
      index += 1;
      continue;
    }
    if (current === "{") {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < end && source[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < end && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(index + 2, end);
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      index = skipString(source, index, end, specifiers);
      continue;
    }
    if (readKeyword(source, index, "from")) {
      index = readSpecifierAfter(source, index + 4, end, specifiers);
      continue;
    }
    if (readKeyword(source, index, "import")) {
      index = readImport(source, index + 6, end, specifiers);
      continue;
    }
    if (readKeyword(source, index, "require")) {
      index = readCallSpecifier(source, index + 7, end, specifiers);
      continue;
    }
    index += 1;
  }
  return index;
}

function readImport(source, index, end, specifiers) {
  index = skipWhitespace(source, index, end);
  if (source[index] === "(") return readCallSpecifier(source, index, end, specifiers);
  return readSpecifierAfter(source, index, end, specifiers);
}

function readCallSpecifier(source, index, end, specifiers) {
  index = skipWhitespace(source, index, end);
  if (source[index] !== "(") return index;
  index = skipWhitespace(source, index + 1, end);
  const quoted = readQuoted(source, index, end);
  if (!quoted) return index;
  remember(specifiers, quoted.value);
  return quoted.index;
}

function readSpecifierAfter(source, index, end, specifiers) {
  index = skipWhitespace(source, index, end);
  const quoted = readQuoted(source, index, end);
  if (!quoted) return index;
  remember(specifiers, quoted.value);
  return quoted.index;
}

function remember(specifiers, specifier) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) specifiers.add(specifier);
}

function readKeyword(source, index, word) {
  if (!source.startsWith(word, index)) return false;
  const before = index === 0 ? "" : source[index - 1];
  const after = source[index + word.length] ?? "";
  return !isIdentifierChar(before) && !isIdentifierChar(after);
}

function readQuoted(source, index, end) {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  index += 1;
  while (index < end) {
    const current = source[index];
    if (current === "\\") {
      value += source[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (current === quote) return { value, index: index + 1 };
    value += current;
    index += 1;
  }
  return { value, index };
}

function skipString(source, index, end, specifiers) {
  const quote = source[index];
  index += 1;
  while (index < end) {
    const current = source[index];
    if (current === "\\") {
      index += 2;
      continue;
    }
    if (current === quote) return index + 1;
    if (quote === "`" && current === "$" && source[index + 1] === "{") {
      index = scanCode(source, index + 2, end, true, specifiers);
      continue;
    }
    index += 1;
  }
  return index;
}

function skipWhitespace(source, index, end) {
  while (index < end && /\s/.test(source[index])) index += 1;
  return index;
}

function isIdentifierChar(char) {
  return /[A-Za-z0-9_$]/.test(char);
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
  if (isDeclarationFile(fromFile)) return declarationTargetExists(resolved);
  if (isFile(resolved)) return true;
  if (isDirectory(resolved)) return isFile(path.join(resolved, "index.js")) || isFile(path.join(resolved, "index.d.ts"));
  return false;
}

function declarationTargetExists(resolved) {
  const sibling = declarationSibling(resolved);
  if (sibling && isFile(sibling)) return true;
  if (isDeclarationFile(resolved) && isFile(resolved)) return true;
  if (!isDirectory(resolved)) return false;
  return isFile(path.join(resolved, "index.d.ts")) || isFile(path.join(resolved, "index.d.mts"));
}

function declarationSibling(resolved) {
  if (resolved.endsWith(".mjs")) return `${resolved.slice(0, -4)}.d.mts`;
  if (resolved.endsWith(".cjs")) return `${resolved.slice(0, -4)}.d.cts`;
  if (resolved.endsWith(".js")) return `${resolved.slice(0, -3)}.d.ts`;
  return null;
}

function isDeclarationFile(filePath) {
  return filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts");
}

function isFile(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function isDirectory(filePath) {
  return fs.existsSync(filePath) && fs.statSync(filePath).isDirectory();
}
