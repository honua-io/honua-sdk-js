/**
 * Finding the documentation pages in this repository, and reading the fenced
 * code blocks out of them.
 *
 * Every gate that checks what the documentation tells a reader to do has to
 * agree about which pages count and where a block starts and ends -- a block one
 * parser misses is a block that gate cannot check -- so this lives in one
 * dependency-free module rather than once per gate. It deliberately imports
 * nothing outside `node:`, so a gate that only needs to read Markdown does not
 * have to install a compiler to run.
 */

import fs from "node:fs";
import path from "node:path";

const MARKDOWN_ROOTS = ["README.md", "INSTALL.md", "docs", "examples", "skills"];
const EXCLUDED_DIRECTORIES = new Set(["dist", "generated", "node_modules"]);

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

export function discoverMarkdownFiles(projectRoot, roots = MARKDOWN_ROOTS) {
  const files = [];
  for (const root of roots) {
    const absolute = path.join(projectRoot, root);
    if (fs.existsSync(absolute)) walkMarkdown(absolute, root, files);
  }
  return files.sort();
}

function stripBlockquotePrefix(line) {
  let rest = line;
  let depth = 0;
  while (true) {
    const match = /^ {0,3}>[ \t]?/.exec(rest);
    if (!match) return { depth, rest };
    rest = rest.slice(match[0].length);
    depth += 1;
  }
}

function openingFence(line) {
  const { depth, rest } = stripBlockquotePrefix(line);
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(rest);
  if (!match) return undefined;
  const info = match[2].trim();
  if (match[1][0] === "`" && info.includes("`")) return undefined;
  return { depth, info, marker: match[1][0], markerLength: match[1].length };
}

function isClosingFence(line, opening) {
  const { depth, rest } = stripBlockquotePrefix(line);
  if (depth !== opening.depth) return false;
  return new RegExp(`^ {0,3}${opening.marker}{${opening.markerLength},}[ \\t]*$`).test(rest);
}

function contentWithoutContainer(line, depth) {
  const stripped = stripBlockquotePrefix(line);
  return stripped.depth === depth ? stripped.rest : line;
}

/** Every fenced block in a page, whatever its language, in source order. */
export function extractFencedBlocks(markdown, sourcePath) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = openingFence(lines[index]);
    if (!opening) continue;
    const language = opening.info.split(/\s+/, 1)[0].toLowerCase();
    const startLine = index + 1;
    const content = [];
    let closed = false;
    for (index += 1; index < lines.length; index += 1) {
      if (isClosingFence(lines[index], opening)) {
        closed = true;
        break;
      }
      content.push(contentWithoutContainer(lines[index], opening.depth));
    }
    if (!closed) throw new Error(`${sourcePath}:${startLine}: unclosed Markdown fence`);
    blocks.push({ content: content.join("\n"), info: opening.info, language, sourcePath, startLine });
  }
  return blocks;
}
