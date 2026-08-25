#!/usr/bin/env node
// Lint agent skills under `skills/`.
//
// Structural checks:
//   1. Every skill directory has a SKILL.md with YAML frontmatter carrying a
//      non-empty `name` and `description`, and `name` must equal the directory.
//   2. Skill bodies may only reference commands and files that actually exist:
//      `npm run <script>` must be a real package.json script, and any
//      repo-relative file path (scripts/*.mjs, src/**, docs/**, root files, ...)
//      must exist on disk.
//
// Release-scoping and drift checks (honua-sdk-js#1425):
//   3. Every skill declares `release`, and it must equal the current release
//      derived from `mcp/release/zero-to-map/journey.v1.json` (`journeyId`).
//      There is no second hand-maintained release constant to drift.
//   4. Every skill declares `stages` (a possibly-empty inline list of journey
//      stage ids), and EVERY stage id in the journey must be claimed by at
//      least one skill. This is the "each terminal stage has a published
//      versioned skill" gate: deleting a stage skill fails this script.
//   5. Any package version pinned in a body (`@honua/sdk-js@X.Y.Z`) must match
//      `package.json` / `.release-please-manifest.json`. Registry availability
//      is a separate opt-in live lane (`HONUA_SKILLS_REGISTRY_LIVE_ENABLED=true`)
//      and never runs in PR CI.
//   6. Any `honua_*` tool name mentioned in a body must exist in a canonical
//      in-repo tool source (see `loadKnownToolNames`).
//   7. No credential-shaped literal may appear in a skill body. Skills are
//      loaded verbatim into agent context; they must reference secrets, never
//      carry them.
//
// All checks are offline. Run with `npm run verify:skills`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const JOURNEY_FILE = path.join("mcp", "release", "zero-to-map", "journey.v1.json");

const REGISTRY_LIVE_ENABLED = process.env.HONUA_SKILLS_REGISTRY_LIVE_ENABLED === "true";

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

function loadScripts(relPkg) {
  const pkgPath = path.join(ROOT, relPkg);
  if (!fs.existsSync(pkgPath)) return {};
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).scripts ?? {};
}

const rootScripts = loadScripts("package.json");
const mcpScripts = loadScripts(path.join("mcp", "package.json"));

const errors = [];

// ── Release + journey stages ────────────────────────────────────────

const journey = readJson(JOURNEY_FILE);

/**
 * The current release, derived from the release journey rather than a separate
 * constant, so there is exactly one place the release can change.
 */
function currentRelease() {
  const match = /^(\d{4}\.\d+)-/.exec(String(journey.journeyId ?? ""));
  if (!match) {
    throw new Error(`${JOURNEY_FILE}: journeyId "${journey.journeyId}" does not start with a <year>.<n> release`);
  }
  return match[1];
}

const CURRENT_RELEASE = currentRelease();
const JOURNEY_STAGES = (journey.stages ?? []).map((stage) => stage.id);

// ── Canonical package versions ──────────────────────────────────────

/**
 * Package name → the authoritative version, taken from
 * `.release-please-manifest.json` and cross-checked against each package.json.
 */
function loadPackageVersions() {
  const manifest = readJson(".release-please-manifest.json");
  const rootPkg = readJson("package.json");
  const mcpPkg = readJson(path.join("mcp", "package.json"));
  const createAppPkg = readJson(path.join("packages", "create-honua-app", "package.json"));

  for (const [manifestKey, pkg] of [
    [".", rootPkg],
    ["mcp", mcpPkg],
    ["packages/create-honua-app", createAppPkg],
  ]) {
    if (manifest[manifestKey] !== pkg.version) {
      errors.push(
        `${manifestKey}: package.json version ${pkg.version} disagrees with .release-please-manifest.json ${manifest[manifestKey]}`,
      );
    }
  }

  const root = manifest["."];
  return new Map([
    // The root package and every split package published from it.
    ["@honua/sdk-js", root],
    ["honua-sdk", root],
    ["honua-sdk-esri-compat", root],
    ["honua-migrate", root],
    ["@honua/react", root],
    ["honua-react", root],
    ["@honua/geometry", root],
    ["honua-geometry", root],
    ["@honua/mcp-server", manifest.mcp],
    ["create-honua-app", manifest["packages/create-honua-app"]],
    ["@honua/create-honua-app", manifest["packages/create-honua-app"]],
  ]);
}

const PACKAGE_VERSIONS = loadPackageVersions();

// ── Canonical honua_* tool names ────────────────────────────────────

function walkTypeScript(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkTypeScript(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

/**
 * Every `honua_*` tool name this repository can actually prove exists, mapped
 * to where the proof lives:
 *
 *  - `mcp/src/tools/<kebab-name>.ts` — the shipped `@honua/mcp-server` tool
 *    modules; the file name IS the tool name.
 *  - `server.tool(...)` / `server.registerTool(...)` registrations under
 *    `mcp/src/` — the catalog the server actually exposes.
 *  - `"tool"` entries in the 2026.1 release journey — the honua-server `/mcp`
 *    operator tools the release contract pins.
 *  - `mcp/src/certification/operator-catalog.ts` — the vendored operator-surface
 *    schemas the certification harness certifies against.
 */
function loadKnownToolNames() {
  const known = new Map();
  const add = (name, source) => {
    if (!known.has(name)) known.set(name, source);
  };

  const toolsDir = path.join(ROOT, "mcp", "src", "tools");
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir)) {
      if (!entry.endsWith(".ts")) continue;
      add(`honua_${entry.slice(0, -3).replaceAll("-", "_")}`, "mcp/src/tools");
    }
  }

  for (const file of walkTypeScript(path.join(ROOT, "mcp", "src"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bserver\.(?:tool|registerTool)\(\s*"(honua_[a-z0-9_]+)"/g)) {
      add(match[1], "mcp/src (registered tool)");
    }
  }

  const operatorCatalog = path.join(ROOT, "mcp", "src", "certification", "operator-catalog.ts");
  if (fs.existsSync(operatorCatalog)) {
    for (const match of fs.readFileSync(operatorCatalog, "utf8").matchAll(/\bname:\s*"(honua_[a-z0-9_]+)"/g)) {
      add(match[1], "mcp/src/certification/operator-catalog.ts");
    }
  }

  for (const stage of journey.stages ?? []) {
    for (const action of stage.actions ?? []) {
      if (typeof action.tool === "string") add(action.tool, JOURNEY_FILE);
    }
  }

  return known;
}

const KNOWN_TOOLS = loadKnownToolNames();

/**
 * Studio package `format` constants (`honua_map_package.v1`, ...) share the
 * `honua_*` prefix but are package versions, not MCP tools. They are collected
 * from the SDK source so a skill can cite one without the tool gate misreading
 * it — and so a constant that stops existing still fails.
 */
function loadPackageFormatConstants() {
  const formats = new Set();
  for (const file of walkTypeScript(path.join(ROOT, "src"))) {
    for (const match of fs.readFileSync(file, "utf8").matchAll(/"(honua_[a-z0-9_]+\.v\d+)"/g)) {
      formats.add(match[1]);
    }
  }
  return formats;
}

const PACKAGE_FORMATS = loadPackageFormatConstants();

// ── Credential-shaped literals ──────────────────────────────────────

const PLACEHOLDER = "(?!<|\\$\\{|env:|\\[|\\*|REDACTED|redacted|your-|YOUR-|xxx|XXX|change-?me|placeholder|example|secret\\b|token\\b)";

const CREDENTIAL_PATTERNS = [
  { label: "PEM private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { label: "provider API key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { label: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: "inline bearer token", pattern: /\bBearer\s+(?!<|\$\{)[A-Za-z0-9._~+/=-]{16,}/g },
  {
    label: "assigned secret literal",
    pattern: new RegExp(
      `\\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|client[_-]?secret|connection[_-]?string|private[_-]?key)\\b\\s*[:=]\\s*["']?${PLACEHOLDER}[A-Za-z0-9._~+/=-]{8,}`,
      "gi",
    ),
  },
  { label: "long opaque literal", pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g },
];

function checkNoCredentials(body, relFile) {
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      const excerpt = match[0].slice(0, 24);
      errors.push(
        `${relFile}: possible ${label} in skill body ("${excerpt}…"). Skills load verbatim into agent context — reference secrets (env:VAR, <placeholder>, credential id + digest), never embed them.`,
      );
    }
  }
}

// ── Frontmatter ─────────────────────────────────────────────────────

function parseScalar(raw) {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

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
    const raw = match[2].trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1).trim();
      fields[match[1]] = inner === "" ? [] : inner.split(",").map(parseScalar);
      continue;
    }
    fields[match[1]] = parseScalar(raw);
  }
  return { fields, body: source.slice(end + 4) };
}

// ── Reference checks ────────────────────────────────────────────────

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

function checkToolNames(body, relFile) {
  for (const match of body.matchAll(/\bhonua_[a-z0-9_]+(?:\.v\d+)?/g)) {
    const name = match[0];
    if (PACKAGE_FORMATS.has(name)) continue;
    if (name.includes(".")) {
      errors.push(`${relFile}: references package format "${name}" that is not defined in src/`);
      continue;
    }
    if (!KNOWN_TOOLS.has(name)) {
      errors.push(
        `${relFile}: references MCP tool "${name}" that does not exist in mcp/src/tools/, the mcp/src server registrations, ${JOURNEY_FILE}, or the vendored operator catalog`,
      );
    }
  }
}

/** Package pins found in a body, deduplicated: `${name}@${version}`. */
function pinnedPackageVersions(body) {
  const pins = new Map();
  const scoped = /(@honua\/[a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
  const bare = /(?<![\w@/-])(honua-sdk-esri-compat|honua-sdk|honua-migrate|honua-react|honua-geometry|create-honua-app)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
  for (const pattern of [scoped, bare]) {
    for (const match of body.matchAll(pattern)) {
      pins.set(`${match[1]}@${match[2]}`, { name: match[1], version: match[2] });
    }
  }
  return [...pins.values()];
}

function checkPackageVersions(body, relFile, livePins) {
  for (const pin of pinnedPackageVersions(body)) {
    const expected = PACKAGE_VERSIONS.get(pin.name);
    if (expected === undefined) {
      errors.push(`${relFile}: pins unknown package "${pin.name}@${pin.version}"`);
      continue;
    }
    if (pin.version !== expected) {
      errors.push(
        `${relFile}: pins ${pin.name}@${pin.version} but the repository publishes ${expected} (package.json / .release-please-manifest.json)`,
      );
      continue;
    }
    livePins.set(`${pin.name}@${pin.version}`, pin);
  }
}

/**
 * Opt-in live lane: confirm each pinned version is actually resolvable on the
 * public registry. Network-gated behind `HONUA_SKILLS_REGISTRY_LIVE_ENABLED`
 * like the repo's other live lanes, and never part of PR CI.
 */
async function checkRegistryAvailability(livePins) {
  for (const { name, version } of livePins.values()) {
    // encodeURIComponent, not a single `replace("/", ...)`: a lone replace
    // rewrites only the FIRST slash, so a crafted package name read out of a
    // skill file could keep a second one and steer the request to another
    // registry path. Encoding the whole segment closes that off, and is also
    // the conventional npm spelling for a scoped name.
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    let response;
    try {
      response = await fetch(url, { headers: { accept: "application/json" } });
    } catch (error) {
      errors.push(`registry lane: ${name}@${version} lookup failed: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    if (!response.ok) {
      errors.push(`registry lane: ${name}@${version} is not available on the npm registry (HTTP ${response.status})`);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
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

  const stageCoverage = new Map(JOURNEY_STAGES.map((stage) => [stage, []]));
  const livePins = new Map();
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

    if (!fields.release) {
      errors.push(`${relFile}: frontmatter missing "release" (expected release: "${CURRENT_RELEASE}")`);
    } else if (fields.release !== CURRENT_RELEASE) {
      errors.push(
        `${relFile}: frontmatter release "${fields.release}" is not the current release "${CURRENT_RELEASE}" (from ${JOURNEY_FILE})`,
      );
    }

    if (!Array.isArray(fields.stages)) {
      errors.push(
        `${relFile}: frontmatter missing "stages" inline list (e.g. stages: [install] — use stages: [] for a skill that serves no terminal stage)`,
      );
    } else {
      for (const stage of fields.stages) {
        if (!stageCoverage.has(stage)) {
          errors.push(
            `${relFile}: declares unknown journey stage "${stage}" (known stages: ${JOURNEY_STAGES.join(", ")})`,
          );
          continue;
        }
        stageCoverage.get(stage).push(dir);
      }
    }

    if (body) {
      checkReferences(body, relFile);
      checkToolNames(body, relFile);
      checkPackageVersions(body, relFile, livePins);
      checkNoCredentials(body, relFile);
    }
  }

  for (const [stage, owners] of stageCoverage) {
    if (owners.length === 0) {
      errors.push(
        `journey stage "${stage}" (${JOURNEY_FILE}) has no published ${CURRENT_RELEASE} skill: add a skills/<name>/SKILL.md declaring stages: [${stage}]`,
      );
    }
  }

  // Also lint skills/README.md references if present.
  const readme = path.join(SKILLS_DIR, "README.md");
  if (fs.existsSync(readme)) {
    const readmeSource = fs.readFileSync(readme, "utf8");
    checkReferences(readmeSource, path.join("skills", "README.md"));
    checkNoCredentials(readmeSource, path.join("skills", "README.md"));
  }

  if (REGISTRY_LIVE_ENABLED) await checkRegistryAvailability(livePins);

  if (errors.length > 0) {
    process.stderr.write("skills lint failed:\n");
    for (const error of errors) process.stderr.write(`- ${error}\n`);
    process.exitCode = 1;
    return;
  }

  const stageSummary = [...stageCoverage.entries()].map(([stage, owners]) => `${stage}=${owners.length}`).join(" ");
  process.stdout.write(
    `skills lint passed: ${skillCount} skill(s) validated for release ${CURRENT_RELEASE}; stage coverage ${stageSummary}\n`,
  );
  if (REGISTRY_LIVE_ENABLED) {
    process.stdout.write(`registry lane: ${livePins.size} pinned version(s) confirmed on the npm registry\n`);
  }
}

await main();
