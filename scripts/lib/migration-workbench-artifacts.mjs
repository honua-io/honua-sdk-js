import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURE_NAME = "arcgis-source-app";
const FIXTURE_REPOSITORY_PATH = `examples/${FIXTURE_NAME}`;
const SCENARIO_REPOSITORY_PATH = `${FIXTURE_REPOSITORY_PATH}/src/workbench-scenario.js`;
const EXPECTED_BEHAVIOR_REPOSITORY_PATH = "examples/migration-workbench/fixtures/expected-behavior.v1.json";
const PUBLIC_ARTIFACT_ROOT = "examples/migration-workbench/public/artifacts/v1";
const GENERATED_TARGET_REPOSITORY_PATH = "examples/migration-workbench/src/generated/migrated-main.js";
const CLI_REPOSITORY_PATH = "dist/src/migration/cli.js";
const FIXED_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const MIGRATION_REPORT_REPOSITORY_PATH = `${PUBLIC_ARTIFACT_ROOT}/migration-report.v1.json`;
const WIDGET_REPORT_REPOSITORY_PATH = `${PUBLIC_ARTIFACT_ROOT}/widget-readiness.v1.json`;
const MAPLIBRE_REPORT_REPOSITORY_PATH = `${PUBLIC_ARTIFACT_ROOT}/maplibre-assessment.v1.json`;
const PATCH_REPOSITORY_PATH = `${PUBLIC_ARTIFACT_ROOT}/migration.v1.patch`;
const MANIFEST_REPOSITORY_PATH = `${PUBLIC_ARTIFACT_ROOT}/manifest.v1.json`;

const ARTIFACT_MEDIA_TYPES = new Map([
  [MIGRATION_REPORT_REPOSITORY_PATH, "application/json"],
  [WIDGET_REPORT_REPOSITORY_PATH, "application/json"],
  [MAPLIBRE_REPORT_REPOSITORY_PATH, "application/json"],
  [PATCH_REPOSITORY_PATH, "text/x-diff"],
  [GENERATED_TARGET_REPOSITORY_PATH, "text/javascript"],
]);

export const MIGRATION_WORKBENCH_ARTIFACT_PATHS = Object.freeze([
  MANIFEST_REPOSITORY_PATH,
  MIGRATION_REPORT_REPOSITORY_PATH,
  WIDGET_REPORT_REPOSITORY_PATH,
  MAPLIBRE_REPORT_REPOSITORY_PATH,
  PATCH_REPOSITORY_PATH,
  GENERATED_TARGET_REPOSITORY_PATH,
]);

export function defaultRepositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export async function buildMigrationWorkbenchArtifacts(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot());
  assertRequiredInputs(repositoryRoot);
  const temporaryParent = options.temporaryRoot ? path.resolve(options.temporaryRoot) : os.tmpdir();
  fs.mkdirSync(temporaryParent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "honua-migration-workbench-"));
  const keepWorkspace = options.keepWorkspace === true;

  const demoOutputRoot = path.join(temporaryRoot, "demo-output");
  const demoReportPath = path.join(temporaryRoot, "demo-report.raw.json");
  const widgetReportPath = path.join(temporaryRoot, "widget-readiness.raw.json");
  const maplibreReportPath = path.join(temporaryRoot, "maplibre-assessment.raw.json");
  const fixturePath = path.join(repositoryRoot, FIXTURE_REPOSITORY_PATH);
  const cliPath = path.join(repositoryRoot, CLI_REPOSITORY_PATH);

  for (const disposablePath of [demoOutputRoot, demoReportPath, widgetReportPath, maplibreReportPath]) {
    fs.rmSync(disposablePath, { recursive: true, force: true });
  }

  try {
    const normalization = { repositoryRoot, temporaryRoot };
    const demoCommand = runCliCommand({
      id: "honua-compat-demo",
      repositoryRoot,
      cliPath,
      args: [
        "demo",
        "--fixtures-root",
        path.join(repositoryRoot, "examples"),
        "--fixture",
        FIXTURE_NAME,
        "--output-dir",
        demoOutputRoot,
        "--target",
        "honua-compat",
        "--compat-import-path",
        "@honua/sdk-js/esri-compat",
        "--skip-import",
        "--skip-reconcile",
        "--report",
        demoReportPath,
      ],
      normalization,
    });
    const widgetCommand = runCliCommand({
      id: "widget-readiness",
      repositoryRoot,
      cliPath,
      args: ["widgets", fixturePath, "--json", "--report", widgetReportPath],
      normalization,
    });
    const maplibreCommand = runCliCommand({
      id: "honua-maplibre-dry-run",
      repositoryRoot,
      cliPath,
      args: ["codemod", fixturePath, "--target", "honua-maplibre", "--annotate-todos", "--report", maplibreReportPath],
      normalization,
    });

    const targetTreePath = path.join(demoOutputRoot, FIXTURE_NAME);
    const generatedScenarioPath = path.join(targetTreePath, "src", "workbench-scenario.js");
    if (!fs.existsSync(generatedScenarioPath)) {
      throw new Error(`Migration CLI did not generate ${generatedScenarioPath}.`);
    }

    const rawDemoReport = readJson(demoReportPath);
    const rawWidgetReport = readJson(widgetReportPath);
    const rawMaplibreReport = readJson(maplibreReportPath);
    const expectedBehaviorFixture = readJson(path.join(repositoryRoot, EXPECTED_BEHAVIOR_REPOSITORY_PATH));
    assertExpectedBehaviorFixture(expectedBehaviorFixture);

    const generatedTargetBytes = fs.readFileSync(generatedScenarioPath);
    const observedBehavior = await executeGeneratedBehavior(repositoryRoot, generatedTargetBytes);
    if (!isDeepStrictEqual(observedBehavior, expectedBehaviorFixture.expected)) {
      throw new Error(
        `Generated target behavior did not match ${EXPECTED_BEHAVIOR_REPOSITORY_PATH}.\n` +
          `Expected: ${JSON.stringify(expectedBehaviorFixture.expected, null, 2)}\n` +
          `Observed: ${JSON.stringify(observedBehavior, null, 2)}`,
      );
    }

    const patchResult = createMigrationPatch({
      sourceTreePath: fixturePath,
      targetTreePath,
      temporaryRoot,
    });
    const patchVerification = verifyMigrationPatch({
      sourceTreePath: fixturePath,
      targetTreePath,
      patchBytes: patchResult.bytes,
      temporaryRoot,
    });

    const normalizedDemoReport = normalizeArtifactValue(rawDemoReport, normalization);
    const normalizedWidgetReport = normalizeArtifactValue(rawWidgetReport, normalization);
    const normalizedMaplibreReport = normalizeArtifactValue(rawMaplibreReport, normalization);
    const normalizedExpectedBehavior = normalizeArtifactValue(expectedBehaviorFixture, normalization);
    const normalizedObservedBehavior = normalizeArtifactValue(observedBehavior, normalization);
    const commands = [demoCommand, widgetCommand, maplibreCommand];
    const provenance = buildProvenance();

    const migrationReport = {
      schemaVersion: "honua.migration-workbench.report.v1",
      fixture: FIXTURE_NAME,
      target: "honua-compat",
      provenance,
      commands,
      demo: normalizedDemoReport,
      behaviorProof: {
        passed: true,
        expectations: normalizedExpectedBehavior,
        observations: normalizedObservedBehavior,
        assertions: buildBehaviorAssertions(normalizedExpectedBehavior.expected, normalizedObservedBehavior),
      },
      patchProof: {
        command: patchResult.command,
        applyCheckPassed: patchVerification.applyCheckPassed,
        targetTreeEqual: patchVerification.targetTreeEqual,
        sourceTreeSha256: patchVerification.sourceTreeSha256,
        targetTreeSha256: patchVerification.targetTreeSha256,
        appliedTreeSha256: patchVerification.appliedTreeSha256,
      },
    };
    const widgetArtifact = {
      schemaVersion: "honua.migration-workbench.widget-readiness.v1",
      fixture: FIXTURE_NAME,
      command: widgetCommand,
      report: normalizedWidgetReport,
    };
    const maplibreArtifact = {
      schemaVersion: "honua.migration-workbench.maplibre-assessment.v1",
      fixture: FIXTURE_NAME,
      command: maplibreCommand,
      report: normalizedMaplibreReport,
      residuals: {
        errors: normalizedMaplibreReport.codemodResult?.errors ?? [],
        manualTodos: normalizedMaplibreReport.manualTodos ?? [],
        unsupportedModules: normalizedMaplibreReport.unhandledArcGisModules ?? [],
      },
    };

    const artifacts = new Map([
      [MIGRATION_REPORT_REPOSITORY_PATH, toJsonBytes(migrationReport)],
      [WIDGET_REPORT_REPOSITORY_PATH, toJsonBytes(widgetArtifact)],
      [MAPLIBRE_REPORT_REPOSITORY_PATH, toJsonBytes(maplibreArtifact)],
      [PATCH_REPOSITORY_PATH, patchResult.bytes],
      [GENERATED_TARGET_REPOSITORY_PATH, generatedTargetBytes],
    ]);
    const manifest = buildManifest(artifacts, provenance, commands);
    artifacts.set(MANIFEST_REPOSITORY_PATH, toJsonBytes(manifest));

    return {
      artifacts,
      manifest,
      commands,
      workspace: {
        temporaryRoot,
        sourceTreePath: fixturePath,
        targetTreePath,
      },
    };
  } finally {
    if (!keepWorkspace) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export async function materializeMigrationWorkbenchArtifacts(options = {}) {
  const mode = options.mode;
  if (mode !== "write" && mode !== "check") {
    throw new Error('Artifact mode must be exactly "write" or "check".');
  }

  const repositoryRoot = path.resolve(options.repositoryRoot ?? defaultRepositoryRoot());
  const result = await buildMigrationWorkbenchArtifacts({ repositoryRoot });
  const mismatches = [];

  for (const [repositoryPath, bytes] of result.artifacts) {
    const outputPath = path.join(repositoryRoot, repositoryPath);
    if (mode === "write") {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, bytes);
      continue;
    }

    if (!fs.existsSync(outputPath)) {
      mismatches.push(`${repositoryPath} is missing`);
      continue;
    }
    if (!fs.readFileSync(outputPath).equals(bytes)) {
      mismatches.push(`${repositoryPath} differs from deterministic CLI output`);
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Migration workbench artifacts are stale:\n- ${mismatches.join("\n- ")}\n` +
        "Run npm run demo:migration-workbench:artifacts:write and commit the results.",
    );
  }

  return {
    mode,
    artifactCount: result.artifacts.size,
    paths: [...result.artifacts.keys()].sort(),
  };
}

export function verifyMigrationPatch({ sourceTreePath, targetTreePath, patchBytes, temporaryRoot }) {
  const verificationRoot = path.join(temporaryRoot, "patch-verification");
  const appliedTreePath = path.join(verificationRoot, "applied");
  const patchPath = path.join(verificationRoot, "migration.patch");
  fs.rmSync(verificationRoot, { recursive: true, force: true });
  fs.mkdirSync(verificationRoot, { recursive: true });
  fs.cpSync(sourceTreePath, appliedTreePath, { recursive: true });
  fs.writeFileSync(patchPath, patchBytes);

  runRequiredCommand("git", ["apply", "--check", "--binary", "--whitespace=nowarn", patchPath], {
    cwd: appliedTreePath,
    label: "git apply --check",
  });
  runRequiredCommand("git", ["apply", "--binary", "--whitespace=nowarn", patchPath], {
    cwd: appliedTreePath,
    label: "git apply",
  });

  const sourceTreeSha256 = hashTree(sourceTreePath);
  const targetTreeSha256 = hashTree(targetTreePath);
  const appliedTreeSha256 = hashTree(appliedTreePath);
  if (targetTreeSha256 !== appliedTreeSha256) {
    throw new Error(
      `Applied patch tree ${appliedTreeSha256} does not match generated target tree ${targetTreeSha256}.`,
    );
  }

  return {
    applyCheckPassed: true,
    targetTreeEqual: true,
    sourceTreeSha256,
    targetTreeSha256,
    appliedTreeSha256,
  };
}

function assertRequiredInputs(repositoryRoot) {
  const requiredPaths = [
    CLI_REPOSITORY_PATH,
    FIXTURE_REPOSITORY_PATH,
    SCENARIO_REPOSITORY_PATH,
    EXPECTED_BEHAVIOR_REPOSITORY_PATH,
  ];
  for (const repositoryPath of requiredPaths) {
    const absolutePath = path.join(repositoryRoot, repositoryPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(
        `${repositoryPath} is required to generate migration workbench artifacts. ` +
          (repositoryPath === CLI_REPOSITORY_PATH ? "Run npm run build first." : ""),
      );
    }
  }
}

function runCliCommand({ id, repositoryRoot, cliPath, args, normalization }) {
  const environment = { TZ: "UTC", LANG: "C", LC_ALL: "C" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key]) {
      environment[key] = process.env[key];
    }
  }

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${id} failed with exit code ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }

  return {
    id,
    executable: "node",
    argv: [CLI_REPOSITORY_PATH, ...args].map((value) => normalizeString(value, normalization)),
    exitCode: result.status,
    stdout: normalizeCliText(result.stdout, normalization),
    stderr: normalizeCliText(result.stderr, normalization),
  };
}

function createMigrationPatch({ sourceTreePath, targetTreePath, temporaryRoot }) {
  const diffRoot = path.join(temporaryRoot, "diff-input");
  const sourceCopyPath = path.join(diffRoot, "source");
  const targetCopyPath = path.join(diffRoot, "target");
  fs.rmSync(diffRoot, { recursive: true, force: true });
  fs.mkdirSync(diffRoot, { recursive: true });
  fs.cpSync(sourceTreePath, sourceCopyPath, { recursive: true });
  fs.cpSync(targetTreePath, targetCopyPath, { recursive: true });

  const args = [
    "diff",
    "--no-index",
    "--binary",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "source",
    "target",
  ];
  const result = spawnSync("git", args, {
    cwd: diffRoot,
    encoding: "buffer",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git diff --no-index failed with exit code ${result.status}: ${result.stderr.toString()}`);
  }
  if (result.stdout.length === 0) {
    throw new Error("Migration CLI produced no source-to-target patch.");
  }

  return {
    command: {
      executable: "git",
      argv: args,
      exitCode: result.status,
      outcome: result.status === 1 ? "differences-found" : "no-differences",
      stderr: result.stderr.toString("utf8"),
    },
    bytes: Buffer.from(normalizeNoIndexPatch(result.stdout.toString("utf8")), "utf8"),
  };
}

function normalizeNoIndexPatch(patchText) {
  return patchText
    .split("\n")
    .map((line) => {
      if (line === " ") {
        return "";
      }
      if (line.startsWith("diff --git a/source/")) {
        return line.replace("diff --git a/source/", "diff --git a/").replace(" b/target/", " b/");
      }
      if (line.startsWith("--- a/source/")) {
        return line.replace("--- a/source/", "--- a/");
      }
      if (line.startsWith("+++ b/target/")) {
        return line.replace("+++ b/target/", "+++ b/");
      }
      if (line.startsWith("Binary files a/source/")) {
        return line.replace("Binary files a/source/", "Binary files a/").replace(" and b/target/", " and b/");
      }
      return line;
    })
    .join("\n");
}

async function executeGeneratedBehavior(repositoryRoot, generatedTargetBytes) {
  const executionParent = path.join(repositoryRoot, ".tmp");
  fs.mkdirSync(executionParent, { recursive: true });
  const executionRoot = fs.mkdtempSync(path.join(executionParent, "migration-workbench-execution-"));
  const executionPath = path.join(executionRoot, "migrated-main.js");
  try {
    fs.writeFileSync(executionPath, generatedTargetBytes);
    const moduleUrl = `${pathToFileURL(executionPath).href}?artifact=${Date.now()}`;
    const generatedModule = await import(moduleUrl);
    return cloneJsonValue(generatedModule.default);
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
}

function buildProvenance() {
  return {
    fixture: FIXTURE_REPOSITORY_PATH,
    scenario: SCENARIO_REPOSITORY_PATH,
    authorship: "Original Honua-authored repository fixture",
    licenseScope: "Apache-2.0 repository license; no third-party sample source is reproduced in these artifacts",
    excludedFixture: {
      path: "test/fixtures/esri-demo-feature-table-relates-app",
      reason:
        "Not used because publishable license evidence for that adapted fixture was not established " +
        "for this public artifact supply chain.",
    },
    transformationEngine: CLI_REPOSITORY_PATH,
    sourceUpload: false,
    externalNetworkRequests: false,
    credentialsRequired: false,
  };
}

function buildManifest(artifacts, provenance, commands) {
  const files = [...artifacts.entries()]
    .map(([repositoryPath, bytes]) => ({
      repositoryPath,
      mediaType: ARTIFACT_MEDIA_TYPES.get(repositoryPath) ?? "application/octet-stream",
      bytes: bytes.length,
      sha256: sha256(bytes),
    }))
    .sort((a, b) => a.repositoryPath.localeCompare(b.repositoryPath));

  return {
    schemaVersion: "honua.migration-workbench.manifest.v1",
    artifactSet: `${FIXTURE_NAME}/honua-compat`,
    fixture: FIXTURE_NAME,
    provenance,
    commands: commands.map(({ id, executable, argv, exitCode }) => ({ id, executable, argv, exitCode })),
    files,
  };
}

function buildBehaviorAssertions(expected, observed) {
  const assertions = [];
  for (const [jsonPath, expectedValue] of flattenJsonLeaves(expected)) {
    const observedValue = readJsonPath(observed, jsonPath);
    assertions.push({ path: jsonPath, expected: expectedValue, observed: observedValue, passed: true });
  }
  return assertions;
}

function flattenJsonLeaves(value, prefix = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenJsonLeaves(item, `${prefix}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.keys(value)
      .sort()
      .flatMap((key) => flattenJsonLeaves(value[key], `${prefix}.${key}`));
  }
  return [[prefix, value]];
}

function readJsonPath(value, jsonPath) {
  const tokens = jsonPath
    .slice(2)
    .split(/\.|\[|\]/)
    .filter(Boolean);
  let current = value;
  for (const token of tokens) {
    current = Array.isArray(current) ? current[Number.parseInt(token, 10)] : current[token];
  }
  return current;
}

function assertExpectedBehaviorFixture(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== "honua.migration-workbench.expected-behavior.v1" ||
    value.fixture !== FIXTURE_NAME ||
    value.entry !== "src/workbench-scenario.js" ||
    !isRecord(value.expected)
  ) {
    throw new Error(`${EXPECTED_BEHAVIOR_REPOSITORY_PATH} is not a valid v1 expectation fixture.`);
  }
}

function normalizeArtifactValue(value, normalization, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeArtifactValue(item, normalization));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((entryKey) => [entryKey, normalizeArtifactValue(value[entryKey], normalization, entryKey)]),
    );
  }
  if (key === "generatedAt" && typeof value === "string") {
    return FIXED_TIMESTAMP;
  }
  if (key === "elapsedMs" && typeof value === "number") {
    return 0;
  }
  return typeof value === "string" ? normalizeString(value, normalization) : value;
}

function normalizeCliText(value, normalization) {
  return normalizeString(value, normalization)
    .replace(/\bdata-generated-at="[^"]+"/g, `data-generated-at="${FIXED_TIMESTAMP}"`)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, FIXED_TIMESTAMP)
    .replace(/\belapsedMs=\d+\b/g, "elapsedMs=0")
    .replace(/("elapsedMs"\s*:\s*)\d+/g, "$10");
}

function normalizeString(value, { repositoryRoot, temporaryRoot }) {
  const replacements = [
    [path.resolve(temporaryRoot), "<workspace>"],
    [path.resolve(repositoryRoot), "<repo>"],
  ].sort((a, b) => b[0].length - a[0].length);
  let normalized = value;
  for (const [absolutePath, placeholder] of replacements) {
    normalized = normalized.split(absolutePath).join(placeholder);
    normalized = normalized.split(absolutePath.split(path.sep).join("/")).join(placeholder);
  }
  return normalized.split(path.sep).join("/");
}

function hashTree(rootPath) {
  const digest = createHash("sha256");
  for (const item of listTree(rootPath)) {
    digest.update(item.relativePath);
    digest.update("\0");
    digest.update(item.type);
    digest.update("\0");
    digest.update(String(item.executable));
    digest.update("\0");
    if (item.type === "file") {
      digest.update(fs.readFileSync(path.join(rootPath, item.relativePath)));
    } else if (item.type === "symlink") {
      digest.update(fs.readlinkSync(path.join(rootPath, item.relativePath)));
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

function listTree(rootPath) {
  const items = [];
  const visit = (currentPath, relativeParent) => {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = path.posix.join(relativeParent, entry.name);
      const stat = fs.lstatSync(absolutePath);
      const type = entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file";
      items.push({ relativePath, type, executable: (stat.mode & 0o111) !== 0 });
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      }
    }
  };
  visit(rootPath, "");
  return items;
}

function runRequiredCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.label} failed with exit code ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function toJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
