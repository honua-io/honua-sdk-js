import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { expectedGateCommand } from "../../scripts/lib/sample-gates.mjs";
import { collectLiveEvidence } from "../../scripts/live-benchmark-evidence.mjs";
import {
  allowedLiveEnvironment,
  acquireSampleEvidenceLock,
  assertCredentialFreeContent,
  beginGateReceiptTransaction,
  ChildSupervisor,
  commandForSpawn,
  commitGateReceiptTransaction,
  forwardedLiveCredentials,
  groupEvidenceGates,
  parseRunnerArgs,
  publishGateReceiptGroup,
  publishGateReceiptGroups,
  pruneUnreferencedEvidenceRuns,
  recoverInterruptedReceiptTransactions,
  resolvePackedDeclaration,
  resolvePackedRuntimeExport,
  rollbackGateReceiptTransaction,
  safeChildEnvironment,
  validateKit,
  validatePackedTarListings,
  validateSelection,
} from "../../scripts/sample-runner.mjs";
import { liveEvidenceOutputContract } from "../../scripts/lib/live-evidence-output.mjs";
import { captureGateSourceSnapshot } from "../../scripts/sample-gate-receipt.mjs";

const gates = {
  packedBuild: true,
  browser: true,
  accessibility: true,
  console: true,
  responsive: true,
  screenshot: false,
  performance: false,
  liveEvidence: false,
};

function selection() {
  const profileGates = { ...gates };
  const sampleGates = { ...gates };
  return {
    format: "honua.sdk.sample-ci-selection.v2",
    schemaVersion: 2,
    profiles: [{ id: "browser-recipe", gates: profileGates, sampleIds: ["safe-sample"] }],
    samples: [
      {
        id: "safe-sample",
        sourcePath: "examples/safe-sample",
        track: "recipe",
        validationProfile: "browser-recipe",
        gates: sampleGates,
        commandPlan: {
          validation: {
            execution: "automatic",
            commands: ["npm run demo:safe:typecheck", "npm run demo:safe:build", "npm run test:playwright:safe"],
          },
          fixtureEvidence: { execution: "orchestrated", commands: ["npm run demo:safe:mock"] },
          liveEvidence: { execution: "scheduled-only", commands: [] },
        },
      },
    ],
  };
}

const packageScripts = {
  "demo:safe:typecheck": "tsc -p examples/safe/tsconfig.json",
  "demo:safe:build": "vite build --config examples/safe/vite.config.ts",
  "demo:safe:mock": "node examples/safe/mock-server.mjs",
  "test:playwright:safe": "playwright test test/playwright/safe.spec.mjs",
};

const artifactKinds = {
  "packed-build": "packed-build-report",
  browser: "playwright-gate-report",
  accessibility: "playwright-gate-report",
  console: "playwright-gate-report",
  responsive: "playwright-gate-report",
  screenshot: "screenshot-report",
  performance: "performance-report",
  fixture: "fixture-probe-report",
  live: "live-evidence-report",
};

function structuralReceipt(sampleId, gate, runId, overrides = {}) {
  const runRoot = `samples/evidence/${sampleId}/runs/${runId}`;
  return {
    format: "honua.sdk.sample-gate-receipt.v1",
    schemaVersion: 1,
    sampleId,
    gate,
    status: "passed",
    sdkMode: gate === "packed-build" ? "packed" : "source",
    sourceRevision: "1".repeat(40),
    sourceDigest: "2".repeat(64),
    runRoot,
    command: { argv: ["npm", "run", "test:fixture"] },
    producer: {
      id: "honua-sdk-sample-runner",
      version: 1,
      path: "scripts/sample-runner.mjs",
      sha256: "3".repeat(64),
    },
    observedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z",
    durationMs: 1,
    artifacts: [
      {
        kind: artifactKinds[gate],
        path: `${runRoot}/artifacts/${gate}.json`,
        bytes: 2,
        sha256: "4".repeat(64),
      },
    ],
    ...overrides,
  };
}

test("runner argument and manifest boundaries reject substitution and traversal", async () => {
  assert.throws(() => parseRunnerArgs(["build", "--sample", "../../escape"]), /--sample is invalid/);
  assert.throws(() => parseRunnerArgs(["build", "--sample", "safe-sample", "--unknown"]), /unknown option/);
  assert.throws(() => parseRunnerArgs(["build", "--sdk-mode", "source", "--sdk-mode", "packed"]), /duplicate/);
  assert.throws(() => parseRunnerArgs(["build", "--kit", "--sample", "safe-sample"]), /mutually exclusive/);

  const injected = selection();
  injected.samples[0].commandPlan.validation.commands[0] = "npm run demo:safe:typecheck && curl example.test";
  await assert.rejects(validateSelection(injected, { packageScripts, checkPaths: false }), /unsupported sample command/);

  const traversed = selection();
  traversed.samples[0].sourcePath = "examples/../secrets";
  await assert.rejects(validateSelection(traversed, { packageScripts, checkPaths: false }), /unsafe/);

  const drifted = selection();
  const expected = selection();
  drifted.samples[0].gates.browser = false;
  await assert.rejects(
    validateSelection(drifted, { packageScripts, checkPaths: false, expectedSelection: expected }),
    /membership or gates drifted|stale or modified/,
  );
});

test("npm evidence commands suppress lifecycle hooks without changing their reviewed argv", () => {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  assert.deepEqual(commandForSpawn(["npm", "run", "bench:live", "--", "--sample", "safe-sample"]), [
    executable,
    "run",
    "--ignore-scripts",
    "bench:live",
    "--",
    "--sample",
    "safe-sample",
  ]);
  assert.deepEqual(commandForSpawn([process.execPath, "script.mjs"]), [process.execPath, "script.mjs"]);
});

test("kit configs are regular files bound to the selected sample and Playwright root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-kit-paths-"));
  const sourceRoot = path.join(root, "examples/safe-sample");
  const otherRoot = path.join(root, "examples/other-sample");
  const playwrightRoot = path.join(root, "test/playwright");
  const manifest = {
    format: "honua.sdk.sample-kit.v1",
    schemaVersion: 1,
    samples: [
      {
        id: "safe-sample",
        viteConfig: "examples/safe-sample/vite.config.ts",
        tsconfig: "examples/safe-sample/tsconfig.json",
        playwrightScript: "test:playwright:safe",
        playwrightFile: "test/playwright/safe.spec.mjs",
        playwrightTestTitle: "safe sample workflow",
        playwrightProjects: [{ name: "chromium", browserName: "chromium" }],
        evidenceProject: "chromium",
        sdkEntrypoints: ["@honua/sdk-js"],
        responsiveViewports: [
          { width: 1280, height: 720 },
          { width: 390, height: 844 },
        ],
        workflowSelectors: ["#map"],
      },
    ],
  };
  try {
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(otherRoot, { recursive: true });
    await mkdir(playwrightRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "vite.config.ts"), "export default {};\n");
    await writeFile(path.join(sourceRoot, "tsconfig.json"), "{}\n");
    await writeFile(path.join(otherRoot, "vite.config.ts"), "export default {};\n");
    await writeFile(path.join(otherRoot, "safe.spec.mjs"), "export {};\n");
    await writeFile(path.join(playwrightRoot, "safe.spec.mjs"), "export {};\n");
    assert.equal((await validateKit(manifest, selection(), packageScripts, { projectRoot: root })).has("safe-sample"), true);

    const duplicateBrowser = structuredClone(manifest);
    duplicateBrowser.samples[0].playwrightProjects.push({ name: "firefox-alias", browserName: "chromium" });
    await assert.rejects(
      validateKit(duplicateBrowser, selection(), packageScripts, { projectRoot: root }),
      /Playwright projects are invalid/,
    );

    const missingEvidenceProject = structuredClone(manifest);
    missingEvidenceProject.samples[0].evidenceProject = "firefox";
    await assert.rejects(
      validateKit(missingEvidenceProject, selection(), packageScripts, { projectRoot: root }),
      /evidence project is invalid/,
    );

    const traversed = structuredClone(manifest);
    traversed.samples[0].viteConfig = "examples/safe-sample/../other-sample/vite.config.ts";
    await assert.rejects(validateKit(traversed, selection(), packageScripts, { projectRoot: root }), /unsafe/);

    const crossSample = structuredClone(manifest);
    crossSample.samples[0].viteConfig = "examples/other-sample/vite.config.ts";
    await assert.rejects(validateKit(crossSample, selection(), packageScripts, { projectRoot: root }), /inside examples\/safe-sample/);

    const crossPlaywright = structuredClone(manifest);
    crossPlaywright.samples[0].playwrightFile = "examples/other-sample/safe.spec.mjs";
    await assert.rejects(
      validateKit(
        crossPlaywright,
        selection(),
        { ...packageScripts, "test:playwright:safe": "playwright test examples/other-sample/safe.spec.mjs" },
        { projectRoot: root },
      ),
      /inside test\/playwright/,
    );

    await symlink(path.join(sourceRoot, "vite.config.ts"), path.join(sourceRoot, "linked-vite.config.ts"));
    const linked = structuredClone(manifest);
    linked.samples[0].viteConfig = "examples/safe-sample/linked-vite.config.ts";
    await assert.rejects(validateKit(linked, selection(), packageScripts, { projectRoot: root }), /regular non-symlink/);

    await symlink(otherRoot, path.join(root, "examples/linked-sample"), "dir");
    const linkedSelection = selection();
    linkedSelection.samples[0].sourcePath = "examples/linked-sample";
    await assert.rejects(
      validateSelection(linkedSelection, { packageScripts, projectRoot: root }),
      /sourcePath must be a regular non-symlink repository directory/,
    );

    const alternatePlaywrightRoot = path.join(root, "alternate-playwright");
    await mkdir(alternatePlaywrightRoot, { recursive: true });
    await writeFile(path.join(alternatePlaywrightRoot, "safe.spec.mjs"), "export {};\n");
    await rm(playwrightRoot, { recursive: true, force: true });
    await symlink(alternatePlaywrightRoot, playwrightRoot, "dir");
    await assert.rejects(
      validateKit(manifest, selection(), packageScripts, { projectRoot: root }),
      /test\/playwright must be a regular non-symlink directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture evidence binds the fixture command and browser evidence binds a local reporter", () => {
  const sample = selection().samples[0];
  assert.deepEqual(expectedGateCommand(sample, "fixture"), ["npm", "run", "demo:safe:mock", "--", "--evidence-once"]);
  assert.deepEqual(expectedGateCommand(sample, "accessibility"), [
    "npm",
    "run",
    "test:playwright:safe",
    "--",
    "--reporter=json",
  ]);
  assert.deepEqual(expectedGateCommand(sample, "screenshot"), expectedGateCommand(sample, "accessibility"));
  assert.deepEqual(expectedGateCommand(sample, "performance"), expectedGateCommand(sample, "accessibility"));

  const groups = groupEvidenceGates(sample, ["browser", "screenshot", "performance", "fixture", "packed-build"]);
  assert.deepEqual(
    groups.map((group) => group.gates),
    [["browser", "screenshot", "performance"], ["fixture"], ["packed-build"]],
  );
});

test("packed archive preflight rejects traversal, links, and declared decompression bombs", () => {
  assert.deepEqual(
    validatePackedTarListings(
      "package/dist/x.js\n",
      "-rw-r--r-- 0/0 1 2026-01-01 00:00 package/dist/x.js\n",
    ),
    { members: ["package/dist/x.js"], declaredBytes: 1 },
  );
  assert.throws(
    () => validatePackedTarListings("package/../escape\n", "-rw-r--r-- 0/0 1 2026-01-01 00:00 package/../escape\n"),
    /unsafe packed SDK tar member/,
  );
  assert.throws(
    () =>
      validatePackedTarListings(
        "package/link\n",
        "lrwxrwxrwx 0/0 0 2026-01-01 00:00 package/link -> /etc/passwd\n",
      ),
    /link, device, or unsupported member/,
  );
  assert.throws(
    () =>
      validatePackedTarListings(
        "package/huge.bin\n",
        "-rw-r--r-- 0/0 134217729 2026-01-01 00:00 package/huge.bin\n",
      ),
    /pre-extraction limit/,
  );
  assert.throws(
    () =>
      validatePackedTarListings(
        "package/dist/x.js\npackage/dist/x.js\n",
        [
          "-rw-r--r-- 0/0 1 2026-01-01 00:00 package/dist/x.js",
          "-rw-r--r-- 0/0 1 2026-01-01 00:00 package/dist/x.js",
          "",
        ].join("\n"),
      ),
    /duplicate packed SDK tar member/,
  );
  assert.throws(
    () =>
      validatePackedTarListings(
        "package/./dist/x.js\n",
        "-rw-r--r-- 0/0 1 2026-01-01 00:00 package/./dist/x.js\n",
      ),
    /noncanonical packed SDK tar member/,
  );
});

test("packed declaration resolution rejects traversal and symlink exports", async () => {
  const sdkRoot = await mkdtemp(path.join(os.tmpdir(), "honua-packed-types-"));
  const outside = path.join(sdkRoot, "outside.d.ts");
  const runtimeOutside = path.join(sdkRoot, "outside.js");
  await mkdir(path.join(sdkRoot, "dist"), { recursive: true });
  await writeFile(outside, "export {};\n");
  await writeFile(runtimeOutside, "export {};\n");
  await symlink(outside, path.join(sdkRoot, "dist/linked.d.ts"));
  await symlink(runtimeOutside, path.join(sdkRoot, "dist/linked.js"));
  try {
    await assert.rejects(resolvePackedDeclaration(sdkRoot, "./dist/../../outside.d.ts"), /unsafe declaration export/);
    await assert.rejects(resolvePackedDeclaration(sdkRoot, "./dist/linked.d.ts"), /bounded contained regular file/);
    await assert.rejects(resolvePackedRuntimeExport(sdkRoot, "./dist/../../outside.js"), /unsafe runtime export/);
    await assert.rejects(resolvePackedRuntimeExport(sdkRoot, "./dist/linked.js"), /bounded contained regular file/);
  } finally {
    await rm(sdkRoot, { recursive: true, force: true });
  }
});

test("child environment strips host secrets and undefined overrides", () => {
  const previous = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_SECRET_ACCESS_KEY = "must-not-leak";
  try {
    const environment = safeChildEnvironment({ HONUA_SAMPLE_SDK_DIR: undefined, FIXED: "yes" });
    assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(environment.HONUA_SAMPLE_SDK_DIR, undefined);
    assert.equal(environment.FIXED, "yes");
  } finally {
    if (previous === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previous;
  }
});

test("fixture mock CLIs reject unknown arguments before binding a server", () => {
  for (const file of ["examples/service-explorer/mock-server.mjs", "examples/standalone-quickstart/mock-server.mjs"]) {
    const result = spawnSync(process.execPath, [file, "--not-a-real-mode"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /MockUrl=/);
    assert.match(result.stderr, /Unknown .* fixture server argument/);
  }
});

test("live environment classification never forwards browser-public credentials", () => {
  assert.deepEqual(
    allowedLiveEnvironment({
      data: {
        config: ["PUBLIC_TOKEN", "PUBLIC_URL", "SERVER_TOKEN"],
        configClassifications: [
          { name: "PUBLIC_TOKEN", exposure: "browser-public", valueKind: "credential" },
          { name: "PUBLIC_URL", exposure: "browser-public", valueKind: "non-secret" },
          { name: "SERVER_TOKEN", exposure: "server-only", valueKind: "credential" },
        ],
      },
    }),
    ["PUBLIC_URL", "SERVER_TOKEN"],
  );
});

test("forwarded live credential values are rejected from canonical evidence bytes", () => {
  const previous = process.env.SERVER_TOKEN;
  process.env.SERVER_TOKEN = "exact-sensitive-value";
  try {
    const catalogSample = {
      data: {
        config: ["SERVER_TOKEN"],
        configClassifications: [{ name: "SERVER_TOKEN", exposure: "server-only", valueKind: "credential" }],
      },
    };
    const credentials = forwardedLiveCredentials(catalogSample);
    assert.deepEqual(credentials, [{ name: "SERVER_TOKEN", value: "exact-sensitive-value" }]);
    assert.throws(
      () => assertCredentialFreeContent(Buffer.from('{"assertion":"exact-sensitive-value"}'), credentials, "evidence"),
      /contains forwarded credential SERVER_TOKEN/,
    );
    assert.doesNotThrow(() => assertCredentialFreeContent(Buffer.from('{"assertion":"redacted"}'), credentials, "evidence"));
  } finally {
    if (previous === undefined) delete process.env.SERVER_TOKEN;
    else process.env.SERVER_TOKEN = previous;
  }
});

test("reviewed live producers honor the explicit per-run output contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-live-contract-"));
  const output = path.join(root, "live-evidence.json");
  const sourceRevision = "1".repeat(40);
  const prior = {
    output: process.env.HONUA_SAMPLE_LIVE_OUTPUT,
    sample: process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID,
    revision: process.env.HONUA_SAMPLE_SOURCE_REVISION,
  };
  try {
    process.env.HONUA_SAMPLE_LIVE_OUTPUT = output;
    process.env.HONUA_SAMPLE_LIVE_SAMPLE_ID = "ai-spatial-app-builder";
    process.env.HONUA_SAMPLE_SOURCE_REVISION = sourceRevision;
    assert.deepEqual(liveEvidenceOutputContract("ai-spatial-app-builder", "ignored.json"), {
      output,
      sourceRevision,
    });
    const result = spawnSync(process.execPath, ["examples/ai-spatial-app-builder/live-evidence.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HONUA_SAMPLE_LIVE_OUTPUT: output,
        HONUA_SAMPLE_LIVE_SAMPLE_ID: "ai-spatial-app-builder",
        HONUA_SAMPLE_SOURCE_REVISION: sourceRevision,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(output, "utf8"));
    assert.equal(evidence.sampleId, "ai-spatial-app-builder");
    assert.equal(evidence.sdk.gitCommit, sourceRevision);
    assert.equal(evidence.status, "skipped");
  } finally {
    for (const [name, value] of [
      ["HONUA_SAMPLE_LIVE_OUTPUT", prior.output],
      ["HONUA_SAMPLE_LIVE_SAMPLE_ID", prior.sample],
      ["HONUA_SAMPLE_SOURCE_REVISION", prior.revision],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("the runner's generic live enable flag activates the reviewed benchmark producer", async () => {
  const evidence = await collectLiveEvidence({
    HONUA_SAMPLE_LIVE_ENABLED: "true",
    HONUA_BENCH_LIVE_SKIP_HONUA_REASON: "unit test avoids external Honua probes",
    HONUA_BENCH_LIVE_SKIP_AWS_REASON: "unit test avoids external AWS probes",
  });
  assert.equal(evidence.run.status, "skipped");
  assert.equal(evidence.run.skipReason, "Every configured target was skipped");
  assert.equal(evidence.targets.length, 3);
  assert.ok(evidence.targets.every((target) => target.sampleEvidence?.lane === "live"));
});

test("evidence run pruning preserves receipt-bound runs and removes only UUID orphans", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-prune-"));
  const sampleId = "safe-sample";
  const baseRoot = path.join(root, "samples/evidence", sampleId);
  const referenced = "11111111-1111-4111-8111-111111111111";
  const orphan = "22222222-2222-4222-8222-222222222222";
  try {
    await mkdir(path.join(baseRoot, "receipts"), { recursive: true });
    await mkdir(path.join(baseRoot, "runs", referenced), { recursive: true });
    await mkdir(path.join(baseRoot, "runs", orphan), { recursive: true });
    await writeFile(
      path.join(baseRoot, "receipts/fixture.v1.json"),
      `${JSON.stringify(structuralReceipt(sampleId, "fixture", referenced))}\n`,
    );
    await pruneUnreferencedEvidenceRuns(baseRoot, sampleId, { projectRoot: root });
    assert.deepEqual(await readdir(path.join(baseRoot, "runs")), [referenced]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence pruning validates every receipt binding before deleting any run", async () => {
  const sampleId = "safe-sample";
  const runId = "11111111-1111-4111-8111-111111111111";
  const cases = [
    ["sample", (receipt) => ({ ...receipt, sampleId: "other-sample" })],
    ["gate", (receipt) => ({ ...receipt, gate: "browser" })],
    ["format", (receipt) => ({ ...receipt, format: "forged" })],
    ["status", (receipt) => ({ ...receipt, status: "failed" })],
    ["artifact", (receipt) => ({
      ...receipt,
      artifacts: [{ ...receipt.artifacts[0], path: "samples/evidence/other-sample/runs/escape/artifact.json" }],
    })],
  ];
  for (const [name, mutate] of cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), `honua-evidence-prune-${name}-`));
    const baseRoot = path.join(root, "samples/evidence", sampleId);
    const sentinel = path.join(baseRoot, "runs", runId, "must-survive.txt");
    try {
      await mkdir(path.join(baseRoot, "receipts"), { recursive: true });
      await mkdir(path.dirname(sentinel), { recursive: true });
      await writeFile(sentinel, "preserve on invalid receipt\n");
      await writeFile(
        path.join(baseRoot, "receipts/fixture.v1.json"),
        `${JSON.stringify(mutate(structuralReceipt(sampleId, "fixture", runId)))}\n`,
      );
      await assert.rejects(pruneUnreferencedEvidenceRuns(baseRoot, sampleId, { projectRoot: root }));
      assert.equal(await readFile(sentinel, "utf8"), "preserve on invalid receipt\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("sample evidence locks serialize runners and reclaim an ownerless stale lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-lock-"));
  try {
    const first = await acquireSampleEvidenceLock("safe-sample", { projectRoot: root });
    await assert.rejects(
      acquireSampleEvidenceLock("other-sample", { projectRoot: root }),
      /another sample evidence run is active/,
    );
    await first.release();

    const lockRoot = path.join(root, ".tmp/sample-runner-locks");
    const stale = path.join(lockRoot, "evidence");
    await mkdir(stale);
    await writeFile(path.join(stale, "owner.json"), '{"pid":0,"token":"invalid"}\n');
    const replacement = await acquireSampleEvidenceLock("safe-sample", { projectRoot: root });
    await replacement.release();
    assert.deepEqual(await readdir(lockRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only a lock-owned receipt guard can recover interrupted publication", async () => {
  const sampleId = "safe-sample";
  const oldRunId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-recovery-"));
  const baseRoot = path.join(root, "samples/evidence", sampleId);
  const runRoot = path.join(baseRoot, "runs", runId);
  const receiptRoot = path.join(baseRoot, "receipts");
  const previous = path.join(runRoot, "receipt-transaction-previous");
  const next = path.join(runRoot, "receipt-transaction-next");
  const original = Buffer.from(`${JSON.stringify(structuralReceipt(sampleId, "browser", oldRunId))}\n`);
  let lock;
  try {
    await mkdir(path.join(baseRoot, "runs", oldRunId), { recursive: true });
    await mkdir(previous, { recursive: true });
    await mkdir(next);
    await mkdir(receiptRoot);
    await writeFile(path.join(receiptRoot, "browser.v1.json"), original);
    await writeFile(path.join(previous, "browser.v1.json"), "planted rollback bytes\n");
    await writeFile(path.join(next, "browser.v1.json"), "planted publication bytes\n");

    assert.equal(await recoverInterruptedReceiptTransactions(baseRoot, sampleId, { projectRoot: root }), false);
    assert.deepEqual(await readFile(path.join(receiptRoot, "browser.v1.json")), original);
    assert.deepEqual((await readdir(runRoot)).sort(), ["receipt-transaction-next", "receipt-transaction-previous"]);

    lock = await acquireSampleEvidenceLock(sampleId, { projectRoot: root });
    await beginGateReceiptTransaction({ baseRoot, evidenceLock: lock, projectRoot: root, sampleId });
    await writeFile(path.join(receiptRoot, "browser.v1.json"), "corrupted by producer\n");
    assert.equal(
      await recoverInterruptedReceiptTransactions(baseRoot, sampleId, {
        projectRoot: root,
        transactionRoot: lock.path,
      }),
      true,
    );
    assert.deepEqual(await readFile(path.join(receiptRoot, "browser.v1.json")), original);
  } finally {
    await lock?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("multi-group receipt publication restores byte-identical prior receipts and prunes failed runs", async () => {
  const sampleId = "safe-sample";
  const oldRunId = "11111111-1111-4111-8111-111111111111";
  const browserRunId = "22222222-2222-4222-8222-222222222222";
  const accessibilityRunId = "33333333-3333-4333-8333-333333333333";
  const failurePoints = [
    "before-stage-write:accessibility",
    "before-publish-rename",
    "after-publish-rename",
  ];
  for (const failurePoint of failurePoints) {
    const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-transaction-"));
    const baseRoot = path.join(root, "samples/evidence", sampleId);
    const receiptRoot = path.join(baseRoot, "receipts");
    const oldRunRoot = path.join(baseRoot, "runs", oldRunId);
    const browserRunRoot = path.join(baseRoot, "runs", browserRunId);
    const accessibilityRunRoot = path.join(baseRoot, "runs", accessibilityRunId);
    const oldBytes = new Map([
      [
        "browser.v1.json",
        Buffer.from(`${JSON.stringify(structuralReceipt(sampleId, "browser", oldRunId))}\n`),
      ],
      [
        "accessibility.v1.json",
        Buffer.from(`${JSON.stringify(structuralReceipt(sampleId, "accessibility", oldRunId))}\n`),
      ],
    ]);
    let lock;
    let transaction;
    try {
      await mkdir(receiptRoot, { recursive: true });
      await mkdir(oldRunRoot, { recursive: true });
      await mkdir(browserRunRoot, { recursive: true });
      await mkdir(accessibilityRunRoot, { recursive: true });
      await writeFile(path.join(oldRunRoot, "sentinel.txt"), "old run\n");
      await writeFile(path.join(browserRunRoot, "sentinel.txt"), "new browser run\n");
      await writeFile(path.join(accessibilityRunRoot, "sentinel.txt"), "new accessibility run\n");
      for (const [name, bytes] of oldBytes) await writeFile(path.join(receiptRoot, name), bytes);
      lock = await acquireSampleEvidenceLock(sampleId, { projectRoot: root });
      transaction = await beginGateReceiptTransaction({
        baseRoot,
        evidenceLock: lock,
        projectRoot: root,
        sampleId,
      });

      await assert.rejects(
        publishGateReceiptGroups({
          baseRoot,
          sampleId,
          projectRoot: root,
          transaction,
          groups: [
            {
              runRoot: browserRunRoot,
              receipts: [
                {
                  gate: "browser",
                  receipt: structuralReceipt(sampleId, "browser", browserRunId),
                },
              ],
            },
            {
              runRoot: accessibilityRunRoot,
              receipts: [
                {
                  gate: "accessibility",
                  receipt: structuralReceipt(sampleId, "accessibility", accessibilityRunId),
                },
              ],
            },
          ],
          fault(point) {
            if (point === failurePoint) throw new Error(`injected receipt transaction failure: ${point}`);
          },
        }),
        new RegExp(failurePoint.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      await rollbackGateReceiptTransaction(transaction);
      for (const [name, bytes] of oldBytes) {
        assert.deepEqual(await readFile(path.join(receiptRoot, name)), bytes, `${failurePoint}: ${name}`);
      }

      await pruneUnreferencedEvidenceRuns(baseRoot, sampleId, { projectRoot: root });
      assert.deepEqual(await readdir(path.join(baseRoot, "runs")), [oldRunId]);
      assert.equal(await readFile(path.join(oldRunRoot, "sentinel.txt"), "utf8"), "old run\n");
    } finally {
      if (transaction && !transaction.closed) {
        await rollbackGateReceiptTransaction(transaction).catch(() => {});
      }
      await lock?.release().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a committed guarded publication retains only the newly referenced run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-commit-"));
  const sampleId = "safe-sample";
  const oldRunId = "11111111-1111-4111-8111-111111111111";
  const newRunId = "22222222-2222-4222-8222-222222222222";
  const baseRoot = path.join(root, "samples/evidence", sampleId);
  const receiptRoot = path.join(baseRoot, "receipts");
  const newRunRoot = path.join(baseRoot, "runs", newRunId);
  let lock;
  try {
    await mkdir(path.join(baseRoot, "runs", oldRunId), { recursive: true });
    await mkdir(newRunRoot);
    await mkdir(receiptRoot);
    await writeFile(
      path.join(receiptRoot, "fixture.v1.json"),
      `${JSON.stringify(structuralReceipt(sampleId, "fixture", oldRunId))}\n`,
    );
    lock = await acquireSampleEvidenceLock(sampleId, { projectRoot: root });
    const transaction = await beginGateReceiptTransaction({
      baseRoot,
      evidenceLock: lock,
      projectRoot: root,
      sampleId,
    });
    await publishGateReceiptGroup({
      baseRoot,
      projectRoot: root,
      receipts: [{ gate: "fixture", receipt: structuralReceipt(sampleId, "fixture", newRunId) }],
      runRoot: newRunRoot,
      sampleId,
      transaction,
    });
    await commitGateReceiptTransaction(transaction);
    await pruneUnreferencedEvidenceRuns(baseRoot, sampleId, { projectRoot: root });
    assert.deepEqual(await readdir(path.join(baseRoot, "runs")), [newRunId]);
    assert.equal(JSON.parse(await readFile(path.join(receiptRoot, "fixture.v1.json"), "utf8")).runRoot.endsWith(newRunId), true);
    assert.deepEqual((await readdir(lock.path)).sort(), ["owner.json"]);
  } finally {
    await lock?.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a pre-execution guard restores producer receipt mutations exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-guard-"));
  const sampleId = "safe-sample";
  const oldRunId = "11111111-1111-4111-8111-111111111111";
  const baseRoot = path.join(root, "samples/evidence", sampleId);
  const receiptRoot = path.join(baseRoot, "receipts");
  const oldBytes = Buffer.from(`${JSON.stringify(structuralReceipt(sampleId, "browser", oldRunId))}\n`);
  let lock;
  try {
    await mkdir(path.join(baseRoot, "runs", oldRunId), { recursive: true });
    await mkdir(receiptRoot);
    await writeFile(path.join(receiptRoot, "browser.v1.json"), oldBytes);
    lock = await acquireSampleEvidenceLock(sampleId, { projectRoot: root });
    const transaction = await beginGateReceiptTransaction({
      baseRoot,
      evidenceLock: lock,
      projectRoot: root,
      sampleId,
    });
    await rm(path.join(receiptRoot, "browser.v1.json"));
    await writeFile(path.join(receiptRoot, "fixture.v1.json"), "producer-forged receipt\n");
    await rollbackGateReceiptTransaction(transaction);
    assert.deepEqual(await readdir(receiptRoot), ["browser.v1.json"]);
    assert.deepEqual(await readFile(path.join(receiptRoot, "browser.v1.json")), oldBytes);
  } finally {
    await lock?.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("tampered receipt guards fail closed without promoting their bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-guard-tamper-"));
  const sampleId = "safe-sample";
  const oldRunId = "11111111-1111-4111-8111-111111111111";
  const baseRoot = path.join(root, "samples/evidence", sampleId);
  const receiptRoot = path.join(baseRoot, "receipts");
  const oldBytes = Buffer.from(`${JSON.stringify(structuralReceipt(sampleId, "browser", oldRunId))}\n`);
  let lock;
  try {
    await mkdir(path.join(baseRoot, "runs", oldRunId), { recursive: true });
    await mkdir(receiptRoot);
    await writeFile(path.join(receiptRoot, "browser.v1.json"), oldBytes);
    lock = await acquireSampleEvidenceLock(sampleId, { projectRoot: root });
    await beginGateReceiptTransaction({ baseRoot, evidenceLock: lock, projectRoot: root, sampleId });
    await writeFile(path.join(lock.path, "receipt-guard/previous/browser.v1.json"), "tampered guard\n");
    await assert.rejects(
      recoverInterruptedReceiptTransactions(baseRoot, sampleId, {
        projectRoot: root,
        transactionRoot: lock.path,
      }),
      /guarded receipt bytes are invalid/,
    );
    assert.deepEqual(await readFile(path.join(receiptRoot, "browser.v1.json")), oldBytes);
  } finally {
    await lock?.release().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("capture failure cannot prune through symlinked canonical runs or receipts", async () => {
  const sampleId = "safe-sample";
  const runId = "33333333-3333-4333-8333-333333333333";
  for (const linkedDirectory of ["runs", "receipts"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), `honua-evidence-${linkedDirectory}-`));
    const external = await mkdtemp(path.join(os.tmpdir(), `honua-evidence-external-${linkedDirectory}-`));
    const baseRoot = path.join(root, "samples/evidence", sampleId);
    const protectedExternal = path.join(external, "must-survive.txt");
    const protectedRun = path.join(baseRoot, "runs", runId, "must-survive.txt");
    try {
      await mkdir(baseRoot, { recursive: true });
      await writeFile(protectedExternal, "outside evidence cleanup\n");
      if (linkedDirectory === "runs") {
        await mkdir(path.join(baseRoot, "receipts"));
        await mkdir(path.join(external, runId));
        await writeFile(path.join(external, runId, "must-survive.txt"), "outside UUID run\n");
        await symlink(external, path.join(baseRoot, "runs"), "dir");
      } else {
        await mkdir(path.dirname(protectedRun), { recursive: true });
        await writeFile(protectedRun, "local UUID run\n");
        await symlink(external, path.join(baseRoot, "receipts"), "dir");
      }

      await assert.rejects(
        async () => {
          try {
            await captureGateSourceSnapshot({
              projectRoot: root,
              sourceRevision: "1".repeat(40),
              outputRoot: `samples/evidence/${sampleId}`,
              runRoot: `samples/evidence/${sampleId}/runs/${runId}`,
            });
          } finally {
            await pruneUnreferencedEvidenceRuns(baseRoot, sampleId, { projectRoot: root });
          }
        },
        /symlink|canonical|non-directory/,
      );
      assert.equal(await readFile(protectedExternal, "utf8"), "outside evidence cleanup\n");
      if (linkedDirectory === "runs") {
        assert.equal(await readFile(path.join(external, runId, "must-survive.txt"), "utf8"), "outside UUID run\n");
      } else {
        assert.equal(await readFile(protectedRun, "utf8"), "local UUID run\n");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  }
});

test("evidence pruning rejects receipt-file symlinks before deleting an orphan run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-receipt-file-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "honua-evidence-external-receipt-file-"));
  const sampleId = "safe-sample";
  const runId = "44444444-4444-4444-8444-444444444444";
  const baseRoot = path.join(root, "samples/evidence", sampleId);
  const runSentinel = path.join(baseRoot, "runs", runId, "must-survive.txt");
  const externalReceipt = path.join(external, "fixture.v1.json");
  try {
    await mkdir(path.join(baseRoot, "receipts"), { recursive: true });
    await mkdir(path.dirname(runSentinel), { recursive: true });
    await writeFile(runSentinel, "local UUID run\n");
    await writeFile(
      externalReceipt,
      `${JSON.stringify({ runRoot: `samples/evidence/${sampleId}/runs/${runId}` })}\n`,
    );
    await symlink(externalReceipt, path.join(baseRoot, "receipts/fixture.v1.json"));

    await assert.rejects(
      pruneUnreferencedEvidenceRuns(baseRoot, sampleId, { projectRoot: root }),
      /receipt tree contains an unsafe entry/,
    );
    assert.equal(await readFile(runSentinel, "utf8"), "local UUID run\n");
    assert.match(await readFile(externalReceipt, "utf8"), /runRoot/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("suppressed live output cannot capture, echo, or persist an allowed credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-live-output-"));
  const supervisor = new ChildSupervisor();
  const name = "HONUA_TEST_LIVE_CREDENTIAL";
  const secret = "credential-must-not-enter-evidence";
  const previous = process.env[name];
  process.env[name] = secret;
  try {
    const result = await supervisor.run([process.execPath, "-e", `process.stdout.write(process.env.${name})`], {
      allowedEnvironmentNames: [name],
      echoOutput: false,
      captureOutput: false,
    });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    await supervisor.stop("SIGKILL", 10);
    await rm(root, { recursive: true, force: true });
  }
});

test("child supervisor waits for flushed logs and bounds hung process groups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "honua-sample-runner-"));
  const log = path.join(root, "run.log");
  const supervisor = new ChildSupervisor();
  try {
    await supervisor.run([process.execPath, "-e", "process.stdout.write('last-byte')"], { artifactPath: log });
    const content = await readFile(log, "utf8");
    assert.match(content, /last-byte/);
    assert.match(content, /"exitCode":0/);

    const hanging = assert.rejects(supervisor.run([
      process.execPath,
      "-e",
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)",
    ]), /SIGTERM|SIGKILL|exit/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supervisor.stop("SIGTERM", 50);
    await hanging;
  } finally {
    await supervisor.stop("SIGKILL", 10);
    await rm(root, { recursive: true, force: true });
  }
});
