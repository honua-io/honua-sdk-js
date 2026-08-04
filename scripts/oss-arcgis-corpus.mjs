#!/usr/bin/env node

/**
 * Opt-in third-party OSS ArcGIS app corpus lane (issue #955, REQ-002).
 *
 * For every app pinned in `config/oss-arcgis-corpus.v1.json` this lane:
 *
 *   1. clones the repository at its pinned commit into an ignored scratch
 *      directory (`.tmp/oss-arcgis-corpus/<id>` by default) and verifies the
 *      checked-out SHA matches the pin;
 *   2. runs the real migration CLI — `scan`, `widgets --gate`, `codemod` —
 *      against the checkout, capturing each command's `--report` JSON;
 *   3. projects the codemod's `JsMigrationReport` (the existing report schema)
 *      onto a per-app readiness record and writes an aggregate run file.
 *
 * The lane is opt-in only. It refuses to do any work unless the manifest's
 * opt-in env var is set to "true", so it can never run as part of PR CI. It
 * performs static analysis only: it clones from GitHub and never contacts an
 * Esri service, and it never installs a cloned app's dependencies.
 *
 * Usage:
 *   HONUA_OSS_ARCGIS_CORPUS_ENABLED=true node scripts/oss-arcgis-corpus.mjs
 *   ... --apps <id,id>          only observe these apps
 *   ... --out <dir>             report root (default: manifest lane.reportRoot)
 *   ... --publish               also write the committed observation the docs
 *                               page is generated from
 *   ... --fail-on-regression    fail when an app's auto-migrated ratio drops
 *                               below the published observation
 *   ... --keep-clones           leave checkouts in place for inspection
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MANIFEST = path.join(ROOT, "config", "oss-arcgis-corpus.v1.json");
const CLI = path.join(ROOT, "dist", "src", "migration", "cli.js");
const CORPUS_MODULE = path.join(ROOT, "dist", "src", "migration", "oss-corpus.js");

function parseArgs(argv) {
  const options = {
    manifestPath: DEFAULT_MANIFEST,
    outDir: undefined,
    checkoutRoot: undefined,
    appIds: undefined,
    publish: false,
    failOnRegression: false,
    keepClones: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--manifest") options.manifestPath = path.resolve(ROOT, argv[++index]);
    else if (token === "--out") options.outDir = path.resolve(ROOT, argv[++index]);
    else if (token === "--checkout-root") options.checkoutRoot = path.resolve(ROOT, argv[++index]);
    else if (token === "--apps") options.appIds = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    else if (token === "--publish") options.publish = true;
    else if (token === "--fail-on-regression") options.failOnRegression = true;
    else if (token === "--keep-clones") options.keepClones = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return options;
}

function run(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function git(args, cwd) {
  const result = run("git", args, cwd);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Fetch exactly the pinned commit. GitHub serves arbitrary SHAs to
 * `git fetch`, so a depth-1 fetch of the pin avoids cloning history we do not
 * need; a full clone is the fallback for servers that refuse SHA fetches.
 */
function checkoutPinnedCommit(app, checkoutDir) {
  fs.rmSync(checkoutDir, { recursive: true, force: true });
  fs.mkdirSync(checkoutDir, { recursive: true });
  git(["init", "--quiet"], checkoutDir);
  git(["remote", "add", "origin", app.repo.url], checkoutDir);

  const shallow = run("git", ["fetch", "--quiet", "--depth", "1", "origin", app.repo.commit], checkoutDir);
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
  return head;
}

function runCli(args, logLines) {
  const result = run("node", [CLI, ...args], ROOT);
  logLines.push(`$ node dist/src/migration/cli.js ${args.join(" ")}`);
  logLines.push(`exit=${result.status}`);
  // The CLI streams the full report JSON to stdout; the structured copy comes
  // from --report, so only the leading human-readable lines are worth keeping.
  const stdout = (result.stdout ?? "").split("\n").slice(0, 40).join("\n");
  logLines.push(stdout);
  if (result.stderr) logLines.push(`stderr: ${result.stderr.trim()}`);
  logLines.push("");
  return result;
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(CORPUS_MODULE)) {
    throw new Error(`missing ${path.relative(ROOT, CORPUS_MODULE)} — run "npm run build" first.`);
  }
  const corpus = await import(pathToFileURL(CORPUS_MODULE).href);
  const manifest = corpus.loadOssArcGisCorpusManifest(options.manifestPath);
  const manifestSummary = corpus.summarizeOssArcGisCorpus(manifest);
  if (manifestSummary.guardrailFailures.length > 0) {
    for (const failure of manifestSummary.guardrailFailures) {
      process.stderr.write(`corpusGuardrailFailure: ${failure}\n`);
    }
    process.exitCode = 2;
    return;
  }

  const optInEnvVar = manifest.lane.optInEnvVar;
  if (process.env[optInEnvVar] !== "true") {
    process.stdout.write(
      `ossArcGisCorpus=skipped reason=opt-in-required set ${optInEnvVar}=true to run (apps=${manifest.apps.length})\n`,
    );
    return;
  }

  const outDir = options.outDir ?? path.resolve(ROOT, manifest.lane.reportRoot);
  const checkoutRoot = options.checkoutRoot ?? path.resolve(ROOT, manifest.lane.checkoutRoot);
  const apps = options.appIds
    ? manifest.apps.filter((app) => options.appIds.includes(app.id))
    : manifest.apps;
  if (apps.length === 0) {
    throw new Error("no apps selected");
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(checkoutRoot, { recursive: true });

  const observedAt = isoDate(new Date());
  const readinessRecords = [];

  for (const app of apps) {
    const appOutDir = path.join(outDir, "apps", app.id);
    fs.mkdirSync(appOutDir, { recursive: true });
    const checkoutDir = path.join(checkoutRoot, app.id);
    const logLines = [`# ${app.id} @ ${app.repo.commit}`, ""];
    let record;

    try {
      checkoutPinnedCommit(app, checkoutDir);
      const scanTarget = path.resolve(checkoutDir, app.scanRoot);
      if (!scanTarget.startsWith(path.resolve(checkoutDir))) {
        throw new Error(`scanRoot ${app.scanRoot} escapes the checkout`);
      }
      if (!fs.existsSync(scanTarget)) {
        throw new Error(`scanRoot ${app.scanRoot} does not exist at the pinned commit`);
      }

      const scanReportPath = path.join(appOutDir, "scan.json");
      const widgetReportPath = path.join(appOutDir, "widgets.json");
      const codemodReportPath = path.join(appOutDir, "codemod.json");

      runCli(["scan", scanTarget, "--report", scanReportPath], logLines);
      runCli(
        ["widgets", scanTarget, "--gate", String(manifest.lane.widgetGatePct), "--report", widgetReportPath],
        logLines,
      );
      // --write is safe: the checkout is a disposable clone in an ignored
      // scratch directory and is never committed anywhere.
      const codemod = runCli(
        [
          "codemod",
          scanTarget,
          "--target",
          manifest.lane.codemodTarget,
          "--write",
          "--annotate-todos",
          "--report",
          codemodReportPath,
        ],
        logLines,
      );
      if (codemod.status !== 0 && codemod.status !== 2) {
        throw new Error(`codemod exited with status ${codemod.status}`);
      }

      const report = readJsonIfPresent(codemodReportPath);
      if (!report) {
        throw new Error("codemod did not emit a report");
      }
      record = corpus.buildOssArcGisAppReadiness({
        app,
        observedAt,
        codemodTarget: manifest.lane.codemodTarget,
        report,
        widgetReport: readJsonIfPresent(widgetReportPath),
        widgetGatePct: manifest.lane.widgetGatePct,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logLines.push(`error: ${message}`);
      record = corpus.buildOssArcGisAppReadiness({
        app,
        observedAt,
        codemodTarget: manifest.lane.codemodTarget,
        error: message,
      });
    } finally {
      if (!options.keepClones) {
        fs.rmSync(checkoutDir, { recursive: true, force: true });
      }
    }

    fs.writeFileSync(path.join(appOutDir, "cli.log"), `${logLines.join("\n")}\n`, "utf8");
    fs.writeFileSync(path.join(appOutDir, "readiness.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
    readinessRecords.push(record);
    process.stdout.write(
      [
        `app=${record.appId}`,
        `status=${record.status}`,
        `readiness=${record.readiness}`,
        `autoMigrated=${record.autoMigratedCallSites}/${record.totalCallSites}`,
        `manual=${record.manualCallSites}`,
        `unhandled=${record.unhandledUsageHits}`,
      ].join(" "),
    );
    process.stdout.write("\n");
  }

  const runRecord = corpus.buildOssArcGisCorpusRun({
    manifest,
    apps: readinessRecords,
    generatedAt: new Date().toISOString(),
  });
  const runPath = path.join(outDir, "readiness.v1.json");
  fs.writeFileSync(runPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
  process.stdout.write(
    [
      "ossArcGisCorpus=complete",
      `apps=${runRecord.summary.appCount}`,
      `observed=${runRecord.summary.observed}`,
      `errored=${runRecord.summary.errored}`,
      `ready=${runRecord.summary.ready}`,
      `assisted=${runRecord.summary.assisted}`,
      `blocked=${runRecord.summary.blocked}`,
      `autoMigratedRatio=${runRecord.summary.autoMigratedRatio.toFixed(3)}`,
      `report=${path.relative(ROOT, runPath)}`,
    ].join(" "),
  );
  process.stdout.write("\n");

  const publishedPath = path.resolve(ROOT, manifest.lane.publishedObservationPath);
  if (options.failOnRegression) {
    const baseline = readJsonIfPresent(publishedPath);
    if (!baseline) {
      process.stderr.write(`regressionGate=skipped reason=no-published-observation path=${publishedPath}\n`);
    } else {
      const regression = corpus.evaluateOssArcGisCorpusRegression(baseline, runRecord);
      process.stdout.write(`regressionGate=${regression.passed ? "pass" : "fail"}\n`);
      for (const failure of regression.failures) {
        process.stdout.write(`- ${failure}\n`);
      }
      if (!regression.passed) {
        process.exitCode = 2;
        return;
      }
    }
  }

  if (options.publish) {
    if (options.appIds) {
      throw new Error("--publish requires a full corpus run (drop --apps)");
    }
    fs.mkdirSync(path.dirname(publishedPath), { recursive: true });
    fs.writeFileSync(publishedPath, `${JSON.stringify(runRecord, null, 2)}\n`, "utf8");
    process.stdout.write(`published=${path.relative(ROOT, publishedPath)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`ossArcGisCorpusError: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
