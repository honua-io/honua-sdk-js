#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKDOWN_ROOTS = ["README.md", "INSTALL.md", "docs", "examples", "skills"];
const EXCLUDED_DIRECTORIES = new Set(["dist", "generated", "node_modules"]);
const JAVASCRIPT_LANGUAGES = new Set(["js", "javascript", "jsx", "ts", "tsx", "typescript"]);
const SPLIT_PACKAGE_SUBPATHS = new Map([
  ["@honua/geometry", "./geometry"],
  ["@honua/honua-migrate", "./migration"],
  ["@honua/react", "./react"],
  ["@honua/sdk-esri-compat", "./esri-compat"],
]);

function walkMarkdown(absolutePath, relativePath, output) {
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    if (absolutePath.endsWith(".md")) output.push(relativePath);
    return;
  }
  for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    walkMarkdown(path.join(absolutePath, entry.name), path.posix.join(relativePath, entry.name), output);
  }
}

export function discoverMarkdownFiles(projectRoot = ROOT, roots = MARKDOWN_ROOTS) {
  const files = [];
  for (const root of roots) {
    const absolute = path.join(projectRoot, root);
    if (fs.existsSync(absolute)) walkMarkdown(absolute, root, files);
  }
  return files.sort();
}

function directiveFromInfo(info, location) {
  const directive = /(?:^|\s)doc-test=(\w[\w-]*)/.exec(info)?.[1] ?? "compile";
  if (directive !== "compile" && directive !== "skip") {
    throw new Error(`${location}: unknown doc-test directive ${directive}`);
  }
  if (directive === "skip" && !/(?:^|\s)reason=(?:"[^"]+"|'[^']+'|\S+)/.test(info)) {
    throw new Error(`${location}: doc-test=skip requires a non-empty reason`);
  }
  return directive;
}

export function extractSnippets(markdown, sourcePath) {
  const lines = markdown.split(/\r?\n/);
  const snippets = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (!opening) continue;
    const marker = opening[2][0];
    const markerLength = opening[2].length;
    const info = opening[3].trim();
    const language = info.split(/\s+/, 1)[0].toLowerCase();
    const startLine = index + 1;
    const content = [];
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      if (new RegExp(`^\\s*${marker}{${markerLength},}\\s*$`).test(lines[index])) {
        closed = true;
        break;
      }
      content.push(lines[index]);
    }
    if (!closed) throw new Error(`${sourcePath}:${startLine}: unclosed Markdown fence`);
    if (!JAVASCRIPT_LANGUAGES.has(language)) continue;
    const location = `${sourcePath}:${startLine}`;
    snippets.push({
      code: content.join("\n"),
      directive: directiveFromInfo(info, location),
      language,
      location,
      sourcePath,
      startLine,
    });
  }
  return snippets;
}

function scriptKind(language) {
  if (language === "tsx") return ts.ScriptKind.TSX;
  if (language === "jsx") return ts.ScriptKind.JSX;
  if (language === "js" || language === "javascript") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function validateSnippetSyntax(snippet) {
  if (snippet.directive === "skip") return [];
  const result = ts.transpileModule(snippet.code, {
    compilerOptions: {
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: `snippet.${snippet.language === "typescript" ? "ts" : snippet.language}`,
    reportDiagnostics: true,
  });
  return (result.diagnostics ?? []).map(
    (diagnostic) => `${snippet.location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
  );
}

function selfPackageSubpath(specifier, packageName) {
  const splitSubpath = SPLIT_PACKAGE_SUBPATHS.get(specifier);
  if (splitSubpath) return splitSubpath;
  if (specifier === packageName) return ".";
  if (specifier.startsWith(`${packageName}/`)) return `.${specifier.slice(packageName.length)}`;
  return undefined;
}

export function collectSdkImports(snippet, packageName) {
  if (snippet.directive === "skip") return [];
  const source = ts.createSourceFile(
    `snippet.${snippet.language}`,
    snippet.code,
    ts.ScriptTarget.ES2022,
    true,
    scriptKind(snippet.language),
  );
  const imports = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const subpath = selfPackageSubpath(statement.moduleSpecifier.text, packageName);
    if (!subpath) continue;
    const names = [];
    const clause = statement.importClause;
    if (clause?.name) names.push("default");
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) names.push(element.propertyName?.text ?? element.name.text);
    }
    imports.push({ names, specifier: statement.moduleSpecifier.text, subpath });
  }
  return imports;
}

export function validateSnippetImports(snippet, packageJson, exportedSymbols) {
  const failures = [];
  for (const imported of collectSdkImports(snippet, packageJson.name)) {
    if (!packageJson.exports?.[imported.subpath]) {
      failures.push(`${snippet.location}: package path ${imported.specifier} is not exported`);
      continue;
    }
    const available = exportedSymbols.get(imported.subpath);
    if (!available) {
      failures.push(`${snippet.location}: declarations are missing for ${imported.specifier}; run npm run build`);
      continue;
    }
    for (const name of imported.names) {
      if (!available.has(name)) failures.push(`${snippet.location}: ${imported.specifier} has no exported member ${name}`);
    }
  }
  return failures;
}

export function loadExportedSymbols(projectRoot, packageJson) {
  const targets = new Map();
  for (const [subpath, definition] of Object.entries(packageJson.exports ?? {})) {
    const typesPath = typeof definition === "object" ? definition.types : undefined;
    if (typeof typesPath === "string") targets.set(subpath, path.resolve(projectRoot, typesPath));
  }
  const missing = [...targets.entries()].find(([, target]) => !fs.existsSync(target));
  if (missing) throw new Error(`built declarations are missing for ${missing[0]}; run npm run build`);

  const program = ts.createProgram({
    options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true },
    rootNames: [...targets.values()],
  });
  const checker = program.getTypeChecker();
  const result = new Map();
  for (const [subpath, target] of targets) {
    const source = program.getSourceFile(target);
    const moduleSymbol = source ? checker.getSymbolAtLocation(source) : undefined;
    result.set(subpath, new Set(moduleSymbol ? checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name) : []));
  }
  return result;
}

export function validateSnippets({ files, packageJson, exportedSymbols }) {
  const failures = [];
  let compiled = 0;
  let skipped = 0;
  for (const file of files) {
    for (const snippet of file.snippets) {
      if (snippet.directive === "skip") {
        skipped += 1;
        continue;
      }
      compiled += 1;
      failures.push(...validateSnippetSyntax(snippet));
      failures.push(...validateSnippetImports(snippet, packageJson, exportedSymbols));
    }
  }
  if (failures.length > 0) {
    throw new Error(`documentation snippet validation failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  }
  return { compiled, files: files.length, skipped };
}

export function readSnippetFiles(projectRoot = ROOT) {
  return discoverMarkdownFiles(projectRoot).map((sourcePath) => ({
    snippets: extractSnippets(fs.readFileSync(path.join(projectRoot, sourcePath), "utf8"), sourcePath),
    sourcePath,
  }));
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const result = validateSnippets({
    exportedSymbols: loadExportedSymbols(ROOT, packageJson),
    files: readSnippetFiles(ROOT),
    packageJson,
  });
  process.stdout.write(`docsSnippets=ok files=${result.files} compiled=${result.compiled} skipped=${result.skipped}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
