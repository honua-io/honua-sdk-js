#!/usr/bin/env node

// Scheduled registry smoke for the generated gallery playgrounds (#958).
//
// A playground link is a promise that a stranger can open the project and get a
// map. PR CI cannot keep that promise honest: it is offline, and it resolves
// `@honua/sdk-js` from this repository's own tree, so a playground whose pinned
// published package no longer installs, builds or runs would still pass every
// required gate. This lane installs the generated project from the *real*
// registry, builds it, serves the production build, and drives it in Chromium
// until the sample's own readiness contract is satisfied — with zero console
// errors and zero off-origin requests, because the fixture lane must stay
// account-free and key-free.
//
// The install step reaches the npm registry, so the lane is explicitly gated:
// without HONUA_PLAYGROUND_LIVE_ENABLED=true it records a skip instead of
// pretending to have run.
//
// Run with:
//   HONUA_PLAYGROUND_LIVE_ENABLED=true npm run samples:playgrounds:smoke
//   HONUA_PLAYGROUND_LIVE_ENABLED=true npm run samples:playgrounds:smoke -- --playground react-quickstart

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  PLAYGROUND_SMOKE_EVIDENCE_FORMAT,
  PLAYGROUND_SMOKE_JOURNEYS,
  PLAYGROUND_SMOKE_STAGES,
  expectedFeatures,
  featuresSatisfied,
  liveLaneEnabled,
  parseArgs,
  planPlaygroundSmoke,
  validatePlaygroundSmokeEvidence,
} from "./lib/sample-playground-smoke.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_PATH = "samples/dist/sample-playgrounds.v1.json";
const SERVER_READY_TIMEOUT_MS = 60_000;
const BROWSER_TIMEOUT_MS = 45_000;

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

function repositoryRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? "unknown";
  }
}

function writeEvidence(outputPath, evidence) {
  validatePlaygroundSmokeEvidence(evidence);
  const target = path.resolve(ROOT, outputPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`samplePlaygroundSmoke=${evidence.status} evidence=${path.relative(ROOT, target)}\n`);
}

function runCommand(command, argumentList, cwd) {
  execFileSync(command, argumentList, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } });
}

const ANSI_ESCAPE = String.fromCharCode(27);

/** Drop SGR colour sequences so a colourized server URL still parses. */
function stripAnsi(value) {
  return value
    .split(ANSI_ESCAPE)
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;]*m/, "")))
    .join("");
}

/**
 * Copy the committed playground into a scratch workspace.
 *
 * `playgrounds/` is generator output and nothing else: installing into it would
 * leave node_modules beside files that `samples:playgrounds:check` compares
 * byte for byte. Any local build output is dropped for the same reason.
 */
function stageProject(projectPath, destination) {
  fs.cpSync(path.join(ROOT, projectPath), destination, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return name !== "node_modules" && name !== "dist";
    },
  });
}

async function startPreview(projectDirectory) {
  // Detached so the whole process group can be torn down: killing the npm
  // wrapper alone would leave the Vite server holding its port.
  const child = spawn("npm", ["run", "preview", "--", "--host", "127.0.0.1"], {
    cwd: projectDirectory,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The preview server did not report a URL in time.")), SERVER_READY_TIMEOUT_MS);
    let buffered = "";
    const inspect = (chunk) => {
      // Vite colorizes the port, so strip ANSI escapes before reading the URL.
      buffered += stripAnsi(String(chunk));
      const match = buffered.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?/);
      if (!match) return;
      clearTimeout(timer);
      resolve(`http://127.0.0.1:${match[1]}/`);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The preview server exited early with code ${code}.`));
    });
  });
  return {
    url,
    close: () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    },
  };
}

/**
 * Drive the served build until the sample's own readiness contract holds.
 *
 * Console errors, page errors and off-origin requests are collected from the
 * first navigation, so a request the page made before the map settled still
 * counts against it.
 */
async function probePlayground(url, journey, expectation) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const consoleErrors = [];
  const externalRequests = [];
  try {
    const page = await browser.newPage();
    const origin = new URL(url).origin;
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    // `blob:` and `data:` requests are created by the page itself (MapLibre's
    // worker), so only a real off-origin fetch counts against the fixture lane.
    // Origins are parsed and compared, never prefix-matched: a prefix test
    // would accept a look-alike host that merely starts with the same text.
    const sameOrigin = (value) => {
      if (value.startsWith("data:")) return true;
      try {
        return new URL(value).origin === origin;
      } catch {
        return false;
      }
    };
    page.on("request", (request) => {
      if (!sameOrigin(request.url())) externalRequests.push(request.url());
    });
    await page.goto(url, { waitUntil: "load", timeout: BROWSER_TIMEOUT_MS });
    if (journey.canvasSelector) await page.waitForSelector(journey.canvasSelector, { timeout: BROWSER_TIMEOUT_MS });
    await page.waitForFunction(
      (probe) => Reflect.get(globalThis, probe.state)?.[probe.field] === true,
      { state: journey.state, field: journey.readyField },
      { timeout: BROWSER_TIMEOUT_MS },
    );
    if (journey.features) {
      await page.waitForFunction(
        (probe) => Number(Reflect.get(globalThis, probe.state)?.[probe.field] ?? 0) >= probe.atLeast,
        { state: journey.state, field: journey.features.field, atLeast: expectation.count },
        { timeout: BROWSER_TIMEOUT_MS },
      );
    }
    const renderedFeatureCount = journey.features
      ? await page.evaluate(
          (probe) => Number(Reflect.get(globalThis, probe.state)?.[probe.field] ?? 0),
          { state: journey.state, field: journey.features.field },
        )
      : 0;
    return {
      booted: true,
      mapMounted: journey.canvasSelector !== undefined,
      renderedFeatureCount,
      expectedFeatureCount: expectation.count,
      featureExpectation: expectation.expectation,
      consoleErrors,
      externalRequests,
    };
  } finally {
    await browser.close();
  }
}

/** Install, build, serve and drive one playground. Never throws: it records. */
async function smokePlayground(record, workspace, journey) {
  const projectDirectory = path.join(workspace, record.sampleId);
  // The reviewed pack is read from the published record, not from a second
  // table: the document this lane counts is the one the artifact says the
  // generated origin serves.
  const fixtureDocument = journey.features?.fixtureDocument;
  if (fixtureDocument !== undefined && record.dataOrigin.kind !== "generated-fixture-service") {
    throw new Error(`${record.sampleId} expects a reviewed fixture document but publishes no generated fixture origin`);
  }
  const expectation = expectedFeatures(
    journey,
    fixtureDocument ? readJson(`${record.dataOrigin.fixturePack}/${fixtureDocument}`) : undefined,
  );
  const stages = [];
  let stageStartedAt = performance.now();
  const finishStage = (name) => {
    const now = performance.now();
    stages.push({ name, elapsedMs: Math.round(now - stageStartedAt) });
    stageStartedAt = now;
  };
  const base = { sampleId: record.sampleId, projectPath: record.projectPath, dataOrigin: record.dataOrigin.kind };
  let preview;
  try {
    stageProject(record.projectPath, projectDirectory);
    runCommand("npm", ["install", "--no-audit", "--no-fund"], projectDirectory);
    finishStage("install");
    runCommand("npm", ["run", "build"], projectDirectory);
    finishStage("build");
    preview = await startPreview(projectDirectory);
    finishStage("serve");
    const journeyResult = await probePlayground(preview.url, journey, expectation);
    finishStage("map");
    const clean = journeyResult.consoleErrors.length === 0 && journeyResult.externalRequests.length === 0;
    const rendered = featuresSatisfied(expectation, journeyResult.renderedFeatureCount);
    return {
      ...base,
      status: clean && rendered ? "passed" : "failed",
      stages,
      journey: journeyResult,
      ...(clean && rendered
        ? {}
        : {
            failure: {
              message: rendered
                ? "The playground reported console errors or off-origin requests."
                : `The playground rendered ${journeyResult.renderedFeatureCount} features, expected ${expectation.expectation} ${expectation.count}.`,
            },
          }),
    };
  } catch (error) {
    for (const name of PLAYGROUND_SMOKE_STAGES) {
      if (!stages.some((stage) => stage.name === name)) stages.push({ name, elapsedMs: 0 });
    }
    return {
      ...base,
      status: "failed",
      stages,
      journey: {
        booted: false,
        mapMounted: false,
        renderedFeatureCount: 0,
        expectedFeatureCount: expectation.count,
        featureExpectation: expectation.expectation,
        consoleErrors: [],
        externalRequests: [],
      },
      failure: { message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    preview?.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifact = readJson(ARTIFACT_PATH);
  const records = new Map(artifact.playgrounds.map((entry) => [entry.sampleId, entry]));
  // Fails loudly when a published playground has no decision, so a newly
  // qualifying sample cannot join the gallery without one.
  const selected = planPlaygroundSmoke([...records.keys()], options.playground);
  const environment = {
    node: process.version,
    revision: repositoryRevision(),
    sdkPackage: artifact.sdk.package,
    sdkVersion: artifact.sdk.version,
  };

  if (!liveLaneEnabled(process.env)) {
    writeEvidence(options.output, {
      format: PLAYGROUND_SMOKE_EVIDENCE_FORMAT,
      status: "skipped",
      skip: { reason: "HONUA_PLAYGROUND_LIVE_ENABLED is not set; the registry install lane stayed disabled." },
      environment,
    });
    return;
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "honua-playground-smoke-"));
  try {
    const runs = [];
    for (const sampleId of selected) {
      runs.push(await smokePlayground(records.get(sampleId), workspace, PLAYGROUND_SMOKE_JOURNEYS.get(sampleId)));
    }
    const passed = runs.every((run) => run.status === "passed");
    writeEvidence(options.output, {
      format: PLAYGROUND_SMOKE_EVIDENCE_FORMAT,
      status: passed ? "passed" : "failed",
      environment,
      runs,
    });
    if (!passed) process.exitCode = 1;
  } finally {
    if (!options.keepWorkspace) fs.rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
