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
  if (row.proofMarkers.length === 0) {
    failures.push(`#${row.issue} does not list any primitive proof marker.`);
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
  for (const proof of row.proofMarkers) {
    validateProofMarker(row.issue, proof, failures);
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
    proofMarkers: codeSpans(cells[4] ?? ""),
  };
}

function codeSpans(markdownCell) {
  return [...markdownCell.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
}

function npmRunScriptName(command) {
  const match = command.match(/^npm run ([^\s]+)$/);
  return match?.[1];
}

function validateProofMarker(issue, proof, targetFailures) {
  const parsed = parseProofMarker(proof);
  if (!parsed) {
    targetFailures.push(
      `#${issue} has unsupported proof marker: ${proof}. Use import:<file>:<module>, marker:<file>:<text>, or script:<name>.`,
    );
    return;
  }

  if (parsed.kind === "script") {
    if (!Object.hasOwn(scripts, parsed.scriptName)) {
      targetFailures.push(`#${issue} references missing proof script: ${parsed.scriptName}`);
    }
    return;
  }

  const absolutePath = path.join(repoRoot, parsed.filePath);
  if (!fs.existsSync(absolutePath)) {
    targetFailures.push(`#${issue} proof marker references missing file: ${parsed.filePath}`);
    return;
  }

  const source = fs.readFileSync(absolutePath, "utf8");
  if (parsed.kind === "marker") {
    if (!source.includes(parsed.text)) {
      targetFailures.push(`#${issue} proof marker not found in ${parsed.filePath}: ${parsed.text}`);
    }
    return;
  }

  const escapedModule = escapeRegExp(parsed.moduleName);
  const importPattern = new RegExp(`(?:from\\s+["']${escapedModule}["']|import\\(\\s*["']${escapedModule}["']\\s*\\))`);
  if (!importPattern.test(source)) {
    targetFailures.push(`#${issue} import proof not found in ${parsed.filePath}: ${parsed.moduleName}`);
  }
}

function parseProofMarker(proof) {
  if (proof.startsWith("script:")) {
    const scriptName = proof.slice("script:".length).trim();
    return scriptName ? { kind: "script", scriptName } : undefined;
  }

  const firstColon = proof.indexOf(":");
  if (firstColon < 0) return undefined;
  const secondColon = proof.indexOf(":", firstColon + 1);
  if (secondColon < 0) return undefined;

  const kind = proof.slice(0, firstColon);
  const filePath = proof.slice(firstColon + 1, secondColon).trim();
  const value = proof.slice(secondColon + 1).trim();
  if (!filePath || !value) return undefined;
  if (kind === "marker") return { kind, filePath, text: value };
  if (kind === "import") return { kind, filePath, moduleName: value };
  return undefined;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
