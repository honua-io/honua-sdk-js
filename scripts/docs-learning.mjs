#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateCatalog } from "./sample-contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "docs/learning-paths.v1.json";
const OUTPUT_PATH = "docs/generated/learning-paths.md";
const REQUIRED_PATH_IDS = [
  "start",
  "connect",
  "query",
  "map-style",
  "analyze",
  "edit",
  "realtime-offline",
  "3d",
  "migrate",
  "automate",
];
const EXECUTION_LABEL_IDS = [
  "fixture",
  "public-live",
  "demo-live",
  "authenticated",
  "degraded",
  "experimental",
];
const SITE_JOURNEY_IDS = [
  "connect-existing-gis",
  "query-map-style",
  "linked-large-data-analysis",
  "realtime-operations",
  "imagery-terrain-3d",
  "migrate-arcgis",
  "safe-agent-automation",
];

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function packageSubpath(specifier) {
  if (specifier === "@honua/sdk-js") return ".";
  if (!specifier.startsWith("@honua/sdk-js/")) return undefined;
  return `.${specifier.slice("@honua/sdk-js".length)}`;
}

function relativeFile(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").includes("..")
  ) {
    return undefined;
  }
  return path.join(root, relativePath);
}

function duplicateValues(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

export async function validateLearningManifest({
  manifest,
  projectRoot = ROOT,
  packageJson = readJson(projectRoot, "package.json"),
  publicSurface = readJson(projectRoot, "config/public-surface.json"),
  sampleCatalog = fs.existsSync(path.join(projectRoot, "samples/catalog.v2.json"))
    ? readJson(projectRoot, "samples/catalog.v2.json")
    : undefined,
  checkRuntimeImports = true,
  qualificationBootstrapSampleId,
}) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (manifest.format !== "honua.sdk.learning-paths.v1") fail("manifest format must be honua.sdk.learning-paths.v1");
  if (manifest.schemaVersion !== 1) fail("manifest schemaVersion must be 1");
  if (manifest.$schema !== "./learning-paths.schema.json") {
    fail("manifest $schema must reference ./learning-paths.schema.json");
  }
  if (!fs.existsSync(path.join(projectRoot, "docs", "learning-paths.schema.json"))) {
    fail("learning path JSON Schema is missing");
  }

  if (sampleCatalog) {
    try {
      await validateCatalog(sampleCatalog, packageJson, { qualificationBootstrapSampleId });
    } catch (error) {
      fail(`sample catalog contract is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ownership = manifest.ownership ?? {};
  if (ownership.executableSourceOwner !== "honua-io/honua-sdk-js") {
    fail("executable source must remain owned by honua-io/honua-sdk-js");
  }
  if (ownership.apiReferenceOwner !== "honua-io/honua-sdk-js") {
    fail("API reference must remain owned by honua-io/honua-sdk-js");
  }
  if (ownership.narrativeCatalogOwner !== "honua-io/honua-site") {
    fail("narrative catalog must remain owned by honua-io/honua-site");
  }
  if (!ownership.sourceReusePolicy?.includes("never maintain a copied implementation snippet")) {
    fail("sourceReusePolicy must forbid copied implementation snippets");
  }
  if (!ownership.internalLinkPolicy?.includes("relative links")) {
    fail("internalLinkPolicy must require relative repository links");
  }

  const labelIds = (manifest.executionLabels ?? []).map((label) => label.id);
  if (JSON.stringify(labelIds) !== JSON.stringify(EXECUTION_LABEL_IDS)) {
    fail(`execution labels must be ${EXECUTION_LABEL_IDS.join(", ")}`);
  }
  const siteJourneys = manifest.siteJourneys ?? [];
  if (JSON.stringify(siteJourneys) !== JSON.stringify(SITE_JOURNEY_IDS)) {
    fail(`site journeys must match the honua-site#121 contract: ${SITE_JOURNEY_IDS.join(", ")}`);
  }

  const paths = manifest.paths ?? [];
  const pathIds = paths.map((learningPath) => learningPath.id);
  if (JSON.stringify(pathIds) !== JSON.stringify(REQUIRED_PATH_IDS)) {
    fail(`learning path order must be ${REQUIRED_PATH_IDS.join(", ")}`);
  }
  const surfaceBySubpath = new Map(publicSurface.entrypoints.map((entrypoint) => [entrypoint.subpath, entrypoint]));
  const samplesById = sampleCatalog
    ? new Map(sampleCatalog.samples.map((sample) => [sample.id, sample]))
    : undefined;
  const usedLabels = new Set();
  const runtimeModules = new Map();
  let runtimeImportCount = 0;

  for (const learningPath of paths) {
    if (!learningPath.title || !learningPath.outcome) fail(`${learningPath.id}: title and outcome are required`);
    if (Object.hasOwn(learningPath, "supportStatus")) {
      fail(`${learningPath.id}: supportStatus is catalog-owned and must not be duplicated`);
    }
    if (!siteJourneys.includes(learningPath.siteJourneyId)) {
      fail(`${learningPath.id}: unknown site journey ${learningPath.siteJourneyId}`);
    }
    if (duplicateValues(learningPath.labels ?? []).length > 0) fail(`${learningPath.id}: duplicate execution labels`);
    for (const label of learningPath.labels ?? []) {
      usedLabels.add(label);
      if (!EXECUTION_LABEL_IDS.includes(label)) fail(`${learningPath.id}: unknown execution label ${label}`);
    }
    if (learningPath.labels?.includes("degraded") && !learningPath.degradationReason) {
      fail(`${learningPath.id}: degraded paths must state a degradationReason`);
    }

    for (const field of ["guidePath", "sourcePath", "sourceEntry", "docsPath"]) {
      const absolute = relativeFile(projectRoot, learningPath[field]);
      if (!absolute || !fs.existsSync(absolute)) fail(`${learningPath.id}: ${field} does not exist: ${learningPath[field]}`);
    }
    if (!learningPath.sourceEntry?.startsWith(`${learningPath.sourcePath}/`)) {
      fail(`${learningPath.id}: sourceEntry must live under sourcePath`);
    }
    if (!packageJson.scripts?.[learningPath.typecheckScript]) {
      fail(`${learningPath.id}: unknown typecheck script ${learningPath.typecheckScript}`);
    }
    const sample = samplesById?.get(learningPath.sampleId);
    if (samplesById && !sample) {
      fail(`${learningPath.id}: sampleId ${learningPath.sampleId} is absent from samples/catalog.v2.json`);
    }
    if (sample) {
      if (sample.sourcePath !== learningPath.sourcePath) {
        fail(`${learningPath.id}: sourcePath must match the sample catalog (${sample.sourcePath})`);
      }
      if (sample.docsPath !== learningPath.docsPath) {
        fail(`${learningPath.id}: docsPath must match the sample catalog (${sample.docsPath})`);
      }
      if (!["supported", "experimental"].includes(sample.supportTier)) {
        fail(`${learningPath.id}: sample support tier ${sample.supportTier} cannot be taught`);
      }
      if (sample.supportTier === "experimental" && !learningPath.labels?.includes("experimental")) {
        fail(`${learningPath.id}: experimental sample must carry the experimental label`);
      }
      const requiresCredentials = !["none", "anonymous"].includes(sample.data.authMode);
      if (learningPath.labels?.includes("authenticated") !== requiresCredentials) {
        fail(`${learningPath.id}: authenticated label must match catalog authMode ${sample.data.authMode}`);
      }
      if (!sample.validation.includes(`npm run ${learningPath.typecheckScript}`)) {
        fail(`${learningPath.id}: typecheckScript must be declared by the sample catalog`);
      }
    }

    for (const api of learningPath.api ?? []) {
      const subpath = packageSubpath(api.specifier);
      const surface = subpath ? surfaceBySubpath.get(subpath) : undefined;
      if (!surface) {
        fail(`${learningPath.id}: unknown SDK subpath ${api.specifier}`);
        continue;
      }
      if (surface.tier === "deprecated") {
        fail(`${learningPath.id}: deprecated SDK subpath ${api.specifier} cannot be taught`);
        continue;
      }
      if (surface.tier === "experimental" && !learningPath.labels?.includes("experimental")) {
        fail(`${learningPath.id}: experimental SDK subpath ${api.specifier} requires the experimental label`);
      }
      if (duplicateValues(api.symbols ?? []).length > 0 || (api.symbols ?? []).length === 0) {
        fail(`${learningPath.id}: ${api.specifier} symbols must be non-empty and unique`);
      }
      if (!checkRuntimeImports) continue;

      const target = packageJson.exports?.[subpath]?.default;
      const absoluteTarget = typeof target === "string" ? path.join(projectRoot, target) : undefined;
      if (!absoluteTarget || !fs.existsSync(absoluteTarget)) {
        fail(`${learningPath.id}: built SDK target is missing for ${api.specifier}; run npm run build`);
        continue;
      }
      let imported = runtimeModules.get(api.specifier);
      if (!imported) {
        imported = await import(pathToFileURL(absoluteTarget).href);
        runtimeModules.set(api.specifier, imported);
        runtimeImportCount += 1;
      }
      for (const symbol of api.symbols ?? []) {
        if (!(symbol in imported)) fail(`${learningPath.id}: stale symbol ${api.specifier}.${symbol}`);
      }
    }
  }

  for (const label of EXECUTION_LABEL_IDS) {
    if (!usedLabels.has(label)) fail(`execution label ${label} is not used by any learning path`);
  }

  if (failures.length > 0) {
    throw new Error(`learning path validation failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
  }
  return {
    paths: paths.length,
    labels: usedLabels.size,
    runtimeImports: runtimeImportCount,
    sampleCatalog: sampleCatalog ? sampleCatalog.format : "not-checked",
  };
}

function markdownLink(fromPath, targetPath) {
  return path.posix.relative(path.posix.dirname(fromPath), targetPath);
}

export function generateLearningMarkdown(manifest, sampleCatalog) {
  const samplesById = new Map(sampleCatalog.samples.map((sample) => [sample.id, sample]));
  const siteRoutesBySample = new Map();
  for (const mapping of sampleCatalog.siteMappings) {
    if (mapping.ownership !== "sdk-projection" || !mapping.sampleId) continue;
    const routes = siteRoutesBySample.get(mapping.sampleId) ?? [];
    if (!routes.includes(mapping.route)) routes.push(mapping.route);
    siteRoutesBySample.set(mapping.sampleId, routes);
  }
  const output = [];
  output.push("# Learn the Honua SDK by task");
  output.push("");
  output.push(
    "Choose the outcome you need, then follow the linked guide and runnable implementation. The examples are the canonical executable source; this guide deliberately contains no copied implementation snippets.",
  );
  output.push("");
  output.push(
    `API reference is SDK-owned at [${manifest.ownership.apiReference}](${manifest.ownership.apiReference}); the task narrative and deployed sample catalog are site-owned at [${manifest.ownership.narrativeCatalog}](${manifest.ownership.narrativeCatalog}).`,
  );
  output.push("");
  output.push(
    `These paths describe the SDK version in [\`package.json\`](../../package.json). Sample track, support, lifecycle, data, provenance, freshness, and degradation metadata comes from the [versioned sample catalog](../../samples/contract/v2/README.md); use the [installation and compatibility guide](../../INSTALL.md) when reading docs for another release.`,
  );
  output.push("");
  output.push("## Execution labels");
  output.push("");
  for (const label of manifest.executionLabels) {
    output.push(`- **${label.label}** (\`${label.id}\`): ${label.description}`);
  }
  output.push("");
  output.push("## Learning paths");
  output.push("");

  manifest.paths.forEach((learningPath, index) => {
    const sample = samplesById.get(learningPath.sampleId);
    if (!sample) throw new Error(`missing sample catalog entry for ${learningPath.sampleId}`);
    const guide = markdownLink(OUTPUT_PATH, learningPath.guidePath);
    const docs = markdownLink(OUTPUT_PATH, learningPath.docsPath);
    const source = markdownLink(OUTPUT_PATH, learningPath.sourcePath);
    const entry = markdownLink(OUTPUT_PATH, learningPath.sourceEntry);
    output.push(`### ${index + 1}. ${learningPath.title}`);
    output.push("");
    output.push(learningPath.outcome);
    output.push("");
    output.push(`Labels: ${learningPath.labels.map((label) => `\`${label}\``).join(" · ")}`);
    output.push("");
    output.push(`- Guide: [${learningPath.guidePath}](${guide})`);
    output.push(`- Runnable example: [${learningPath.sampleId}](${source})`);
    output.push(`- Executable entry: [${learningPath.sourceEntry}](${entry})`);
    output.push(`- Example notes: [${learningPath.docsPath}](${docs})`);
    output.push(`- Compile check: \`npm run ${learningPath.typecheckScript}\``);
    output.push(`- Sample contract: \`${sample.track}\` · \`${sample.supportTier}\` · \`${sample.lifecycle.state}\``);
    output.push(`- Data and auth: \`${sample.data.mode}\` · \`${sample.data.authMode}\``);
    output.push(`- Provenance: ${sample.data.provenance}`);
    output.push(`- Freshness: ${sample.data.freshness}`);
    output.push(`- Catalog degradation: ${sample.expectedDegradation}`);
    const siteRoutes = siteRoutesBySample.get(sample.id) ?? [];
    if (siteRoutes.length > 0) {
      output.push(
        `- Live sample: ${siteRoutes
          .map((route) => `[${route}](${new URL(route, manifest.ownership.narrativeCatalog).href})`)
          .join(" · ")}`,
      );
    }
    output.push(
      `- Supported API imports: ${learningPath.api.map((api) => `\`${api.specifier}\` (${api.symbols.map((symbol) => `\`${symbol}\``).join(", ")})`).join("; ")}`,
    );
    output.push(`- honua.io journey: \`${learningPath.siteJourneyId}\``);
    if (learningPath.degradationReason) output.push(`- Degradation: ${learningPath.degradationReason}`);
    output.push("");
  });

  output.push("## Publication boundary");
  output.push("");
  output.push(`- ${manifest.ownership.sourceReusePolicy}`);
  output.push(`- ${manifest.ownership.internalLinkPolicy}`);
  output.push(
    "- Site consumers join the [learning navigation manifest](../learning-paths.v1.json) to the [static sample projection](../../samples/dist/honua-site-samples.v2.json) by `sampleId`; catalog-owned metadata is not copied into another source file.",
  );
  output.push(
    `- Sample metadata and evidence are owned by [SDK issue #540](${manifest.ownership.sampleContractIssue}); the generated consumer projection is coordinated by [SDK issue #550](${manifest.ownership.siteProjectionIssue}).`,
  );
  output.push("");
  return output.join("\n");
}

export function validateMarkdownLinks(markdown, sourcePath, projectRoot = ROOT) {
  const failures = [];
  for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = href.split("#", 1)[0];
    const absolute = path.resolve(projectRoot, path.dirname(sourcePath), target);
    if (!fs.existsSync(absolute)) failures.push(`${sourcePath}: broken internal link ${href}`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (!["check", "write"].includes(command)) throw new Error(`unknown command: ${command}`);
  const args = process.argv.slice(3);
  let qualificationBootstrapSampleId;
  if (command === "write" && args.length === 2 && args[0] === "--qualification-bootstrap") {
    qualificationBootstrapSampleId = args[1];
  } else if (args.length > 0) {
    throw new Error(`${command} does not accept arguments`);
  }
  const manifest = readJson(ROOT, MANIFEST_PATH);
  const validation = await validateLearningManifest({
    manifest,
    checkRuntimeImports: command === "check",
    qualificationBootstrapSampleId,
  });
  const sampleCatalog = readJson(ROOT, "samples/catalog.v2.json");
  const generated = `${generateLearningMarkdown(manifest, sampleCatalog).replace(/\s+$/, "")}\n`;
  const outputFile = path.join(ROOT, OUTPUT_PATH);
  if (command === "write") {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, generated, "utf8");
  } else {
    const current = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8") : "";
    if (current !== generated) throw new Error(`${OUTPUT_PATH} has drifted; run npm run docs:learning:generate`);
  }
  validateMarkdownLinks(generated, OUTPUT_PATH);
  process.stdout.write(
    `${command === "write" ? "Generated" : "Verified"} ${validation.paths} learning paths, ${validation.labels} execution labels, ${validation.runtimeImports} SDK runtime imports (${validation.sampleCatalog})\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
