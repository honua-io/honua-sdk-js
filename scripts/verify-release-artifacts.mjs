#!/usr/bin/env node

// Release artifact manifest drift gate (honua-io/honua-sdk-js#1337, AC5).
//
// A coordinated release cut is only meaningful if the set of packages it covers
// is written down and enforced. Before this gate the set existed in exactly one
// place -- six hardcoded `publish_package "..."` lines at the bottom of
// publish-js-sdk.yml -- while `@honua/mcp-server` and `create-honua-app`
// published from unrelated workflows with nothing binding them to the same cut.
// Adding a sixth split package to scripts/prepare-split-packages.mjs and
// forgetting the seventh publish line produced a release that looked complete
// and silently shipped a stale package (the `@honua/react` / `@honua/geometry`
// 404s consumers hit at 0.0.19).
//
// config/release-artifacts.v1.json is now the declaration, and this gate proves
// it still describes reality:
//
//   1. The split packages it declares are exactly the ones
//      scripts/prepare-split-packages.mjs emits and
//      scripts/verify-split-packages.mjs checks.
//   2. The publish targets it declares are exactly the ones the publish
//      workflows actually hand to `npm publish`, in the working directory those
//      workflows actually run in.
//   3. Every release tag prefix it declares is the prefix Release Please is
//      configured to produce, and every Release Please package is claimed.
//   4. EVERY tracked package.json in the repository is either an included
//      artifact or an explicit exclusion with a reason. A new package that is
//      neither cannot silently leave (or silently join) the cut.
//
// The evaluation is a pure function over already-read inputs so the failure
// modes above are unit-tested without a checkout (test/scripts/release-artifacts.test.mjs).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MANIFEST_PATH = "config/release-artifacts.v1.json";
export const MANIFEST_SCHEMA_PATH = "config/release-artifacts.schema.json";
export const SPLIT_PACKAGE_GENERATOR = "scripts/prepare-split-packages.mjs";
export const SPLIT_PACKAGE_VERIFIER = "scripts/verify-split-packages.mjs";
export const RELEASE_PLEASE_CONFIG = "release-please-config.json";
export const SEALING_WORKFLOW = ".github/workflows/release-please.yml";

/** `path.join` semantics without the platform separator leaking into a manifest comparison. */
function joinRepoPath(base, next) {
  const joined = path.posix.normalize(path.posix.join(base ?? ".", next ?? "."));
  return joined === "" ? "." : joined.replace(/\/$/u, "");
}

function directoryOf(manifestPath) {
  const directory = path.posix.dirname(manifestPath);
  return directory === "" ? "." : directory;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function formatList(values) {
  return values.length === 0 ? "<none>" : values.join(", ");
}

/**
 * Split packages scripts/prepare-split-packages.mjs emits, derived from the
 * generator source rather than from a second hardcoded list: each
 * `path.join(OUTPUT_ROOT, "<dir>")` is followed by the `name:` of the manifest
 * written into that directory.
 */
export function splitPackagesFromGenerator(source) {
  const pattern = /path\.join\(\s*OUTPUT_ROOT\s*,\s*"([^"]+)"\s*\)[\s\S]*?\bname:\s*"([^"]+)"/gu;
  const found = [];
  for (const match of source.matchAll(pattern)) {
    found.push({ directory: match[1], npmName: match[2] });
  }
  return found.sort((left, right) => left.directory.localeCompare(right.directory));
}

/** The same set as scripts/verify-split-packages.mjs believes it is verifying. */
export function splitPackagesFromVerifier(source) {
  const block = source.match(/const packageDirs = \{([\s\S]*?)\n\};/u);
  if (!block) return [];
  const pattern = /"([^"]+)":\s*path\.join\(\s*PACKAGES_ROOT\s*,\s*"([^"]+)"\s*\)/gu;
  const found = [];
  for (const match of block[1].matchAll(pattern)) {
    found.push({ directory: match[2], npmName: match[1] });
  }
  return found.sort((left, right) => left.directory.localeCompare(right.directory));
}

/** Tag patterns a workflow's `on: push: tags:` trigger listens for. */
export function workflowTagTriggers(parsed) {
  // `on` is a YAML 1.1 boolean; the `yaml` package's 1.2 core schema keeps it a
  // string, but read both so a parser change cannot silently empty this list.
  const triggers = parsed?.on ?? parsed?.true ?? parsed?.[true];
  const tags = triggers?.push?.tags;
  return Array.isArray(tags) ? [...tags] : [];
}

/**
 * Every `npm publish` a workflow performs, as `{ workingDirectory, argument }`.
 *
 * A run block that defines a `publish_package()` helper is read at its call
 * sites (publish-js-sdk.yml publishes several packages from one step); any
 * other block is read at the `npm publish` invocation itself, where an omitted
 * path argument means "publish the working directory".
 */
export function npmPublishInvocations(parsed) {
  const workflowDefault = parsed?.defaults?.run?.["working-directory"];
  const invocations = [];
  for (const job of Object.values(parsed?.jobs ?? {})) {
    const jobDefault = job?.defaults?.run?.["working-directory"] ?? workflowDefault;
    for (const step of job?.steps ?? []) {
      const run = typeof step?.run === "string" ? step.run : "";
      if (run.length === 0) continue;
      const workingDirectory = step?.["working-directory"] ?? jobDefault ?? ".";
      if (/^\s*publish_package\(\)\s*\{/mu.test(run)) {
        for (const call of run.matchAll(/^\s*publish_package\s+"([^"]*)"\s*$/gmu)) {
          invocations.push({ workingDirectory, argument: call[1] });
        }
        continue;
      }
      for (const call of run.matchAll(/(?:^|\n)\s*(?:node\s+"\$\{PINNED_NPM\}"|npm)\s+publish\b([^\n]*)/gu)) {
        const rest = call[1].trim();
        const first = rest.split(/\s+/u)[0] ?? "";
        invocations.push({ workingDirectory, argument: first.startsWith("-") || first === "" ? "" : first });
      }
    }
  }
  return invocations;
}

/**
 * Validate the manifest against config/release-artifacts.schema.json.
 *
 * Ajv is required lazily: this module is imported for its constants by tooling
 * that runs from checkouts which are deliberately never `npm ci`-installed
 * (honua-io/honua-sdk-js#1325).
 */
export async function validateReleaseArtifactsManifest(manifest, schema) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020").default;
  const addFormats = require("ajv-formats").default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(manifest)) return [];
  return (validate.errors ?? []).map((error) => `manifest${error.instancePath} ${error.message}`);
}

/**
 * Cross-file drift evaluation. Every input is supplied by the caller so the
 * whole policy is exercisable from fixtures.
 *
 * @param {object} inputs
 * @param {object} inputs.manifest parsed config/release-artifacts.v1.json
 * @param {string} inputs.generatorSource scripts/prepare-split-packages.mjs source
 * @param {string} inputs.splitVerifierSource scripts/verify-split-packages.mjs source
 * @param {Record<string, {source: string, parsed: object}>} inputs.workflows by repository-relative path
 * @param {Record<string, object|null>} inputs.packageManifests every tracked package.json, parsed
 * @param {object} inputs.releasePleaseConfig parsed release-please-config.json
 * @returns {{errors: string[]}}
 */
export function evaluateReleaseArtifacts({
  manifest,
  generatorSource,
  splitVerifierSource,
  workflows,
  packageManifests,
  releasePleaseConfig,
}) {
  const errors = [];
  const included = manifest?.included ?? [];
  const excluded = manifest?.excluded ?? [];

  const seenIds = new Set();
  for (const artifact of [...included, ...excluded]) {
    if (seenIds.has(artifact.id)) {
      errors.push(`duplicate artifact id "${artifact.id}" in ${MANIFEST_PATH}`);
    }
    seenIds.add(artifact.id);
  }
  const seenNames = new Set();
  for (const artifact of included) {
    if (seenNames.has(artifact.npmName)) {
      errors.push(`"${artifact.npmName}" is declared as an included artifact more than once`);
    }
    seenNames.add(artifact.npmName);
  }

  // 1. Split packages: the manifest, the generator, and the split verifier must
  //    describe the same set.
  const generated = splitPackagesFromGenerator(generatorSource);
  const verified = splitPackagesFromVerifier(splitVerifierSource);
  const declaredSplit = included
    .filter((artifact) => artifact.source?.kind === "split-package")
    .map((artifact) => ({ directory: artifact.source.splitPackageDirectory, npmName: artifact.npmName }))
    .sort((left, right) => left.directory.localeCompare(right.directory));

  const describe = (entries) => entries.map((entry) => `${entry.directory}=${entry.npmName}`);
  if (generated.length === 0) {
    errors.push(
      `could not derive any split package from ${SPLIT_PACKAGE_GENERATOR}; the generator's shape changed and this gate is no longer proving anything`,
    );
  }
  if (describe(declaredSplit).join("|") !== describe(generated).join("|")) {
    errors.push(
      `split packages in ${MANIFEST_PATH} drifted from ${SPLIT_PACKAGE_GENERATOR}: manifest declares ${formatList(describe(declaredSplit))}, the generator emits ${formatList(describe(generated))}`,
    );
  }
  if (describe(verified).join("|") !== describe(generated).join("|")) {
    errors.push(
      `${SPLIT_PACKAGE_VERIFIER} verifies ${formatList(describe(verified))} but ${SPLIT_PACKAGE_GENERATOR} emits ${formatList(describe(generated))}`,
    );
  }

  // 2. Publish workflows: the manifest's publish targets must be exactly what
  //    the workflows hand to `npm publish`.
  const byWorkflow = new Map();
  for (const artifact of included) {
    const workflowPath = artifact.publish?.workflow;
    if (!workflows[workflowPath]) {
      errors.push(`"${artifact.npmName}" names publish workflow ${workflowPath}, which was not found`);
      continue;
    }
    if (!byWorkflow.has(workflowPath)) byWorkflow.set(workflowPath, []);
    byWorkflow.get(workflowPath).push(artifact);
  }

  for (const [workflowPath, artifacts] of byWorkflow) {
    const { parsed } = workflows[workflowPath];
    const actual = npmPublishInvocations(parsed);
    const actualKeys = sortedUnique(actual.map((entry) => `${entry.workingDirectory}::${entry.argument || "."}`));
    const declaredKeys = sortedUnique(
      artifacts.map((artifact) => `${artifact.publish.workingDirectory}::${artifact.publish.publishArgument || "."}`),
    );
    if (actualKeys.join("|") !== declaredKeys.join("|")) {
      errors.push(
        `${workflowPath} publishes ${formatList(actualKeys)} but ${MANIFEST_PATH} declares ${formatList(declaredKeys)} for it`,
      );
    }

    for (const artifact of artifacts) {
      const trigger = `${artifact.publish.releaseTagPrefix}*`;
      const triggers = workflowTagTriggers(parsed);
      if (!triggers.includes(trigger)) {
        errors.push(
          `"${artifact.npmName}" releases on ${trigger} but ${workflowPath} triggers on ${formatList(triggers)}`,
        );
      }
    }
  }

  // The published directory must be the directory the artifact actually comes
  // from: the workspace package's own directory, or the generator's output.
  for (const artifact of included) {
    if (!artifact.publish) continue;
    const publishedDirectory = joinRepoPath(artifact.publish.workingDirectory, artifact.publish.publishArgument || ".");
    if (artifact.source?.kind === "workspace-package") {
      const expected = directoryOf(artifact.source.packageManifest);
      if (publishedDirectory !== expected) {
        errors.push(
          `"${artifact.npmName}" publishes ${publishedDirectory} but its package manifest lives in ${expected}`,
        );
      }
    } else if (artifact.source?.kind === "split-package") {
      const expected = `dist/packages/${artifact.source.splitPackageDirectory}`;
      if (publishedDirectory !== expected) {
        errors.push(`"${artifact.npmName}" publishes ${publishedDirectory} but the generator writes it to ${expected}`);
      }
    }
  }

  // 3. Release tag prefixes and the sealing dispatch.
  const sealedPrefix = manifest?.cut?.sealedTagPrefix;
  for (const artifact of included) {
    const prefix = artifact.publish?.releaseTagPrefix;
    const sealed = artifact.sourceBinding === "sealed-js-sdk-tag";
    if (sealed && prefix !== sealedPrefix) {
      errors.push(
        `"${artifact.npmName}" claims the sealed cut but releases on ${prefix}, not the sealed prefix ${sealedPrefix}`,
      );
    }
    if (!sealed && prefix === sealedPrefix) {
      errors.push(
        `"${artifact.npmName}" releases on the sealed prefix ${sealedPrefix} but does not declare sourceBinding "sealed-js-sdk-tag"`,
      );
    }

    const releasePleasePackage = releasePleaseConfig?.packages?.[artifact.publish?.releasePleasePackage];
    if (!releasePleasePackage) {
      errors.push(
        `"${artifact.npmName}" names Release Please package "${artifact.publish?.releasePleasePackage}", which is absent from ${RELEASE_PLEASE_CONFIG}`,
      );
      continue;
    }
    if (releasePleasePackage["include-component-in-tag"] !== true) {
      errors.push(
        `Release Please package "${artifact.publish.releasePleasePackage}" does not include its component in the tag, so ${prefix} tags are not what it produces`,
      );
      continue;
    }
    const expectedPrefix = `${releasePleasePackage.component}${releasePleasePackage["tag-separator"] ?? "-"}`;
    if (expectedPrefix !== prefix) {
      errors.push(
        `"${artifact.npmName}" declares tag prefix ${prefix} but ${RELEASE_PLEASE_CONFIG} produces ${expectedPrefix} for "${artifact.publish.releasePleasePackage}"`,
      );
    }
  }

  const claimedReleasePleasePackages = new Set(included.map((artifact) => artifact.publish?.releasePleasePackage));
  for (const releasePleasePackage of Object.keys(releasePleaseConfig?.packages ?? {})) {
    if (!claimedReleasePleasePackages.has(releasePleasePackage)) {
      errors.push(
        `${RELEASE_PLEASE_CONFIG} releases "${releasePleasePackage}" but no artifact in ${MANIFEST_PATH} claims it`,
      );
    }
  }

  const sealingWorkflow = workflows[manifest?.cut?.sealedBy];
  if (!sealingWorkflow) {
    errors.push(`the sealing workflow ${manifest?.cut?.sealedBy} was not found`);
  } else {
    if (!sealingWorkflow.source.includes(manifest.cut.sealedByFunction)) {
      errors.push(
        `${manifest.cut.sealedBy} no longer defines ${manifest.cut.sealedByFunction}, so the sealed cut this manifest describes does not exist`,
      );
    }
    for (const artifact of included) {
      const workflowName = path.posix.basename(artifact.publish?.workflow ?? "");
      if (workflowName && !sealingWorkflow.source.includes(workflowName)) {
        errors.push(
          `${manifest.cut.sealedBy} never dispatches ${workflowName}, so "${artifact.npmName}" is not part of the cut it claims to be in`,
        );
      }
    }
  }

  // 4. Completeness: every tracked package.json must be declared.
  const declaredByManifestPath = new Map();
  for (const artifact of [...included, ...excluded]) {
    if (artifact.source?.kind === "workspace-package") {
      declaredByManifestPath.set(artifact.source.packageManifest, artifact);
    }
  }
  const declaredTrees = excluded
    .filter((artifact) => artifact.source?.kind === "workspace-tree")
    .map((artifact) => artifact.source.sourceTree);
  const treesWithMembers = new Set();

  for (const [manifestPath, packageJson] of Object.entries(packageManifests)) {
    const declared = declaredByManifestPath.get(manifestPath);
    if (declared) {
      const isIncluded = included.includes(declared);
      if (declared.npmName && packageJson?.name !== declared.npmName) {
        errors.push(
          `${manifestPath} is declared as "${declared.npmName}" but its name is "${packageJson?.name ?? "<missing>"}"`,
        );
      }
      if (isIncluded && packageJson?.private === true) {
        errors.push(`"${declared.npmName}" is an included artifact but ${manifestPath} is private`);
      }
      if (!isIncluded && packageJson?.private !== true) {
        errors.push(
          `${manifestPath} is excluded from the release cut but is not private, so nothing stops it being published`,
        );
      }
      continue;
    }

    const tree = declaredTrees.find(
      (candidate) => manifestPath === `${candidate}/package.json` || manifestPath.startsWith(`${candidate}/`),
    );
    if (tree) {
      treesWithMembers.add(tree);
      if (packageJson?.private !== true) {
        errors.push(
          `${manifestPath} is covered by the "${tree}" tree exclusion but is not private, so nothing stops it being published`,
        );
      }
      continue;
    }

    errors.push(
      `${manifestPath} is in neither the included nor the excluded list of ${MANIFEST_PATH}. Every package must make the release cut an explicit decision: add it to "included" with its publish workflow, or to "excluded" with a reason.`,
    );
  }

  for (const manifestPath of declaredByManifestPath.keys()) {
    if (!(manifestPath in packageManifests)) {
      errors.push(`${MANIFEST_PATH} declares ${manifestPath}, which does not exist`);
    }
  }
  for (const tree of declaredTrees) {
    if (!treesWithMembers.has(tree)) {
      errors.push(`${MANIFEST_PATH} excludes the "${tree}" tree, which contains no tracked package.json`);
    }
  }

  // Non-registry exclusions must stay non-registry.
  for (const artifact of excluded) {
    if (artifact.source?.kind !== "non-registry-artifact") continue;
    const workflow = workflows[artifact.source.workflow];
    if (!workflow) {
      errors.push(`"${artifact.id}" excludes ${artifact.source.workflow}, which was not found`);
      continue;
    }
    if (npmPublishInvocations(workflow.parsed).length > 0) {
      errors.push(
        `"${artifact.id}" is excluded as a non-registry artifact but ${artifact.source.workflow} runs npm publish`,
      );
    }
  }

  return { errors };
}

/** Every tracked `package.json`, relative to the repository root, POSIX-separated. */
export function trackedPackageManifests(root = ROOT) {
  const output = execFileSync("git", ["ls-files", "--", "*/package.json", "package.json"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && path.posix.basename(line) === "package.json")
    .sort();
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

/** Read every input the evaluation needs from a checkout. */
export async function collectReleaseArtifactInputs(root = ROOT) {
  const { parse: parseYaml } = await import("yaml");
  const manifest = readJson(root, MANIFEST_PATH);

  const workflowPaths = sortedUnique(
    [
      manifest.cut?.sealedBy,
      ...(manifest.included ?? []).map((artifact) => artifact.publish?.workflow),
      ...(manifest.excluded ?? [])
        .filter((artifact) => artifact.source?.kind === "non-registry-artifact")
        .map((artifact) => artifact.source.workflow),
    ].filter((value) => typeof value === "string"),
  );

  const workflows = {};
  for (const workflowPath of workflowPaths) {
    const absolute = path.join(root, workflowPath);
    if (!fs.existsSync(absolute)) continue;
    const source = fs.readFileSync(absolute, "utf8");
    workflows[workflowPath] = { source, parsed: parseYaml(source) };
  }

  const packageManifests = {};
  for (const manifestPath of trackedPackageManifests(root)) {
    packageManifests[manifestPath] = readJson(root, manifestPath);
  }

  return {
    manifest,
    schema: readJson(root, MANIFEST_SCHEMA_PATH),
    generatorSource: fs.readFileSync(path.join(root, SPLIT_PACKAGE_GENERATOR), "utf8"),
    splitVerifierSource: fs.readFileSync(path.join(root, SPLIT_PACKAGE_VERIFIER), "utf8"),
    workflows,
    packageManifests,
    releasePleaseConfig: readJson(root, RELEASE_PLEASE_CONFIG),
  };
}

async function main() {
  const inputs = await collectReleaseArtifactInputs();
  const schemaErrors = await validateReleaseArtifactsManifest(inputs.manifest, inputs.schema);
  const { errors } = schemaErrors.length > 0 ? { errors: [] } : evaluateReleaseArtifacts(inputs);
  const all = [...schemaErrors, ...errors];
  if (all.length > 0) {
    process.stderr.write(`${MANIFEST_PATH} no longer describes the release cut:\n`);
    for (const error of all) {
      process.stderr.write(`- ${error}\n`);
    }
    process.stderr.write(
      "\nRemediation: update config/release-artifacts.v1.json so it matches the packages this\n" +
        "repository actually builds and publishes, or change the build/publish side to match the\n" +
        "manifest. A package may leave the coordinated cut only by becoming an explicit exclusion\n" +
        "with a reason.\n",
    );
    process.exitCode = 1;
    return;
  }
  const included = inputs.manifest.included.length;
  const excluded = inputs.manifest.excluded.length;
  process.stdout.write(
    `${MANIFEST_PATH}: ${included} artifacts in the coordinated cut, ${excluded} explicit exclusions, no drift.\n`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
