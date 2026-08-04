#!/usr/bin/env node

/**
 * Deep (post-codemod build) validation for the third-party OSS ArcGIS corpus
 * — issue #955's second acceptance criterion.
 *
 * The standard lane (`scripts/oss-arcgis-corpus.mjs`) is static analysis only
 * and never installs a cloned app's dependencies. This runner does install
 * them, so it is a separate script behind a second opt-in switch and an
 * explicit per-app allowlist. It is never wired into PR CI.
 *
 * For each allowlisted app it measures the same commit twice with the same
 * installed dependency tree:
 *
 *   baseline  clone the pin -> npm ci --ignore-scripts -> typecheck -> build
 *   migrated  codemod --write -> install packed Honua packages -> typecheck -> build
 *
 * and reports the delta. A third-party app's pre-existing diagnostics show up
 * in both phases and cancel; what is left is what the migration introduced.
 *
 * Supply-chain posture (mirrored in the manifest's deepValidation.supplyChain,
 * which the guardrail check enforces):
 *   - every install passes --ignore-scripts, so no third-party lifecycle
 *     script ever executes;
 *   - only apps with a committed lockfile are eligible, and `npm ci` uses it
 *     verbatim — the app's package.json and lockfile are never rewritten;
 *   - Honua packages are added with --no-save from locally packed
 *     dist/packages tarballs, never from a registry;
 *   - the whole checkout, including node_modules, is deleted when the run ends.
 *
 * Usage:
 *   HONUA_OSS_ARCGIS_CORPUS_ENABLED=true HONUA_OSS_ARCGIS_CORPUS_DEEP=true \
 *     node scripts/oss-arcgis-corpus-deep.mjs
 *   ... --apps <id,id>   only validate these allowlisted apps
 *   ... --publish        write the committed observation the docs page uses
 *   ... --keep-clones    leave the installed checkout in place for inspection
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runNpmSync } from "./lib/npm-cli.mjs";

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(ROOT, "config", "oss-arcgis-corpus.v1.json");
const CLI = path.join(ROOT, "dist", "src", "migration", "cli.js");
const CORPUS_MODULE = path.join(ROOT, "dist", "src", "migration", "oss-corpus.js");
const DEEP_MODULE = path.join(ROOT, "dist", "src", "migration", "oss-corpus-deep.js");
const OUTPUT_TAIL_LINES = 12;
const STEP_TIMEOUT_MS = 20 * 60 * 1000;

function parseArgs(argv) {
  const options = { appIds: undefined, publish: false, keepClones: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apps") {
      options.appIds = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (token === "--publish") options.publish = true;
    else if (token === "--keep-clones") options.keepClones = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

function relative(target) {
  return path.relative(ROOT, target) || ".";
}

function tail(text) {
  return (text ?? "").split(/\r?\n/).filter(Boolean).slice(-OUTPUT_TAIL_LINES).join("\n");
}

function step(command, run) {
  const startedAt = Date.now();
  const result = run();
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    record: {
      command,
      status: result.status === 0 ? "passed" : "failed",
      exitCode: result.status,
      durationMs: Date.now() - startedAt,
      outputTail: tail(combined),
    },
    stdout: result.stdout ?? "",
    combined,
  };
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

function checkoutPinnedCommit(app, checkoutDir) {
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  fs.mkdirSync(checkoutDir, { recursive: true });
  git(["init", "--quiet"], checkoutDir);
  git(["remote", "add", "origin", app.repo.url], checkoutDir);
  const shallow = spawnSync("git", ["fetch", "--quiet", "--depth", "1", "origin", app.repo.commit], {
    cwd: checkoutDir,
    encoding: "utf8",
  });
  if (shallow.status === 0) {
    git(["checkout", "--quiet", "FETCH_HEAD"], checkoutDir);
  } else {
    git(["fetch", "--quiet", "origin"], checkoutDir);
    git(["checkout", "--quiet", app.repo.commit], checkoutDir);
  }
  const head = git(["rev-parse", "HEAD"], checkoutDir);
  if (head !== app.repo.commit) {
    throw new Error(`checkout SHA ${head} does not match the pinned commit ${app.repo.commit}`);
  }
}

/**
 * Pack the split packages the migrated app installs. Packing (rather than
 * pointing npm at the directory) is what makes the installed bytes the same
 * bytes a consumer would get from the registry tarball.
 */
function packHonuaPackages(deep, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const tarballs = [];
  for (const packageDir of deep.honuaPackageDirs) {
    const absolute = path.resolve(ROOT, packageDir);
    if (!fs.existsSync(path.join(absolute, "package.json"))) {
      throw new Error(`missing ${relative(absolute)} — run "npm run build:split-packages" first.`);
    }
    const result = runNpmSync(["pack", absolute, "--pack-destination", workDir, "--silent"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`npm pack ${relative(absolute)} failed: ${(result.stderr ?? "").trim()}`);
    }
    const name = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).pop();
    if (!name) {
      throw new Error(`npm pack ${relative(absolute)} produced no tarball name`);
    }
    tarballs.push(path.join(workDir, name));
  }
  return tarballs;
}

function honuaVersion(deep) {
  const first = path.resolve(ROOT, deep.honuaPackageDirs[0]);
  return JSON.parse(fs.readFileSync(path.join(first, "package.json"), "utf8")).version;
}

/**
 * Write the typecheck probe. The corpus apps do not all ship a TypeScript
 * config (and the ones that do pin their own toolchain), so the probe is a
 * fixed, generated config: `allowJs` + `checkJs` so plain JavaScript is still
 * type-checked, `strict: false` so the baseline is not drowned in the app's
 * own untyped code, and `skipLibCheck` so third-party declaration files are
 * not the thing under test. It is identical across both phases, which is what
 * makes the diff meaningful.
 */
function writeTypecheckProbe(packageRoot, deepApp) {
  const probePath = path.join(packageRoot, "tsconfig.honua-deep-probe.json");
  const compilerOptions = {
    noEmit: true,
    allowJs: true,
    checkJs: true,
    module: "esnext",
    moduleResolution: "bundler",
    target: "es2022",
    lib: ["DOM", "DOM.Iterable", "ES2022"],
    strict: false,
    skipLibCheck: true,
    resolveJsonModule: true,
    types: [],
  };
  if (deepApp.typecheckJsx !== "none") {
    compilerOptions.jsx = deepApp.typecheckJsx;
  }
  fs.writeFileSync(
    probePath,
    `${JSON.stringify({ compilerOptions, include: deepApp.typecheckInclude }, null, 2)}\n`,
    "utf8",
  );
  return probePath;
}

function runPhase(deepModule, packageRoot, deepApp, probePath, tscBin) {
  // The probe deliberately runs *Honua's* pinned TypeScript, resolved by
  // absolute path, rather than whatever the app pins (many corpus apps pin
  // none at all). It is Honua's instrument, and it must be the identical
  // binary in both phases for the diagnostic diff to mean anything — relying
  // on `npx` to walk up into this repository's node_modules would be the same
  // thing by accident, and would silently change if a checkout moved.
  const typecheck = step(`node <honua tsc> --noEmit -p ${path.basename(probePath)}`, () =>
    spawnSync(process.execPath, [tscBin, "--noEmit", "-p", probePath], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const build = step(`npm run ${deepApp.buildScript}`, () =>
    runNpmSync(["run", deepApp.buildScript], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: STEP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  return {
    typecheck: typecheck.record,
    build: build.record,
    diagnostics: deepModule.normalizeTypecheckDiagnostics(typecheck.combined),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  for (const modulePath of [CORPUS_MODULE, DEEP_MODULE, CLI]) {
    if (!fs.existsSync(modulePath)) {
      throw new Error(`missing ${relative(modulePath)} — run "npm run build" first.`);
    }
  }
  const corpus = await import(pathToFileURL(CORPUS_MODULE).href);
  const deepModule = await import(pathToFileURL(DEEP_MODULE).href);
  const manifest = corpus.loadOssArcGisCorpusManifest(DEFAULT_MANIFEST);
  const guardrails = corpus.summarizeOssArcGisCorpus(manifest);
  if (guardrails.guardrailFailures.length > 0) {
    for (const failure of guardrails.guardrailFailures) {
      process.stderr.write(`corpusGuardrailFailure: ${failure}\n`);
    }
    process.exitCode = 2;
    return;
  }

  const deep = manifest.deepValidation;
  // Two switches, both required: the corpus-wide opt-in, and deep validation's
  // own. Installing a stranger's dependency tree is never a default.
  if (process.env[manifest.lane.optInEnvVar] !== "true" || process.env[deep.optInEnvVar] !== "true") {
    process.stdout.write(
      `ossArcGisCorpusDeep=skipped reason=opt-in-required set ${manifest.lane.optInEnvVar}=true and ${deep.optInEnvVar}=true to run (apps=${deep.apps.length})\n`,
    );
    return;
  }

  const selected = options.appIds ? deep.apps.filter((app) => options.appIds.includes(app.id)) : deep.apps;
  if (selected.length === 0) {
    throw new Error("no allowlisted apps selected");
  }

  const outDir = path.resolve(ROOT, deep.reportRoot);
  const checkoutRoot = path.resolve(ROOT, deep.checkoutRoot);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(checkoutRoot, { recursive: true });

  const tarballs = packHonuaPackages(deep, path.join(checkoutRoot, "_packages"));
  const version = honuaVersion(deep);
  const tscBin = require.resolve("typescript/bin/tsc");
  const typescriptVersion = require("typescript/package.json").version;
  const observedAt = new Date().toISOString().slice(0, 10);
  const results = [];

  for (const deepApp of selected) {
    const app = manifest.apps.find((candidate) => candidate.id === deepApp.id);
    const appOutDir = path.join(outDir, "apps", deepApp.id);
    fs.mkdirSync(appOutDir, { recursive: true });
    const checkoutDir = path.join(checkoutRoot, deepApp.id);
    let record;

    const skipped = { command: "", status: "skipped", exitCode: null, durationMs: 0, outputTail: "" };
    let install = { ...skipped };
    let honuaInstall = { ...skipped };
    let baseline;
    let migrated;
    let codemod;

    try {
      checkoutPinnedCommit(app, checkoutDir);
      const packageRoot = path.resolve(checkoutDir, deepApp.packageDir);
      if (!packageRoot.startsWith(path.resolve(checkoutDir))) {
        throw new Error(`packageDir ${deepApp.packageDir} escapes the checkout`);
      }
      const lockfilePath = path.resolve(checkoutDir, deepApp.lockfile);
      if (!fs.existsSync(lockfilePath)) {
        throw new Error(`no committed lockfile at ${deepApp.lockfile}; deep validation requires one`);
      }
      // Some repositories commit node_modules. Deep validation must measure a
      // tree resolved from the lockfile, not whatever bytes were checked in.
      fs.rmSync(path.join(packageRoot, "node_modules"), { recursive: true, force: true });

      const installStep = step("npm ci --ignore-scripts --no-audit --no-fund", () =>
        runNpmSync(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
          cwd: packageRoot,
          encoding: "utf8",
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
      install = installStep.record;
      if (install.status !== "passed") {
        throw new Error(`npm ci failed for ${deepApp.id}: ${install.outputTail}`);
      }

      const probePath = writeTypecheckProbe(packageRoot, deepApp);
      baseline = runPhase(deepModule, packageRoot, deepApp, probePath, tscBin);

      const codemodReportPath = path.join(appOutDir, "codemod.json");
      const scanTarget = path.resolve(checkoutDir, app.scanRoot);
      const codemodResult = spawnSync(
        "node",
        [
          CLI,
          "codemod",
          scanTarget,
          "--target",
          manifest.lane.codemodTarget,
          "--write",
          "--annotate-todos",
          "--report",
          codemodReportPath,
        ],
        { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      );
      if (codemodResult.status !== 0 && codemodResult.status !== 2) {
        throw new Error(`codemod exited with status ${codemodResult.status}`);
      }
      const codemodReport = JSON.parse(fs.readFileSync(codemodReportPath, "utf8"));
      codemod = {
        totalCallSites: codemodReport.codemodResult.metrics.totalCodemodScopedCallSites,
        autoMigratedCallSites: codemodReport.codemodResult.metrics.autoMigratedCallSites,
        manualCallSites: codemodReport.codemodResult.metrics.manualCallSites,
        filesChanged: codemodReport.codemodResult.filesChanged,
        compatImportPath: "@honua/sdk-esri-compat",
      };

      const honuaStep = step("npm install --ignore-scripts --no-save <packed honua tarballs>", () =>
        runNpmSync(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", ...tarballs], {
          cwd: packageRoot,
          encoding: "utf8",
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
      honuaInstall = honuaStep.record;
      if (honuaInstall.status !== "passed") {
        throw new Error(`installing the packed Honua packages failed: ${honuaInstall.outputTail}`);
      }

      migrated = runPhase(deepModule, packageRoot, deepApp, probePath, tscBin);

      record = deepModule.buildOssArcGisDeepAppResult({
        app,
        deepApp,
        observedAt,
        install,
        honuaInstall,
        codemod,
        baseline,
        migrated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = deepModule.buildOssArcGisDeepAppResult({
        app,
        deepApp,
        observedAt,
        install,
        honuaInstall,
        codemod,
        baseline,
        migrated,
        error: message,
      });
    } finally {
      if (!options.keepClones) {
        fs.rmSync(checkoutDir, { recursive: true, force: true });
      }
    }

    fs.writeFileSync(path.join(appOutDir, "deep.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    results.push(record);
    process.stdout.write(
      [
        `app=${record.appId}`,
        `outcome=${record.outcome}`,
        `baselineBuild=${record.baseline?.build.status ?? "n/a"}`,
        `migratedBuild=${record.migrated?.build.status ?? "n/a"}`,
        `introducedDiagnostics=${record.introducedDiagnostics.length}`,
        `resolvedDiagnostics=${record.resolvedDiagnostics.length}`,
      ].join(" "),
    );
    process.stdout.write("\n");
  }

  const runRecord = deepModule.buildOssArcGisDeepRun({
    manifest,
    apps: results,
    generatedAt: new Date().toISOString(),
    honuaVersion: version,
    typescriptVersion,
  });
  const runPath = path.join(outDir, "deep-build.v1.json");
  fs.writeFileSync(runPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
  process.stdout.write(
    [
      "ossArcGisCorpusDeep=complete",
      `apps=${runRecord.summary.appCount}`,
      `buildsPostCodemod=${runRecord.summary.buildsPostCodemod}`,
      `buildRegressions=${runRecord.summary.buildRegressions}`,
      `errored=${runRecord.summary.errored}`,
      `introducedDiagnostics=${runRecord.summary.introducedDiagnosticCount}`,
      `report=${relative(runPath)}`,
    ].join(" "),
  );
  process.stdout.write("\n");

  if (!options.keepClones) {
    fs.rmSync(path.join(checkoutRoot, "_packages"), { recursive: true, force: true });
  }

  if (options.publish) {
    if (options.appIds) {
      throw new Error("--publish requires a full deep run (drop --apps)");
    }
    const publishedPath = path.resolve(ROOT, deep.publishedObservationPath);
    fs.mkdirSync(path.dirname(publishedPath), { recursive: true });
    fs.writeFileSync(publishedPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
    process.stdout.write(`published=${relative(publishedPath)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`ossArcGisCorpusDeepError: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
