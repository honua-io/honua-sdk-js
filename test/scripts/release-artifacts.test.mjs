import assert from "node:assert/strict";
import test from "node:test";

import {
  collectReleaseArtifactInputs,
  evaluateReleaseArtifacts,
  npmPublishInvocations,
  splitPackagesFromGenerator,
  splitPackagesFromVerifier,
  validateReleaseArtifactsManifest,
  workflowTagTriggers,
} from "../../scripts/verify-release-artifacts.mjs";

// config/release-artifacts.v1.json is the only written-down answer to "what is
// in this release cut" (#1337 AC5). Before it existed the answer lived in six
// hardcoded publish lines, and `@honua/react` / `@honua/geometry` were
// documented while 404ing at 0.0.19 because nothing compared the two. These
// tests prove the manifest still matches the real generator, the real
// workflows, and the real package tree -- and, with fixtures, that each way of
// drifting is actually caught rather than merely described.

const inputs = await collectReleaseArtifactInputs();

/** Deep-clone the real inputs so a fixture can mutate one fact in isolation. */
function withInputs(mutate) {
  const copy = {
    manifest: structuredClone(inputs.manifest),
    generatorSource: inputs.generatorSource,
    splitVerifierSource: inputs.splitVerifierSource,
    workflows: structuredClone(inputs.workflows),
    packageManifests: structuredClone(inputs.packageManifests),
    releasePleaseConfig: structuredClone(inputs.releasePleaseConfig),
  };
  mutate(copy);
  return evaluateReleaseArtifacts(copy).errors;
}

function includedArtifact(manifest, npmName) {
  const artifact = manifest.included.find((entry) => entry.npmName === npmName);
  assert.ok(artifact, `no included artifact named ${npmName}`);
  return artifact;
}

test("the committed manifest satisfies its own schema", async () => {
  const errors = await validateReleaseArtifactsManifest(inputs.manifest, inputs.schema);
  assert.deepEqual(errors, []);
});

test("the committed manifest describes the repository as it is today", () => {
  const { errors } = evaluateReleaseArtifacts(inputs);
  assert.deepEqual(errors, []);
});

test("the cut covers the coordinated SDK, the split SDK, React, app-platform, and MCP", () => {
  // The acceptance criterion names these by hand; assert them by hand so a
  // manifest edit that quietly drops one is a test failure, not a silent
  // narrowing of the release.
  const names = inputs.manifest.included.map((artifact) => artifact.npmName).sort();
  assert.deepEqual(names, [
    "@honua/app-platform",
    "@honua/geometry",
    "@honua/mcp-server",
    "@honua/react",
    "@honua/sdk",
    "@honua/sdk-esri-compat",
    "@honua/sdk-js",
    "create-honua-app",
  ]);
});

test("every exclusion carries a reason", () => {
  for (const artifact of inputs.manifest.excluded) {
    assert.ok(
      typeof artifact.reason === "string" && artifact.reason.length >= 40,
      `exclusion "${artifact.id}" has no substantive reason`,
    );
  }
});

test("the split package list is derived from the generator, not restated", () => {
  const generated = splitPackagesFromGenerator(inputs.generatorSource);
  assert.deepEqual(generated.map((entry) => entry.npmName).sort(), [
    "@honua/app-platform",
    "@honua/geometry",
    "@honua/react",
    "@honua/sdk",
    "@honua/sdk-esri-compat",
  ]);
  assert.deepEqual(splitPackagesFromVerifier(inputs.splitVerifierSource), generated);
});

test("publish invocations are read out of the workflows themselves", () => {
  const jsSdk = inputs.workflows[".github/workflows/publish-js-sdk.yml"];
  assert.deepEqual(workflowTagTriggers(jsSdk.parsed), ["js-sdk-*"]);
  assert.deepEqual(
    npmPublishInvocations(jsSdk.parsed).map((entry) => entry.argument),
    [
      ".",
      "./dist/packages/honua-sdk",
      "./dist/packages/honua-sdk-esri-compat",
      "./dist/packages/honua-react",
      "./dist/packages/honua-geometry",
      "./dist/packages/honua-app-platform",
    ],
  );

  // The single-package workflows publish their working directory with no path
  // argument at all; the manifest must describe that shape, not invent one.
  const mcp = inputs.workflows[".github/workflows/publish-mcp-server.yml"];
  assert.deepEqual(npmPublishInvocations(mcp.parsed), [{ workingDirectory: "mcp", argument: "" }]);
});

test("a new split package that never joined the manifest fails the gate", () => {
  // The exact regression AC5 exists for: prepare-split-packages.mjs grows a
  // package, publish-js-sdk.yml grows a publish line, and nothing declares it.
  const errors = withInputs((copy) => {
    copy.generatorSource += [
      "",
      "function createTilingPackage() {",
      '  const packageRoot = path.join(OUTPUT_ROOT, "honua-tiling");',
      "  writePackageJson(packageRoot, {",
      '    name: "@honua/tiling",',
      "  });",
      "}",
      "",
    ].join("\n");
  });
  assert.ok(
    errors.some((error) => error.includes("drifted from scripts/prepare-split-packages.mjs")),
    errors.join("\n"),
  );
});

test("a split package the split verifier stopped checking fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.splitVerifierSource = copy.splitVerifierSource.replace(
      '  "@honua/geometry": path.join(PACKAGES_ROOT, "honua-geometry"),\n',
      "",
    );
  });
  assert.ok(
    errors.some((error) => error.includes("scripts/verify-split-packages.mjs verifies")),
    errors.join("\n"),
  );
});

test("a package the manifest includes but the workflow never publishes fails the gate", () => {
  const errors = withInputs((copy) => {
    const workflow = copy.workflows[".github/workflows/publish-js-sdk.yml"];
    for (const job of Object.values(workflow.parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === "string") {
          step.run = step.run.replace('publish_package "./dist/packages/honua-react"\n', "");
        }
      }
    }
  });
  assert.ok(
    errors.some((error) => error.includes("publish-js-sdk.yml publishes")),
    errors.join("\n"),
  );
});

test("a package the workflow publishes but the manifest omits fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.manifest.included = copy.manifest.included.filter((artifact) => artifact.npmName !== "@honua/app-platform");
  });
  // Both halves fire: the generator still emits it, and the workflow still
  // publishes it.
  assert.ok(
    errors.some((error) => error.includes("drifted from scripts/prepare-split-packages.mjs")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((error) => error.includes("publish-js-sdk.yml publishes")),
    errors.join("\n"),
  );
});

test("a new publishable package that is neither included nor excluded fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.packageManifests["packages/honua-cli/package.json"] = {
      name: "@honua/cli",
      version: "0.1.0",
    };
  });
  assert.ok(
    errors.some(
      (error) =>
        error.includes("packages/honua-cli/package.json") &&
        error.includes("neither the included nor the excluded list"),
    ),
    errors.join("\n"),
  );
});

test("an excluded package that stops being private fails the gate", () => {
  // An exclusion is only credible while the package genuinely cannot be
  // published. Dropping `private` turns a template into a publishable package
  // that nothing in the cut owns.
  const errors = withInputs((copy) => {
    copy.packageManifests["packages/create-honua-app/templates/react-ts/package.json"].private = false;
  });
  assert.ok(
    errors.some((error) => error.includes("is excluded from the release cut but is not private")),
    errors.join("\n"),
  );
});

test("a generated playground that stops being private fails the tree exclusion", () => {
  const [playground] = Object.keys(inputs.packageManifests).filter((entry) => entry.startsWith("playgrounds/"));
  assert.ok(playground, "expected at least one tracked playground manifest");
  const errors = withInputs((copy) => {
    delete copy.packageManifests[playground].private;
  });
  assert.ok(
    errors.some((error) => error.includes(playground) && error.includes("tree exclusion")),
    errors.join("\n"),
  );
});

test("an artifact whose name drifted from its package.json fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.packageManifests["mcp/package.json"].name = "@honua/mcp";
  });
  assert.ok(
    errors.some((error) => error.includes('mcp/package.json is declared as "@honua/mcp-server"')),
    errors.join("\n"),
  );
});

test("a publish target that is not the artifact's own directory fails the gate", () => {
  const errors = withInputs((copy) => {
    includedArtifact(copy.manifest, "@honua/geometry").publish.publishArgument = "./dist/packages/honua-geo";
  });
  assert.ok(
    errors.some((error) => error.includes("but the generator writes it to dist/packages/honua-geometry")),
    errors.join("\n"),
  );
});

test("a tag prefix Release Please does not produce fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.releasePleaseConfig.packages.mcp.component = "mcp";
  });
  assert.ok(
    errors.some((error) => error.includes("release-please-config.json produces mcp- for")),
    errors.join("\n"),
  );
});

test("a Release Please package no artifact claims fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.releasePleaseConfig.packages["packages/honua-cli"] = {
      component: "honua-cli",
      "tag-separator": "-",
      "include-component-in-tag": true,
    };
  });
  assert.ok(
    errors.some((error) => error.includes('releases "packages/honua-cli" but no artifact')),
    errors.join("\n"),
  );
});

test("an artifact release-please.yml never dispatches is not really in the cut", () => {
  const errors = withInputs((copy) => {
    const sealing = copy.workflows[".github/workflows/release-please.yml"];
    sealing.source = sealing.source.replaceAll("publish-mcp-server.yml", "publish-mcp.yml");
  });
  assert.ok(
    errors.some((error) => error.includes("never dispatches publish-mcp-server.yml")),
    errors.join("\n"),
  );
});

test("losing the sealing function invalidates the cut this manifest describes", () => {
  const errors = withInputs((copy) => {
    const sealing = copy.workflows[".github/workflows/release-please.yml"];
    sealing.source = sealing.source.replaceAll("dispatch_resealed_js_publish", "dispatch_js_publish");
  });
  assert.ok(
    errors.some((error) => error.includes("no longer defines dispatch_resealed_js_publish")),
    errors.join("\n"),
  );
});

test("an artifact that claims the sealed cut but releases on another tag fails the gate", () => {
  const errors = withInputs((copy) => {
    includedArtifact(copy.manifest, "@honua/mcp-server").sourceBinding = "sealed-js-sdk-tag";
  });
  assert.ok(
    errors.some((error) => error.includes("claims the sealed cut but releases on mcp-server-")),
    errors.join("\n"),
  );
});

test("a non-registry exclusion that starts publishing to npm fails the gate", () => {
  const errors = withInputs((copy) => {
    const workflow = copy.workflows[".github/workflows/publish-content-addressed-sample-bundles.yml"];
    const [job] = Object.values(workflow.parsed.jobs);
    job.steps.push({ name: "Publish", run: "npm publish --access public\n" });
  });
  assert.ok(
    errors.some((error) => error.includes("excluded as a non-registry artifact but")),
    errors.join("\n"),
  );
});

test("a duplicated artifact id fails the gate", () => {
  const errors = withInputs((copy) => {
    copy.manifest.excluded.push({
      id: "react",
      source: { kind: "external-repository", repository: "honua-io/other" },
      reason: "x".repeat(40),
    });
  });
  assert.ok(
    errors.some((error) => error.includes('duplicate artifact id "react"')),
    errors.join("\n"),
  );
});

test("a manifest that declares a package that does not exist fails the gate", () => {
  const errors = withInputs((copy) => {
    includedArtifact(copy.manifest, "@honua/mcp-server").source.packageManifest = "mcp-server/package.json";
  });
  assert.ok(
    errors.some((error) => error.includes("declares mcp-server/package.json, which does not exist")),
    errors.join("\n"),
  );
});

test("a generator whose shape this gate can no longer read fails loudly", () => {
  // A silent zero-match regex would turn this gate into a no-op that still
  // reports success -- the failure mode #1337 is about.
  const errors = withInputs((copy) => {
    copy.generatorSource = "// rewritten\n";
  });
  assert.ok(
    errors.some((error) => error.includes("no longer proving anything")),
    errors.join("\n"),
  );
});
