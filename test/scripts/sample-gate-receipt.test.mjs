import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import {
  SAMPLE_SCREENSHOT_REPORT_FORMAT,
  SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY,
} from "../../scripts/lib/sample-gates.mjs";

import {
  captureGateSourceSnapshot,
  createGateReceipt,
  evidenceNeutralSourceDigest,
  readCanonicalBoundedFile,
  requiredReceiptGates,
  validateGateReceipt,
  validateGateReceiptStructure,
  validatePlaywrightGate,
  validateQualificationReceiptSet,
  verifyEvidenceNeutralCheckout,
  verifyGateSourceSnapshot,
} from "../../scripts/sample-gate-receipt.mjs";

const sampleId = "receipt-adversary";
const require = createRequire(import.meta.url);
const playwrightVersion = require("@playwright/test/package.json").version;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const fixtureSourceDigest = "2".repeat(64);
const receiptRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const snapshotRunId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function artifact(name, value, targetSampleId = sampleId) {
  const artifactRoot = path.resolve("samples/evidence", targetSampleId, `runs/${receiptRunId}/artifacts`);
  await mkdir(artifactRoot, { recursive: true });
  const file = path.join(artifactRoot, name);
  await writeFile(
    file,
    Buffer.isBuffer(value) ? value : typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
  );
  if (name.endsWith(".png")) await writeFile(file.replace(/\.png$/u, "-repeat.png"), value);
  return path.relative(process.cwd(), file).replaceAll(path.sep, "/");
}

function receiptOptions(gate, kind, artifactPath, targetSampleId = sampleId) {
  return {
    sampleId: targetSampleId,
    gate,
    sdkMode: "source",
    sourceRevision: revision,
    sourceDigest: fixtureSourceDigest,
    runRoot: `samples/evidence/${targetSampleId}/runs/${receiptRunId}`,
    command: ["npm", "run", "test:playwright:receipt"],
    durationMs: 1,
    artifacts: [{ kind, path: artifactPath }],
    projectRoot: process.cwd(),
    verifyCheckout: false,
  };
}

function fixtureReport(command = ["npm", "run", "test:playwright:receipt"]) {
  return {
    format: "honua.sdk.sample-fixture-gate.v1",
    sampleId,
    sourceRevision: revision,
    command,
    transport: "loopback-http",
    networkScope: "loopback-only",
    host: "127.0.0.1",
    port: 12345,
    ready: true,
    started: true,
    probe: { method: "GET", path: "/", status: 200, bodyBytes: 10, bodySha256: "1".repeat(64) },
    closed: true,
    listeningAfterClose: false,
    activeConnectionsAfterClose: 0,
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function undecodableViewportPng(extraChunks = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280, 0);
  header.writeUInt32BE(720, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    ...extraChunks,
    pngChunk("IDAT", Buffer.from([1, 2, 3])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function screenshotVariant(variant, imagePath, imageBytes, viewport) {
  const repeatPath = imagePath.replace(/\.png$/u, "-repeat.png");
  return {
    variant,
    projectName: "chromium",
    browserName: "chromium",
    path: imagePath,
    bytes: imageBytes.byteLength,
    sha256: digest(imageBytes),
    viewport,
    reproducibility: {
      captureCount: SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.captureCount,
      comparison: SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.comparison,
      repeatPath,
      repeatBytes: imageBytes.byteLength,
      repeatSha256: digest(imageBytes),
    },
  };
}

function screenshotReport(targetSampleId, screenshots) {
  return {
    format: SAMPLE_SCREENSHOT_REPORT_FORMAT,
    sampleId: targetSampleId,
    sourceRevision: revision,
    command: ["npm", "run", "test:playwright:receipt"],
    reproducibilityPolicy: SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY,
    runtime: {
      playwrightVersion,
      projectName: "chromium",
      browserName: "chromium",
      browserVersion: "123.0.0.0",
      platform: "linux",
      architecture: "x64",
    },
    screenshots,
  };
}

function grayscaleViewportPng(width, height, shade) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let row = 0; row < height; row += 1) {
    scanlines.fill(shade, row * (width + 1) + 1, (row + 1) * (width + 1));
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function playwrightGateReport({
  gate: reportGate = "browser",
  retry = 0,
  extraAttachments = [],
  projects = [{ name: "chromium", browserName: "chromium" }],
} = {}) {
  const targetSampleId = "maplibre-quickstart";
  const payload = (gate, project) => ({
    format: "honua.sdk.sample-gate-assertion.v1",
    sampleId: targetSampleId,
    gate,
    status: "passed",
    observations:
      gate === "browser"
        ? { runtimeReady: true, projectName: project.name, browserName: project.browserName }
        : gate === "console"
          ? {
              pageErrors: [],
              consoleErrors: [],
              pageClosed: true,
              contextClosed: true,
              finalizationBoundary: "owned-page-and-context-close",
              finalizedAfterTeardown: true,
            }
        : {},
  });
  return {
    format: "honua.sdk.sample-playwright-gate.v1",
    sampleId: targetSampleId,
    sourceRevision: revision,
    gate: reportGate,
    command: ["npm", "run", "test:playwright:receipt"],
    playwright: {
      config: { rootDir: "test/playwright" },
      suites: [
        {
          file: "quickstart-map.spec.mjs",
          specs: [
            {
              title: "First Map proves the canonical fixture journey in source or packed mode",
              tests: projects.map((project) => {
                const attachments = ["accessibility", "browser", "console", "fixture", "responsive"]
                  .map((gate) => ({
                    name: `honua-gate:${gate}`,
                    contentType: "application/json",
                    body: Buffer.from(JSON.stringify(payload(gate, project))).toString("base64"),
                  }))
                  .concat(extraAttachments);
                return {
                  projectName: project.name,
                  expectedStatus: "passed",
                  results: [{ status: "passed", retry, attachments }],
                };
              }),
            },
          ],
        },
      ],
    },
  };
}

async function validFixtureReceipt() {
  const file = await artifact("valid-fixture.json", fixtureReport());
  return createGateReceipt(receiptOptions("fixture", "fixture-probe-report", file));
}

test.afterEach(async () => {
  await rm(path.resolve("samples/evidence", sampleId, `runs/${receiptRunId}`), { recursive: true, force: true });
  await rm(path.resolve(`samples/evidence/maplibre-quickstart/runs/${receiptRunId}`), {
    recursive: true,
    force: true,
  });
  await rm(path.resolve(`samples/evidence/realtime-incident-dashboard/runs/${receiptRunId}`), {
    recursive: true,
    force: true,
  });
  for (const targetSampleId of [sampleId, "maplibre-quickstart", "realtime-incident-dashboard"]) {
    for (const relative of [`samples/evidence/${targetSampleId}/runs`, `samples/evidence/${targetSampleId}`]) {
      try {
        await rmdir(path.resolve(relative));
      } catch (error) {
        if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
      }
    }
  }
});

test("arbitrary text cannot qualify a fixture gate", async () => {
  const file = await artifact("fixture.json", "plain text");
  await assert.rejects(createGateReceipt(receiptOptions("fixture", "fixture-probe-report", file)), /must be JSON/);
});

test("packed-build receipts require packed SDK mode", async () => {
  const receipt = await validFixtureReceipt();
  receipt.gate = "packed-build";
  receipt.sdkMode = "source";
  receipt.artifacts[0].kind = "packed-build-report";
  assert.throws(() => validateGateReceiptStructure(receipt), /sdkMode/);
});

test("receipt creation rejects run roots that are not lowercase UUIDv4", async () => {
  const file = await artifact("uuid-fixture.json", fixtureReport());
  for (const runId of [
    "receipt-unit-test",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa",
    "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
  ]) {
    await assert.rejects(
      createGateReceipt({
        ...receiptOptions("fixture", "fixture-probe-report", file),
        runRoot: `samples/evidence/${sampleId}/runs/${runId}`,
      }),
      /controlled run root is invalid/,
    );
  }
});

test("metadata-only fixture booleans cannot qualify readiness and isolation", async () => {
  const file = await artifact("metadata-fixture.json", {
    format: "honua.sdk.sample-fixture-gate.v1",
    sampleId,
    sourceRevision: revision,
    command: ["npm", "run", "test:playwright:receipt"],
    transport: "loopback-http",
    started: true,
    closed: true,
  });
  await assert.rejects(
    createGateReceipt(receiptOptions("fixture", "fixture-probe-report", file)),
    /readiness, an isolated probe, and closed resources/,
  );
});

test("metadata-only accessibility JSON cannot qualify", async () => {
  const targetSampleId = "maplibre-quickstart";
  const payload = (gate, observations = {}) => ({
    format: "honua.sdk.sample-gate-assertion.v1",
    sampleId: targetSampleId,
    gate,
    status: "passed",
    observations,
  });
  const attachments = ["accessibility", "browser", "console", "fixture", "responsive"].map((gate) => ({
    name: `honua-gate:${gate}`,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(payload(gate))).toString("base64"),
  }));
  const report = {
    format: "honua.sdk.sample-playwright-gate.v1",
    sampleId: targetSampleId,
    sourceRevision: revision,
    gate: "accessibility",
    command: ["npm", "run", "test:playwright:receipt"],
    playwright: {
      config: { rootDir: "test/playwright" },
      suites: [
        {
          file: "quickstart-map.spec.mjs",
          specs: [
            {
              title: "First Map proves the canonical fixture journey in source or packed mode",
              tests: [
                {
                  projectName: "chromium",
                  expectedStatus: "passed",
                  results: [{ status: "passed", retry: 0, attachments }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
  const file = await artifact("accessibility.json", report, targetSampleId);
  await assert.rejects(
    createGateReceipt(receiptOptions("accessibility", "playwright-gate-report", file, targetSampleId)),
    /passing axe-core audit/,
  );
});

test("Playwright evidence rejects retries and non-contract attachments", async () => {
  const targetSampleId = "maplibre-quickstart";
  const retryReport = await artifact("retry.json", playwrightGateReport({ retry: 1 }), targetSampleId);
  await assert.rejects(
    createGateReceipt(receiptOptions("browser", "playwright-gate-report", retryReport, targetSampleId)),
    /first-attempt passed result/,
  );

  const extraReport = await artifact(
    "extra-attachment.json",
    playwrightGateReport({
      extraAttachments: [{ name: "trace", contentType: "application/zip", body: "" }],
    }),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("browser", "playwright-gate-report", extraReport, targetSampleId)),
    /attachment set is not exact/,
  );
});

test("Playwright evidence binds every declared browser engine without assuming one project", () => {
  const projects = [
    { name: "chromium", browserName: "chromium" },
    { name: "firefox", browserName: "firefox" },
  ];
  const contract = {
    playwrightFile: "test/playwright/quickstart-map.spec.mjs",
    playwrightTestTitle: "First Map proves the canonical fixture journey in source or packed mode",
    playwrightProjects: projects,
    evidenceProject: "chromium",
  };
  const report = playwrightGateReport({ projects }).playwright;

  assert.doesNotThrow(() => validatePlaywrightGate(report, "maplibre-quickstart", "browser", contract));
  const wrongRoot = structuredClone(report);
  wrongRoot.config.rootDir = "test/browser";
  assert.throws(
    () => validatePlaywrightGate(wrongRoot, "maplibre-quickstart", "browser", contract),
    /root directory binding mismatch/,
  );
  const externalRoot = structuredClone(report);
  externalRoot.config.rootDir = path.join(os.tmpdir(), "attacker", "test", "playwright");
  assert.throws(
    () => validatePlaywrightGate(externalRoot, "maplibre-quickstart", "browser", contract),
    /root directory binding mismatch/,
  );
  const wrongFile = structuredClone(report);
  wrongFile.suites[0].file = "service-explorer.spec.mjs";
  assert.throws(
    () => validatePlaywrightGate(wrongFile, "maplibre-quickstart", "browser", contract),
    /file binding mismatch/,
  );
  report.suites[0].specs[0].tests.pop();
  assert.throws(
    () => validatePlaywrightGate(report, "maplibre-quickstart", "browser", contract),
    /one declared test execution per Playwright project/,
  );
});

test("renaming text to PNG cannot qualify a screenshot", async () => {
  const targetSampleId = "maplibre-quickstart";
  const fakeBytes = Buffer.from("not a png");
  const desktop = await artifact("screenshot-desktop.png", fakeBytes, targetSampleId);
  const mobile = await artifact("screenshot-mobile.png", fakeBytes, targetSampleId);
  const reportPath = await artifact(
    "screenshot.json",
    screenshotReport(targetSampleId, [
      screenshotVariant("desktop", desktop, fakeBytes, { width: 1280, height: 720 }),
      screenshotVariant("mobile", mobile, fakeBytes, { width: 390, height: 844 }),
    ]),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath, targetSampleId)),
    /not a PNG/,
  );
});

test("screenshot evidence requires an ordered desktop/mobile pair", async () => {
  const targetSampleId = "maplibre-quickstart";
  const imageBytes = undecodableViewportPng();
  const imagePath = await artifact("screenshot-desktop.png", imageBytes, targetSampleId);
  const reportPath = await artifact(
    "desktop-only.json",
    screenshotReport(targetSampleId, [
      screenshotVariant("desktop", imagePath, imageBytes, { width: 1280, height: 720 }),
    ]),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath, targetSampleId)),
    /complete desktop\/mobile variant set/,
  );
});

test("screenshot evidence rejects legacy single-capture reports", async () => {
  const targetSampleId = "maplibre-quickstart";
  const legacy = screenshotReport(targetSampleId, []);
  legacy.format = "honua.sdk.sample-screenshot-gate.v1";
  delete legacy.reproducibilityPolicy;
  const reportPath = await artifact("legacy-screenshot.json", legacy, targetSampleId);
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath, targetSampleId)),
    /screenshot report format is invalid/,
  );
});

test("screenshot evidence rejects aliased and non-identical repeat captures", async () => {
  const targetSampleId = "maplibre-quickstart";
  const desktopBytes = grayscaleViewportPng(1280, 720, 0x44);
  const mobileBytes = grayscaleViewportPng(390, 844, 0x66);
  const desktopPath = await artifact("screenshot-desktop.png", desktopBytes, targetSampleId);
  const mobilePath = await artifact("screenshot-mobile.png", mobileBytes, targetSampleId);
  const screenshots = [
    screenshotVariant("desktop", desktopPath, desktopBytes, { width: 1280, height: 720 }),
    screenshotVariant("mobile", mobilePath, mobileBytes, { width: 390, height: 844 }),
  ];

  const aliased = structuredClone(screenshots);
  aliased[0].reproducibility.repeatPath = aliased[0].path;
  const aliasedReport = await artifact(
    "aliased-repeat-screenshot.json",
    screenshotReport(targetSampleId, aliased),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", aliasedReport, targetSampleId)),
    /primary and repeat paths must be unique/,
  );

  const repeatDesktopBytes = grayscaleViewportPng(1280, 720, 0x45);
  await writeFile(path.resolve(screenshots[0].reproducibility.repeatPath), repeatDesktopBytes);
  screenshots[0].reproducibility.repeatBytes = repeatDesktopBytes.byteLength;
  screenshots[0].reproducibility.repeatSha256 = digest(repeatDesktopBytes);
  const mismatchedReport = await artifact(
    "non-identical-repeat-screenshot.json",
    screenshotReport(targetSampleId, screenshots),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", mismatchedReport, targetSampleId)),
    /captures are not byte-identical/,
  );
});

test("screenshot evidence rejects runtime drift and noncanonical capture paths", async () => {
  const targetSampleId = "maplibre-quickstart";
  const desktopBytes = grayscaleViewportPng(1280, 720, 0x22);
  const mobileBytes = grayscaleViewportPng(390, 844, 0x77);
  const desktopPath = await artifact("screenshot-desktop.png", desktopBytes, targetSampleId);
  const mobilePath = await artifact("screenshot-mobile.png", mobileBytes, targetSampleId);
  const screenshots = [
    screenshotVariant("desktop", desktopPath, desktopBytes, { width: 1280, height: 720 }),
    screenshotVariant("mobile", mobilePath, mobileBytes, { width: 390, height: 844 }),
  ];

  const runtimeDrift = screenshotReport(targetSampleId, structuredClone(screenshots));
  runtimeDrift.runtime.playwrightVersion = "0.0.0";
  const runtimeDriftReport = await artifact("runtime-drift-screenshot.json", runtimeDrift, targetSampleId);
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", runtimeDriftReport, targetSampleId)),
    /bound to the declared Playwright project and browser runtime/,
  );

  const noncanonical = structuredClone(screenshots);
  noncanonical[0].path = noncanonical[0].path.replace("/artifacts/", "/artifacts/../artifacts/");
  const noncanonicalReport = await artifact(
    "noncanonical-screenshot.json",
    screenshotReport(targetSampleId, noncanonical),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", noncanonicalReport, targetSampleId)),
    /unsafe artifact path/,
  );
});

test("screenshot evidence accepts a runtime-bound reproducible desktop/mobile pair", async () => {
  const targetSampleId = "maplibre-quickstart";
  const desktopBytes = grayscaleViewportPng(1280, 720, 0x33);
  const mobileBytes = grayscaleViewportPng(390, 844, 0x55);
  const desktopPath = await artifact("screenshot-desktop.png", desktopBytes, targetSampleId);
  const mobilePath = await artifact("screenshot-mobile.png", mobileBytes, targetSampleId);
  const reportPath = await artifact(
    "valid-screenshot.json",
    screenshotReport(targetSampleId, [
      screenshotVariant("desktop", desktopPath, desktopBytes, { width: 1280, height: 720 }),
      screenshotVariant("mobile", mobilePath, mobileBytes, { width: 390, height: 844 }),
    ]),
    targetSampleId,
  );

  await assert.doesNotReject(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath, targetSampleId)),
  );
});

test("a CRC-correct PNG with undecodable image data cannot qualify", async () => {
  const targetSampleId = "maplibre-quickstart";
  const imageBytes = undecodableViewportPng();
  const desktopPath = await artifact("screenshot-desktop.png", imageBytes, targetSampleId);
  const mobilePath = await artifact("screenshot-mobile.png", imageBytes, targetSampleId);
  const reportPath = await artifact(
    "undecodable-screenshot.json",
    screenshotReport(targetSampleId, [
      screenshotVariant("desktop", desktopPath, imageBytes, { width: 1280, height: 720 }),
      screenshotVariant("mobile", mobilePath, imageBytes, { width: 390, height: 844 }),
    ]),
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath, targetSampleId)),
    /not decodable/,
  );
});

test("PNG evidence rejects unknown critical chunks and duplicate IHDR chunks", async () => {
  const targetSampleId = "maplibre-quickstart";
  const command = ["npm", "run", "test:playwright:receipt"];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280, 0);
  header.writeUInt32BE(720, 4);
  header[8] = 8;
  header[9] = 6;
  const cases = [
    ["unknown-critical", undecodableViewportPng([pngChunk("ABCD", Buffer.from("critical"))]), /unknown critical chunk ABCD/],
    ["duplicate-ihdr", undecodableViewportPng([pngChunk("IHDR", header)]), /duplicate IHDR/],
  ];
  for (const [name, imageBytes, expected] of cases) {
    const desktopPath = await artifact("screenshot-desktop.png", imageBytes, targetSampleId);
    const mobilePath = await artifact("screenshot-mobile.png", imageBytes, targetSampleId);
    const reportPath = await artifact(
      `${name}.json`,
      {
        ...screenshotReport(targetSampleId, [
          screenshotVariant("desktop", desktopPath, imageBytes, { width: 1280, height: 720 }),
          screenshotVariant("mobile", mobilePath, imageBytes, { width: 390, height: 844 }),
        ]),
        command,
      },
      targetSampleId,
    );
    await assert.rejects(
      createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath, targetSampleId)),
      expected,
    );
  }
});

test("console evidence must be finalized after teardown and reject late errors", async () => {
  const targetSampleId = "maplibre-quickstart";
  const report = playwrightGateReport();
  report.gate = "console";
  for (const execution of report.playwright.suites[0].specs[0].tests) {
    const attachment = execution.results[0].attachments.find(({ name }) => name === "honua-gate:console");
    const payload = JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));
    payload.observations = {
      pageErrors: [],
      consoleErrors: ["late teardown failure"],
      pageClosed: true,
      contextClosed: true,
      finalizationBoundary: "owned-page-and-context-close",
      finalizedAfterTeardown: true,
    };
    attachment.body = Buffer.from(JSON.stringify(payload)).toString("base64");
  }
  const reportPath = await artifact("late-console.json", report, targetSampleId);
  await assert.rejects(
    createGateReceipt(receiptOptions("console", "playwright-gate-report", reportPath, targetSampleId)),
    /console evidence is not clean/,
  );
});

test("metadata-only performance, packed-build, and live reports cannot qualify", async () => {
  const command = ["npm", "run", "test:playwright:receipt"];
  const browserSample = "maplibre-quickstart";
  const performance = await artifact(
    "performance.json",
    {
      format: "honua.sdk.sample-performance-gate.v1",
      sampleId: browserSample,
      sourceRevision: revision,
      command,
      withinBudget: true,
    },
    browserSample,
  );
  await assert.rejects(
    createGateReceipt(receiptOptions("performance", "performance-report", performance, browserSample)),
    /browser-observed navigation, resource, interaction, and budget/,
  );

  const packedSample = "maplibre-quickstart";
  const packed = await artifact(
    "packed.json",
    {
      format: "honua.sdk.sample-packed-build-gate.v1",
      sampleId: packedSample,
      sourceRevision: revision,
      command,
      sdkMode: "packed",
      packageTarballSha256: "1".repeat(64),
      resolution: { mode: "packed" },
      files: [{ path: "index.html", bytes: 1, sha256: "1".repeat(64) }],
    },
    packedSample,
  );
  await assert.rejects(
    createGateReceipt({ ...receiptOptions("packed-build", "packed-build-report", packed, packedSample), sdkMode: "packed" }),
    /artifact path is required|tarball/,
  );

  const live = await artifact("live.json", {
    format: "honua.sdk.sample-live-gate.v1",
    sampleId,
    sourceRevision: revision,
    command,
    evidencePath: "does-not-exist.json",
    evidence: { format: "honua.sdk.sample-evidence.v1", status: "executed" },
  });
  await assert.rejects(
    createGateReceipt(receiptOptions("live", "live-evidence-report", live)),
    /ENOENT|live evidence|bound evidence run/,
  );
});

test("browser-observed navigation, resource, and interaction measurements qualify performance", async () => {
  const targetSampleId = "maplibre-quickstart";
  const command = ["npm", "run", "test:playwright:receipt"];
  const value = 425;
  const performance = await artifact(
    "browser-performance.json",
    {
      format: "honua.sdk.sample-performance-gate.v1",
      sampleId: targetSampleId,
      sourceRevision: revision,
      command,
      measurement: {
        projectName: "chromium",
        browserName: "chromium",
        source: "browser-performance-api",
        metric: "sample-ready-duration",
        unit: "ms",
        budget: { operator: "<=", value: 5000 },
        value,
        observations: {
          navigation: {
            entryType: "navigation",
            sampleReadyMs: value,
            responseStartMs: 8,
            domContentLoadedMs: 64,
            loadEventMs: 72,
          },
          resources: { count: 6, transferBytes: 1024, decodedBodyBytes: 2048, completedByMs: 100 },
          interaction: { name: "evidence-drawer-keyboard-workflow", durationMs: 18 },
        },
      },
    },
    targetSampleId,
  );

  const receipt = await createGateReceipt(
    receiptOptions("performance", "performance-report", performance, targetSampleId),
  );
  assert.equal(receipt.status, "passed");

  const placeholder = JSON.parse(await readFile(path.resolve(performance), "utf8"));
  placeholder.measurement.observations = {
    navigation: {
      entryType: "navigation",
      sampleReadyMs: value,
      responseStartMs: 0,
      domContentLoadedMs: 0,
      loadEventMs: 0,
    },
    resources: { count: 0, transferBytes: 0, decodedBodyBytes: 0, completedByMs: 0 },
    interaction: { name: "evidence-drawer-keyboard-workflow", durationMs: 0 },
  };
  const placeholderPath = await artifact("placeholder-performance.json", placeholder, targetSampleId);
  await assert.rejects(
    createGateReceipt(receiptOptions("performance", "performance-report", placeholderPath, targetSampleId)),
    /browser-observed navigation, resource, interaction, and budget/,
  );
});

test("live receipts reuse the credential-safe evidence-envelope semantics", async () => {
  const command = ["npm", "run", "test:playwright:receipt"];
  const evidence = JSON.parse(await readFile("samples/contract/v1/fixtures/sample-evidence.live.json", "utf8"));
  evidence.source.endpoint = "https://example.test/features?x-api-key=must-not-appear";
  const evidencePath = await artifact("credential-evidence.json", evidence);
  const reportPath = await artifact("credential-live-report.json", {
    format: "honua.sdk.sample-live-gate.v1",
    sampleId,
    sourceRevision: revision,
    command,
    evidencePath,
    evidence,
  });
  await assert.rejects(
    createGateReceipt(receiptOptions("live", "live-evidence-report", reportPath)),
    /forbidden credential query parameter x-api-key/,
  );
});

test("live receipts bind the reviewed command to exactly its reviewed producer", async () => {
  const targetSampleId = "realtime-incident-dashboard";
  const command = ["npm", "run", "bench:live"];
  const observedAt = new Date().toISOString();
  const evidence = JSON.parse(await readFile("samples/contract/v1/fixtures/sample-evidence.live.json", "utf8"));
  evidence.observedAt = observedAt;
  evidence.provenance.observedAt = observedAt;
  evidence.provenance.validAt = observedAt;
  evidence.sdk.gitCommit = revision;
  evidence.semantics.operation = "snapshot-observe-and-reconnect-delta";
  evidence.artifacts = [{ kind: "producer-generator", path: "README.md", sha256: digest(await readFile("README.md")) }];
  const evidencePath = await artifact("arbitrary-producer-evidence.json", evidence, targetSampleId);
  const reportPath = await artifact(
    "arbitrary-producer-live-report.json",
    { format: "honua.sdk.sample-live-gate.v1", sampleId: targetSampleId, sourceRevision: revision, command, evidencePath, evidence },
    targetSampleId,
  );
  await assert.rejects(
    createGateReceipt({
      ...receiptOptions("live", "live-evidence-report", reportPath, targetSampleId),
      command,
      observedAt,
    }),
    /producer generator path.*must be scripts\/live-benchmark-evidence\.mjs/,
  );

  const producerPath = "scripts/live-benchmark-evidence.mjs";
  evidence.artifacts = [{ kind: "producer-generator", path: producerPath, sha256: digest(await readFile(producerPath)) }];
  const validEvidencePath = await artifact("reviewed-producer-evidence.json", evidence, targetSampleId);
  const validReportPath = await artifact(
    "reviewed-producer-live-report.json",
    {
      format: "honua.sdk.sample-live-gate.v1",
      sampleId: targetSampleId,
      sourceRevision: revision,
      command,
      evidencePath: validEvidencePath,
      evidence,
    },
    targetSampleId,
  );
  const receipt = await createGateReceipt({
    ...receiptOptions("live", "live-evidence-report", validReportPath, targetSampleId),
    command,
    observedAt,
  });
  assert.equal(receipt.status, "passed");
});

test("packed receipt re-reads the final dist tree instead of trusting its inventory", async () => {
  const targetSampleId = "maplibre-quickstart";
  const repository = await mkdtemp(path.join(os.tmpdir(), "honua-packed-receipt-"));
  const artifactRoot = path.join(
    repository,
      `samples/evidence/${targetSampleId}/runs/${receiptRunId}/artifacts`,
  );
  const distRoot = path.join(artifactRoot, "packed-sample-dist");
  const command = ["npm", "run", "test:playwright:receipt"];
  try {
    await mkdir(path.join(repository, "scripts"), { recursive: true });
    await copyFile(path.resolve("scripts/sample-runner.mjs"), path.join(repository, "scripts/sample-runner.mjs"));
    await mkdir(path.join(distRoot, "assets"), { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    const bundlePath = path.join(distRoot, "assets/index.js");
    const bundleBytes = Buffer.from("export const packed = true;\n");
    const styleBytes = Buffer.from("body { color: black; }\n");
    await writeFile(bundlePath, bundleBytes);
    await writeFile(path.join(distRoot, "assets/index.css"), styleBytes);
    await writeFile(path.join(distRoot, "index.html"), "<!doctype html>\n");
    const resolution = {
      format: "honua.sdk.sample-resolution.v1",
      schemaVersion: 1,
      mode: "packed",
      package: { name: "@honua/sdk-js", version: "0.0.0-test" },
      entrypoints: ["@honua/sdk-js", "@honua/sdk-js/runtime"].map(
        (specifier) => ({
          specifier,
          exportTarget: "./dist/index.js",
          hashSubject: "packed-published-entrypoint-file",
          sha256: "1".repeat(64),
        }),
      ),
      bundle: [
        {
          fileName: "assets/index.js",
          kind: "chunk",
          hashSubject: "final-written-bundle-file",
          bytes: bundleBytes.byteLength,
          sha256: digest(bundleBytes),
        },
        {
          fileName: "assets/index.css",
          kind: "asset",
          hashSubject: "final-written-bundle-file",
          bytes: styleBytes.byteLength,
          sha256: digest(styleBytes),
        },
      ],
    };
    const tarballPath = path.join(artifactRoot, "honua-sdk-js.tgz");
    const tarballBytes = Buffer.from("bounded tarball fixture\n");
    await writeFile(tarballPath, tarballBytes);
    const reportPath = path.join(artifactRoot, "packed.json");
    const writePackedReport = async (candidateResolution) => {
      await writeFile(
        path.join(distRoot, "honua-sample-sdk-resolution.json"),
        `${JSON.stringify(candidateResolution, null, 2)}\n`,
      );
      const inventory = [];
      for (const name of ["assets/index.css", "assets/index.js", "honua-sample-sdk-resolution.json", "index.html"]) {
        const bytes = await readFile(path.join(distRoot, name));
        inventory.push({
          path: name,
          bytes: bytes.byteLength,
          sha256: digest(bytes),
        });
      }
      await writeFile(
        reportPath,
        `${JSON.stringify(
          {
          format: "honua.sdk.sample-packed-build-gate.v1",
          sampleId: targetSampleId,
          sourceRevision: revision,
          command,
          sdkMode: "packed",
          packageTarball: path.relative(repository, tarballPath).replaceAll(path.sep, "/"),
          packageTarballBytes: tarballBytes.byteLength,
          packageTarballSha256: digest(tarballBytes),
          sampleDistRoot: path.relative(repository, distRoot).replaceAll(path.sep, "/"),
          resolution: candidateResolution,
          files: inventory,
          },
          null,
          2,
        )}\n`,
      );
    };
    const packedReceiptOptions = () => ({
      sampleId: targetSampleId,
      gate: "packed-build",
      sdkMode: "packed",
      sourceRevision: revision,
      sourceDigest: fixtureSourceDigest,
      runRoot: `samples/evidence/${targetSampleId}/runs/${receiptRunId}`,
      command,
      durationMs: 1,
      artifacts: [
        {
          kind: "packed-build-report",
          path: path.relative(repository, reportPath).replaceAll(path.sep, "/"),
        },
      ],
      projectRoot: repository,
      verifyCheckout: false,
    });

    await writePackedReport({ ...resolution, bundle: [resolution.bundle[0]] });
    await assert.rejects(createGateReceipt(packedReceiptOptions()), /does not exactly cover the final Vite bundle/);
    await writePackedReport({ ...resolution, bundle: [resolution.bundle[0], resolution.bundle[0]] });
    await assert.rejects(createGateReceipt(packedReceiptOptions()), /does not exactly cover the final Vite bundle/);

    await writePackedReport(resolution);
    const receipt = await createGateReceipt(packedReceiptOptions());
    await writeFile(bundlePath, "export const packed = false;\n");
    await assert.rejects(
      validateGateReceipt(receipt, { projectRoot: repository, verifyCheckout: false }),
      /does not match the bounded sample dist tree|bundle digest/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("receipt freshness, command, producer, artifact digest, and byte bindings fail closed", async () => {
  const receipt = await validFixtureReceipt();
  await assert.rejects(
    validateGateReceipt(receipt, {
      projectRoot: process.cwd(),
      verifyCheckout: false,
      now: new Date(Date.parse(receipt.expiresAt) + 1).toISOString(),
    }),
    /stale/,
  );
  await assert.rejects(
    validateGateReceipt(receipt, {
      projectRoot: process.cwd(),
      verifyCheckout: false,
      command: ["npm", "run", "different:command"],
    }),
    /command binding mismatch/,
  );

  const wrongProducer = structuredClone(receipt);
  wrongProducer.producer.sha256 = "0".repeat(64);
  await assert.rejects(validateGateReceipt(wrongProducer, { projectRoot: process.cwd(), verifyCheckout: false }), /producer digest/);

  const wrongDigest = structuredClone(receipt);
  wrongDigest.artifacts[0].sha256 = "0".repeat(64);
  await assert.rejects(validateGateReceipt(wrongDigest, { projectRoot: process.cwd(), verifyCheckout: false }), /artifact digest/);

  const wrongBytes = structuredClone(receipt);
  wrongBytes.artifacts[0].bytes += 1;
  await assert.rejects(validateGateReceipt(wrongBytes, { projectRoot: process.cwd(), verifyCheckout: false }), /byte count/);
});

test("receipt artifacts cannot cross runs or traverse a symlinked run ancestor", async () => {
  const receipt = await validFixtureReceipt();
  const originalPath = path.resolve(receipt.artifacts[0].path);
  const otherRoot = path.resolve(`samples/evidence/${sampleId}/runs/${otherRunId}/artifacts`);
  await mkdir(otherRoot, { recursive: true });
  const otherPath = path.join(otherRoot, path.basename(originalPath));
  await copyFile(originalPath, otherPath);

  const crossRun = structuredClone(receipt);
  crossRun.artifacts[0].path = path.relative(process.cwd(), otherPath).replaceAll(path.sep, "/");
  await assert.rejects(
    validateGateReceipt(crossRun, { projectRoot: process.cwd(), verifyCheckout: false }),
    /bound evidence run|outside its evidence run/,
  );

  const artifactDirectory = path.dirname(originalPath);
  await rm(artifactDirectory, { recursive: true, force: true });
  await symlink(otherRoot, artifactDirectory, "dir");
  await assert.rejects(
    validateGateReceipt(receipt, { projectRoot: process.cwd(), verifyCheckout: false }),
    /contains a symlink/,
  );
  await rm(path.resolve(`samples/evidence/${sampleId}/runs/${otherRunId}`), { recursive: true, force: true });
});

test("bounded canonical reads reject a forced symlink swap and size growth", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "honua-bounded-read-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "honua-bounded-outside-"));
  const candidate = path.join(repository, "artifact.json");
  const outsideFile = path.join(outside, "secret.json");
  try {
    await writeFile(candidate, "safe\n");
    await writeFile(outsideFile, "secret\n");
    await assert.rejects(
      readCanonicalBoundedFile(repository, "artifact.json", {
        maxBytes: 16,
        onBeforeOpen: async () => {
          await rm(candidate);
          await symlink(outsideFile, candidate, "file");
        },
      }),
      /symlink|changed/,
    );

    await rm(candidate, { force: true });
    await writeFile(candidate, "safe\n");
    await assert.rejects(
      readCanonicalBoundedFile(repository, "artifact.json", {
        maxBytes: 16,
        onBeforeOpen: async () => writeFile(candidate, "this grew beyond the bound\n"),
      }),
      /changed|exceeds/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("bounded canonical reads reject a FIFO swap without blocking", { skip: process.platform !== "linux" }, async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "honua-bounded-fifo-"));
  const candidate = path.join(repository, "artifact.json");
  try {
    await writeFile(candidate, "safe\n");
    const moduleUrl = pathToFileURL(path.resolve("scripts/sample-gate-receipt.mjs")).href;
    const script = `
      import { execFileSync } from "node:child_process";
      import { rm } from "node:fs/promises";
      import { readCanonicalBoundedFile } from ${JSON.stringify(moduleUrl)};
      try {
        await readCanonicalBoundedFile(${JSON.stringify(repository)}, "artifact.json", {
          maxBytes: 16,
          onBeforeOpen: async ({ absolute }) => {
            await rm(absolute);
            execFileSync("mkfifo", [absolute]);
          },
        });
        process.exitCode = 2;
      } catch (error) {
        if (!/changed|regular/.test(String(error))) {
          console.error(error);
          process.exitCode = 3;
        }
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 3_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("qualification requires the exact gate set and profile boolean changes alter it", async () => {
  const profile = { gates: { browser: false } };
  assert.deepEqual(requiredReceiptGates(profile), ["fixture"]);
  assert.deepEqual(requiredReceiptGates({ gates: { browser: true } }), ["browser", "fixture"]);

  const receiptRoot = path.resolve("test-results/qualification-set-adversary");
  const directory = path.join(receiptRoot, sampleId, "receipts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fixture.v1.json"), "{}\n");
  await writeFile(path.join(directory, "extra.v1.json"), "{}\n");
  try {
    await assert.rejects(
      validateQualificationReceiptSet({
        sample: { id: sampleId },
        profile,
        receiptRoot,
        sourceRevision: revision,
        projectRoot: process.cwd(),
        verifyCheckout: false,
        expectedCommand: () => ["npm", "run", "test:playwright:receipt"],
      }),
      /gate receipt set mismatch/,
    );
  } finally {
    await rm(receiptRoot, { recursive: true, force: true });
  }
});

test("qualification bounds adversarial excess receipt inventory at expected plus one", async () => {
  const profile = { gates: { browser: false } };
  const receiptRoot = path.resolve("test-results/qualification-excess-entry-adversary");
  const directory = path.join(receiptRoot, sampleId, "receipts");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fixture.v1.json"), "{}\n");
  for (let index = 0; index < 128; index += 1) {
    await writeFile(path.join(directory, `excess-${index.toString().padStart(3, "0")}.v1.json`), "{}\n");
  }
  try {
    await assert.rejects(
      validateQualificationReceiptSet({
        sample: { id: sampleId },
        profile,
        receiptRoot,
        sourceRevision: revision,
        projectRoot: process.cwd(),
        verifyCheckout: false,
        expectedCommand: () => ["npm", "run", "test:playwright:receipt"],
      }),
      /gate receipt set mismatch;.*found more than 1 entries/,
    );
  } finally {
    await rm(receiptRoot, { recursive: true, force: true });
  }
});

test("qualification rejects a receipt with a non-UUID run root", async () => {
  const receipt = await validFixtureReceipt();
  receipt.runRoot = `samples/evidence/${sampleId}/runs/receipt-unit-test`;
  const receiptRoot = path.resolve("test-results/qualification-run-root");
  const directory = path.join(receiptRoot, sampleId, "receipts");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "fixture.v1.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    await assert.rejects(
      validateQualificationReceiptSet({
        sample: { id: sampleId },
        profile: { gates: { browser: false } },
        receiptRoot,
        projectRoot: process.cwd(),
        verifyCheckout: false,
        expectedCommand: () => ["npm", "run", "test:playwright:receipt"],
      }),
      /gate receipt schema validation failed.*runRoot/,
    );
  } finally {
    await rm(receiptRoot, { recursive: true, force: true });
  }
});

test("qualification requires one run per expected command while allowing separate command runs", async () => {
  const targetSampleId = "maplibre-quickstart";
  const receiptRoot = path.resolve("test-results/qualification-command-groups");
  const receiptDirectory = path.join(receiptRoot, targetSampleId, "receipts");
  const fixtureRun = "11111111-1111-4111-8111-111111111111";
  const browserRun = "22222222-2222-4222-8222-222222222222";
  const mismatchedConsoleRun = "33333333-3333-4333-8333-333333333333";
  const fixtureCommand = ["npm", "run", "demo:standalone:mock", "--", "--evidence-once"];
  const playwrightCommand = ["npm", "run", "test:playwright:receipt"];
  const runRoot = (run) => `samples/evidence/${targetSampleId}/runs/${run}`;
  const writeArtifact = async (run, name, value) => {
    const artifactPath = path.resolve(runRoot(run), "artifacts", name);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
    return path.relative(process.cwd(), artifactPath).replaceAll(path.sep, "/");
  };
  const receiptFor = async (gate, run, report) => {
    const reportPath = await writeArtifact(run, `${gate}.json`, report);
    return createGateReceipt({
      ...receiptOptions(
        gate,
        gate === "fixture" ? "fixture-probe-report" : "playwright-gate-report",
        reportPath,
        targetSampleId,
      ),
      command: gate === "fixture" ? fixtureCommand : playwrightCommand,
      runRoot: runRoot(run),
    });
  };
  const fixture = await receiptFor("fixture", fixtureRun, {
    ...fixtureReport(fixtureCommand),
    sampleId: targetSampleId,
  });
  const browser = await receiptFor("browser", browserRun, playwrightGateReport({ gate: "browser" }));
  const mismatchedConsole = await receiptFor(
    "console",
    mismatchedConsoleRun,
    playwrightGateReport({ gate: "console" }),
  );
  const profile = { gates: { browser: true, console: true } };
  const sample = { id: targetSampleId };
  const expectedCommand = (_sample, gate) => (gate === "fixture" ? fixtureCommand : playwrightCommand);
  try {
    await mkdir(receiptDirectory, { recursive: true });
    for (const receipt of [fixture, browser, mismatchedConsole]) {
      await writeFile(path.join(receiptDirectory, `${receipt.gate}.v1.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    }
    await assert.rejects(
      validateQualificationReceiptSet({
        sample,
        profile,
        receiptRoot,
        projectRoot: process.cwd(),
        verifyCheckout: false,
        expectedCommand,
      }),
      /gates produced by one command must share one evidence run root/,
    );

    const correlatedConsole = await receiptFor("console", browserRun, playwrightGateReport({ gate: "console" }));
    await writeFile(
      path.join(receiptDirectory, "console.v1.json"),
      `${JSON.stringify(correlatedConsole, null, 2)}\n`,
    );
    await validateQualificationReceiptSet({
      sample,
      profile,
      receiptRoot,
      projectRoot: process.cwd(),
      verifyCheckout: false,
      expectedCommand,
    });
  } finally {
    await rm(receiptRoot, { recursive: true, force: true });
    for (const run of [fixtureRun, browserRun, mismatchedConsoleRun]) {
      await rm(path.resolve(runRoot(run)), { recursive: true, force: true });
    }
  }
});

test("clean-checkout binding rejects a dirty relevant tree", async () => {
  const dirty = path.resolve("sample-runner-dirty-probe.tmp");
  await writeFile(dirty, "dirty\n");
  try {
    assert.throws(() => verifyEvidenceNeutralCheckout(undefined, process.cwd()), /clean source checkout/);
  } finally {
    await rm(dirty, { force: true });
  }
});

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function integrityRepository({ trackedEvidence = false } = {}) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "honua-gate-source-"));
  await mkdir(path.join(repository, "scripts"), { recursive: true });
  await copyFile(path.resolve("scripts/sample-runner.mjs"), path.join(repository, "scripts/sample-runner.mjs"));
  await mkdir(path.join(repository, "samples"), { recursive: true });
  await writeFile(path.join(repository, "samples/.keep"), "canonical sample root\n");
  await writeFile(path.join(repository, ".gitignore"), "test-results/\n");
  if (trackedEvidence) {
    await mkdir(path.join(repository, "samples/evidence/other-sample/receipts"), { recursive: true });
    await writeFile(path.join(repository, "samples/evidence/other-sample/receipts/fixture.v1.json"), '{"prior":true}\n');
  }
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Mike McDougall"]);
  git(repository, ["config", "user.email", "mike@honua.io"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  return { repository, sourceRevision: git(repository, ["rev-parse", "HEAD"]) };
}

function snapshotOptions(repository, sourceRevision, runId = snapshotRunId) {
  const outputRoot = "samples/evidence/receipt-adversary";
  return {
    projectRoot: repository,
    sourceRevision,
    outputRoot,
    runRoot: `${outputRoot}/runs/${runId}`,
  };
}

test("evidence-neutral source binding survives evidence-only changes and commits", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  try {
    const digest = evidenceNeutralSourceDigest(repository);
    const evidence = path.join(repository, "samples/evidence/receipt-adversary/receipts/fixture.v1.json");
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(evidence, '{"status":"passed"}\n');
    assert.equal(verifyEvidenceNeutralCheckout(digest, repository), digest);
    git(repository, ["add", "samples/evidence"]);
    git(repository, ["commit", "--quiet", "-m", "evidence"]);
    assert.notEqual(git(repository, ["rev-parse", "HEAD"]), sourceRevision);
    assert.equal(evidenceNeutralSourceDigest(repository), digest);
    assert.equal(verifyEvidenceNeutralCheckout(digest, repository), digest);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("persisted source binding rejects missing, non-ancestor, and source-different revisions", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  try {
    const digest = evidenceNeutralSourceDigest(repository);
    assert.throws(
      () => verifyEvidenceNeutralCheckout(digest, repository, "0".repeat(40)),
      /does not name an existing commit/,
    );

    const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
    const sibling = git(repository, ["commit-tree", tree, "-m", "unrelated same tree"]);
    assert.throws(
      () => verifyEvidenceNeutralCheckout(digest, repository, sibling),
      /not an ancestor/,
    );

    await writeFile(path.join(repository, "samples/.keep"), "changed source\n");
    git(repository, ["add", "samples/.keep"]);
    git(repository, ["commit", "--quiet", "-m", "change source"]);
    const changedDigest = evidenceNeutralSourceDigest(repository);
    assert.throws(
      () => verifyEvidenceNeutralCheckout(changedDigest, repository, sourceRevision),
      /source revision does not match its source digest/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("source binding rejects assume-unchanged and skip-worktree inputs", async () => {
  const { repository } = await integrityRepository();
  try {
    git(repository, ["update-index", "--assume-unchanged", "samples/.keep"]);
    assert.throws(() => verifyEvidenceNeutralCheckout(undefined, repository), /assume-unchanged/);
    git(repository, ["update-index", "--no-assume-unchanged", "samples/.keep"]);
    git(repository, ["update-index", "--skip-worktree", "samples/.keep"]);
    assert.throws(() => verifyEvidenceNeutralCheckout(undefined, repository), /skip-worktree/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("source snapshot preserves prior canonical evidence and isolates fresh run output", async () => {
  const { repository, sourceRevision } = await integrityRepository({ trackedEvidence: true });
  const options = snapshotOptions(repository, sourceRevision);
  const prior = path.join(repository, "samples/evidence/other-sample/receipts/fixture.v1.json");
  const baselineEmptyDirectory = path.join(repository, "samples/evidence/other-sample/empty-baseline");
  const priorBytes = await readFile(prior);
  try {
    await mkdir(baselineEmptyDirectory, { recursive: true });
    const sourceSnapshot = await captureGateSourceSnapshot(options);
    assert.deepEqual(sourceSnapshot.baselineEvidence.map((binding) => binding.path), [
      "samples/evidence/other-sample/receipts/fixture.v1.json",
    ]);
    const playwrightOutput = path.join(repository, options.runRoot, "artifacts/playwright-output/result.json");
    await mkdir(path.dirname(playwrightOutput), { recursive: true });
    await writeFile(playwrightOutput, "{}\n");
    await verifyGateSourceSnapshot(sourceSnapshot, repository);
    assert.deepEqual(await readFile(prior), priorBytes);

    const unrelatedEmptyDirectory = path.join(repository, "samples/evidence/forged-empty-directory");
    await mkdir(unrelatedEmptyDirectory);
    await assert.rejects(
      verifyGateSourceSnapshot(sourceSnapshot, repository),
      /created an unrelated canonical evidence directory/,
    );
    await rm(unrelatedEmptyDirectory, { recursive: true });
    await verifyGateSourceSnapshot(sourceSnapshot, repository);

    await rm(baselineEmptyDirectory, { recursive: true });
    await assert.rejects(
      verifyGateSourceSnapshot(sourceSnapshot, repository),
      /removed a canonical evidence directory/,
    );
    await mkdir(baselineEmptyDirectory);

    await writeFile(prior, '{"status":"forged"}\n');
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /unrelated canonical evidence/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("a later gate run cannot delete an earlier gate receipt", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const priorReceipt = path.join(repository, "samples/evidence/receipt-adversary/receipts/fixture.v1.json");
  const options = snapshotOptions(repository, sourceRevision);
  try {
    await mkdir(path.dirname(priorReceipt), { recursive: true });
    await writeFile(priorReceipt, '{"priorGate":"fixture"}\n');
    const sourceSnapshot = await captureGateSourceSnapshot(options);
    const browserArtifact = path.join(repository, options.runRoot, "artifacts/browser.json");
    await mkdir(path.dirname(browserArtifact), { recursive: true });
    await writeFile(browserArtifact, '{"gate":"browser"}\n');
    await verifyGateSourceSnapshot(sourceSnapshot, repository);

    await rm(priorReceipt);
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /removed canonical evidence/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("bulk command-group snapshots cannot prewrite future receipts or rewrite prior receipts", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const receiptRoot = path.join(repository, "samples/evidence/receipt-adversary/receipts");
  try {
    const browserOptions = snapshotOptions(
      repository,
      sourceRevision,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    );
    const browserSnapshot = await captureGateSourceSnapshot(browserOptions);
    const browserArtifact = path.join(repository, browserOptions.runRoot, "artifacts/browser.json");
    await mkdir(path.dirname(browserArtifact), { recursive: true });
    await writeFile(browserArtifact, '{"gate":"browser"}\n');

    const futureFixtureReceipt = path.join(receiptRoot, "fixture.v1.json");
    await mkdir(receiptRoot, { recursive: true });
    await writeFile(futureFixtureReceipt, '{"prewritten":true}\n');
    await assert.rejects(
      verifyGateSourceSnapshot(browserSnapshot, repository),
      /outside its controlled canonical evidence paths/,
    );
    await rm(futureFixtureReceipt);
    await verifyGateSourceSnapshot(browserSnapshot, repository);

    const browserReceipt = path.join(receiptRoot, "browser.v1.json");
    await writeFile(browserReceipt, '{"gate":"browser"}\n');
    const fixtureOptions = snapshotOptions(
      repository,
      sourceRevision,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    const fixtureSnapshot = await captureGateSourceSnapshot(fixtureOptions);
    const fixtureArtifact = path.join(repository, fixtureOptions.runRoot, "artifacts/fixture.json");
    await mkdir(path.dirname(fixtureArtifact), { recursive: true });
    await writeFile(fixtureArtifact, '{"gate":"fixture"}\n');
    await writeFile(browserReceipt, '{"gate":"forged"}\n');
    await assert.rejects(
      verifyGateSourceSnapshot(fixtureSnapshot, repository),
      /changed unrelated canonical evidence/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("source snapshot rejects an empty commit or ref move during a gate", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const options = snapshotOptions(repository, sourceRevision);
  try {
    const sourceSnapshot = await captureGateSourceSnapshot(options);
    const artifact = path.join(repository, options.runRoot, "artifacts/fixture.json");
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, '{"gate":"fixture"}\n');
    git(repository, ["commit", "--quiet", "--allow-empty", "-m", "move head"]);
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /source revision changed/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("a clean source snapshot accepts only its own fresh controlled artifact", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const options = snapshotOptions(repository, sourceRevision);
  try {
    const sourceSnapshot = await captureGateSourceSnapshot(options);
    const reportPath = path.join(repository, options.runRoot, "artifacts/fixture.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    const command = ["npm", "run", "demo:receipt:mock", "--", "--evidence-once"];
    await writeFile(
      reportPath,
      `${JSON.stringify({
        format: "honua.sdk.sample-fixture-gate.v1",
        sampleId: "receipt-adversary",
        sourceRevision,
        command,
        transport: "loopback-http",
        networkScope: "loopback-only",
        host: "127.0.0.1",
        port: 12345,
        ready: true,
        started: true,
        probe: {
          method: "GET",
          path: "/",
          status: 200,
          bodyBytes: 10,
          bodySha256: "1".repeat(64),
        },
        closed: true,
        listeningAfterClose: false,
        activeConnectionsAfterClose: 0,
      })}\n`,
    );
    const receipt = await createGateReceipt({
      sampleId: "receipt-adversary",
      gate: "fixture",
      sdkMode: "source",
      sourceRevision,
      command,
      durationMs: 1,
      artifacts: [{ kind: "fixture-probe-report", path: path.relative(repository, reportPath) }],
      projectRoot: repository,
      sourceSnapshot,
    });
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.sourceDigest, sourceSnapshot.sourceDigest);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("source snapshot rejects producer drift and unrelated forged test output", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const options = snapshotOptions(repository, sourceRevision);
  try {
    const sourceSnapshot = await captureGateSourceSnapshot(options);
    await mkdir(path.join(repository, options.runRoot), { recursive: true });
    await writeFile(path.join(repository, options.runRoot, "owned.json"), "{}\n");
    await writeFile(path.join(repository, "scripts/sample-runner.mjs"), "// modified producer\n");
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /clean source checkout|producer changed/);

    await rm(path.join(repository, "scripts/sample-runner.mjs"));
    await copyFile(path.resolve("scripts/sample-runner.mjs"), path.join(repository, "scripts/sample-runner.mjs"));
    await mkdir(path.join(repository, "samples/evidence/forged"), { recursive: true });
    await writeFile(path.join(repository, "samples/evidence/forged/unrelated.json"), "{}\n");
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /outside its controlled canonical evidence paths/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("pre-existing controlled output cannot be captured as a fresh run", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const options = snapshotOptions(repository, sourceRevision);
  try {
    await mkdir(path.join(repository, options.runRoot), { recursive: true });
    await writeFile(path.join(repository, options.runRoot, "forged.json"), "{}\n");
    await assert.rejects(
      captureGateSourceSnapshot(options),
      /run root must be fresh/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("canonical evidence root and sample ancestors cannot be external symlinks", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const external = await mkdtemp(path.join(os.tmpdir(), "honua-external-evidence-"));
  const options = snapshotOptions(repository, sourceRevision);
  const evidenceRoot = path.join(repository, "samples/evidence");
  try {
    await symlink(external, evidenceRoot, "dir");
    await assert.rejects(
      captureGateSourceSnapshot(options),
      /canonical evidence root must be a non-symlink directory/,
    );
    assert.deepEqual(await readFile(path.join(repository, "samples/.keep"), "utf8"), "canonical sample root\n");

    await rm(evidenceRoot);
    const sourceSnapshot = await captureGateSourceSnapshot(options);
    const sampleRoot = path.join(repository, "samples/evidence/receipt-adversary");
    await rm(sampleRoot, { recursive: true });
    await symlink(external, sampleRoot, "dir");
    const escapedArtifact = path.join(external, `runs/${snapshotRunId}/artifacts/fixture.json`);
    await mkdir(path.dirname(escapedArtifact), { recursive: true });
    await writeFile(escapedArtifact, '{"escaped":true}\n');
    await assert.rejects(
      verifyGateSourceSnapshot(sourceSnapshot, repository),
      /canonical sample evidence directory must be a non-symlink directory/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});
