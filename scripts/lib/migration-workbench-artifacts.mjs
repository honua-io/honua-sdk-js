import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { verifyPreparedSdkArtifact } from "./prepared-sdk-artifact.mjs";

const FIXTURE_NAME = "arcgis-source-app";
const FIXTURE_REPOSITORY_PATH = `examples/${FIXTURE_NAME}`;
const SCENARIO_REPOSITORY_PATH = `${FIXTURE_REPOSITORY_PATH}/src/workbench-scenario.js`;
const EXPECTED_BEHAVIOR_REPOSITORY_PATH = "examples/migration-workbench/fixtures/expected-behavior.v1.json";
const PUBLIC_ARTIFACT_ROOT = "examples/migration-workbench/public/artifacts/v1";
const GENERATED_TARGET_REPOSITORY_PATH = "examples/migration-workbench/src/generated/migrated-main.js";
const GENERATED_TARGET_ROOT = path.posix.dirname(GENERATED_TARGET_REPOSITORY_PATH);
const CLI_REPOSITORY_PATH = "dist/src/migration/cli.js";
const EXECUTION_RUNNER_REPOSITORY_PATH = "scripts/lib/migration-workbench-execution-runner.mjs";
const NETWORK_GUARD_REPOSITORY_PATH = "scripts/lib/migration-workbench-network-guard.mjs";
const FIXED_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const CLI_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 20_000;
const GENERATED_EXECUTION_TIMEOUT_MS = 10_000;
const MAX_SUBPROCESS_BUFFER = 16 * 1024 * 1024;

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

const GIT_CONFIG_ARGUMENTS = Object.freeze([
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=true",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.fileMode=true",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.indentHeuristic=false",
  "-c",
  "apply.whitespace=nowarn",
]);

export const MIGRATION_WORKBENCH_ARTIFACT_PATHS = Object.freeze([
  MANIFEST_REPOSITORY_PATH,
  MIGRATION_REPORT_REPOSITORY_PATH,
  WIDGET_REPORT_REPOSITORY_PATH,
  MAPLIBRE_REPORT_REPOSITORY_PATH,
  PATCH_REPOSITORY_PATH,
  GENERATED_TARGET_REPOSITORY_PATH,
]);

const EXPECTED_ARTIFACT_PATHS = new Set(MIGRATION_WORKBENCH_ARTIFACT_PATHS);
const EXPECTED_PUBLIC_ARTIFACT_NAMES = new Set(
  MIGRATION_WORKBENCH_ARTIFACT_PATHS.filter((repositoryPath) => repositoryPath.startsWith(`${PUBLIC_ARTIFACT_ROOT}/`)).map(
    (repositoryPath) => path.posix.basename(repositoryPath),
  ),
);
const EXPECTED_GENERATED_TARGET_NAMES = new Set([path.posix.basename(GENERATED_TARGET_REPOSITORY_PATH)]);
const RETIREMENT_ROOTS = Object.freeze([
  {
    repositoryPath: PUBLIC_ARTIFACT_ROOT,
    expectedNames: EXPECTED_PUBLIC_ARTIFACT_NAMES,
    label: "public migration artifact root",
  },
  {
    repositoryPath: GENERATED_TARGET_ROOT,
    expectedNames: EXPECTED_GENERATED_TARGET_NAMES,
    label: "generated migration target root",
  },
]);

export function defaultRepositoryRoot() {
  return canonicalizeExistingDirectory(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "repository root");
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export async function buildMigrationWorkbenchArtifacts(options = {}) {
  const repositoryRoot = canonicalizeExistingDirectory(
    path.resolve(options.repositoryRoot ?? defaultRepositoryRoot()),
    "repository root",
  );
  const preparedSdk = capturePreparedSdkIdentity(repositoryRoot);
  const requiredInputs = assertRequiredInputs(repositoryRoot);
  const temporaryParent = canonicalizeExistingDirectory(
    path.resolve(options.temporaryRoot ?? os.tmpdir()),
    "artifact temporary root",
  );
  const temporaryRoot = fs.mkdtempSync(path.join(temporaryParent, "honua-migration-workbench-"));
  const keepWorkspace = options.keepWorkspace === true;

  const demoOutputRoot = path.join(temporaryRoot, "demo-output");
  const demoReportPath = path.join(temporaryRoot, "demo-report.raw.json");
  const widgetReportPath = path.join(temporaryRoot, "widget-readiness.raw.json");
  const maplibreReportPath = path.join(temporaryRoot, "maplibre-assessment.raw.json");
  const liveSourceIdentity = captureLiveSourceIdentity(requiredInputs);
  const sourceSnapshotRoot = path.join(temporaryRoot, "source-snapshot");
  const fixturePath = path.join(sourceSnapshotRoot, FIXTURE_NAME);
  fs.mkdirSync(sourceSnapshotRoot);
  writeRegularTreeSnapshot(liveSourceIdentity.fixtureEntries, fixturePath);
  const expectedBehaviorPath = path.join(sourceSnapshotRoot, "expected-behavior.v1.json");
  writeNewRegularFile(expectedBehaviorPath, liveSourceIdentity.expectedBehaviorBytes);
  assertSourceSnapshotIdentity(fixturePath, expectedBehaviorPath, liveSourceIdentity);
  assertLiveSourceIdentity(requiredInputs, liveSourceIdentity);
  const cliPath = requiredInputs.cliPath;

  try {
    const normalization = {
      repositoryRoot,
      temporaryRoot,
      aliases: [
        [fixturePath, path.join(repositoryRoot, ...FIXTURE_REPOSITORY_PATH.split("/"))],
        [sourceSnapshotRoot, path.join(repositoryRoot, "examples")],
      ],
    };
    const demoCommand = runCliCommand({
      id: "honua-compat-demo",
      repositoryRoot,
      temporaryRoot,
      cliPath,
      args: [
        "demo",
        "--fixtures-root",
        sourceSnapshotRoot,
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
    options.testHooks?.afterCommand?.("honua-compat-demo", repositoryRoot);
    const widgetCommand = runCliCommand({
      id: "widget-readiness",
      repositoryRoot,
      temporaryRoot,
      cliPath,
      args: ["widgets", fixturePath, "--json", "--report", widgetReportPath],
      normalization,
    });
    options.testHooks?.afterCommand?.("widget-readiness", repositoryRoot);
    const maplibreCommand = runCliCommand({
      id: "honua-maplibre-dry-run",
      repositoryRoot,
      temporaryRoot,
      cliPath,
      args: ["codemod", fixturePath, "--target", "honua-maplibre", "--annotate-todos", "--report", maplibreReportPath],
      normalization,
    });
    options.testHooks?.afterCommand?.("honua-maplibre-dry-run", repositoryRoot);

    const targetTreePath = resolveAbsoluteInsideRoot(
      temporaryRoot,
      path.join(demoOutputRoot, FIXTURE_NAME),
      "generated migration target tree",
      "directory",
    );
    // Capture the whole CLI output before consuming any file. This rejects links and special files anywhere in the tree.
    captureRegularTree(targetTreePath);
    const generatedScenarioPath = resolveAbsoluteInsideRoot(
      temporaryRoot,
      path.join(targetTreePath, "src", "workbench-scenario.js"),
      "generated migration scenario",
      "file",
    );
    const validatedDemoReportPath = resolveAbsoluteInsideRoot(
      temporaryRoot,
      demoReportPath,
      "migration demo report",
      "file",
    );
    const validatedWidgetReportPath = resolveAbsoluteInsideRoot(
      temporaryRoot,
      widgetReportPath,
      "widget report",
      "file",
    );
    const validatedMaplibreReportPath = resolveAbsoluteInsideRoot(
      temporaryRoot,
      maplibreReportPath,
      "MapLibre report",
      "file",
    );

    const rawDemoReport = readJson(validatedDemoReportPath);
    const rawWidgetReport = readJson(validatedWidgetReportPath);
    const rawMaplibreReport = readJson(validatedMaplibreReportPath);
    const expectedBehaviorFixture = readJson(expectedBehaviorPath);
    assertExpectedBehaviorFixture(expectedBehaviorFixture);

    const generatedTargetBytes = readRegularFile(generatedScenarioPath, "generated migration scenario");
    const execution = executeIsolatedGeneratedModule({ repositoryRoot, generatedTargetBytes });
    const observedBehavior = execution.value;
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
    assertLiveSourceIdentity(requiredInputs, liveSourceIdentity);
    verifyPreparedSdkIdentity(repositoryRoot, preparedSdk);

    const normalizedDemoReport = normalizeArtifactValue(rawDemoReport, normalization);
    const normalizedWidgetReport = normalizeArtifactValue(rawWidgetReport, normalization);
    const normalizedMaplibreReport = normalizeArtifactValue(rawMaplibreReport, normalization);
    const normalizedExpectedBehavior = normalizeArtifactValue(expectedBehaviorFixture, normalization);
    const normalizedObservedBehavior = normalizeArtifactValue(observedBehavior, normalization);
    const commands = [demoCommand, widgetCommand, maplibreCommand];
    const provenance = buildProvenance(preparedSdk, liveSourceIdentity, execution.evidence);

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
        applyCheckCommand: patchVerification.applyCheckCommand,
        applyCommand: patchVerification.applyCommand,
        applyCheckPassed: patchVerification.applyCheckPassed,
        targetTreeEqual: patchVerification.targetTreeEqual,
        directEntryComparisonPassed: patchVerification.directEntryComparisonPassed,
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
      guards: {
        preparedSdk,
        liveSourceIdentity,
      },
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

  const repositoryRoot = canonicalizeExistingDirectory(
    path.resolve(options.repositoryRoot ?? defaultRepositoryRoot()),
    "repository root",
  );
  // Reject unsafe output paths before running the migration CLI, then repeat the preflight immediately before commit.
  preflightArtifactDestinations(repositoryRoot);
  const result = await buildMigrationWorkbenchArtifacts({ repositoryRoot, testHooks: options.testHooks });
  const verifyPublicationInputs = () => {
    verifyPreparedSdkIdentity(repositoryRoot, result.guards.preparedSdk);
    assertLiveSourceIdentity(assertRequiredInputs(repositoryRoot), result.guards.liveSourceIdentity);
  };
  return materializeArtifactSet({
    mode,
    repositoryRoot,
    artifacts: result.artifacts,
    testHooks: options.testHooks,
    publicationGuard: verifyPublicationInputs,
  });
}

export function materializeArtifactSet({
  mode,
  repositoryRoot: repositoryRootOption,
  artifacts,
  testHooks,
  publicationGuard,
}) {
  if (mode !== "write" && mode !== "check") {
    throw new Error('Artifact mode must be exactly "write" or "check".');
  }
  const repositoryRoot = canonicalizeExistingDirectory(path.resolve(repositoryRootOption), "repository root");
  assertArtifactAllowlist(artifacts);
  const state = preflightArtifactDestinations(repositoryRoot);

  if (mode === "check") {
    testHooks?.beforePublication?.(repositoryRoot);
    publicationGuard?.();
    const mismatches = [];
    for (const repositoryPath of sortedArtifactPaths()) {
      const expectedBytes = artifacts.get(repositoryPath);
      const outputPath = resolveRepositoryPath(repositoryRoot, repositoryPath, {
        allowMissing: true,
        expectedType: "file",
        label: `artifact output ${repositoryPath}`,
      });
      const outputStat = lstatOrUndefined(outputPath);
      if (!outputStat) {
        mismatches.push(`${repositoryPath} is missing`);
      } else if (!readRegularFile(outputPath, `artifact output ${repositoryPath}`).equals(expectedBytes)) {
        mismatches.push(`${repositoryPath} differs from deterministic CLI output`);
      }
    }
    for (const retired of state.retiredEntries) {
      mismatches.push(`${retired.repositoryPath} is an unexpected retired artifact entry`);
    }
    if (mismatches.length > 0) {
      throw staleArtifactsError(mismatches);
    }
    publicationGuard?.();
  } else {
    commitArtifactSet({ repositoryRoot, artifacts, state, testHooks, publicationGuard });
  }

  return {
    mode,
    artifactCount: artifacts.size,
    paths: sortedArtifactPaths(),
  };
}

export function verifyMigrationPatch({ sourceTreePath, targetTreePath, patchBytes, temporaryRoot }) {
  const canonicalTemporaryRoot = canonicalizeExistingDirectory(temporaryRoot, "patch verification temporary root");
  const verificationRoot = path.join(canonicalTemporaryRoot, "patch-verification");
  const appliedTreePath = path.join(verificationRoot, "applied");
  const patchPath = path.join(verificationRoot, "migration.patch");
  if (lstatOrUndefined(verificationRoot)) {
    assertSafePathChain(verificationRoot, { expectedType: "directory", label: "patch verification root" });
    fs.rmSync(verificationRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(verificationRoot);
  copyRegularTree(sourceTreePath, appliedTreePath);
  writeNewRegularFile(patchPath, patchBytes);

  const patchArgument = path.relative(appliedTreePath, patchPath).split(path.sep).join("/");
  const applyCheckArgs = gitArgs("apply", "--check", "--binary", "--whitespace=nowarn", patchArgument);
  const applyArgs = gitArgs("apply", "--binary", "--whitespace=nowarn", patchArgument);
  const gitEnvironment = createHermeticEnvironment(path.join(verificationRoot, "git-home"), {
    gitCeilingDirectory: verificationRoot,
  });
  runBoundedCommand("git", applyCheckArgs, {
    cwd: appliedTreePath,
    env: gitEnvironment,
    label: "git apply --check",
    timeoutMs: GIT_TIMEOUT_MS,
  });
  runBoundedCommand("git", applyArgs, {
    cwd: appliedTreePath,
    env: gitEnvironment,
    label: "git apply",
    timeoutMs: GIT_TIMEOUT_MS,
  });

  const sourceTree = captureRegularTree(sourceTreePath);
  const targetTree = captureRegularTree(targetTreePath);
  const appliedTree = captureRegularTree(appliedTreePath);
  const sourceTreeSha256 = digestTreeSnapshot(sourceTree);
  const targetTreeSha256 = digestTreeSnapshot(targetTree);
  const appliedTreeSha256 = digestTreeSnapshot(appliedTree);
  const directEntryComparisonPassed = regularTreeSnapshotsEqual(targetTree, appliedTree);
  if (!directEntryComparisonPassed || targetTreeSha256 !== appliedTreeSha256) {
    throw new Error(
      `Applied patch tree ${appliedTreeSha256} does not match generated target tree ${targetTreeSha256}.`,
    );
  }

  return {
    applyCheckCommand: {
      executable: "git",
      argv: applyCheckArgs,
      exitCode: 0,
    },
    applyCommand: {
      executable: "git",
      argv: applyArgs,
      exitCode: 0,
    },
    applyCheckPassed: true,
    targetTreeEqual: true,
    directEntryComparisonPassed: true,
    sourceTreeSha256,
    targetTreeSha256,
    appliedTreeSha256,
  };
}

export function captureRegularTree(rootPath) {
  const canonicalRoot = canonicalizeExistingDirectory(rootPath, "tree root");
  const entries = [];

  const visit = (currentPath, relativeParent) => {
    const names = fs.readdirSync(currentPath).sort(compareUtf8);
    for (const name of names) {
      const absolutePath = path.join(currentPath, name);
      const relativePath = path.posix.join(relativeParent, name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsafe symbolic link in deterministic tree: ${absolutePath}`);
      }
      if (stat.isDirectory()) {
        entries.push({
          relativePath,
          type: "directory",
          executable: (stat.mode & 0o111) !== 0,
          byteLength: 0,
          contentSha256: sha256(Buffer.alloc(0)),
          bytes: Buffer.alloc(0),
        });
        visit(absolutePath, relativePath);
      } else if (stat.isFile()) {
        const bytes = readRegularFile(absolutePath, `tree entry ${relativePath}`);
        entries.push({
          relativePath,
          type: "file",
          executable: (stat.mode & 0o111) !== 0,
          byteLength: bytes.length,
          contentSha256: sha256(bytes),
          bytes,
        });
      } else {
        throw new Error(`Unsupported special file in deterministic tree: ${absolutePath}`);
      }
    }
  };

  visit(canonicalRoot, "");
  entries.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return Object.freeze(entries);
}

export function digestTreeSnapshot(entries) {
  const digest = createHash("sha256");
  updateLengthFramed(digest, Buffer.from("honua.regular-tree.v2", "utf8"));
  updateLengthFramed(digest, Buffer.from(String(entries.length), "ascii"));
  for (const entry of entries) {
    updateLengthFramed(digest, Buffer.from(entry.relativePath, "utf8"));
    updateLengthFramed(digest, Buffer.from(entry.type, "ascii"));
    updateLengthFramed(digest, Buffer.from(entry.executable ? "1" : "0", "ascii"));
    updateLengthFramed(digest, Buffer.from(String(entry.byteLength), "ascii"));
    updateLengthFramed(digest, Buffer.from(entry.contentSha256, "ascii"));
  }
  return digest.digest("hex");
}

export function hashRegularTree(rootPath) {
  return digestTreeSnapshot(captureRegularTree(rootPath));
}

export function regularTreeSnapshotsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return (
      entry.relativePath === other.relativePath &&
      entry.type === other.type &&
      entry.executable === other.executable &&
      entry.byteLength === other.byteLength &&
      entry.contentSha256 === other.contentSha256 &&
      entry.bytes.equals(other.bytes)
    );
  });
}

export function executeIsolatedGeneratedModule({
  repositoryRoot: repositoryRootOption,
  generatedTargetBytes,
  timeoutMs = GENERATED_EXECUTION_TIMEOUT_MS,
}) {
  const repositoryRoot = canonicalizeExistingDirectory(repositoryRootOption, "repository root");
  const runnerPath = resolveRepositoryPath(repositoryRoot, EXECUTION_RUNNER_REPOSITORY_PATH, {
    expectedType: "file",
    label: "isolated execution runner",
  });
  resolveRepositoryPath(repositoryRoot, NETWORK_GUARD_REPOSITORY_PATH, {
    expectedType: "file",
    label: "isolated network guard",
  });
  const executionParent = ensureRepositoryDirectory(repositoryRoot, ".tmp");
  const executionRoot = fs.mkdtempSync(path.join(executionParent, "migration-workbench-execution-"));
  const executionPath = path.join(executionRoot, "migrated-main.js");

  try {
    writeNewRegularFile(executionPath, generatedTargetBytes);
    const runnerNonce = randomBytes(32).toString("hex");
    const permissionReadRoots = [repositoryRoot, executionRoot, ...findAncestorNodeModules(repositoryRoot)];
    const args = ["--no-warnings", "--experimental-permission"];
    for (const readRoot of uniqueSortedPaths(permissionReadRoots)) {
      args.push(`--allow-fs-read=${readRoot}`);
    }
    args.push(`--allow-fs-write=${executionRoot}`, runnerPath, executionPath);

    const result = runBoundedCommand(process.execPath, args, {
      cwd: executionRoot,
      env: createHermeticEnvironment(path.join(executionRoot, "home"), { temporaryRoot: executionRoot }),
      label: "isolated generated migration target",
      timeoutMs,
      input: `${runnerNonce}\n`,
    });
    let payload;
    try {
      payload = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error(
        `Isolated generated migration target returned invalid runner output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      !isRecord(payload) ||
      payload.protocol !== "honua.migration-workbench.runner.v1" ||
      payload.nonce !== runnerNonce ||
      !Array.isArray(payload.networkAttempts) ||
      !("value" in payload)
    ) {
      throw new Error("Isolated generated migration target returned an invalid result envelope.");
    }
    if (payload.networkAttempts.length !== 0) {
      throw new Error("Isolated generated migration target reported denied network attempts.");
    }
    return {
      value: cloneJsonValue(payload.value),
      evidence: {
        processBoundary: "separate Node.js process",
        permissionModel: "Node.js experimental permission model",
        readableScope: "repository runtime, isolated target, and resolved dependency roots",
        writableScope: "isolated execution workspace only",
        inheritedEnvironment: "fixed non-secret allowlist",
        childProcesses: "denied by the Node.js permission model",
        workerThreads: "denied by the Node.js permission model",
        networkGuardScope: "standard Node.js HTTP, HTTPS, fetch, WebSocket, net, TLS, DNS, and datagram APIs",
        externalNetworkAttemptsObserved: 0,
        timeoutMs,
      },
    };
  } finally {
    fs.rmSync(executionRoot, { recursive: true, force: true });
  }
}

export function runBoundedCommand(command, args, options) {
  const timeoutMs = options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`A positive subprocess timeout is required for ${options.label}.`);
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding ?? "utf8",
    env: options.env,
    shell: false,
    maxBuffer: options.maxBuffer ?? MAX_SUBPROCESS_BUFFER,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    input: options.input,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${options.label} timed out after ${timeoutMs}ms and was terminated.`);
    }
    throw new Error(`${options.label} could not start: ${result.error.message}`);
  }
  if (result.status === null) {
    throw new Error(`${options.label} terminated without an exit code${result.signal ? ` (signal ${result.signal})` : ""}.`);
  }
  const acceptedStatuses = options.acceptedStatuses ?? [0];
  if (!acceptedStatuses.includes(result.status)) {
    throw new Error(
      `${options.label} failed with exit code ${result.status}${result.signal ? ` (signal ${result.signal})` : ""}.\n` +
        `stdout:\n${subprocessText(result.stdout)}\nstderr:\n${subprocessText(result.stderr)}`,
    );
  }
  return result;
}

function capturePreparedSdkIdentity(repositoryRoot) {
  const manifest = verifyPreparedSdkArtifact({ projectRoot: repositoryRoot });
  return {
    format: manifest.format,
    runId: manifest.runId,
    inputs: {
      sha256: manifest.inputs.sha256,
      fileCount: manifest.inputs.fileCount,
    },
    dist: {
      sha256: manifest.dist.sha256,
      fileCount: manifest.dist.fileCount,
    },
  };
}

function verifyPreparedSdkIdentity(repositoryRoot, expected) {
  const observed = verifyPreparedSdkArtifact({
    projectRoot: repositoryRoot,
    expectedRunId: expected.runId,
    expectedInputSha256: expected.inputs.sha256,
    expectedDistSha256: expected.dist.sha256,
  });
  if (
    observed.format !== expected.format ||
    observed.inputs.fileCount !== expected.inputs.fileCount ||
    observed.dist.fileCount !== expected.dist.fileCount
  ) {
    throw new Error("Prepared SDK manifest identity changed during migration artifact generation.");
  }
}

function captureLiveSourceIdentity(requiredInputs) {
  const fixtureEntries = captureRegularTree(requiredInputs.fixturePath);
  const expectedBehaviorBytes = readRegularFile(
    requiredInputs.expectedBehaviorPath,
    EXPECTED_BEHAVIOR_REPOSITORY_PATH,
  );
  const fixtureTreeSha256 = digestTreeSnapshot(fixtureEntries);
  const expectedBehaviorSha256 = sha256(expectedBehaviorBytes);
  const digest = createHash("sha256");
  updateLengthFramed(digest, Buffer.from("honua.migration-workbench.source-snapshot.v1", "utf8"));
  updateLengthFramed(digest, Buffer.from(fixtureTreeSha256, "ascii"));
  updateLengthFramed(digest, Buffer.from(expectedBehaviorSha256, "ascii"));
  return {
    fixtureEntries,
    fixtureTreeSha256,
    expectedBehaviorBytes,
    expectedBehaviorSha256,
    combinedSha256: digest.digest("hex"),
  };
}

function assertLiveSourceIdentity(requiredInputs, expected) {
  const observed = captureLiveSourceIdentity(requiredInputs);
  if (
    observed.fixtureTreeSha256 !== expected.fixtureTreeSha256 ||
    observed.expectedBehaviorSha256 !== expected.expectedBehaviorSha256 ||
    observed.combinedSha256 !== expected.combinedSha256 ||
    !regularTreeSnapshotsEqual(observed.fixtureEntries, expected.fixtureEntries) ||
    !observed.expectedBehaviorBytes.equals(expected.expectedBehaviorBytes)
  ) {
    throw new Error("Live migration workbench source inputs changed during deterministic artifact generation.");
  }
}

function assertSourceSnapshotIdentity(fixturePath, expectedBehaviorPath, expected) {
  const snapshot = captureLiveSourceIdentity({ fixturePath, expectedBehaviorPath });
  if (
    snapshot.fixtureTreeSha256 !== expected.fixtureTreeSha256 ||
    snapshot.expectedBehaviorSha256 !== expected.expectedBehaviorSha256 ||
    snapshot.combinedSha256 !== expected.combinedSha256 ||
    !regularTreeSnapshotsEqual(snapshot.fixtureEntries, expected.fixtureEntries) ||
    !snapshot.expectedBehaviorBytes.equals(expected.expectedBehaviorBytes)
  ) {
    throw new Error("Immutable migration workbench source snapshot did not match its captured repository inputs.");
  }
}

function assertRequiredInputs(repositoryRoot) {
  const cliPath = resolveRepositoryPath(repositoryRoot, CLI_REPOSITORY_PATH, {
    expectedType: "file",
    label: CLI_REPOSITORY_PATH,
    missingHint: "Run npm run build first.",
  });
  const fixturePath = resolveRepositoryPath(repositoryRoot, FIXTURE_REPOSITORY_PATH, {
    expectedType: "directory",
    label: FIXTURE_REPOSITORY_PATH,
  });
  const scenarioPath = resolveRepositoryPath(repositoryRoot, SCENARIO_REPOSITORY_PATH, {
    expectedType: "file",
    label: SCENARIO_REPOSITORY_PATH,
  });
  const expectedBehaviorPath = resolveRepositoryPath(repositoryRoot, EXPECTED_BEHAVIOR_REPOSITORY_PATH, {
    expectedType: "file",
    label: EXPECTED_BEHAVIOR_REPOSITORY_PATH,
  });
  resolveRepositoryPath(repositoryRoot, EXECUTION_RUNNER_REPOSITORY_PATH, {
    expectedType: "file",
    label: EXECUTION_RUNNER_REPOSITORY_PATH,
  });
  resolveRepositoryPath(repositoryRoot, NETWORK_GUARD_REPOSITORY_PATH, {
    expectedType: "file",
    label: NETWORK_GUARD_REPOSITORY_PATH,
  });
  return {
    cliPath,
    fixturePath,
    scenarioPath,
    expectedBehaviorPath,
  };
}

function runCliCommand({ id, repositoryRoot, temporaryRoot, cliPath, args, normalization }) {
  const result = runBoundedCommand(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: createHermeticEnvironment(path.join(temporaryRoot, "cli-home"), { temporaryRoot }),
    label: `migration CLI command ${id}`,
    timeoutMs: CLI_TIMEOUT_MS,
  });
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
  fs.mkdirSync(diffRoot);
  copyRegularTree(sourceTreePath, sourceCopyPath);
  copyRegularTree(targetTreePath, targetCopyPath);

  const args = gitArgs(
    "diff",
    "--no-index",
    "--binary",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    "--inter-hunk-context=0",
    "--diff-algorithm=myers",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "source",
    "target",
  );
  const result = runBoundedCommand("git", args, {
    cwd: diffRoot,
    encoding: "buffer",
    env: createHermeticEnvironment(path.join(diffRoot, "git-home"), { gitCeilingDirectory: diffRoot }),
    label: "git diff --no-index",
    timeoutMs: GIT_TIMEOUT_MS,
    acceptedStatuses: [0, 1],
  });
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

function buildProvenance(preparedSdk, liveSourceIdentity, executionEvidence) {
  return {
    fixture: FIXTURE_REPOSITORY_PATH,
    scenario: SCENARIO_REPOSITORY_PATH,
    sourceSnapshot: {
      fixtureTreeSha256: liveSourceIdentity.fixtureTreeSha256,
      expectedBehaviorPath: EXPECTED_BEHAVIOR_REPOSITORY_PATH,
      expectedBehaviorSha256: liveSourceIdentity.expectedBehaviorSha256,
      combinedSha256: liveSourceIdentity.combinedSha256,
    },
    authorship: "Original Honua-authored repository fixture",
    licenseScope: "Apache-2.0 repository license; no third-party sample source is reproduced in these artifacts",
    excludedFixture: {
      path: "test/fixtures/esri-demo-feature-table-relates-app",
      reason:
        "Not used because publishable license evidence for that adapted fixture was not established " +
        "for this public artifact supply chain.",
    },
    transformationEngine: {
      path: CLI_REPOSITORY_PATH,
      preparedArtifactFormat: preparedSdk.format,
      buildInputsSha256: preparedSdk.inputs.sha256,
      buildInputFileCount: preparedSdk.inputs.fileCount,
      distSha256: preparedSdk.dist.sha256,
      distFileCount: preparedSdk.dist.fileCount,
      digestScope: "Complete prepared SDK build-input and dist snapshots, including all CLI transitive modules.",
    },
    generatedTargetExecution: executionEvidence,
    sourceUpload: false,
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
    .sort((left, right) => compareUtf8(left.repositoryPath, right.repositoryPath));

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
      .sort(compareUtf8)
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
        .sort(compareUtf8)
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

function normalizeString(value, { repositoryRoot, temporaryRoot, aliases = [] }) {
  const replacements = [
    ...aliases,
    [path.resolve(temporaryRoot), "<workspace>"],
    [path.resolve(repositoryRoot), "<repo>"],
  ]
    .map(([absolutePath, replacement]) => [path.resolve(absolutePath), replacement])
    .sort((left, right) => right[0].length - left[0].length);
  let normalized = value;
  for (const [absolutePath, placeholder] of replacements) {
    normalized = normalized.split(absolutePath).join(placeholder);
    normalized = normalized.split(absolutePath.split(path.sep).join("/")).join(placeholder);
  }
  return normalized.split(path.sep).join("/");
}

function preflightArtifactDestinations(repositoryRoot) {
  for (const repositoryPath of sortedArtifactPaths()) {
    resolveRepositoryPath(repositoryRoot, repositoryPath, {
      allowMissing: true,
      expectedType: "file",
      label: `artifact output ${repositoryPath}`,
    });
  }

  const retiredEntries = [];
  for (const retirementRoot of RETIREMENT_ROOTS) {
    const absoluteRoot = resolveRepositoryPath(repositoryRoot, retirementRoot.repositoryPath, {
      allowMissing: true,
      expectedType: "directory",
      label: retirementRoot.label,
    });
    if (lstatOrUndefined(absoluteRoot)) {
      captureRegularTree(absoluteRoot);
      for (const name of fs.readdirSync(absoluteRoot).sort(compareUtf8)) {
        if (!retirementRoot.expectedNames.has(name)) {
          retiredEntries.push({
            absolutePath: path.join(absoluteRoot, name),
            repositoryPath: path.posix.join(retirementRoot.repositoryPath, name),
          });
        }
      }
    }
  }
  retiredEntries.sort((left, right) => compareUtf8(left.repositoryPath, right.repositoryPath));
  return { retiredEntries };
}

function commitArtifactSet({ repositoryRoot, artifacts, state, testHooks, publicationGuard }) {
  const transactionParent = ensureRepositoryDirectory(repositoryRoot, ".tmp");
  const transactionRoot = fs.mkdtempSync(path.join(transactionParent, "migration-workbench-materialize-"));
  const stagedRoot = path.join(transactionRoot, "staged");
  const backupRoot = path.join(transactionRoot, "backups");
  fs.mkdirSync(stagedRoot);
  fs.mkdirSync(backupRoot);
  const stagedFiles = new Map();
  const createdDirectories = [];
  const journal = [];
  let replacementCount = 0;
  let committed = false;

  try {
    for (const [index, repositoryPath] of sortedArtifactPaths().entries()) {
      const stagedPath = path.join(stagedRoot, String(index).padStart(3, "0"));
      const bytes = artifacts.get(repositoryPath);
      writeNewRegularFile(stagedPath, bytes);
      if (!readRegularFile(stagedPath, `staged artifact ${repositoryPath}`).equals(bytes)) {
        throw new Error(`Staged artifact verification failed for ${repositoryPath}.`);
      }
      stagedFiles.set(repositoryPath, stagedPath);
    }

    // Every byte is staged and verified before the first destination is replaced.
    for (const repositoryPath of sortedArtifactPaths()) {
      ensureRepositoryDirectory(repositoryRoot, path.posix.dirname(repositoryPath), createdDirectories);
    }
    const refreshedState = preflightArtifactDestinations(repositoryRoot);
    if (
      !isDeepStrictEqual(
        refreshedState.retiredEntries.map((entry) => entry.repositoryPath),
        state.retiredEntries.map((entry) => entry.repositoryPath),
      )
    ) {
      throw new Error("Artifact destinations changed after transactional staging and must be retried.");
    }
    testHooks?.beforePublication?.(repositoryRoot, transactionRoot);
    publicationGuard?.();

    for (const [index, repositoryPath] of sortedArtifactPaths().entries()) {
      const destinationPath = resolveRepositoryPath(repositoryRoot, repositoryPath, {
        allowMissing: true,
        expectedType: "file",
        label: `artifact output ${repositoryPath}`,
      });
      const backupPath = path.join(backupRoot, `artifact-${String(index).padStart(3, "0")}`);
      const entry = { kind: "artifact", destinationPath, backupPath, hadOriginal: false, installed: false };
      const existing = lstatOrUndefined(destinationPath);
      if (existing) {
        assertRegularStat(existing, destinationPath, `artifact output ${repositoryPath}`);
        fs.renameSync(destinationPath, backupPath);
        entry.hadOriginal = true;
      }
      journal.push(entry);
      fs.renameSync(stagedFiles.get(repositoryPath), destinationPath);
      entry.installed = true;
      if (!readRegularFile(destinationPath, `materialized artifact ${repositoryPath}`).equals(artifacts.get(repositoryPath))) {
        throw new Error(`Materialized artifact verification failed for ${repositoryPath}.`);
      }
      replacementCount += 1;
      testHooks?.afterReplacement?.(replacementCount, repositoryPath);
    }

    for (const [index, retired] of state.retiredEntries.entries()) {
      const current = resolveRepositoryPath(repositoryRoot, retired.repositoryPath, {
        expectedType: "entry",
        label: `retired artifact ${retired.repositoryPath}`,
      });
      const backupPath = path.join(backupRoot, `retired-${String(index).padStart(3, "0")}`);
      const stat = fs.lstatSync(current);
      assertSupportedEntry(stat, current, `retired artifact ${retired.repositoryPath}`);
      const entry = { kind: "retired", destinationPath: current, backupPath, hadOriginal: true, installed: false };
      fs.renameSync(current, backupPath);
      journal.push(entry);
      replacementCount += 1;
      testHooks?.afterReplacement?.(replacementCount, retired.repositoryPath);
    }
    publicationGuard?.();
    // From this point onward, every intended artifact replacement and retirement is committed.
    // Transaction cleanup is bookkeeping and must never trigger destructive rollback.
    committed = true;
  } catch (error) {
    const rollbackErrors = rollbackMaterialization(journal, createdDirectories);
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Artifact materialization failed and rollback was incomplete; recovery files remain at ${transactionRoot}: ` +
          `${rollbackErrors.join("; ")}. ` +
          `Original failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      fs.rmSync(transactionRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `Artifact materialization failed and rollback completed, but transaction cleanup failed; ` +
          `recovery files remain at ${transactionRoot}. ` +
          `Cleanup failure: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. ` +
          `Original failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new Error(
      `Artifact materialization failed; all handled replacements were rolled back. ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!committed) {
    throw new Error("Artifact materialization exited its transaction without an explicit commit point.");
  }
  try {
    testHooks?.beforeCleanup?.(transactionRoot, repositoryRoot);
    fs.rmSync(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    throw new Error(
      `Artifact materialization committed, but transaction cleanup failed; installed artifacts were preserved and ` +
        `were not rolled back. Cleanup path: ${transactionRoot}. ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function rollbackMaterialization(journal, createdDirectories) {
  const errors = [];
  for (const entry of [...journal].reverse()) {
    try {
      let backup;
      if (entry.hadOriginal) {
        backup = lstatOrUndefined(entry.backupPath);
        if (!backup) {
          throw new Error(`Required rollback backup is missing: ${entry.backupPath}`);
        }
        if (entry.kind === "artifact") {
          assertRegularStat(backup, entry.backupPath, "artifact backup during rollback");
        } else {
          assertSupportedEntry(backup, entry.backupPath, "retired artifact backup during rollback");
        }
      }
      if (entry.installed) {
        const installed = lstatOrUndefined(entry.destinationPath);
        if (installed) {
          assertRegularStat(installed, entry.destinationPath, "installed artifact during rollback");
          fs.unlinkSync(entry.destinationPath);
        }
      }
      if (backup) {
        if (lstatOrUndefined(entry.destinationPath)) {
          throw new Error(`Rollback destination is unexpectedly occupied: ${entry.destinationPath}`);
        }
        fs.renameSync(entry.backupPath, entry.destinationPath);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const directoryPath of [...createdDirectories].reverse()) {
    try {
      const stat = lstatOrUndefined(directoryPath);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Created artifact directory became unsafe during rollback: ${directoryPath}`);
        }
        fs.rmdirSync(directoryPath);
      }
    } catch (error) {
      if (error?.code !== "ENOTEMPTY") {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return errors;
}

function assertArtifactAllowlist(artifacts) {
  if (!(artifacts instanceof Map)) {
    throw new Error("Migration artifact materialization requires a Map of deterministic bytes.");
  }
  const actualPaths = [...artifacts.keys()].sort(compareUtf8);
  const expectedPaths = sortedArtifactPaths();
  if (!isDeepStrictEqual(actualPaths, expectedPaths)) {
    throw new Error("Migration artifact set does not match the fixed repository-path allowlist.");
  }
  for (const [repositoryPath, bytes] of artifacts) {
    if (!EXPECTED_ARTIFACT_PATHS.has(repositoryPath) || !Buffer.isBuffer(bytes)) {
      throw new Error(`Migration artifact ${repositoryPath} is not an allowlisted byte buffer.`);
    }
  }
}

function sortedArtifactPaths() {
  return [...MIGRATION_WORKBENCH_ARTIFACT_PATHS].sort(compareUtf8);
}

function staleArtifactsError(mismatches) {
  return new Error(
    `Migration workbench artifacts are stale:\n- ${mismatches.join("\n- ")}\n` +
      "Run npm run demo:migration-workbench:artifacts:write and commit the results.",
  );
}

function canonicalizeExistingDirectory(directoryPath, label) {
  const absolutePath = path.resolve(directoryPath);
  assertSafePathChain(absolutePath, { expectedType: "directory", label });
  return fs.realpathSync.native(absolutePath);
}

function resolveRepositoryPath(repositoryRoot, repositoryPath, options = {}) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    repositoryPath.includes("\0") ||
    repositoryPath.includes("\\") ||
    path.posix.isAbsolute(repositoryPath) ||
    path.win32.isAbsolute(repositoryPath)
  ) {
    throw new Error(`Unsafe repository-relative path: ${String(repositoryPath)}`);
  }
  const segments = repositoryPath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Repository path traversal is not allowed: ${repositoryPath}`);
  }
  const candidate = path.join(repositoryRoot, ...segments);
  if (!isPathInside(repositoryRoot, candidate)) {
    throw new Error(`Repository path escapes the canonical root: ${repositoryPath}`);
  }
  const chain = assertSafePathChain(candidate, {
    allowMissing: options.allowMissing === true,
    expectedType: options.expectedType,
    label: options.label ?? repositoryPath,
    missingHint: options.missingHint,
  });
  if (chain.exists) {
    const real = fs.realpathSync.native(candidate);
    if (!isPathInside(repositoryRoot, real)) {
      throw new Error(`Resolved repository path escapes the canonical root: ${repositoryPath}`);
    }
  }
  return candidate;
}

function resolveAbsoluteInsideRoot(root, absolutePath, label, expectedType) {
  const resolved = path.resolve(absolutePath);
  if (!isPathInside(root, resolved)) {
    throw new Error(`${label} escapes its allowed root: ${resolved}`);
  }
  const chain = assertSafePathChain(resolved, { expectedType, label });
  if (chain.exists && !isPathInside(root, fs.realpathSync.native(resolved))) {
    throw new Error(`${label} resolves outside its allowed root: ${resolved}`);
  }
  return resolved;
}

function assertSafePathChain(absolutePath, options = {}) {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = lstatOrUndefined(current);
    if (!stat) {
      if (options.allowMissing) {
        return { exists: false, missingPath: current };
      }
      throw new Error(
        `${options.label ?? resolved} is required but missing at ${current}.` +
          (options.missingHint ? ` ${options.missingHint}` : ""),
      );
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Unsafe symbolic link in ${options.label ?? resolved}: ${current}`);
    }
    const final = index === components.length - 1;
    if (!final && !stat.isDirectory()) {
      throw new Error(`Non-directory path component in ${options.label ?? resolved}: ${current}`);
    }
    if (final && options.expectedType) {
      assertExpectedStatType(stat, current, options.expectedType, options.label ?? resolved);
    }
  }
  return { exists: true };
}

function assertExpectedStatType(stat, absolutePath, expectedType, label) {
  if (expectedType === "file") {
    assertRegularStat(stat, absolutePath, label);
  } else if (expectedType === "directory") {
    if (!stat.isDirectory()) {
      throw new Error(`${label} must be a regular directory: ${absolutePath}`);
    }
  } else if (expectedType === "entry") {
    assertSupportedEntry(stat, absolutePath, label);
  }
}

function assertRegularStat(stat, absolutePath, label) {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file and cannot be a link or special file: ${absolutePath}`);
  }
}

function assertSupportedEntry(stat, absolutePath, label) {
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`${label} must be a regular file or directory and cannot be a link or special file: ${absolutePath}`);
  }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readRegularFile(filePath, label) {
  const before = fs.lstatSync(filePath);
  assertRegularStat(before, filePath, label);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const after = fs.fstatSync(descriptor);
    assertRegularStat(after, filePath, label);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error(`${label} changed while it was being opened: ${filePath}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeNewRegularFile(filePath, bytes, mode = 0o644) {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
    mode,
  );
  try {
    fs.writeFileSync(descriptor, bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyRegularTree(sourceTreePath, destinationTreePath) {
  const source = captureRegularTree(sourceTreePath);
  writeRegularTreeSnapshot(source, destinationTreePath);
}

function writeRegularTreeSnapshot(source, destinationTreePath) {
  assertSafePathChain(destinationTreePath, { allowMissing: true, label: "tree copy destination" });
  if (lstatOrUndefined(destinationTreePath)) {
    throw new Error(`Tree copy destination already exists: ${destinationTreePath}`);
  }
  fs.mkdirSync(destinationTreePath);
  for (const entry of source) {
    const outputPath = path.join(destinationTreePath, ...entry.relativePath.split("/"));
    if (entry.type === "directory") {
      fs.mkdirSync(outputPath, { mode: entry.executable ? 0o755 : 0o644 });
    } else {
      writeNewRegularFile(outputPath, entry.bytes, entry.executable ? 0o755 : 0o644);
    }
  }
  const copied = captureRegularTree(destinationTreePath);
  if (!regularTreeSnapshotsEqual(source, copied)) {
    throw new Error(`Strict tree copy verification failed for ${destinationTreePath}.`);
  }
}

function ensureRepositoryDirectory(repositoryRoot, repositoryPath, createdDirectories = []) {
  if (repositoryPath === "." || repositoryPath === "") {
    return repositoryRoot;
  }
  const segments = repositoryPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    throw new Error(`Unsafe repository directory path: ${repositoryPath}`);
  }
  let current = repositoryRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatOrUndefined(current);
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Artifact parent must be a regular directory: ${current}`);
      }
    } else {
      fs.mkdirSync(current);
      createdDirectories.push(current);
    }
  }
  if (!isPathInside(repositoryRoot, current)) {
    throw new Error(`Artifact parent escapes repository root: ${current}`);
  }
  return current;
}

function createHermeticEnvironment(homePath, options = {}) {
  if (!lstatOrUndefined(homePath)) {
    assertSafePathChain(homePath, { allowMissing: true, label: "subprocess home" });
    assertSafePathChain(path.dirname(homePath), { expectedType: "directory", label: "subprocess home parent" });
    fs.mkdirSync(homePath);
  } else {
    assertSafePathChain(homePath, { expectedType: "directory", label: "subprocess home" });
  }
  const environment = {
    TZ: "UTC",
    LANG: "C",
    LC_ALL: "C",
    HOME: homePath,
    XDG_CONFIG_HOME: homePath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["PATH", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) {
      environment[key] = process.env[key];
    }
  }
  const temporaryRoot = options.temporaryRoot;
  if (temporaryRoot) {
    environment.TEMP = temporaryRoot;
    environment.TMP = temporaryRoot;
    environment.TMPDIR = temporaryRoot;
  }
  if (options.gitCeilingDirectory) {
    environment.GIT_CEILING_DIRECTORIES = options.gitCeilingDirectory;
  }
  return environment;
}

function gitArgs(...args) {
  return [...GIT_CONFIG_ARGUMENTS, ...args];
}

function findAncestorNodeModules(startPath) {
  const roots = [];
  let current = path.resolve(startPath);
  while (true) {
    const candidate = path.join(current, "node_modules");
    const stat = lstatOrUndefined(candidate);
    if (stat) {
      assertSafePathChain(candidate, { expectedType: "directory", label: "dependency root" });
      roots.push(fs.realpathSync.native(candidate));
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return roots;
}

function uniqueSortedPaths(paths) {
  return [...new Set(paths.map((value) => path.resolve(value)))].sort(compareUtf8);
}

function updateLengthFramed(digest, value) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.length));
  digest.update(length);
  digest.update(value);
}

function readJson(filePath) {
  return JSON.parse(readRegularFile(filePath, `JSON input ${filePath}`).toString("utf8"));
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

function subprocessText(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
}

function lstatOrUndefined(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
