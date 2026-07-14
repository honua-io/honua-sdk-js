#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalCommand,
  classifySampleCommand,
  isPlaywrightCommand,
  parseSampleCommand,
} from "./lib/sample-command.mjs";
import { expectedGateCommand } from "./lib/sample-gates.mjs";
import {
  captureGateSourceSnapshot,
  createGateReceipt,
  requiredReceiptGates,
  SAMPLE_GATE_NAMES,
} from "./sample-gate-receipt.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELECTION_PATH = path.join(PROJECT_ROOT, "samples/dist/sample-ci-selection.v2.json");
const CATALOG_PATH = path.join(PROJECT_ROOT, "samples/catalog.v2.json");
const KIT_PATH = path.join(PROJECT_ROOT, "examples/_kit/manifest.v1.json");
const PACKAGE_PATH = path.join(PROJECT_ROOT, "package.json");
const ACTIONS = new Set(["list", "dev", "typecheck", "build", "test", "verify", "evidence"]);
const SDK_MODES = new Set(["source", "packed"]);
const TRACKS = new Set(["golden", "recipe", "lab", "fixture"]);
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
    if (typeof sample.playwrightProject !== "string") fail(`${sample.id}: sample kit Playwright project is invalid`);
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

function commandForSpawn(argv) {
  if (process.platform !== "win32") return argv;
  if (argv[0] === "npm") return ["npm.cmd", ...argv.slice(1)];
  if (argv[0] === "npx") return ["npx.cmd", ...argv.slice(1)];
  return argv;
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

async function buildPackedReport(sample, revision, packed, command) {
  const dist = path.join(PROJECT_ROOT, sample.sourcePath, "dist");
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
      path: path.relative(PROJECT_ROOT, file.absolute).replaceAll(path.sep, "/"),
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

async function writeGateReport({ sample, catalogSample, gate, revision, command, result, runRoot, packed }) {
  const artifactRoot = path.join(runRoot, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  if (["browser", "accessibility", "console", "responsive"].includes(gate)) {
    const playwrightPath = path.join(artifactRoot, "playwright.json");
    await stat(playwrightPath);
    const report = {
      format: "honua.sdk.sample-playwright-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      gate,
      command,
      playwright: JSON.parse(await readFile(playwrightPath, "utf8")),
    };
    const reportPath = path.join(artifactRoot, `${gate}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
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
    report = await buildPackedReport(sample, revision, packed, command);
  } else if (gate === "live") {
    kind = "live-evidence-report";
    const evidencePath = sample.liveEvidence?.evidencePath;
    const catalogEvidencePath = catalogSample?.evidence?.live?.evidencePath;
    if (typeof evidencePath !== "string" || typeof catalogEvidencePath !== "string") {
      fail(`${sample.id}: live producer has no bound evidence artifact`);
    }
    if (evidencePath !== catalogEvidencePath) {
      fail(`${sample.id}: generated live-evidence binding does not match the catalog`);
    }
    const normalizedEvidencePath = safeRelativePath(evidencePath, `${sample.id}.evidence.live.evidencePath`);
    const absoluteEvidencePath = path.resolve(PROJECT_ROOT, normalizedEvidencePath);
    const canonicalEvidencePath = await realpath(absoluteEvidencePath);
    const evidenceMetadata = await lstat(absoluteEvidencePath);
    if (
      !canonicalEvidencePath.startsWith(`${PROJECT_ROOT}${path.sep}`) ||
      !evidenceMetadata.isFile() ||
      evidenceMetadata.isSymbolicLink() ||
      evidenceMetadata.size > 16 * 1024 * 1024
    ) {
      fail(`${sample.id}: catalog live evidence path is not a bounded repository file`);
    }
    report = {
      format: "honua.sdk.sample-live-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      evidencePath: normalizedEvidencePath,
      evidence: JSON.parse(await readFile(canonicalEvidencePath, "utf8")),
    };
  } else if (gate === "screenshot") {
    kind = "screenshot-report";
    const producerPath = path.join(artifactRoot, "screenshot-gate.json");
    await stat(producerPath);
    report = {
      format: "honua.sdk.sample-screenshot-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      screenshot: JSON.parse(await readFile(producerPath, "utf8")),
    };
  } else if (gate === "performance") {
    kind = "performance-report";
    const producerPath = path.join(artifactRoot, "performance-gate.json");
    await stat(producerPath);
    report = {
      format: "honua.sdk.sample-performance-gate.v1",
      sampleId: sample.id,
      sourceRevision: revision,
      command,
      measurement: JSON.parse(await readFile(producerPath, "utf8")),
    };
  } else fail(`unsupported evidence gate: ${gate}`);
  const reportPath = path.join(artifactRoot, `${gate}.json`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { kind, path: path.relative(PROJECT_ROOT, reportPath).replaceAll(path.sep, "/") };
}

async function executeEvidence(sample, options, context) {
  const profile = context.selection.profiles.find((candidate) => candidate.id === sample.validationProfile);
  if (!profile) fail(`${sample.id}: validation profile is missing`);
  const gates = options.gate ? [options.gate] : requiredReceiptGates(profile);
  if (gates.includes("live") && !options.allowLive) fail("live evidence requires explicit --allow-live");
  const revision = (await context.supervisor.run(["git", "rev-parse", "HEAD"])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) fail("could not resolve a full source revision");
  const baseRoot = path.join(PROJECT_ROOT, "test-results/sample-evidence", sample.id);
  await rm(baseRoot, { recursive: true, force: true });
  const sourceSnapshot = await captureGateSourceSnapshot({
    sourceRevision: revision,
    outputRoot: path.relative(PROJECT_ROOT, baseRoot).replaceAll(path.sep, "/"),
    projectRoot: PROJECT_ROOT,
  });
  const receiptRoot = path.join(baseRoot, "receipts");
  const runRoot = path.join(baseRoot, "runs", randomUUID());
  await mkdir(path.join(runRoot, "logs"), { recursive: true });
  await mkdir(receiptRoot, { recursive: true });

  const groups = new Map();
  for (const gate of gates) {
    const command = expectedGateCommand(sample, gate);
    const key = canonicalCommand(command);
    const group = groups.get(key) ?? { command, gates: [] };
    group.gates.push(gate);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const containsLiveGate = group.gates.includes("live");
    const commandMode = group.gates.includes("packed-build") ? "packed" : options.sdkMode;
    let packed = context.packed;
    if (commandMode === "packed" && !packed) {
      packed = await preparePackedSdk(context.supervisor, path.join(runRoot, "tooling/packed-sdk"));
      context.packed = packed;
    }
    const playwrightReport = group.gates.some((gate) => ["browser", "accessibility", "console", "responsive"].includes(gate))
      ? path.join(runRoot, "artifacts/playwright.json")
      : undefined;
    const screenshotReport = group.gates.includes("screenshot")
      ? path.join(runRoot, "artifacts/screenshot-gate.json")
      : undefined;
    const performanceReport = group.gates.includes("performance")
      ? path.join(runRoot, "artifacts/performance-gate.json")
      : undefined;
    for (const expectedReport of [playwrightReport, screenshotReport, performanceReport]) {
      if (expectedReport) await rm(expectedReport, { force: true });
    }
    const result = await context.supervisor.run(group.command, {
      env: sdkEnvironment(commandMode, packed, {
        ...(playwrightReport ? { PLAYWRIGHT_JSON_OUTPUT_NAME: playwrightReport } : {}),
        ...(playwrightReport ? { HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR: path.join(runRoot, "artifacts/playwright-output") } : {}),
        ...(screenshotReport ? { HONUA_SAMPLE_SCREENSHOT_OUTPUT: screenshotReport } : {}),
        ...(performanceReport ? { HONUA_SAMPLE_PERFORMANCE_OUTPUT: performanceReport } : {}),
      }),
      allowedEnvironmentNames: group.gates.includes("live") ? allowedLiveEnvironment(context.catalogSample) : [],
      echoOutput: containsLiveGate ? false : undefined,
      captureOutput: containsLiveGate ? false : undefined,
      artifactPath: containsLiveGate ? undefined : path.join(runRoot, "logs", `${commandDigest(group.command)}.log`),
    });
    for (const gate of group.gates) {
      const receiptPath = path.join(receiptRoot, `${gate}.v1.json`);
      const artifact = await writeGateReport({
        sample,
        catalogSample: context.catalogSample,
        gate,
        revision,
        command: group.command,
        result,
        runRoot,
        packed,
      });
      const receipt = await createGateReceipt({
        sampleId: sample.id,
        gate,
        sdkMode: commandMode,
        sourceRevision: revision,
        command: group.command,
        durationMs: result.durationMs,
        artifacts: [artifact],
        receiptPath: path.relative(PROJECT_ROOT, receiptPath).replaceAll(path.sep, "/"),
        projectRoot: PROJECT_ROOT,
        sourceSnapshot,
      });
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      process.stdout.write(`sample gate receipt: ${path.relative(PROJECT_ROOT, receiptPath)}\n`);
    }
  }
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
