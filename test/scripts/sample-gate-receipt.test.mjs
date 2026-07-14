import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  captureGateSourceSnapshot,
  createGateReceipt,
  requiredReceiptGates,
  validateGateReceipt,
  validateQualificationReceiptSet,
  verifyCleanCheckout,
  verifyGateSourceSnapshot,
} from "../../scripts/sample-gate-receipt.mjs";

const sampleId = "receipt-adversary";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function artifact(name, value, targetSampleId = sampleId) {
  const artifactRoot = path.resolve("test-results/sample-evidence", targetSampleId, "runs/test/artifacts");
  await mkdir(artifactRoot, { recursive: true });
  const file = path.join(artifactRoot, name);
  await writeFile(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  return path.relative(process.cwd(), file).replaceAll(path.sep, "/");
}

function receiptOptions(gate, kind, artifactPath, targetSampleId = sampleId) {
  return {
    sampleId: targetSampleId,
    gate,
    sdkMode: "source",
    sourceRevision: revision,
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

function playwrightGateReport({ retry = 0, extraAttachments = [] } = {}) {
  const targetSampleId = "standalone-quickstart";
  const payload = (gate) => ({
    format: "honua.sdk.sample-gate-assertion.v1",
    sampleId: targetSampleId,
    gate,
    status: "passed",
    observations: gate === "browser" ? { runtimeReady: true } : {},
  });
  const attachments = ["accessibility", "browser", "console", "fixture", "responsive"]
    .map((gate) => ({
      name: `honua-gate:${gate}`,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(payload(gate))).toString("base64"),
    }))
    .concat(extraAttachments);
  return {
    format: "honua.sdk.sample-playwright-gate.v1",
    sampleId: targetSampleId,
    sourceRevision: revision,
    gate: "browser",
    command: ["npm", "run", "test:playwright:receipt"],
    playwright: {
      config: {},
      suites: [
        {
          file: "test/playwright/standalone-quickstart.spec.mjs",
          specs: [
            {
              title: "standalone quickstart renders public-endpoint features with no Honua server",
              tests: [
                {
                  projectName: "",
                  expectedStatus: "passed",
                  results: [{ status: "passed", retry, attachments }],
                },
              ],
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
  await rm(path.resolve("test-results/sample-evidence", sampleId), { recursive: true, force: true });
  await rm(path.resolve("test-results/sample-evidence/standalone-quickstart"), { recursive: true, force: true });
});

test("arbitrary text cannot qualify a fixture gate", async () => {
  const file = await artifact("fixture.json", "plain text");
  await assert.rejects(createGateReceipt(receiptOptions("fixture", "fixture-probe-report", file)), /must be JSON/);
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
  const targetSampleId = "standalone-quickstart";
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
      config: {},
      suites: [
        {
          file: "test/playwright/standalone-quickstart.spec.mjs",
          specs: [
            {
              title: "standalone quickstart renders public-endpoint features with no Honua server",
              tests: [
                {
                  projectName: "",
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
  const targetSampleId = "standalone-quickstart";
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

test("renaming text to PNG cannot qualify a screenshot", async () => {
  const fakePng = await artifact("renamed.png", "not a png");
  const reportPath = await artifact("screenshot.json", {
    format: "honua.sdk.sample-screenshot-gate.v1",
    sampleId,
    sourceRevision: revision,
    command: ["npm", "run", "test:playwright:receipt"],
    screenshot: {
      path: fakePng,
      bytes: 9,
      sha256: "0".repeat(64),
      viewport: { width: 1280, height: 720 },
    },
  });
  await assert.rejects(createGateReceipt(receiptOptions("screenshot", "screenshot-report", reportPath)), /not a PNG/);
});

test("metadata-only performance, packed-build, and live reports cannot qualify", async () => {
  const command = ["npm", "run", "test:playwright:receipt"];
  const performance = await artifact("performance.json", {
    format: "honua.sdk.sample-performance-gate.v1",
    sampleId,
    sourceRevision: revision,
    command,
    withinBudget: true,
  });
  await assert.rejects(
    createGateReceipt(receiptOptions("performance", "performance-report", performance)),
    /declared metric and budget/,
  );

  const packedSample = "standalone-quickstart";
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
    /ENOENT|live evidence/,
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

test("packed receipt re-reads the final dist tree instead of trusting its inventory", async () => {
  const targetSampleId = "standalone-quickstart";
  const repository = await mkdtemp(path.join(os.tmpdir(), "honua-packed-receipt-"));
  const distRoot = path.join(repository, "examples/standalone-quickstart/dist");
  const artifactRoot = path.join(
    repository,
    `test-results/sample-evidence/${targetSampleId}/runs/test/artifacts`,
  );
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
      entrypoints: ["@honua/sdk-js", "@honua/sdk-js/esri-compat", "@honua/sdk-js/honua", "@honua/sdk-js/map"].map(
        (specifier) => ({
          specifier,
          exportTarget: "./dist/index.js",
          hashSubject: "packed-published-entrypoint-file",
          sha256: "1".repeat(64),
        }),
      ),
      bundle: [
        { fileName: "assets/index.js", kind: "chunk", bytes: bundleBytes.byteLength, sha256: digest(bundleBytes) },
        { fileName: "assets/index.css", kind: "asset", bytes: styleBytes.byteLength, sha256: digest(styleBytes) },
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
          path: `examples/standalone-quickstart/dist/${name}`,
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

test("clean-checkout binding rejects a dirty relevant tree", async () => {
  const dirty = path.resolve("sample-runner-dirty-probe.tmp");
  await writeFile(dirty, "dirty\n");
  try {
    assert.throws(() => verifyCleanCheckout(revision, process.cwd()), /clean checkout/);
  } finally {
    await rm(dirty, { force: true });
  }
});

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function integrityRepository({ trackedTestResults = false } = {}) {
  const repository = await mkdtemp(path.join(os.tmpdir(), "honua-gate-source-"));
  await mkdir(path.join(repository, "scripts"), { recursive: true });
  await copyFile(path.resolve("scripts/sample-runner.mjs"), path.join(repository, "scripts/sample-runner.mjs"));
  await writeFile(path.join(repository, ".gitignore"), "test-results/sample-evidence/\ntest-results/ignored/\n");
  if (trackedTestResults) {
    await mkdir(path.join(repository, "test-results"), { recursive: true });
    await writeFile(path.join(repository, "test-results/.last-run.json"), '{"status":"passed"}\n');
    await writeFile(path.join(repository, "test-results/integration-vitest.json"), '{"success":true}\n');
  }
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Mike McDougall"]);
  git(repository, ["config", "user.email", "mike@honua.io"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  return { repository, sourceRevision: git(repository, ["rev-parse", "HEAD"]) };
}

test("source snapshot preserves exact tracked test-results baselines and isolates Playwright output", async () => {
  const { repository, sourceRevision } = await integrityRepository({ trackedTestResults: true });
  const outputRoot = "test-results/sample-evidence/receipt-adversary";
  const lastRun = path.join(repository, "test-results/.last-run.json");
  const integration = path.join(repository, "test-results/integration-vitest.json");
  const lastRunBaseline = await readFile(lastRun);
  const integrationBaseline = await readFile(integration);
  try {
    const sourceSnapshot = await captureGateSourceSnapshot({ projectRoot: repository, sourceRevision, outputRoot });
    assert.deepEqual(
      sourceSnapshot.baselineTestResults.map((binding) => binding.path),
      ["test-results/.last-run.json", "test-results/integration-vitest.json"],
    );
    const playwrightOutput = path.join(repository, outputRoot, "runs/fresh/artifacts/playwright-output/result.json");
    await mkdir(path.dirname(playwrightOutput), { recursive: true });
    await writeFile(playwrightOutput, "{}\n");
    await verifyGateSourceSnapshot(sourceSnapshot, repository);
    assert.deepEqual(await readFile(lastRun), lastRunBaseline);
    assert.deepEqual(await readFile(integration), integrationBaseline);

    await writeFile(lastRun, '{"status":"changed"}\n');
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /clean checkout|tracked test-results baseline/);
    await writeFile(lastRun, lastRunBaseline);

    const unrelated = path.join(repository, "test-results/ignored/forged.json");
    await mkdir(path.dirname(unrelated), { recursive: true });
    await writeFile(unrelated, "{}\n");
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /unrelated test output/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("a clean source snapshot accepts only its own fresh controlled artifact", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const outputRoot = "test-results/sample-evidence/receipt-adversary";
  try {
    const sourceSnapshot = await captureGateSourceSnapshot({ projectRoot: repository, sourceRevision, outputRoot });
    const reportPath = path.join(repository, outputRoot, "runs/fresh/artifacts/fixture.json");
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
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("source snapshot rejects producer drift and unrelated forged test output", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const outputRoot = "test-results/sample-evidence/receipt-adversary";
  try {
    const sourceSnapshot = await captureGateSourceSnapshot({ projectRoot: repository, sourceRevision, outputRoot });
    await mkdir(path.join(repository, outputRoot), { recursive: true });
    await writeFile(path.join(repository, outputRoot, "owned.json"), "{}\n");
    await writeFile(path.join(repository, "scripts/sample-runner.mjs"), "// modified producer\n");
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /clean checkout|producer changed/);

    await rm(path.join(repository, "scripts/sample-runner.mjs"));
    await copyFile(path.resolve("scripts/sample-runner.mjs"), path.join(repository, "scripts/sample-runner.mjs"));
    await mkdir(path.join(repository, "test-results/forged"), { recursive: true });
    await writeFile(path.join(repository, "test-results/forged/unrelated.json"), "{}\n");
    await assert.rejects(verifyGateSourceSnapshot(sourceSnapshot, repository), /clean checkout|unrelated test output/);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test("pre-existing controlled output cannot be captured as a fresh run", async () => {
  const { repository, sourceRevision } = await integrityRepository();
  const outputRoot = "test-results/sample-evidence/receipt-adversary";
  try {
    await mkdir(path.join(repository, outputRoot), { recursive: true });
    await writeFile(path.join(repository, outputRoot, "forged.json"), "{}\n");
    await assert.rejects(
      captureGateSourceSnapshot({ projectRoot: repository, sourceRevision, outputRoot }),
      /only its clean tracked test-results baseline/,
    );
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});
