#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { discoverMarkdownFiles, extractFencedBlocks } from "./lib/markdown-fences.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JAVASCRIPT_LANGUAGES = new Set(["js", "javascript", "jsx", "ts", "tsx", "typescript"]);

function parseQuotedAttribute(info, name, location) {
  const occurrences = [...info.matchAll(new RegExp(`(?:^|\\s)${name}=`, "g"))];
  if (occurrences.length > 1) throw new Error(`${location}: duplicate ${name} attribute`);
  if (occurrences.length === 0) return undefined;
  const match = new RegExp(`(?:^|\\s)${name}=("([^"]*)"|'([^']*)')(?:\\s|$)`).exec(info);
  if (!match) throw new Error(`${location}: ${name} must use a quoted value`);
  const value = match[2] ?? match[3] ?? "";
  if (value.trim().length === 0) throw new Error(`${location}: ${name} must not be empty`);
  return value;
}

function directiveFromInfo(info, location) {
  const directives = [...info.matchAll(/(?:^|\s)doc-test=([^\s]+)/g)].map((match) => match[1]);
  if (directives.length !== 1) {
    throw new Error(`${location}: exactly one doc-test=compile or doc-test=skip directive is required`);
  }
  const directive = directives[0];
  if (directive !== "compile" && directive !== "skip") {
    throw new Error(`${location}: unknown doc-test directive ${directive}`);
  }
  const reason = parseQuotedAttribute(info, "reason", location);
  const prelude = parseQuotedAttribute(info, "prelude", location);
  if (directive === "skip" && !reason) throw new Error(`${location}: doc-test=skip requires a quoted reason`);
  if (directive === "skip" && prelude) throw new Error(`${location}: doc-test=skip cannot declare a prelude`);
  if (directive === "compile" && reason) throw new Error(`${location}: doc-test=compile cannot declare a skip reason`);
  return { directive, prelude, reason };
}

// Re-exported so `discoverMarkdownFiles` keeps one import site for callers
// that read snippets and nothing else.
export { discoverMarkdownFiles, extractFencedBlocks };

export function extractSnippets(markdown, sourcePath) {
  const snippets = [];
  for (const block of extractFencedBlocks(markdown, sourcePath)) {
    if (!JAVASCRIPT_LANGUAGES.has(block.language)) continue;
    const location = `${block.sourcePath}:${block.startLine}`;
    snippets.push({
      code: block.content,
      language: block.language,
      location,
      sourcePath: block.sourcePath,
      startLine: block.startLine,
      ...directiveFromInfo(block.info, location),
    });
  }
  return snippets;
}

function extensionFor(language) {
  if (language === "javascript") return "js";
  if (language === "typescript") return "ts";
  return language;
}

function compilerOptions(projectRoot) {
  const configPath = path.join(projectRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.formatDiagnostic(read.error, diagnosticHost));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, projectRoot, undefined, configPath);
  if (parsed.errors.length > 0) throw new Error(ts.formatDiagnostics(parsed.errors, diagnosticHost));
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const splitPaths = {};
  for (const [packageName, subpath] of [
    ["@honua/geometry", "./geometry"],
    ["@honua/react", "./react"],
    ["@honua/sdk-esri-compat", "./esri-compat"],
  ]) {
    const typesPath = packageJson.exports?.[subpath]?.types;
    if (typeof typesPath === "string") splitPaths[packageName] = [typesPath];
  }
  return {
    ...parsed.options,
    allowJs: true,
    checkJs: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    incremental: false,
    noEmit: true,
    baseUrl: projectRoot,
    // A documentation snippet names the result of the call it is teaching and
    // stops there, so the repository's dead-code rules do not apply to it: an
    // illustrative binding is the point of the example, not an oversight.
    noUnusedLocals: false,
    noUnusedParameters: false,
    paths: { ...parsed.options.paths, ...splitPaths },
    skipLibCheck: true,
    sourceMap: false,
  };
}

const diagnosticHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => "\n",
};

function formatDiagnostic(diagnostic, snippet, preludeLines) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) return `${snippet.location}: TS${diagnostic.code}: ${message}`;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const snippetLine = Math.max(1, position.line + 1 - preludeLines);
  return `${snippet.location}:${snippetLine}: TS${diagnostic.code}: ${message}`;
}

function safePrelude(projectRoot, snippet) {
  if (!snippet.prelude) return "";
  if (path.isAbsolute(snippet.prelude) || snippet.prelude.split(/[\\/]/).includes("..")) {
    throw new Error(`${snippet.location}: prelude must be a repository-relative path without .. segments`);
  }
  const absolute = path.resolve(projectRoot, snippet.prelude);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
    throw new Error(`${snippet.location}: prelude does not exist: ${snippet.prelude}`);
  }
  return fs.readFileSync(absolute, "utf8");
}

function virtualEntry(snippet, projectRoot) {
  const prelude = safePrelude(projectRoot, snippet);
  const preludeLines = prelude.length === 0 ? 0 : prelude.split(/\r?\n/).length;
  const code = `${prelude}${prelude ? "\n" : ""}${snippet.code}\nexport {};\n`;
  const safeName = snippet.sourcePath.replace(/[^a-zA-Z0-9_.-]/g, "-");
  const fileName = path.join(projectRoot, ".docs-snippets", `${safeName}-${snippet.startLine}.${extensionFor(snippet.language)}`);
  return { code, fileName, preludeLines, snippet };
}

function compileEntries(entries, projectRoot, options = compilerOptions(projectRoot)) {
  if (entries.length === 0) return [];
  const byFileName = new Map(entries.map((entry) => [path.resolve(entry.fileName), entry]));
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (candidate) => byFileName.has(path.resolve(candidate)) || originalFileExists(candidate);
  host.readFile = (candidate) => byFileName.get(path.resolve(candidate))?.code ?? originalReadFile(candidate);
  host.getSourceFile = (candidate, languageVersion, onError, shouldCreateNewSourceFile) => {
    const entry = byFileName.get(path.resolve(candidate));
    if (entry) {
      return ts.createSourceFile(entry.fileName, entry.code, languageVersion, true);
    }
    return originalGetSourceFile(candidate, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram({ host, options, rootNames: entries.map((entry) => entry.fileName) });
  const fallback = entries[0];
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const entry = diagnostic.file ? (byFileName.get(path.resolve(diagnostic.file.fileName)) ?? fallback) : fallback;
    return formatDiagnostic(diagnostic, entry.snippet, entry.preludeLines);
  });
}

export function validateSnippetWithCompiler(snippet, projectRoot = ROOT, options = compilerOptions(projectRoot)) {
  if (snippet.directive === "skip") return [];
  return compileEntries([virtualEntry(snippet, projectRoot)], projectRoot, options);
}

export function validateSnippets({ files, projectRoot = ROOT }) {
  const failures = [];
  let compiled = 0;
  let skipped = 0;
  const options = compilerOptions(projectRoot);
  const entries = [];
  for (const file of files) {
    for (const snippet of file.snippets) {
      if (snippet.directive === "skip") {
        skipped += 1;
        continue;
      }
      compiled += 1;
      entries.push(virtualEntry(snippet, projectRoot));
    }
  }
  failures.push(...compileEntries(entries, projectRoot, options));
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
  const result = validateSnippets({ files: readSnippetFiles(ROOT), projectRoot: ROOT });
  process.stdout.write(`docsSnippets=ok files=${result.files} compiled=${result.compiled} skipped=${result.skipped}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
