import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const matrixPath = path.join(repoRoot, "docs", "primitive-demo-integration-matrix.md");
const packagePath = path.join(repoRoot, "package.json");
const requiredIssues = new Set([177, 178, 179, 180, 181, 182, 183, 184, 185, 186]);

const matrix = fs.readFileSync(matrixPath, "utf8");
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
const scripts = packageJson.scripts ?? {};

const rows = matrix
  .split(/\r?\n/)
  .filter((line) => /^\| #\d+ \|/.test(line))
  .map(parseRow);

const seen = new Set();
const failures = [];

for (const row of rows) {
  seen.add(row.issue);
  if (!requiredIssues.has(row.issue)) {
    failures.push(`#${row.issue} is not part of the primitive issue set.`);
  }
  if (row.demoPaths.length === 0) {
    failures.push(`#${row.issue} does not list any demo path.`);
  }
  if (row.validationCommands.length === 0) {
    failures.push(`#${row.issue} does not list any validation command.`);
  }
  for (const demoPath of row.demoPaths) {
    if (!fs.existsSync(path.join(repoRoot, demoPath))) {
      failures.push(`#${row.issue} references missing demo path: ${demoPath}`);
    }
  }
  for (const command of row.validationCommands) {
    const scriptName = npmRunScriptName(command);
    if (!scriptName) {
      failures.push(`#${row.issue} validation command must be an npm script: ${command}`);
    } else if (!Object.hasOwn(scripts, scriptName)) {
      failures.push(`#${row.issue} references missing package script: ${scriptName}`);
    }
  }
}

for (const issue of requiredIssues) {
  if (!seen.has(issue)) failures.push(`#${issue} is missing from ${path.relative(repoRoot, matrixPath)}.`);
}

if (rows.length !== requiredIssues.size) {
  failures.push(`Expected ${requiredIssues.size} primitive rows, found ${rows.length}.`);
}

if (failures.length > 0) {
  console.error("Primitive demo matrix verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Primitive demo matrix covers ${rows.length} primitive issues.`);

function parseRow(line) {
  const cells = line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  const issue = Number(cells[0].match(/^#(\d+)$/)?.[1]);
  return {
    issue,
    demoPaths: codeSpans(cells[2]).filter((value) => value.startsWith("examples/")),
    validationCommands: codeSpans(cells[3]).filter((value) => value.startsWith("npm run ")),
  };
}

function codeSpans(markdownCell) {
  return [...markdownCell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
}

function npmRunScriptName(command) {
  const match = command.match(/^npm run ([^\s]+)$/);
  return match?.[1];
}
