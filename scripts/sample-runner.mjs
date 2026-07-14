#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalCommand,
  classifySampleCommand,
  isPlaywrightCommand,
  parseSampleCommand,
} from "./lib/sample-command.mjs";
import { expectedGateCommand, isSampleEvidenceRunId } from "./lib/sample-gates.mjs";
import {
  captureGateSourceSnapshot,
  createGateReceipt,
  readCanonicalBoundedFile,
  requiredReceiptGates,
  SAMPLE_GATE_NAMES,
  validateGateReceiptStructure,
} from "./sample-gate-receipt.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELECTION_PATH = path.join(PROJECT_ROOT, "samples/dist/sample-ci-selection.v2.json");
const CATALOG_PATH = path.join(PROJECT_ROOT, "samples/catalog.v2.json");
const KIT_PATH = path.join(PROJECT_ROOT, "examples/_kit/manifest.v1.json");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const ACTIONS = new Set(["list", "dev", "typecheck", "build", "test", "verify", "evidence"]);
const SDK_MODES = new Set(["source", "packed"]);
const TRACKS = new Set(["golden", "recipe", "lab", "fixture"]);
const PLAYWRIGHT_BROWSERS = new Set(["chromium", "firefox", "webkit"]);
const PROFILE_GATE_KEYS = [
  "packedBuild",
  "browser",
  "accessibility",
  "console",
  "responsive",
  "screenshot",
  "performance",
  "liveEvidence",
];
const SAFE_HOST_ENVIRONMENT = new Set([
  "CI",
  "DISPLAY",
  "HOME",
  "HONUA_BUILD_SLOTS",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "PATHEXT",
  "PLAYWRIGHT_BROWSERS_PATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
]);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_GATE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_PACKED_FILES = 6_000;
const MAX_PACKED_BYTES = 128 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

export function validatePackedTarListings(memberOutput, verboseOutput) {
  const members = memberOutput.trim().split("\n");
  if (members.length === 0 || members.length > MAX_PACKED_FILES || members.some((member) => member.length === 0)) {
    fail("packed SDK tar member count is invalid");
  }
  const uniqueMembers = new Set();
  for (const member of members) {
    if (!member.startsWith("package/") || member.includes("\\") || member.split("/").includes("..")) {
      fail(`unsafe packed SDK tar member: ${member}`);
    }
    if (path.posix.normalize(member) !== member) fail(`noncanonical packed SDK tar member: ${member}`);
    if (uniqueMembers.has(member)) fail(`duplicate packed SDK tar member: ${member}`);
    uniqueMembers.add(member);
  }
  const verboseMembers = verboseOutput.trim().split("\n");
  if (verboseMembers.length !== members.length) fail("packed SDK tar listings disagree");
  let declaredBytes = 0;
  for (let index = 0; index < verboseMembers.length; index += 1) {
    const match = /^(\S+)\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(verboseMembers[index]);
    if (!match) fail(`could not parse packed SDK tar member metadata: ${verboseMembers[index]}`);
    const type = match[1][0];
    const size = Number(match[2]);
    const member = match[3];
    if ((type !== "-" && type !== "d") || !Number.isSafeInteger(size) || size < 0) {
      fail(`packed SDK tar contains a link, device, or unsupported member: ${member}`);
    }
    if (member !== members[index]) fail(`packed SDK tar member ordering or path metadata disagrees: ${member}`);
    if (type === "-" && size === 0 && member.endsWith("/")) fail(`packed SDK regular file has a directory path: ${member}`);
    declaredBytes += size;
    if (declaredBytes > MAX_PACKED_BYTES) fail("packed SDK declared bytes exceed the pre-extraction limit");
  }
  return { members, declaredBytes };
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function safeRelativePath(value, label) {
  if (typeof value !== "string" || path.isAbsolute(value) || value.includes("\\")) fail(`${label} must be relative`);
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === ".." || normalized.startsWith("../")) fail(`${label} is unsafe: ${value}`);
  return normalized;
}

function parseFlagValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

export function parseRunnerArgs(argv) {
  const action = argv[0];
  if (!ACTIONS.has(action)) fail(`action must be one of ${[...ACTIONS].join(", ")}`);
  const options = {
    action,
    sdkMode: "source",
    sampleId: undefined,
    track: undefined,
    gate: undefined,
    allowLive: false,
    kitOnly: false,
    dryRun: false,
    json: false,
  };
  let sdkModeSeen = false;
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--allow-live", "--dry-run", "--json", "--kit"].includes(flag)) {
      const key =
        flag === "--allow-live" ? "allowLive" : flag === "--dry-run" ? "dryRun" : flag === "--kit" ? "kitOnly" : "json";
      if (options[key]) fail(`duplicate option: ${flag}`);
      options[key] = true;
      continue;
    }
    if (!["--sample", "--track", "--sdk-mode", "--gate"].includes(flag)) fail(`unknown option: ${flag}`);
    const value = parseFlagValue(argv, index, flag);
    index += 1;
    const key = flag === "--sample" ? "sampleId" : flag === "--track" ? "track" : flag === "--gate" ? "gate" : "sdkMode";
    if (key === "sdkMode") {
      if (sdkModeSeen) fail(`duplicate option: ${flag}`);
      sdkModeSeen = true;
    } else if (options[key] !== undefined) fail(`duplicate option: ${flag}`);
    options[key] = value;
  }
  if (!SDK_MODES.has(options.sdkMode)) fail("--sdk-mode must be source or packed");
  if (options.track && !TRACKS.has(options.track)) fail("--track must be golden, recipe, lab, or fixture");
  if (options.sampleId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.sampleId)) fail("--sample is invalid");
  if (options.sampleId && options.track) fail("--sample and --track are mutually exclusive");
  if (options.kitOnly && (options.sampleId || options.track)) fail("--kit, --sample, and --track are mutually exclusive");
  if (options.gate && !SAMPLE_GATE_NAMES.includes(options.gate)) fail(`--gate is invalid: ${options.gate}`);
  if (options.gate && action !== "evidence") fail("--gate is only valid for evidence");
  if (options.allowLive && action !== "evidence") fail("--allow-live is only valid for evidence");
  if (["dev", "evidence"].includes(action) && !options.sampleId) fail(`${action} requires --sample`);
  if (options.kitOnly && ["dev", "evidence"].includes(action)) fail(`--kit is not supported by ${action}`);
  return options;
}

function validateCommandGroup(group, execution, scripts, label) {
  if (!isPlainRecord(group) || group.execution !== execution || !Array.isArray(group.commands)) {
    fail(`${label} has an invalid command group`);
  }
  for (const command of group.commands) {
    const argv = parseSampleCommand(command);
    if (argv[0] === "npm" && !Object.hasOwn(scripts, argv[2])) fail(`${label} references unknown npm script ${argv[2]}`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateSelection(selection, options = {}) {
  const scripts = options.packageScripts ?? {};
  if (!isPlainRecord(selection) || selection.format !== "honua.sdk.sample-ci-selection.v2" || selection.schemaVersion !== 2) {
    fail("sample selection format is invalid");
  }
  if (!Array.isArray(selection.samples) || !Array.isArray(selection.profiles)) fail("sample selection arrays are missing");
  const profileIds = new Set();
  for (const profile of selection.profiles) {
    if (!isPlainRecord(profile) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)) fail("sample profile id is invalid");
    if (profileIds.has(profile.id)) fail(`duplicate sample profile: ${profile.id}`);
    profileIds.add(profile.id);
    if (!isPlainRecord(profile.gates) || !sameJson(Object.keys(profile.gates).sort(), [...PROFILE_GATE_KEYS].sort())) {
      fail(`${profile.id}: profile gate keys are invalid`);
    }
    if (PROFILE_GATE_KEYS.some((key) => typeof profile.gates[key] !== "boolean")) fail(`${profile.id}: profile gates are invalid`);
    if (!Array.isArray(profile.sampleIds) || new Set(profile.sampleIds).size !== profile.sampleIds.length) {
      fail(`${profile.id}: profile sampleIds are invalid`);
    }
  }

  const ids = new Set();
  for (const sample of selection.samples) {
    if (!isPlainRecord(sample) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sample.id)) fail("sample selection id is invalid");
    if (ids.has(sample.id)) fail(`duplicate selected sample: ${sample.id}`);
    ids.add(sample.id);
    if (!TRACKS.has(sample.track)) fail(`${sample.id}: invalid track`);
    const sourcePath = safeRelativePath(sample.sourcePath, `${sample.id}.sourcePath`);
    if (!sourcePath.startsWith("examples/") && !sourcePath.startsWith("docs/examples/")) fail(`${sample.id}: sourcePath is outside sample roots`);
    const profile = selection.profiles.find((candidate) => candidate.id === sample.validationProfile);
    if (!profile || !sameJson(sample.gates, profile.gates) || !profile.sampleIds.includes(sample.id)) {
      fail(`${sample.id}: profile membership or gates drifted`);
    }
    if (!isPlainRecord(sample.commandPlan)) fail(`${sample.id}: command plan is invalid`);
    validateCommandGroup(sample.commandPlan.validation, "automatic", scripts, `${sample.id}.validation`);
    validateCommandGroup(sample.commandPlan.fixtureEvidence, "orchestrated", scripts, `${sample.id}.fixtureEvidence`);
    validateCommandGroup(sample.commandPlan.liveEvidence, "scheduled-only", scripts, `${sample.id}.liveEvidence`);
    if (options.checkPaths !== false) {
      const root = path.resolve(options.projectRoot ?? PROJECT_ROOT);
      const lexical = path.resolve(root, sourcePath);
      const metadata = await lstat(lexical);
      const canonicalRoot = await realpath(root);
      const canonical = await realpath(lexical);
      if (
        !canonical.startsWith(`${canonicalRoot}${path.sep}`) ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink()
      ) {
        fail(`${sample.id}: sourcePath must be a regular non-symlink repository directory`);
      }
    }
  }
  for (const profile of selection.profiles) {
    const expectedIds = selection.samples.filter((sample) => sample.validationProfile === profile.id).map((sample) => sample.id);
    if (!sameJson(profile.sampleIds, expectedIds)) fail(`${profile.id}: profile sampleIds do not exactly match samples`);
  }
  if (options.expectedSelection && !sameJson(selection, options.expectedSelection)) fail("generated sample selection is stale or modified");
  return selection;
}

async function containedRegularFile(root, container, relative, label) {
  const normalized = safeRelativePath(relative, label);
  const lexicalContainer = path.resolve(root, container);
  const containerMetadata = await lstat(lexicalContainer);
  const canonicalContainer = await realpath(lexicalContainer);
  if (!containerMetadata.isDirectory() || containerMetadata.isSymbolicLink()) {
    fail(`${container} must be a regular non-symlink directory`);
  }
  const absolute = path.resolve(root, normalized);
  const metadata = await lstat(absolute);
  const canonical = await realpath(absolute);
  if (
    !canonical.startsWith(`${canonicalContainer}${path.sep}`) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    fail(`${label} must be a regular non-symlink file inside ${container}`);
  }
  return normalized;
}

export async function validateKit(kit, selection, scripts, options = {}) {
  if (!isPlainRecord(kit) || kit.format !== "honua.sdk.sample-kit.v1" || kit.schemaVersion !== 1 || !Array.isArray(kit.samples)) {
    fail("sample kit manifest is invalid");
  }
  const root = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const ids = new Set();
  for (const sample of kit.samples) {
    if (!isPlainRecord(sample)) fail("sample kit contains an invalid or duplicate sample");
    const selectedSample = selection.samples.find((candidate) => candidate.id === sample.id);
    if (ids.has(sample.id) || !selectedSample) {
      fail("sample kit contains an invalid or duplicate sample");
    }
    ids.add(sample.id);
    safeRelativePath(sample.viteConfig, `${sample.id}.viteConfig`);
    safeRelativePath(sample.tsconfig, `${sample.id}.tsconfig`);
    if (!/^test:playwright:[a-z0-9-]+$/.test(sample.playwrightScript) || !Object.hasOwn(scripts, sample.playwrightScript)) {
      fail(`${sample.id}: sample kit Playwright script is invalid`);
    }
    safeRelativePath(sample.playwrightFile, `${sample.id}.playwrightFile`);
    if (scripts[sample.playwrightScript] !== `playwright test ${sample.playwrightFile}`) {
      fail(`${sample.id}: sample kit Playwright script does not bind its declared file`);
    }
    if (
      typeof sample.playwrightTestTitle !== "string" ||
      sample.playwrightTestTitle.length === 0 ||
      sample.playwrightTestTitle.trim() !== sample.playwrightTestTitle
    ) {
      fail(`${sample.id}: sample kit Playwright title is invalid`);
    }
    if (
      !Array.isArray(sample.playwrightProjects) ||
      sample.playwrightProjects.length === 0 ||
      sample.playwrightProjects.length > PLAYWRIGHT_BROWSERS.size ||
      sample.playwrightProjects.some(
        (project) =>
          !isPlainRecord(project) ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.name) ||
          !PLAYWRIGHT_BROWSERS.has(project.browserName),
      ) ||
      new Set(sample.playwrightProjects.map((project) => project.name)).size !== sample.playwrightProjects.length ||
      new Set(sample.playwrightProjects.map((project) => project.browserName)).size !== sample.playwrightProjects.length
    ) {
      fail(`${sample.id}: sample kit Playwright projects are invalid`);
    }
    if (
      typeof sample.evidenceProject !== "string" ||
      !sample.playwrightProjects.some((project) => project.name === sample.evidenceProject)
    ) {
      fail(`${sample.id}: sample kit evidence project is invalid`);
    }
    if (options.checkPaths !== false) {
      const sourcePath = safeRelativePath(selectedSample.sourcePath, `${sample.id}.sourcePath`);
      await containedRegularFile(root, sourcePath, sample.viteConfig, `${sample.id}.viteConfig`);
      await containedRegularFile(root, sourcePath, sample.tsconfig, `${sample.id}.tsconfig`);
      await containedRegularFile(root, "test/playwright", sample.playwrightFile, `${sample.id}.playwrightFile`);
    }
    if (
      !Array.isArray(sample.sdkEntrypoints) ||
      sample.sdkEntrypoints.length === 0 ||
      new Set(sample.sdkEntrypoints).size !== sample.sdkEntrypoints.length ||
      sample.sdkEntrypoints.some(
        (specifier) => specifier !== "@honua/sdk-js" && !/^@honua\/sdk-js\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(specifier),
      )
    ) {
      fail(`${sample.id}: sample kit SDK entrypoints are invalid`);
    }
    if (
      !Array.isArray(sample.responsiveViewports) ||
      sample.responsiveViewports.length < 2 ||
      sample.responsiveViewports.some(
        (viewport) =>
          !isPlainRecord(viewport) ||
          !Number.isInteger(viewport.width) ||
          !Number.isInteger(viewport.height) ||
          viewport.width < 320 ||
          viewport.height < 320,
      )
    ) {
      fail(`${sample.id}: sample kit responsive viewports are invalid`);
    }
    if (
      !Array.isArray(sample.workflowSelectors) ||
      sample.workflowSelectors.length === 0 ||
      new Set(sample.workflowSelectors).size !== sample.workflowSelectors.length ||
      sample.workflowSelectors.some((selector) => typeof selector !== "string" || !/^#[a-z0-9-]+$/.test(selector))
    ) {
      fail(`${sample.id}: sample kit workflow selectors are invalid`);
    }
  }
  return new Map(kit.samples.map((sample) => [sample.id, sample]));
}

export function selectSamples(selection, options, kitIds) {
  if (options.sampleId) {
    const sample = selection.samples.find((candidate) => candidate.id === options.sampleId);
    if (!sample) fail(`unknown sample: ${options.sampleId}`);
    return [sample];
  }
  if (options.track) return selection.samples.filter((sample) => sample.track === options.track);
  if (options.kitOnly) return selection.samples.filter((sample) => kitIds?.has(sample.id));
  return [...selection.samples];
}

function commandsForAction(sample, action) {
  const commands = sample.commandPlan.validation.commands.map(parseSampleCommand);
  if (action === "verify") return commands;
  return commands.filter((argv) => classifySampleCommand(argv) === action);
}

export { expectedGateCommand };

export function commandForSpawn(argv) {
  const executable = process.platform === "win32" && argv[0] === "npm"
    ? "npm.cmd"
    : process.platform === "win32" && argv[0] === "npx"
      ? "npx.cmd"
      : argv[0];
  if (argv[0] === "npm" && argv[1] === "run") return [executable, "run", "--ignore-scripts", ...argv.slice(2)];
  return [executable, ...argv.slice(1)];
}

export function safeChildEnvironment(overrides = {}, allowedNames = []) {
  const environment = {};
  for (const name of [...SAFE_HOST_ENVIRONMENT, ...allowedNames]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[name] = String(value);
  }
  environment.npm_config_update_notifier = "false";
  environment.npm_config_ignore_scripts = "true";
  return environment;
}

function waitForStream(stream) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
}

export class ChildSupervisor {
  #children = new Map();

  async run(argv, options = {}) {
    canonicalCommand(argv);
    const [executable, ...args] = commandForSpawn(argv);
    const startedAt = performance.now();
    const logPath = options.artifactPath;
    if (logPath) await mkdir(path.dirname(logPath), { recursive: true });
    const log = logPath ? createWriteStream(logPath, { flags: "w" }) : undefined;
    log?.write(`${JSON.stringify({ argv, startedAt: new Date().toISOString() })}\n`);
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let overflow = false;
    let spawnError;

    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const child = spawn(executable, args, {
      cwd: options.cwd ?? PROJECT_ROOT,
      env: safeChildEnvironment(options.env, options.allowedEnvironmentNames),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#children.set(child, { child, done });
    const append = (channel, bytes) => {
      capturedBytes += bytes.byteLength;
      if (capturedBytes > (options.maxCaptureBytes ?? MAX_CAPTURE_BYTES)) {
        overflow = true;
        try {
          this.#kill(child, "SIGKILL");
        } catch (error) {
          spawnError ??= error;
          child.kill("SIGKILL");
        }
        return;
      }
      const value = bytes.toString();
      if (channel === "stdout") {
        if (options.captureOutput !== false) stdout += value;
        if (options.echoOutput !== false) process.stdout.write(bytes);
      } else {
        if (options.captureOutput !== false) stderr += value;
        if (options.echoOutput !== false) process.stderr.write(bytes);
      }
      log?.write(`${channel}: ${value}`);
    };
    child.stdout.on("data", (bytes) => append("stdout", bytes));
    child.stderr.on("data", (bytes) => append("stderr", bytes));
    child.once("error", (error) => {
      spawnError = error;
    });

    return await new Promise((resolve, reject) => {
      let settled = false;
      child.once("close", async (code, signal) => {
        if (settled) return;
        settled = true;
        this.#children.delete(child);
        const durationMs = Math.max(0, performance.now() - startedAt);
        if (log) {
          const flushed = waitForStream(log);
          log.end(`${JSON.stringify({ exitCode: code, signal, durationMs })}\n`);
          try {
            await flushed;
          } catch (error) {
            resolveDone();
            reject(error);
            return;
          }
        }
        resolveDone();
        if (overflow) reject(new Error(`${canonicalCommand(argv)} exceeded the bounded output capture`));
        else if (spawnError) reject(spawnError);
        else if (code === 0) resolve({ stdout, stderr, durationMs });
        else reject(new Error(`${canonicalCommand(argv)} failed (${signal ?? `exit ${code}`})`));
      });
    });
  }

  #kill(child, signal) {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  async stop(signal = "SIGTERM", graceMs = 2_000) {
    const records = [...this.#children.values()];
    if (records.length === 0) return;
    const failures = [];
    for (const { child } of records) {
      try {
        this.#kill(child, signal);
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.race([
      Promise.allSettled(records.map(({ done }) => done)),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    const remaining = records.filter(({ child }) => this.#children.has(child));
    for (const { child } of remaining) {
      try {
        this.#kill(child, "SIGKILL");
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.race([
      Promise.allSettled(remaining.map(({ done }) => done)),
      new Promise((resolve) => setTimeout(resolve, graceMs)),
    ]);
    const survivors = records.filter(({ child }) => this.#children.has(child));
    if (survivors.length > 0) failures.push(new Error(`${survivors.length} supervised process group(s) survived SIGKILL`));
    if (failures.length > 0) throw new AggregateError(failures, "failed to stop supervised sample processes");
  }
}

async function readInputs() {
  const [selection, catalog, kit, packageJson, contract] = await Promise.all([
    readFile(SELECTION_PATH, "utf8").then(JSON.parse),
    readFile(CATALOG_PATH, "utf8").then(JSON.parse),
    readFile(KIT_PATH, "utf8").then(JSON.parse),
    readFile(PACKAGE_PATH, "utf8").then(JSON.parse),
    import("./sample-contract.mjs"),
  ]);
  await contract.validateCatalog(catalog, packageJson);
  const expectedSelection = contract.generateCiSelection(catalog);
  await validateSelection(selection, {
    packageScripts: packageJson.scripts,
    projectRoot: PROJECT_ROOT,
    expectedSelection,
  });
  const validatedKit = await validateKit(kit, selection, packageJson.scripts, { projectRoot: PROJECT_ROOT });
  return { selection, catalog, packageJson, kit: validatedKit };
}

async function boundedTree(root, options = {}) {
  const output = [];
  let totalBytes = 0;
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) fail(`symlink is forbidden in bounded artifact tree: ${absolute}`);
      if (metadata.isDirectory()) await visit(absolute);
      else if (metadata.isFile()) {
        totalBytes += metadata.size;
        output.push({ absolute, bytes: metadata.size });
        if (output.length > (options.maxFiles ?? MAX_PACKED_FILES) || totalBytes > (options.maxBytes ?? MAX_PACKED_BYTES)) {
          fail("bounded artifact tree exceeds file or byte limits");
        }
      } else fail(`unsupported artifact type: ${absolute}`);
    }
  };
  await visit(root);
  return output;
}

async function fileSha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function preparePackedSdk(supervisor, root) {
  if (!root) fail("packed SDK preparation requires an isolated tooling root");
  const pack = path.join(root, "pack");
  const extract = path.join(root, "extract");
  await rm(root, { recursive: true, force: true });
  await mkdir(pack, { recursive: true });
  await supervisor.run(["npm", "run", "build", "--silent"]);
  const result = await supervisor.run(
    ["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", pack, PROJECT_ROOT],
    { echoOutput: false },
  );
  const start = result.stdout.indexOf("[");
  if (start < 0) fail("npm pack did not return JSON");
  const report = JSON.parse(result.stdout.slice(start));
  const filename = report.find((item) => item.name === "@honua/sdk-js")?.filename;
  if (typeof filename !== "string" || path.basename(filename) !== filename) fail("npm pack returned an unsafe filename");
  const tarballPath = path.join(pack, filename);
  if ((await stat(tarballPath)).size > 64 * 1024 * 1024) fail("packed SDK tarball exceeds size limit");
  const memberOutput = (await supervisor.run(["tar", "-tzf", tarballPath], { echoOutput: false })).stdout;
  const verboseOutput = (
    await supervisor.run(["tar", "--numeric-owner", "-tvzf", tarballPath], { echoOutput: false })
  ).stdout;
  validatePackedTarListings(memberOutput, verboseOutput);
  await mkdir(extract, { recursive: true });
  await supervisor.run([
    "tar",
    "-xzf",
    tarballPath,
    "-C",
    extract,
    "--no-same-owner",
    "--no-same-permissions",
    "--delay-directory-restore",
  ]);
  const sdkRoot = path.join(extract, "package");
  await boundedTree(sdkRoot);
  const manifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
  if (manifest.name !== "@honua/sdk-js") fail("packed SDK manifest identity mismatch");
  return { sdkRoot, manifest, tarballPath, tarballSha256: await fileSha256(tarballPath) };
}

function sdkEnvironment(mode, packed, additions = {}) {
  return {
    HONUA_SAMPLE_SDK_MODE: mode,
    ...(mode === "packed" ? { HONUA_SAMPLE_SDK_DIR: packed?.sdkRoot } : {}),
    ...additions,
  };
}

export function allowedLiveEnvironment(catalogSample) {
  const config = catalogSample?.data?.config;
  const classifications = catalogSample?.data?.configClassifications;
  if (!Array.isArray(config) || !Array.isArray(classifications)) fail("live evidence sample lacks configuration classifications");
  const byName = new Map(classifications.map((item) => [item.name, item]));
  return config.filter((name) => {
    const classification = byName.get(name);
    if (!classification) fail(`live evidence configuration is unclassified: ${name}`);
    return !(classification.exposure === "browser-public" && classification.valueKind === "credential");
  });
}

export function forwardedLiveCredentials(catalogSample) {
  const allowed = new Set(allowedLiveEnvironment(catalogSample));
  return (catalogSample?.data?.configClassifications ?? [])
    .filter((classification) => allowed.has(classification.name) && classification.valueKind === "credential")
    .map((classification) => ({ name: classification.name, value: process.env[classification.name] }))
    .filter(({ value }) => typeof value === "string" && value.length > 0);
}

export function assertCredentialFreeContent(bytes, credentials, label) {
  for (const credential of credentials) {
    if (bytes.includes(Buffer.from(credential.value))) fail(`${label} contains forwarded credential ${credential.name}`);
  }
}

export async function resolvePackedDeclaration(sdkRoot, target) {
  if (
    typeof target !== "string" ||
    !target.startsWith("./dist/") ||
    !target.endsWith(".d.ts") ||
    `./${path.posix.normalize(target.slice(2))}` !== target
  ) {
    fail(`packed SDK contains an unsafe declaration export: ${target}`);
  }
  const canonicalRoot = await realpath(sdkRoot);
  const candidate = path.resolve(canonicalRoot, target);
  const canonical = await realpath(candidate);
  const metadata = await lstat(candidate);
  if (
    !canonical.startsWith(`${canonicalRoot}${path.sep}`) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 8 * 1024 * 1024
  ) {
    fail(`packed SDK declaration export is not a bounded contained regular file: ${target}`);
  }
  return canonical;
}

export async function resolvePackedRuntimeExport(sdkRoot, target) {
  if (
    typeof target !== "string" ||
    !target.startsWith("./dist/") ||
    `./${path.posix.normalize(target.slice(2))}` !== target
  ) {
    fail(`packed SDK contains an unsafe runtime export: ${target}`);
  }
  const canonicalRoot = await realpath(sdkRoot);
  const candidate = path.resolve(canonicalRoot, target);
  const canonical = await realpath(candidate);
  const metadata = await lstat(candidate);
  if (
    !canonical.startsWith(`${canonicalRoot}${path.sep}`) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 16 * 1024 * 1024
  ) {
    fail(`packed SDK runtime export is not a bounded contained regular file: ${target}`);
  }
  return canonical;
}

async function packedTypePaths(packed) {
  const paths = {};
  for (const [key, declaration] of Object.entries(packed.manifest.exports ?? {})) {
    const target = typeof declaration === "string" ? undefined : declaration.types;
    if (typeof target !== "string") continue;
    const canonical = await resolvePackedDeclaration(packed.sdkRoot, target);
    paths[key === "." ? "@honua/sdk-js" : `@honua/sdk-js/${key.slice(2)}`] = [canonical];
  }
  if (!paths["@honua/sdk-js"]) fail("packed SDK does not expose root declarations");
  return paths;
}

async function runPackedTypecheck(sample, kitSample, packed, supervisor, toolingRoot) {
  const sampleConfig = path.join(PROJECT_ROOT, kitSample.tsconfig);
  const configRoot = path.join(toolingRoot, "packed-typecheck");
  await mkdir(configRoot, { recursive: true });
  const configPath = path.join(configRoot, `${sample.id}.json`);
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        extends: path.relative(configRoot, sampleConfig).replaceAll(path.sep, "/"),
        compilerOptions: { baseUrl: PROJECT_ROOT, paths: await packedTypePaths(packed) },
      },
      null,
      2,
    )}\n`,
  );
  const result = await supervisor.run(["npx", "--no-install", "tsc", "-p", configPath, "--noEmit", "--listFiles"], {
    echoOutput: false,
  });
  if (!result.stdout.includes(`${packed.sdkRoot}${path.sep}dist${path.sep}src${path.sep}`)) {
    fail(`${sample.id}: packed typecheck did not resolve extracted SDK declarations`);
  }
  if (result.stdout.includes(`${PROJECT_ROOT}${path.sep}src${path.sep}`)) fail(`${sample.id}: packed typecheck leaked SDK source paths`);
}

async function executeAction(sample, action, context) {
  if (action === "dev") {
    const config = context.kitSample?.viteConfig ?? `${sample.sourcePath}/vite.config.ts`;
    await context.supervisor.run(["npx", "--no-install", "vite", "--config", config], {
      env: sdkEnvironment(context.mode, context.packed),
    });
    return;
  }
  const commands = commandsForAction(sample, action);
  if (commands.length === 0 && action !== "verify") fail(`${sample.id} declares no ${action} command`);
  let packedTypechecked = false;
  for (const argv of commands) {
    if (context.mode === "packed" && classifySampleCommand(argv) === "typecheck") {
      if (!packedTypechecked) {
        await runPackedTypecheck(sample, context.kitSample, context.packed, context.supervisor, context.toolingRoot);
      }
      packedTypechecked = true;
    } else {
      const playwrightOutput = isPlaywrightCommand(argv)
        ? path.join(context.toolingRoot, "playwright", sample.id)
        : undefined;
      await context.supervisor.run(argv, {
        env: sdkEnvironment(context.mode, context.packed, {
          ...(playwrightOutput ? { HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR: playwrightOutput } : {}),
        }),
      });
    }
  }
}

function commandDigest(argv) {
  return createHash("sha256").update(canonicalCommand(argv)).digest("hex").slice(0, 16);
}

async function persistBoundedTree(source, destination) {
  const files = await boundedTree(source, { maxFiles: 1_000, maxBytes: 64 * 1024 * 1024 });
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const relative = path.relative(source, file.absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) fail("bounded tree copy escaped its source");
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file.absolute, target);
  }
  return files.length;
}

async function buildPackedReport(sample, revision, packed, command, runRoot) {
  const builtDist = path.join(PROJECT_ROOT, sample.sourcePath, "dist");
  const dist = path.join(runRoot, "artifacts/packed-sample-dist");
  const copiedFiles = await persistBoundedTree(builtDist, dist);
  if (copiedFiles <= 1) fail(`${sample.id}: packed sample dist file count is invalid`);
  const resolution = JSON.parse(await readFile(path.join(dist, "honua-sample-sdk-resolution.json"), "utf8"));
  if (resolution.format !== "honua.sdk.sample-resolution.v1" || resolution.mode !== "packed") {
    fail(`${sample.id}: build did not emit packed SDK resolution evidence`);
  }
  for (const entrypoint of resolution.entrypoints ?? []) {
    const declaration = packed.manifest.exports?.[entrypoint.specifier === "@honua/sdk-js" ? "." : `./${entrypoint.specifier.slice(14)}`];
    const target = typeof declaration === "string" ? declaration : declaration?.default;
    if (
      typeof target !== "string" ||
      entrypoint.exportTarget !== target ||
      (await fileSha256(await resolvePackedRuntimeExport(packed.sdkRoot, target))) !== entrypoint.sha256
    ) {
      fail(`${sample.id}: packed entrypoint digest mismatch for ${entrypoint.specifier}`);
    }
  }
  const files = [];
  for (const file of await boundedTree(dist, { maxFiles: 1_000, maxBytes: 64 * 1024 * 1024 })) {
    files.push({
      path: path.relative(dist, file.absolute).replaceAll(path.sep, "/"),
      bytes: file.bytes,
      sha256: await fileSha256(file.absolute),
    });
  }
  return {
    format: "honua.sdk.sample-packed-build-gate.v1",
    sampleId: sample.id,
    sourceRevision: revision,
    command,
    sdkMode: "packed",
    packageTarballSha256: packed.tarballSha256,
    packageTarball: path.relative(PROJECT_ROOT, packed.tarballPath).replaceAll(path.sep, "/"),
    packageTarballBytes: (await stat(packed.tarballPath)).size,
    sampleDistRoot: path.relative(PROJECT_ROOT, dist).replaceAll(path.sep, "/"),
    resolution,
    files,
  };
}

function fixtureObservation(stdout, sampleId) {
  const line = stdout.split("\n").find((value) => value.startsWith("fixtureEvidence="));
  if (!line) fail(`${sampleId}: fixture producer emitted no closure evidence`);
  const observation = JSON.parse(line.slice("fixtureEvidence=".length));
  if (
    observation.transport !== "loopback-http" ||
    observation.host !== "127.0.0.1" ||
    !Number.isInteger(observation.port) ||
    observation.port <= 0 ||
    observation.port > 65_535 ||
    observation.ready !== true ||
    observation.started !== true ||
    observation.closed !== true ||
    observation.listeningAfterClose !== false ||
    observation.activeConnectionsAfterClose !== 0 ||
    observation.probe?.method !== "GET" ||
    observation.probe?.path !== "/" ||
    observation.probe?.status !== 200 ||
    !Number.isInteger(observation.probe?.bodyBytes) ||
    observation.probe.bodyBytes <= 0 ||
    !/^[a-f0-9]{64}$/.test(observation.probe?.bodySha256)
  ) {
    fail(`${sampleId}: fixture producer evidence is invalid`);
  }
  return observation;
}

function projectRelativeArtifactPath(absolute, label) {
  const relative = path.relative(PROJECT_ROOT, absolute).replaceAll(path.sep, "/");
  return safeRelativePath(relative, label);
}

async function readGateArtifact(absolute, label, minimumMtimeMs) {
  const relative = projectRelativeArtifactPath(absolute, label);
  const bytes = await readCanonicalBoundedFile(PROJECT_ROOT, relative, {
    label,
    maxBytes: MAX_GATE_ARTIFACT_BYTES,
    minimumMtimeMs,
  });
  return { bytes, relative };
}

async function readGateArtifactJson(absolute, label, minimumMtimeMs) {
  const artifact = await readGateArtifact(absolute, label, minimumMtimeMs);
  return { ...artifact, value: JSON.parse(artifact.bytes.toString("utf8")) };
}

async function writeGateReport({
  sample,
  gate,
  revision,
  command,
  result,
  runRoot,
  packed,
  sourceSnapshot,
  liveCredentials = [],
}) {
  const artifactRoot = path.join(runRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  if (["browser", "accessibility", "console", "responsive"].includes(gate)) {
    const playwrightPath = path.join(artifactRoot, "playwright.json");
    const playwright = await readGateArtifactJson(
      playwrightPath,
      `${sample.id} Playwright report`,
      sourceSnapshot.capturedAtMs,
    );
    const report = {
      format: "honua.sdk.sample-playwright-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      gate,
      command,
      playwright: playwright.value,
    };
    const reportPath = path.join(artifactRoot, `${gate}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    return { kind: "playwright-gate-report", path: path.relative(PROJECT_ROOT, reportPath).replaceAll(path.sep, "/") };
  }
  let kind;
  let report;
  if (gate === "fixture") {
    kind = "fixture-probe-report";
    report = {
      format: "honua.sdk.sample-fixture-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      ...fixtureObservation(result.stdout, sample.id),
    };
  } else if (gate === "packed-build") {
    kind = "packed-build-report";
    report = await buildPackedReport(sample, revision, packed, command, runRoot);
  } else if (gate === "live") {
    kind = "live-evidence-report";
    const absoluteEvidencePath = path.join(artifactRoot, "live-evidence.json");
    const normalizedEvidencePath = path.relative(PROJECT_ROOT, absoluteEvidencePath).replaceAll(path.sep, "/");
    const { bytes: evidenceBytes } = await readGateArtifact(
      absoluteEvidencePath,
      `${sample.id} fresh live evidence output`,
      sourceSnapshot.capturedAtMs,
    );
    assertCredentialFreeContent(evidenceBytes, liveCredentials, `${sample.id} live evidence`);
    const evidence = JSON.parse(evidenceBytes.toString("utf8"));
    for (const artifact of evidence.artifacts ?? []) {
      if (
        typeof artifact?.path !== "string" ||
        typeof artifact.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)
      ) {
        fail(`${sample.id}: live producer artifact binding is invalid`);
      }
      const normalizedArtifactPath = safeRelativePath(artifact.path, `${sample.id} live artifact path`);
      const runRelative = path.relative(PROJECT_ROOT, runRoot).replaceAll(path.sep, "/");
      if (artifact.kind === "producer-generator") {
        if (normalizedArtifactPath.startsWith("samples/evidence/")) {
          fail(`${sample.id}: live producer source cannot be supplied by the evidence tree`);
        }
      } else if (!normalizedArtifactPath.startsWith(`${runRelative}/`)) {
        fail(`${sample.id}: live artifact is outside this evidence run`);
      }
      const artifactBytes = await readCanonicalBoundedFile(PROJECT_ROOT, normalizedArtifactPath, {
        label: `${sample.id} live artifact ${artifact.path}`,
        maxBytes: MAX_GATE_ARTIFACT_BYTES,
        minimumMtimeMs: artifact.kind === "producer-generator" ? undefined : sourceSnapshot.capturedAtMs,
      });
      if (createHash("sha256").update(artifactBytes).digest("hex") !== artifact.sha256) {
        fail(`${sample.id}: live artifact digest does not match its evidence binding`);
      }
      assertCredentialFreeContent(artifactBytes, liveCredentials, `${sample.id} live artifact ${artifact.path}`);
    }
    report = {
      format: "honua.sdk.sample-live-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      evidencePath: normalizedEvidencePath,
      evidence,
    };
  } else if (gate === "screenshot") {
    kind = "screenshot-report";
    const producerPath = path.join(artifactRoot, "screenshot-gate.json");
    const producer = await readGateArtifactJson(
      producerPath,
      `${sample.id} screenshot report`,
      sourceSnapshot.capturedAtMs,
    );
    report = {
      format: "honua.sdk.sample-screenshot-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      screenshot: producer.value,
    };
  } else if (gate === "performance") {
    kind = "performance-report";
    const producerPath = path.join(artifactRoot, "performance-gate.json");
    const producer = await readGateArtifactJson(
      producerPath,
      `${sample.id} performance report`,
      sourceSnapshot.capturedAtMs,
    );
    report = {
      format: "honua.sdk.sample-performance-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      measurement: producer.value,
    };
  } else fail(`unsupported evidence gate: ${gate}`);
  const reportPath = path.join(artifactRoot, `${gate}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return { kind, path: path.relative(PROJECT_ROOT, reportPath).replaceAll(path.sep, "/") };
}

export function groupEvidenceGates(sample, gates) {
  const groups = new Map();
  for (const gate of gates) {
    const command = expectedGateCommand(sample, gate);
    const key = canonicalCommand(command);
    const group = groups.get(key) ?? { command, gates: [] };
    group.gates.push(gate);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function validEvidenceSampleId(sampleId) {
  return typeof sampleId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sampleId);
}

async function ensureCanonicalToolingDirectory(absolute, expectedCanonical, label) {
  try {
    await mkdir(absolute);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const metadata = await lstat(absolute);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(absolute)) !== expectedCanonical
  ) {
    fail(`${label} is not a canonical directory`);
  }
}

async function canonicalEvidenceLockRoot(projectRoot) {
  const lexicalProjectRoot = path.resolve(projectRoot);
  const projectMetadata = await lstat(lexicalProjectRoot);
  const canonicalProjectRoot = await realpath(lexicalProjectRoot);
  if (
    !projectMetadata.isDirectory() ||
    projectMetadata.isSymbolicLink() ||
    canonicalProjectRoot !== lexicalProjectRoot
  ) {
    fail("sample evidence lock project root is not canonical");
  }
  const temporaryRoot = path.join(lexicalProjectRoot, ".tmp");
  const lockRoot = path.join(temporaryRoot, "sample-runner-locks");
  await ensureCanonicalToolingDirectory(
    temporaryRoot,
    path.join(canonicalProjectRoot, ".tmp"),
    "sample evidence temporary root",
  );
  await ensureCanonicalToolingDirectory(
    lockRoot,
    path.join(canonicalProjectRoot, ".tmp/sample-runner-locks"),
    "sample evidence lock root",
  );
  return lockRoot;
}

async function readEvidenceLockOwner(lockPath, projectRoot) {
  try {
    const ownerPath = path.join(lockPath, "owner.json");
    const relative = path.relative(projectRoot, ownerPath).replaceAll(path.sep, "/");
    const owner = JSON.parse((await readCanonicalBoundedFile(projectRoot, relative, {
      label: "sample evidence lock owner",
      maxBytes: 4_096,
    })).toString("utf8"));
    if (
      !Number.isSafeInteger(owner?.pid) ||
      owner.pid <= 0 ||
      !validEvidenceSampleId(owner.sampleId) ||
      typeof owner.token !== "string" ||
      !/^[a-f0-9-]{36}$/.test(owner.token) ||
      (owner.processStart !== null && !/^\d+$/.test(owner.processStart))
    ) {
      return undefined;
    }
    return owner;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function processStartIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    const fields = value.slice(close + 2).split(" ");
    return /^\d+$/.test(fields[19] ?? "") ? fields[19] : null;
  } catch (error) {
    if (new Set(["ENOENT", "ESRCH", "EACCES", "EPERM"]).has(error?.code)) return null;
    throw error;
  }
}

async function processIsOwnerAlive(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") return false;
  }
  if (owner.processStart === null) return true;
  return (await processStartIdentity(owner.pid)) === owner.processStart;
}

/**
 * Serialize all evidence generation across processes. Source snapshots cover
 * the complete evidence tree, so cross-sample runs must share this one lock.
 * The canonical
 * lock is published only after its immutable owner record exists, so a second
 * runner can safely reclaim a lock whose process no longer exists.
 */
export async function acquireSampleEvidenceLock(sampleId, options = {}) {
  if (!validEvidenceSampleId(sampleId)) fail("sample evidence lock sample ID is invalid");
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const lockRoot = await canonicalEvidenceLockRoot(projectRoot);
  const token = randomUUID();
  const lockPath = path.join(lockRoot, "evidence");
  const candidatePath = path.join(lockRoot, `.candidate-${token}`);
  await mkdir(candidatePath);
  const processStart = await processStartIdentity(process.pid);
  await writeFile(
    path.join(candidatePath, "owner.json"),
    `${JSON.stringify({ pid: process.pid, processStart, sampleId, token, createdAt: new Date().toISOString() })}\n`,
    { flag: "wx" },
  );

  let acquired = false;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await rename(candidatePath, lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error?.code)) throw error;
      }
      const owner = await readEvidenceLockOwner(lockPath, projectRoot);
      if (owner && await processIsOwnerAlive(owner)) {
        fail(`${sampleId}: another sample evidence run is active for ${owner.sampleId} (pid ${owner.pid})`);
      }
      const stalePath = path.join(lockRoot, `.stale-${randomUUID()}`);
      try {
        await rename(lockPath, stalePath);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      try {
        await recoverInterruptedReceiptTransactions(undefined, owner?.sampleId, {
          projectRoot,
          transactionRoot: stalePath,
        });
      } catch (error) {
        throw new AggregateError(
          [error],
          `${sampleId}: stale evidence lock recovery failed; preserved ${path.basename(stalePath)}`,
        );
      }
      await rm(stalePath, { recursive: true, force: false });
    }
    if (!acquired) fail(`${sampleId}: could not acquire the sample evidence lock`);
  } finally {
    if (!acquired) await rm(candidatePath, { recursive: true, force: true });
  }

  let released = false;
  return {
    path: lockPath,
    sampleId,
    token,
    async release() {
      if (released) return;
      const owner = await readEvidenceLockOwner(lockPath, projectRoot);
      if (!owner || owner.token !== token || owner.pid !== process.pid) {
        fail(`${sampleId}: sample evidence lock ownership changed before release`);
      }
      const releasePath = path.join(lockRoot, `.release-${sampleId}-${token}`);
      await rename(lockPath, releasePath);
      await rm(releasePath, { recursive: true, force: false });
      released = true;
    },
  };
}

async function canonicalExistingDirectory(absolute, expectedCanonical, label, optional = false) {
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(absolute)) !== expectedCanonical
  ) {
    fail(`${label} is a symlink or escaped directory`);
  }
  return { absolute, canonical: expectedCanonical, dev: metadata.dev, ino: metadata.ino };
}

function receiptNameGate(name) {
  const suffix = ".v1.json";
  const gate = typeof name === "string" && name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
  return SAMPLE_GATE_NAMES.includes(gate) ? gate : undefined;
}

function receiptSnapshotManifest(sampleId, snapshot) {
  return {
    format: "honua.sdk.sample-receipt-guard.v1",
    schemaVersion: 1,
    sampleId,
    receiptRoot: `samples/evidence/${sampleId}/receipts`,
    receipts: [...snapshot]
      .map(([name, value]) => ({
        name,
        bytes: value.bytes.byteLength,
        sha256: createHash("sha256").update(value.bytes).digest("hex"),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function validateReceiptGuardManifest(manifest, sampleId) {
  if (
    !isPlainRecord(manifest) ||
    manifest.format !== "honua.sdk.sample-receipt-guard.v1" ||
    manifest.schemaVersion !== 1 ||
    !validEvidenceSampleId(manifest.sampleId) ||
    (sampleId && manifest.sampleId !== sampleId) ||
    manifest.receiptRoot !== `samples/evidence/${manifest.sampleId}/receipts` ||
    !Array.isArray(manifest.receipts)
  ) {
    fail("interrupted receipt guard manifest is invalid");
  }
  const names = new Set();
  for (const receipt of manifest.receipts) {
    if (
      !isPlainRecord(receipt) ||
      !receiptNameGate(receipt.name) ||
      names.has(receipt.name) ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < 0 ||
      receipt.bytes > 1024 * 1024 ||
      typeof receipt.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.sha256)
    ) {
      fail(`${manifest.sampleId}: interrupted receipt guard entry is invalid`);
    }
    names.add(receipt.name);
  }
  const sorted = [...manifest.receipts].sort((left, right) => left.name.localeCompare(right.name));
  if (!sameJson(sorted, manifest.receipts)) fail(`${manifest.sampleId}: receipt guard entries are not sorted`);
  return manifest;
}

async function readReceiptGuard(transactionRoot, expectedSampleId, projectRoot, expectedSnapshot) {
  const guardRoot = path.join(transactionRoot, "receipt-guard");
  let guardMetadata;
  try {
    guardMetadata = await lstat(guardRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !guardMetadata.isDirectory() ||
    guardMetadata.isSymbolicLink() ||
    (await realpath(guardRoot)) !== guardRoot
  ) {
    fail("interrupted receipt guard is not a canonical directory");
  }
  const guardEntries = await readdir(guardRoot, { withFileTypes: true });
  if (
    guardEntries.length !== 2 ||
    !guardEntries.some((entry) => entry.name === "manifest.json" && entry.isFile() && !entry.isSymbolicLink()) ||
    !guardEntries.some((entry) => entry.name === "previous" && entry.isDirectory() && !entry.isSymbolicLink())
  ) {
    fail("interrupted receipt guard has an unexpected structure");
  }
  const manifestRelative = path.relative(projectRoot, path.join(guardRoot, "manifest.json")).replaceAll(path.sep, "/");
  const manifestBytes = await readCanonicalBoundedFile(projectRoot, manifestRelative, {
    label: "interrupted receipt guard manifest",
    maxBytes: 64 * 1024,
  });
  const manifest = validateReceiptGuardManifest(JSON.parse(manifestBytes.toString("utf8")), expectedSampleId);
  const previousRoot = path.join(guardRoot, "previous");
  const previousMetadata = await lstat(previousRoot);
  if (
    !previousMetadata.isDirectory() ||
    previousMetadata.isSymbolicLink() ||
    (await realpath(previousRoot)) !== previousRoot
  ) {
    fail(`${manifest.sampleId}: receipt guard rollback directory is not canonical`);
  }
  const entries = await readdir(previousRoot, { withFileTypes: true });
  if (
    entries.length !== manifest.receipts.length ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !receiptNameGate(entry.name))
  ) {
    fail(`${manifest.sampleId}: receipt guard rollback set is invalid`);
  }
  const snapshot = new Map();
  for (const binding of manifest.receipts) {
    const relative = path.relative(projectRoot, path.join(previousRoot, binding.name)).replaceAll(path.sep, "/");
    const bytes = await readCanonicalBoundedFile(projectRoot, relative, {
      label: `${manifest.sampleId} guarded receipt ${binding.name}`,
      maxBytes: 1024 * 1024,
    });
    if (
      bytes.byteLength !== binding.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== binding.sha256 ||
      (expectedSnapshot && !bytes.equals(expectedSnapshot.get(binding.name)?.bytes))
    ) {
      fail(`${manifest.sampleId}: guarded receipt bytes are invalid: ${binding.name}`);
    }
    validateGateReceiptStructure(JSON.parse(bytes.toString("utf8")), {
      sampleId: manifest.sampleId,
      gate: receiptNameGate(binding.name),
    });
    snapshot.set(binding.name, { bytes });
  }
  return { guardRoot, manifest, previousRoot, snapshot };
}

async function canonicalReceiptRecoveryParent(projectRoot, sampleId) {
  const canonicalProjectRoot = await realpath(projectRoot);
  if (canonicalProjectRoot !== projectRoot) fail(`${sampleId}: receipt recovery project root is not canonical`);
  for (const relative of ["samples", "samples/evidence", `samples/evidence/${sampleId}`]) {
    await canonicalExistingDirectory(
      path.join(projectRoot, relative),
      path.join(canonicalProjectRoot, relative),
      `${sampleId}: receipt recovery ${relative}`,
    );
  }
  return path.join(projectRoot, `samples/evidence/${sampleId}/receipts`);
}

async function restoreReceiptGuard(guard, transactionRoot, projectRoot) {
  const { sampleId } = guard.manifest;
  const receiptRoot = await canonicalReceiptRecoveryParent(projectRoot, sampleId);
  const discarded = path.join(transactionRoot, "discarded-receipts");
  try {
    await lstat(discarded);
    fail(`${sampleId}: receipt recovery quarantine already exists`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let discardedExisting = false;
  try {
    const existing = await canonicalExistingDirectory(
      receiptRoot,
      receiptRoot,
      `${sampleId}: receipt recovery canonical receipts`,
      true,
    );
    if (existing) {
      await rename(receiptRoot, discarded);
      discardedExisting = true;
    }
    await rename(guard.previousRoot, receiptRoot);
  } catch (error) {
    if (discardedExisting) {
      try {
        await rename(discarded, receiptRoot);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `${sampleId}: receipt guard recovery rollback failed`);
      }
    }
    throw error;
  }
  const restoredEntries = await readdir(receiptRoot);
  if (
    restoredEntries.length !== guard.snapshot.size ||
    restoredEntries.some((name) => !guard.snapshot.has(name))
  ) {
    fail(`${sampleId}: restored receipt set is incomplete`);
  }
  for (const [name, expected] of guard.snapshot) {
    const relative = path.relative(projectRoot, path.join(receiptRoot, name)).replaceAll(path.sep, "/");
    const bytes = await readCanonicalBoundedFile(projectRoot, relative, {
      label: `${sampleId} restored receipt ${name}`,
      maxBytes: 1024 * 1024,
    });
    if (!bytes.equals(expected.bytes)) fail(`${sampleId}: restored receipt bytes changed: ${name}`);
  }
  if (discardedExisting) await rm(discarded, { recursive: true, force: false });
}

/** Recover only a pre-execution guard owned by a stale global evidence lock. */
export async function recoverInterruptedReceiptTransactions(_baseRoot, sampleId, options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const transactionRoot = options.transactionRoot;
  if (!transactionRoot) return false;
  const guard = await readReceiptGuard(transactionRoot, sampleId, projectRoot);
  if (!guard) return false;
  await restoreReceiptGuard(guard, transactionRoot, projectRoot);
  await rm(guard.guardRoot, { recursive: true, force: false });
  return true;
}

async function canonicalPruneDirectories(baseRoot, sampleId, projectRoot) {
  if (!validEvidenceSampleId(sampleId)) fail("evidence cleanup sample ID is invalid");
  const lexicalProjectRoot = path.resolve(projectRoot);
  const expectedBaseRoot = path.join(lexicalProjectRoot, "samples/evidence", sampleId);
  if (path.resolve(baseRoot) !== expectedBaseRoot) fail(`${sampleId}: evidence cleanup root is not canonical`);

  const directories = [];
  const relativeDirectories = ["", "samples", "samples/evidence", `samples/evidence/${sampleId}`,
    `samples/evidence/${sampleId}/receipts`, `samples/evidence/${sampleId}/runs`];
  let canonicalProjectRoot;
  for (const relative of relativeDirectories) {
    const absolute = relative ? path.join(lexicalProjectRoot, relative) : lexicalProjectRoot;
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(`${sampleId}: evidence cleanup directory is a symlink or non-directory: ${absolute}`);
    }
    const canonical = await realpath(absolute);
    if (relative === "") canonicalProjectRoot = canonical;
    const expectedCanonical = relative ? path.join(canonicalProjectRoot, relative) : lexicalProjectRoot;
    if (canonical !== expectedCanonical) fail(`${sampleId}: evidence cleanup directory escapes its canonical root`);
    directories.push({ absolute, canonical, dev: metadata.dev, ino: metadata.ino });
  }
  return {
    projectRoot: lexicalProjectRoot,
    directories,
    receiptRoot: directories.at(-2),
    runsRoot: directories.at(-1),
  };
}

async function revalidatePruneDirectories(binding, sampleId) {
  for (const directory of binding.directories) {
    const metadata = await lstat(directory.absolute);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== directory.dev ||
      metadata.ino !== directory.ino ||
      (await realpath(directory.absolute)) !== directory.canonical
    ) {
      fail(`${sampleId}: evidence cleanup directory changed during pruning`);
    }
  }
}

async function validateEvidenceRunDirectory(binding, runRoot, sampleId) {
  const runId = path.basename(runRoot);
  const expectedRunRoot = path.join(binding.runsRoot.absolute, runId);
  if (!isSampleEvidenceRunId(runId) || path.resolve(runRoot) !== expectedRunRoot) {
    fail(`${sampleId}: evidence transaction run root is not canonical`);
  }
  await revalidatePruneDirectories(binding, sampleId);
  const metadata = await lstat(expectedRunRoot);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(expectedRunRoot)) !== path.join(binding.runsRoot.canonical, runId)
  ) {
    fail(`${sampleId}: evidence transaction run root is a symlink or escaped directory`);
  }
  return {
    absolute: expectedRunRoot,
    canonical: path.join(binding.runsRoot.canonical, runId),
    dev: metadata.dev,
    ino: metadata.ino,
    runId,
  };
}

async function revalidateEvidenceRunDirectory(binding, run, sampleId) {
  await revalidatePruneDirectories(binding, sampleId);
  const metadata = await lstat(run.absolute);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== run.dev ||
    metadata.ino !== run.ino ||
    (await realpath(run.absolute)) !== run.canonical
  ) {
    fail(`${sampleId}: evidence transaction run root changed during publication`);
  }
}

async function absentPublicationPath(value, transaction) {
  if (path.dirname(value) !== transaction.evidenceLock.path) {
    fail(`${transaction.sampleId}: evidence publication path escapes its lock`);
  }
  try {
    await lstat(value);
    fail(`${transaction.sampleId}: evidence publication path already exists: ${path.basename(value)}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function copyCanonicalReceiptsToStage(binding, stageRoot, sampleId) {
  const receiptNames = new Set(SAMPLE_GATE_NAMES.map((gate) => `${gate}.v1.json`));
  const entries = await readdir(binding.receiptRoot.absolute, { withFileTypes: true });
  const snapshot = new Map();
  for (const entry of entries) {
    if (!receiptNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail(`${sampleId}: canonical receipt tree contains an unsafe entry: ${entry.name}`);
    }
    await revalidatePruneDirectories(binding, sampleId);
    const sourcePath = path.join(binding.receiptRoot.absolute, entry.name);
    const metadata = await lstat(sourcePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 1024 * 1024 ||
      (await realpath(sourcePath)) !== path.join(binding.receiptRoot.canonical, entry.name)
    ) {
      fail(`${sampleId}: canonical receipt is not a bounded regular file: ${entry.name}`);
    }
    const relative = path.relative(binding.projectRoot, sourcePath).replaceAll(path.sep, "/");
    const bytes = await readCanonicalBoundedFile(binding.projectRoot, relative, {
      label: `${sampleId} canonical receipt ${entry.name}`,
      maxBytes: 1024 * 1024,
    });
    const current = await lstat(sourcePath);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      (await realpath(sourcePath)) !== path.join(binding.receiptRoot.canonical, entry.name)
    ) {
      fail(`${sampleId}: canonical receipt changed during transaction staging: ${entry.name}`);
    }
    validateGateReceiptStructure(JSON.parse(bytes.toString("utf8")), {
      sampleId,
      gate: receiptNameGate(entry.name),
    });
    await writeFile(path.join(stageRoot, entry.name), bytes, { flag: "wx" });
    snapshot.set(entry.name, { bytes, dev: metadata.dev, ino: metadata.ino });
  }
  return snapshot;
}

async function validateReceiptSnapshotAt(
  directory,
  canonicalDirectory,
  directoryIdentity,
  snapshot,
  sampleId,
  projectRoot,
) {
  const directoryMetadata = await lstat(directory);
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    directoryMetadata.dev !== directoryIdentity.dev ||
    directoryMetadata.ino !== directoryIdentity.ino ||
    (await realpath(directory)) !== canonicalDirectory
  ) {
    fail(`${sampleId}: canonical receipt directory changed during transaction publication`);
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== snapshot.size ||
    entries.some((entry) => !snapshot.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail(`${sampleId}: canonical receipt set changed during transaction publication`);
  }
  for (const entry of entries) {
    const expected = snapshot.get(entry.name);
    const receiptPath = path.join(directory, entry.name);
    const metadata = await lstat(receiptPath);
    const relative = path.relative(projectRoot, receiptPath).replaceAll(path.sep, "/");
    const bytes = await readCanonicalBoundedFile(projectRoot, relative, {
      label: `${sampleId} receipt transaction snapshot ${entry.name}`,
      maxBytes: 1024 * 1024,
    });
    const current = await lstat(receiptPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== metadata.dev ||
      current.ino !== metadata.ino ||
      (await realpath(receiptPath)) !== path.join(canonicalDirectory, entry.name) ||
      !bytes.equals(expected.bytes)
    ) {
      fail(`${sampleId}: canonical receipt changed during transaction publication: ${entry.name}`);
    }
  }
}

export async function beginGateReceiptTransaction(options) {
  const projectRoot = path.resolve(options.projectRoot ?? PROJECT_ROOT);
  const { baseRoot, sampleId, evidenceLock } = options;
  if (
    !evidenceLock ||
    evidenceLock.sampleId !== sampleId ||
    typeof evidenceLock.token !== "string" ||
    path.resolve(evidenceLock.path) !== path.join(projectRoot, ".tmp/sample-runner-locks/evidence")
  ) {
    fail(`${sampleId}: receipt guard requires the active global evidence lock`);
  }
  const owner = await readEvidenceLockOwner(evidenceLock.path, projectRoot);
  if (
    !owner ||
    owner.pid !== process.pid ||
    owner.token !== evidenceLock.token ||
    owner.sampleId !== sampleId
  ) {
    fail(`${sampleId}: receipt guard lock ownership is invalid`);
  }
  const binding = await canonicalPruneDirectories(baseRoot, sampleId, projectRoot);
  if (!binding) fail(`${sampleId}: receipt guard canonical directories are missing`);
  const guardRoot = path.join(evidenceLock.path, "receipt-guard");
  const candidateRoot = path.join(evidenceLock.path, `.guard-candidate-${evidenceLock.token}`);
  for (const value of [guardRoot, candidateRoot]) {
    try {
      await lstat(value);
      fail(`${sampleId}: receipt guard already exists`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await mkdir(candidateRoot);
  const candidatePrevious = path.join(candidateRoot, "previous");
  await mkdir(candidatePrevious);
  try {
    const snapshot = await copyCanonicalReceiptsToStage(binding, candidatePrevious, sampleId);
    const manifest = receiptSnapshotManifest(sampleId, snapshot);
    await writeFile(path.join(candidateRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(candidateRoot, guardRoot);
    const transaction = {
      baseRoot,
      binding,
      evidenceLock,
      guardRoot,
      previousRoot: path.join(guardRoot, "previous"),
      projectRoot,
      published: false,
      sampleId,
      snapshot,
      closed: false,
    };
    await readReceiptGuard(evidenceLock.path, sampleId, projectRoot, snapshot);
    return transaction;
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true });
    throw error;
  }
}

async function validateGateReceiptTransaction(transaction) {
  if (!transaction || transaction.closed) fail("evidence receipt guard is not active");
  const owner = await readEvidenceLockOwner(transaction.evidenceLock.path, transaction.projectRoot);
  if (
    !owner ||
    owner.pid !== process.pid ||
    owner.token !== transaction.evidenceLock.token ||
    owner.sampleId !== transaction.sampleId
  ) {
    fail(`${transaction.sampleId}: receipt guard lock ownership changed`);
  }
  await readReceiptGuard(
    transaction.evidenceLock.path,
    transaction.sampleId,
    transaction.projectRoot,
    transaction.snapshot,
  );
  await validateReceiptSnapshotAt(
    transaction.binding.receiptRoot.absolute,
    transaction.binding.receiptRoot.canonical,
    transaction.binding.receiptRoot,
    transaction.snapshot,
    transaction.sampleId,
    transaction.projectRoot,
  );
}

export async function rollbackGateReceiptTransaction(transaction) {
  if (!transaction || transaction.closed) return;
  const guard = await readReceiptGuard(
    transaction.evidenceLock.path,
    transaction.sampleId,
    transaction.projectRoot,
    transaction.snapshot,
  );
  if (!guard) fail(`${transaction.sampleId}: receipt rollback guard is missing`);
  await restoreReceiptGuard(guard, transaction.evidenceLock.path, transaction.projectRoot);
  await rm(guard.guardRoot, { recursive: true, force: false });
  transaction.closed = true;
}

export async function commitGateReceiptTransaction(transaction) {
  if (!transaction || transaction.closed || !transaction.published) {
    fail("evidence receipt guard cannot commit before publication");
  }
  await readReceiptGuard(
    transaction.evidenceLock.path,
    transaction.sampleId,
    transaction.projectRoot,
    transaction.snapshot,
  );
  const committedRoot = path.join(transaction.evidenceLock.path, "receipt-guard-committed");
  await absentPublicationPath(committedRoot, transaction);
  await rename(transaction.guardRoot, committedRoot);
  transaction.closed = true;
  await rm(committedRoot, { recursive: true, force: false });
}

async function invokeReceiptTransactionFault(fault, point) {
  if (fault) await fault(point);
}

async function validateStagedReceiptDirectory(
  stageRoot,
  stageCanonical,
  stageIdentity,
  expectedBytes,
  sampleId,
  projectRoot,
) {
  const stagedDirectory = await lstat(stageRoot);
  if (
    !stagedDirectory.isDirectory() ||
    stagedDirectory.isSymbolicLink() ||
    stagedDirectory.dev !== stageIdentity.dev ||
    stagedDirectory.ino !== stageIdentity.ino ||
    (await realpath(stageRoot)) !== stageCanonical
  ) {
    fail(`${sampleId}: evidence receipt staging directory changed during publication`);
  }
  const entries = await readdir(stageRoot, { withFileTypes: true });
  if (
    entries.length !== expectedBytes.size ||
    entries.some((entry) => !expectedBytes.has(entry.name) || !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail(`${sampleId}: staged evidence receipt set is incomplete`);
  }
  const snapshot = new Map();
  for (const entry of entries) {
    const stagedPath = path.join(stageRoot, entry.name);
    const metadata = await lstat(stagedPath);
    const relative = path.relative(projectRoot, stagedPath).replaceAll(path.sep, "/");
    const bytes = await readCanonicalBoundedFile(projectRoot, relative, {
      label: `${sampleId} staged receipt ${entry.name}`,
      maxBytes: 1024 * 1024,
    });
    const current = await lstat(stagedPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== current.dev ||
      metadata.ino !== current.ino ||
      (await realpath(stagedPath)) !== path.join(stageCanonical, entry.name) ||
      !bytes.equals(expectedBytes.get(entry.name))
    ) {
      fail(`${sampleId}: staged evidence receipt is not a stable bounded regular file: ${entry.name}`);
    }
    validateGateReceiptStructure(JSON.parse(bytes.toString("utf8")), {
      sampleId,
      gate: receiptNameGate(entry.name),
    });
    snapshot.set(entry.name, { bytes, dev: metadata.dev, ino: metadata.ino });
  }
  return snapshot;
}

export async function publishGateReceiptGroups(options) {
  const { baseRoot, groups, sampleId, transaction } = options;
  if (
    !transaction ||
    transaction.baseRoot !== baseRoot ||
    transaction.sampleId !== sampleId ||
    transaction.closed ||
    transaction.published ||
    path.resolve(options.projectRoot ?? PROJECT_ROOT) !== transaction.projectRoot
  ) {
    fail(`${sampleId}: evidence receipt transaction has no pre-execution guard`);
  }
  if (!Array.isArray(groups) || groups.length === 0) {
    fail(`${sampleId}: evidence receipt transaction has no publication groups`);
  }
  await validateGateReceiptTransaction(transaction);
  const binding = transaction.binding;
  const uniqueGates = new Set();
  const validatedGroups = [];
  for (const group of groups) {
    if (!group || !Array.isArray(group.receipts) || group.receipts.length === 0) {
      fail(`${sampleId}: evidence receipt transaction contains an empty publication group`);
    }
    const run = await validateEvidenceRunDirectory(binding, group.runRoot, sampleId);
    const expectedRunRoot = `samples/evidence/${sampleId}/runs/${run.runId}`;
    for (const entry of group.receipts) {
      if (
        !entry ||
        !SAMPLE_GATE_NAMES.includes(entry.gate) ||
        uniqueGates.has(entry.gate) ||
        entry.receipt?.sampleId !== sampleId ||
        entry.receipt?.gate !== entry.gate ||
        entry.receipt?.runRoot !== expectedRunRoot
      ) {
        fail(`${sampleId}: evidence receipt transaction has an invalid gate or run binding`);
      }
      validateGateReceiptStructure(entry.receipt, { sampleId, gate: entry.gate });
      uniqueGates.add(entry.gate);
    }
    validatedGroups.push({ ...group, run });
  }

  const stageRoot = path.join(transaction.evidenceLock.path, "receipt-publication-next");
  const backupRoot = path.join(transaction.evidenceLock.path, "receipt-publication-previous");
  const failedRoot = path.join(transaction.evidenceLock.path, "receipt-publication-failed");
  for (const publicationPath of [stageRoot, backupRoot, failedRoot]) {
    await absentPublicationPath(publicationPath, transaction);
  }
  let stageMetadata;
  let stagedReceipts;
  let previousMoved = false;
  let nextPublished = false;
  try {
    await mkdir(stageRoot);
    stageMetadata = await lstat(stageRoot);
    const stageCanonical = path.join(await realpath(transaction.evidenceLock.path), path.basename(stageRoot));
    if (
      !stageMetadata.isDirectory() ||
      stageMetadata.isSymbolicLink() ||
      (await realpath(stageRoot)) !== stageCanonical
    ) {
      fail(`${sampleId}: evidence receipt staging directory is not canonical`);
    }
    const stagedReceiptBytes = new Map();
    for (const [name, value] of transaction.snapshot) {
      await writeFile(path.join(stageRoot, name), value.bytes, { flag: "wx" });
      stagedReceiptBytes.set(name, value.bytes);
    }
    for (const group of validatedGroups) {
      for (const { gate, receipt } of group.receipts) {
        await invokeReceiptTransactionFault(options.fault, `before-stage-write:${gate}`);
        const name = `${gate}.v1.json`;
        const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
        if (bytes.byteLength > 1024 * 1024) fail(`${sampleId}: staged evidence receipt exceeds its size limit: ${name}`);
        const stagedPath = path.join(stageRoot, name);
        await rm(stagedPath, { force: true });
        await writeFile(stagedPath, bytes, { flag: "wx" });
        stagedReceiptBytes.set(name, bytes);
      }
    }
    stagedReceipts = await validateStagedReceiptDirectory(
      stageRoot,
      stageCanonical,
      stageMetadata,
      stagedReceiptBytes,
      sampleId,
      transaction.projectRoot,
    );
    for (const group of validatedGroups) {
      await revalidateEvidenceRunDirectory(binding, group.run, sampleId);
    }
    await validateGateReceiptTransaction(transaction);
    await rename(binding.receiptRoot.absolute, backupRoot);
    previousMoved = true;
    await validateReceiptSnapshotAt(
      backupRoot,
      path.join(await realpath(transaction.evidenceLock.path), path.basename(backupRoot)),
      binding.receiptRoot,
      transaction.snapshot,
      sampleId,
      binding.projectRoot,
    );
    await invokeReceiptTransactionFault(options.fault, "before-publish-rename");
    await rename(stageRoot, binding.receiptRoot.absolute);
    nextPublished = true;
    await validateReceiptSnapshotAt(
      binding.receiptRoot.absolute,
      binding.receiptRoot.canonical,
      stageMetadata,
      stagedReceipts,
      sampleId,
      binding.projectRoot,
    );
    await invokeReceiptTransactionFault(options.fault, "after-publish-rename");
    await rm(backupRoot, { recursive: true, force: false });
    previousMoved = false;
  } catch (error) {
    const rollbackErrors = [];
    let failedMoved = false;
    if (nextPublished) {
      try {
        await rename(binding.receiptRoot.absolute, failedRoot);
        failedMoved = true;
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (previousMoved && (!nextPublished || failedMoved)) {
      try {
        await rename(backupRoot, binding.receiptRoot.absolute);
        previousMoved = false;
        await validateReceiptSnapshotAt(
          binding.receiptRoot.absolute,
          binding.receiptRoot.canonical,
          binding.receiptRoot,
          transaction.snapshot,
          sampleId,
          binding.projectRoot,
        );
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (failedMoved) {
      try {
        await rm(failedRoot, { recursive: true, force: false });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      await rm(stageRoot, { recursive: true, force: true });
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `${sampleId}: evidence receipt transaction rollback failed`);
    }
    throw error;
  }
  transaction.published = true;
}

export async function publishGateReceiptGroup(options) {
  const { runRoot, receipts, ...shared } = options;
  return publishGateReceiptGroups({ ...shared, groups: [{ runRoot, receipts }] });
}

export async function pruneUnreferencedEvidenceRuns(baseRoot, sampleId, options = {}) {
  const binding = await canonicalPruneDirectories(baseRoot, sampleId, options.projectRoot ?? PROJECT_ROOT);
  if (!binding) return;
  await revalidatePruneDirectories(binding, sampleId);
  const [receiptEntries, runEntries] = await Promise.all([
    readdir(binding.receiptRoot.absolute, { withFileTypes: true }),
    readdir(binding.runsRoot.absolute, { withFileTypes: true }),
  ]);
  const referenced = new Set();
  const receiptNames = new Set(SAMPLE_GATE_NAMES.map((gate) => `${gate}.v1.json`));
  for (const entry of receiptEntries) {
    if (!receiptNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      fail(`${sampleId}: canonical receipt tree contains an unsafe entry: ${entry.name}`);
    }
    await revalidatePruneDirectories(binding, sampleId);
    const receiptPath = path.join(binding.receiptRoot.absolute, entry.name);
    const relative = path.relative(binding.projectRoot, receiptPath).replaceAll(path.sep, "/");
    const receiptBytes = await readCanonicalBoundedFile(binding.projectRoot, relative, {
      label: `${sampleId} canonical receipt ${entry.name}`,
      maxBytes: 1024 * 1024,
    });
    await revalidatePruneDirectories(binding, sampleId);
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    const gate = entry.name.slice(0, -".v1.json".length);
    validateGateReceiptStructure(receipt, { sampleId, gate });
    const prefix = `samples/evidence/${sampleId}/runs/`;
    const runId = typeof receipt.runRoot === "string" ? receipt.runRoot.slice(prefix.length) : "";
    if (receipt.runRoot !== `${prefix}${runId}` || !isSampleEvidenceRunId(runId)) {
      fail(`${sampleId}: cannot prune around a receipt with an invalid run root`);
    }
    referenced.add(runId);
  }
  for (const entry of runEntries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !isSampleEvidenceRunId(entry.name)
    ) {
      fail(`${sampleId}: canonical evidence run tree contains an unsafe entry: ${entry.name}`);
    }
    await revalidatePruneDirectories(binding, sampleId);
    const runPath = path.join(binding.runsRoot.absolute, entry.name);
    const initial = await lstat(runPath);
    if (
      !initial.isDirectory() ||
      initial.isSymbolicLink() ||
      (await realpath(runPath)) !== path.join(binding.runsRoot.canonical, entry.name)
    ) {
      fail(`${sampleId}: canonical evidence run is a symlink or escaped directory: ${entry.name}`);
    }
    if (!referenced.has(entry.name)) {
      await revalidatePruneDirectories(binding, sampleId);
      const current = await lstat(runPath);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        (await realpath(runPath)) !== path.join(binding.runsRoot.canonical, entry.name)
      ) {
        fail(`${sampleId}: evidence run changed before cleanup: ${entry.name}`);
      }
      await rm(runPath, { recursive: true, force: false });
      await revalidatePruneDirectories(binding, sampleId);
    }
  }
}

async function executeEvidence(sample, options, context) {
  const profile = context.selection.profiles.find((candidate) => candidate.id === sample.validationProfile);
  if (!profile) fail(`${sample.id}: validation profile is missing`);
  const gates = options.gate ? [options.gate] : requiredReceiptGates(profile);
  if (gates.includes("live") && !options.allowLive) fail("live evidence requires explicit --allow-live");
  const revision = (await context.supervisor.run(["git", "rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) fail("could not resolve a full source revision");
  const baseRoot = path.join(PROJECT_ROOT, "samples/evidence", sample.id);
  const receiptRoot = path.join(baseRoot, "receipts");
  const groups = groupEvidenceGates(sample, gates);
  const evidenceLock = await acquireSampleEvidenceLock(sample.id);
  const publicationGroups = [];
  let transaction;
  let primaryError;
  let rollbackFailed = false;
  try {
    for (const group of groups) {
      const runId = randomUUID();
      const runRoot = path.join(baseRoot, "runs", runId);
      const groupToolingRoot = path.join(context.toolingRoot, "evidence", sample.id, runId);
      const sourceSnapshot = await captureGateSourceSnapshot({
        sourceRevision: revision,
        outputRoot: path.relative(PROJECT_ROOT, baseRoot).replaceAll(path.sep, "/"),
        runRoot: path.relative(PROJECT_ROOT, runRoot).replaceAll(path.sep, "/"),
        projectRoot: PROJECT_ROOT,
      });
      transaction ??= await beginGateReceiptTransaction({
        baseRoot,
        evidenceLock,
        projectRoot: PROJECT_ROOT,
        sampleId: sample.id,
      });
      await mkdir(path.join(groupToolingRoot, "logs"), { recursive: true });
      const containsLiveGate = group.gates.includes("live");
      const commandMode = group.gates.includes("packed-build") ? "packed" : options.sdkMode;
      let packed = context.packed;
      if (commandMode === "packed" && !packed) {
        packed = await preparePackedSdk(context.supervisor, path.join(context.toolingRoot, "packed-sdk"));
        context.packed = packed;
      }
      const playwrightReport = group.gates.some((gate) => ["browser", "accessibility", "console", "responsive"].includes(gate))
        ? path.join(runRoot, "artifacts/playwright.json")
        : undefined;
      const playwrightOutput = isPlaywrightCommand(group.command)
        ? path.join(groupToolingRoot, "playwright-output")
        : undefined;
      const screenshotReport = group.gates.includes("screenshot")
        ? path.join(runRoot, "artifacts/screenshot-gate.json")
        : undefined;
      const performanceReport = group.gates.includes("performance")
        ? path.join(runRoot, "artifacts/performance-gate.json")
        : undefined;
      const evidenceProject = screenshotReport || performanceReport ? context.kitSample?.evidenceProject : undefined;
      if ((screenshotReport || performanceReport) && !evidenceProject) {
        fail(`${sample.id}: visual or performance evidence requires a declared evidence project`);
      }
      for (const expectedReport of [playwrightReport, screenshotReport, performanceReport]) {
        if (expectedReport) await rm(expectedReport, { force: true });
      }
      const liveEvidenceOutput = containsLiveGate ? path.join(runRoot, "artifacts/live-evidence.json") : undefined;
      if (liveEvidenceOutput) await mkdir(path.dirname(liveEvidenceOutput), { recursive: true });
      const liveCredentials = containsLiveGate ? forwardedLiveCredentials(context.catalogSample) : [];
      const result = await context.supervisor.run(group.command, {
        env: sdkEnvironment(commandMode, packed, {
          ...(playwrightReport ? { PLAYWRIGHT_JSON_OUTPUT_NAME: playwrightReport } : {}),
          ...(playwrightOutput ? { HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR: playwrightOutput } : {}),
          ...(screenshotReport ? { HONUA_SAMPLE_SCREENSHOT_OUTPUT: screenshotReport } : {}),
          ...(performanceReport ? { HONUA_SAMPLE_PERFORMANCE_OUTPUT: performanceReport } : {}),
          ...(evidenceProject ? { HONUA_SAMPLE_EVIDENCE_PROJECT: evidenceProject } : {}),
          ...(liveEvidenceOutput ? { HONUA_SAMPLE_LIVE_OUTPUT: liveEvidenceOutput } : {}),
          ...(liveEvidenceOutput ? { HONUA_SAMPLE_LIVE_ENABLED: "true" } : {}),
          ...(liveEvidenceOutput ? { HONUA_SAMPLE_LIVE_SAMPLE_ID: sample.id } : {}),
          ...(liveEvidenceOutput ? { HONUA_SAMPLE_SOURCE_REVISION: revision } : {}),
        }),
        allowedEnvironmentNames: group.gates.includes("live") ? allowedLiveEnvironment(context.catalogSample) : [],
        echoOutput: containsLiveGate ? false : undefined,
        captureOutput: containsLiveGate ? false : undefined,
        artifactPath: containsLiveGate ? undefined : path.join(groupToolingRoot, "logs", `${commandDigest(group.command)}.log`),
      });
      let receiptPacked = packed;
      if (group.gates.includes("packed-build")) {
        const tarballPath = path.join(runRoot, "artifacts", path.basename(packed.tarballPath));
        await mkdir(path.dirname(tarballPath), { recursive: true });
        await copyFile(packed.tarballPath, tarballPath);
        receiptPacked = { ...packed, tarballPath };
      }
      const artifacts = new Map();
      for (const gate of group.gates) {
        artifacts.set(gate, await writeGateReport({
          sample,
          gate,
          revision,
          command: group.command,
          result,
          runRoot,
          packed: receiptPacked,
          liveCredentials,
          sourceSnapshot,
        }));
      }
      const receipts = [];
      for (const gate of group.gates) {
        const receiptPath = path.join(receiptRoot, `${gate}.v1.json`);
        const receipt = await createGateReceipt({
          sampleId: sample.id,
          gate,
          sdkMode: commandMode,
          sourceRevision: revision,
          command: group.command,
          durationMs: result.durationMs,
          artifacts: [artifacts.get(gate)],
          receiptPath: path.relative(PROJECT_ROOT, receiptPath).replaceAll(path.sep, "/"),
          projectRoot: PROJECT_ROOT,
          sourceSnapshot,
        });
        receipts.push({ gate, receipt });
      }
      publicationGroups.push({ runRoot, receipts });
    }
    await publishGateReceiptGroups({
      baseRoot,
      groups: publicationGroups,
      projectRoot: PROJECT_ROOT,
      sampleId: sample.id,
      transaction,
    });
    await commitGateReceiptTransaction(transaction);
    for (const group of publicationGroups) {
      for (const { gate } of group.receipts) {
        process.stdout.write(`sample gate receipt: ${path.relative(PROJECT_ROOT, path.join(receiptRoot, `${gate}.v1.json`))}\n`);
      }
    }
  } catch (error) {
    primaryError = error;
    if (transaction && !transaction.closed) {
      try {
        await rollbackGateReceiptTransaction(transaction);
      } catch (rollbackError) {
        rollbackFailed = true;
        primaryError = new AggregateError(
          [error, rollbackError],
          `${sample.id}: evidence generation failed and receipt rollback could not be validated`,
        );
      }
    }
  }

  const cleanupErrors = [];
  if (!rollbackFailed) {
    try {
      await pruneUnreferencedEvidenceRuns(baseRoot, sample.id);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await evidenceLock.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], `${sample.id}: evidence generation and cleanup failed`);
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, `${sample.id}: evidence cleanup failed`);
}

function printList(samples, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(samples.map(({ id, track, validationProfile }) => ({ id, track, validationProfile })), null, 2)}\n`);
  } else {
    for (const sample of samples) process.stdout.write(`${sample.id}\t${sample.track}\t${sample.validationProfile}\n`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseRunnerArgs(argv);
  const inputs = await readInputs();
  const samples = selectSamples(inputs.selection, options, new Set(inputs.kit.keys()));
  if (options.sdkMode === "packed") {
    const unsupported = samples.filter((sample) => !inputs.kit.has(sample.id)).map((sample) => sample.id);
    if (unsupported.length > 0) fail(`packed mode is not declared by the shared kit for: ${unsupported.join(", ")}`);
  }
  if (options.action === "list") {
    printList(samples, options.json);
    return;
  }
  if (options.dryRun) {
    const plan = samples.map((sample) => ({
      sampleId: sample.id,
      action: options.action,
      sdkMode: options.sdkMode,
      commands:
        options.action === "evidence"
          ? (options.gate ? [options.gate] : requiredReceiptGates(inputs.selection.profiles.find((item) => item.id === sample.validationProfile))).map(
              (gate) => expectedGateCommand(sample, gate),
            )
          : options.action === "dev"
            ? [["npx", "--no-install", "vite", "--config", inputs.kit.get(sample.id)?.viteConfig ?? `${sample.sourcePath}/vite.config.ts`]]
            : commandsForAction(sample, options.action),
    }));
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const supervisor = new ChildSupervisor();
  const toolingRoot = path.join(PROJECT_ROOT, ".tmp/sample-runner", randomUUID());
  const stop = (signal) => void supervisor.stop(signal).catch(() => {
    process.exitCode = 1;
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const packed =
      options.sdkMode === "packed" && options.action !== "evidence"
        ? await preparePackedSdk(supervisor, path.join(toolingRoot, "packed-sdk"))
        : undefined;
    for (const sample of samples) {
      const catalogSample = inputs.catalog.samples.find((candidate) => candidate.id === sample.id);
      const context = {
        ...inputs,
        selection: inputs.selection,
        supervisor,
        packed,
        mode: options.sdkMode,
        toolingRoot,
        kitSample: inputs.kit.get(sample.id),
        catalogSample,
      };
      process.stdout.write(`sample ${options.action}: ${sample.id} (${options.sdkMode})\n`);
      if (options.action === "evidence") await executeEvidence(sample, options, context);
      else await executeAction(sample, options.action, context);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    try {
      await supervisor.stop();
    } finally {
      await rm(toolingRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
