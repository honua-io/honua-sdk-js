#!/usr/bin/env node
// Lint agent skills under `skills/`:
//   1. Every skill directory has a SKILL.md with YAML frontmatter carrying a
//      non-empty `name` and `description`, and `name` must equal the directory.
//   2. Skill bodies may only reference commands and files that actually exist:
//      `npm run <script>` must be a real package.json script, and any
//      repo-relative file path (scripts/*.mjs, src/**, docs/**, root files, ...)
//      must exist on disk. This fails CI on drift.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");

function loadScripts(relPkg) {
  const pkgPath = path.join(ROOT, relPkg);
  if (!fs.existsSync(pkgPath)) return {};
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts ?? {};
}

const rootScripts = loadScripts("package.json");
const mcpScripts = loadScripts(path.join("mcp", "package.json"));

const errors = [];

function parseFrontmatter(source, relFile) {
  if (!source.startsWith("---")) {
    errors.push(`${relFile}: missing YAML frontmatter (must start with '---')`);
    return {};
  }
  const end = source.indexOf("\n---", 3);
  if (end === -1) {
    errors.push(`${relFile}: unterminated YAML frontmatter (missing closing '---')`);
    return {};
  }
  const block = source.slice(3, end);
  const fields = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return { fields, body: source.slice(end + 4) };
}

function checkReferences(body, relFile) {
  // `npm run <script>` — validate against the right package.json.
  const mcpRun = /npm\s+--prefix\s+mcp\s+run\s+([A-Za-z0-9:_-]+)/g;
  for (const match of body.matchAll(mcpRun)) {
    if (!(match[1] in mcpScripts)) {
      errors.push(`${relFile}: references mcp script "${match[1]}" not found in mcp/package.json`);
    }
  }
  const rootRun = /(?<!--prefix mcp )\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
  for (const match of body.matchAll(rootRun)) {
    if (!(match[1] in rootScripts)) {
      errors.push(`${relFile}: references npm script "${match[1]}" not found in package.json`);
    }
  }

  // Repo-relative file paths under known top-level dirs.
  const dirPath =
    /(?:^|[\s`("'])((?:\.github|src|docs|scripts|mcp|examples|skills|test|conformance|bench)\/[A-Za-z0-9._/-]+\.(?:mjs|cjs|json|jsonc|ts|tsx|js|md|txt|yml|yaml))/g;
  for (const match of body.matchAll(dirPath)) {
    const rel = match[1];
    if (!fs.existsSync(path.join(ROOT, rel))) {
      errors.push(`${relFile}: references file "${rel}" that does not exist`);
    }
  }

  // Root-level files referenced by bare name.
  const rootFile = /\b(README\.md|INSTALL\.md|package\.json|context7\.json|llms\.txt|llms-full\.txt|biome\.json)\b/g;
  for (const match of body.matchAll(rootFile)) {
    if (!fs.existsSync(path.join(ROOT, match[1]))) {
      errors.push(`${relFile}: references root file "${match[1]}" that does not exist`);
    }
  }
}

function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    process.stderr.write("skills/ directory not found\n");
    process.exitCode = 1;
    return;
  }

  const dirs = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let skillCount = 0;
  for (const dir of dirs) {
    const skillPath = path.join(SKILLS_DIR, dir, "SKILL.md");
    const relFile = path.join("skills", dir, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      errors.push(`skills/${dir}: missing SKILL.md`);
      continue;
    }
    skillCount += 1;
    const source = fs.readFileSync(skillPath, "utf8");
    const { fields, body } = parseFrontmatter(source, relFile);
    if (!fields) continue;

    if (!fields.name) errors.push(`${relFile}: frontmatter missing "name"`);
    else if (fields.name !== dir) {
      errors.push(`${relFile}: frontmatter name "${fields.name}" does not match directory "${dir}"`);
    }
    if (!fields.description || fields.description.length < 20) {
      errors.push(`${relFile}: frontmatter "description" missing or too short (state WHEN to use the skill)`);
    }
    if (body) checkReferences(body, relFile);
  }

  // Also lint skills/README.md references if present.
  const readme = path.join(SKILLS_DIR, "README.md");
  if (fs.existsSync(readme)) {
    checkReferences(fs.readFileSync(readme, "utf8"), path.join("skills", "README.md"));
  }

  if (errors.length > 0) {
    process.stderr.write("skills lint failed:\n");
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`skills lint passed: ${skillCount} skill(s) validated\n`);
}

main();
