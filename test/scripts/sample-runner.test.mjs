import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { expectedGateCommand } from "../../scripts/lib/sample-gates.mjs";
import {
  allowedLiveEnvironment,
  ChildSupervisor,
  parseRunnerArgs,
  resolvePackedDeclaration,
  resolvePackedRuntimeExport,
  safeChildEnvironment,
  validateKit,
  validatePackedTarListings,
  validateSelection,
} from "../../scripts/sample-runner.mjs";

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
        playwrightProject: "",
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
    ]), /SIGKILL|exit/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await supervisor.stop("SIGTERM", 50);
    await hanging;
  } finally {
    await supervisor.stop("SIGKILL", 10);
    await rm(root, { recursive: true, force: true });
  }
});
