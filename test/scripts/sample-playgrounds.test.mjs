import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SAMPLE_BUNDLE_AUDIT } from "../../scripts/build-sample-bundles.mjs";
import {
  PLAYGROUND_EXCLUSION_CATEGORIES,
  analyzeSampleSource,
  bareSpecifierPackage,
  derivePlaygroundDecisions,
  evaluateSamplePlaygroundEligibility,
  publishedSdkEntrypoints,
} from "../../scripts/sample-playgrounds.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

const catalog = readJson("samples/catalog.v2.json");
const rootManifest = readJson("package.json");
const templateManifest = readJson("packages/create-honua-app/templates.manifest.json");

function context(overrides = {}) {
  return {
    audit: new Map(SAMPLE_BUNDLE_AUDIT.map((record) => [record.id, record])),
    analyze: analyzeSampleSource,
    sdkEntrypoints: publishedSdkEntrypoints(rootManifest),
    sdkVersion: templateManifest.sdk.version,
    ...overrides,
  };
}

const decisions = derivePlaygroundDecisions(catalog, context());
const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));

describe("playground eligibility", () => {
  it("gives every root example exactly one decision", () => {
    const rootExamples = catalog.samples.filter((sample) => sample.sourceKind === "root-example");
    assert.equal(decisions.length, rootExamples.length);
    assert.equal(new Set(decisions.map((decision) => decision.id)).size, decisions.length);
  });

  it("categorizes every exclusion with a declared reason", () => {
    for (const decision of decisions) {
      if (decision.qualified) continue;
      assert.ok(
        PLAYGROUND_EXCLUSION_CATEGORIES.includes(decision.category),
        `${decision.id} uses undeclared category ${decision.category}`,
      );
      assert.ok(decision.detail.length > 0, `${decision.id} has no exclusion detail`);
    }
  });

  it("qualifies only samples whose data comes from their own committed source", () => {
    const audited = new Map(SAMPLE_BUNDLE_AUDIT.map((record) => [record.id, record]));
    for (const decision of decisions.filter((entry) => entry.qualified)) {
      assert.equal(audited.get(decision.id)?.runtimeHosting, "self-contained");
    }
  });

  it("excludes a sample that reaches outside its own directory", () => {
    const decision = decisionById.get("nl-map-control");
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "shared-repository-source");
  });

  it("excludes a sample that needs a committed binary asset", () => {
    const decision = decisionById.get("pmtiles-static");
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "binary-asset");
  });

  it("excludes a sample that builds through the shared example kit", () => {
    const decision = decisionById.get("migration-workbench");
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "repository-vite-kit");
  });

  it("excludes a sample that needs a data origin the playground cannot serve", () => {
    const decision = decisionById.get("service-explorer");
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "requires-data-origin");
  });

  it("refuses an entrypoint the published package does not export", () => {
    const sample = catalog.samples.find((entry) => entry.id === "temporal-playback");
    const decision = evaluateSamplePlaygroundEligibility(sample, context({ sdkEntrypoints: new Set() }));
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "unpublished-entrypoint");
  });

  it("refuses a sample with no audited hosting verdict", () => {
    const sample = catalog.samples.find((entry) => entry.id === "temporal-playback");
    const decision = evaluateSamplePlaygroundEligibility(sample, context({ audit: new Map() }));
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "audit-pending");
  });
});

describe("generated playground projects", () => {
  const qualified = decisions.filter((decision) => decision.qualified);

  it("generates a project for every qualifying sample and nothing else", () => {
    assert.ok(qualified.length >= 4, `expected qualifying samples, found ${qualified.length}`);
    const generated = fs
      .readdirSync(path.join(ROOT, "playgrounds"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(generated, qualified.map((decision) => decision.id).sort());
  });

  it("pins every dependency to a published version and never to a range", () => {
    for (const decision of qualified) {
      const manifest = readJson(`${decision.projectPath}/package.json`);
      const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
      for (const [name, version] of Object.entries(dependencies)) {
        assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${decision.id} ${name}`);
      }
      assert.equal(manifest.dependencies["@honua/sdk-js"], templateManifest.sdk.version);
      assert.equal(manifest.private, true);
    }
  });

  it("carries the sample's committed source unchanged apart from shared-module specifiers", () => {
    for (const decision of qualified) {
      const sample = catalog.samples.find((entry) => entry.id === decision.id);
      for (const relative of decision.files) {
        const original = fs.readFileSync(path.join(ROOT, sample.sourcePath, relative), "utf8");
        const copied = fs.readFileSync(path.join(ROOT, decision.projectPath, relative), "utf8");
        let expected = original;
        for (const shared of decision.sharedSources) expected = expected.split(shared.from).join(shared.rewrite);
        assert.equal(copied, expected, `${decision.id}/${relative}`);
      }
      for (const shared of decision.sharedSources) {
        assert.equal(
          fs.readFileSync(path.join(ROOT, decision.projectPath, shared.target), "utf8"),
          fs.readFileSync(path.join(ROOT, shared.source), "utf8"),
        );
      }
    }
  });

  it("never carries a repository alias into the generated Vite config", () => {
    for (const decision of qualified) {
      const config = fs.readFileSync(path.join(ROOT, decision.projectPath, "vite.config.ts"), "utf8");
      assert.doesNotMatch(config, /resolve\s*:\s*{[\s\S]*alias/);
      assert.doesNotMatch(config, /repoRoot/);
    }
  });
});

describe("catalog playground links", () => {
  it("carries a query-free https link per provider for every qualifying sample", () => {
    const qualified = new Set(decisions.filter((decision) => decision.qualified).map((decision) => decision.id));
    for (const sample of catalog.samples) {
      if (!qualified.has(sample.id)) {
        assert.equal(sample.playground, undefined, `${sample.id} should carry no playground`);
        continue;
      }
      assert.ok(sample.playground, `${sample.id} is missing its playground entry`);
      assert.equal(sample.playground.projectPath, `playgrounds/${sample.id}`);
      assert.equal(sample.playground.providers.length, templateManifest.playgroundProviders.length);
      for (const provider of sample.playground.providers) {
        const url = new URL(provider.url);
        assert.equal(url.protocol, "https:");
        assert.equal(url.search, "");
        assert.equal(url.hash, "");
        assert.ok(url.pathname.endsWith(`/playgrounds/${sample.id}`));
      }
    }
  });
});

describe("published decision artifact", () => {
  const artifact = readJson("samples/dist/sample-playgrounds.v1.json");

  it("publishes one record per decision, and never inside the pinned site projection", () => {
    assert.equal(artifact.format, "honua.sdk.sample-playgrounds.v1");
    assert.equal(artifact.playgrounds.length + artifact.excluded.length, decisions.length);
    assert.deepEqual(
      artifact.playgrounds.map((entry) => entry.sampleId).sort(),
      decisions.filter((decision) => decision.qualified).map((decision) => decision.id).sort(),
    );
    for (const entry of artifact.excluded) {
      assert.ok(PLAYGROUND_EXCLUSION_CATEGORIES.includes(entry.category), entry.sampleId);
    }
    // The site projection's schema is content-addressed by the committed
    // consumer handoff, so playground data must never appear there.
    const projection = readJson("samples/dist/honua-site-samples.v2.json");
    for (const sample of projection.samples) assert.equal(sample.playground, undefined, sample.id);
  });

  it("agrees with the catalog entries it was generated beside", () => {
    for (const entry of artifact.playgrounds) {
      const sample = catalog.samples.find((candidate) => candidate.id === entry.sampleId);
      assert.deepEqual(sample.playground, { projectPath: entry.projectPath, providers: entry.providers });
    }
  });
});

describe("source analysis helpers", () => {
  it("resolves a scoped or deep specifier to its package", () => {
    assert.equal(bareSpecifierPackage("maplibre-gl/dist/maplibre-gl.css"), "maplibre-gl");
    assert.equal(bareSpecifierPackage("@honua/sdk-js/runtime"), "@honua/sdk-js");
    assert.equal(bareSpecifierPackage("react"), "react");
  });

  it("reads the published SDK entrypoints from the shipped exports map", () => {
    const entrypoints = publishedSdkEntrypoints(rootManifest);
    assert.ok(entrypoints.has("@honua/sdk-js"));
    assert.ok(entrypoints.has("@honua/sdk-js/runtime"));
    assert.ok(!entrypoints.has("@honua/sdk-js/not-a-real-entrypoint"));
  });

  it("separates escaping, bare, and configuration references", () => {
    const analysis = analyzeSampleSource(path.join(ROOT, "examples/temporal-playback"));
    assert.deepEqual(analysis.escapingImports, ["../../shared/maplibre-vite-worker.js"]);
    assert.ok(analysis.bareImports.includes("@honua/sdk-js/map"));
    assert.deepEqual(analysis.envVars, []);
    assert.deepEqual(analysis.binaryFiles, []);
  });
});
