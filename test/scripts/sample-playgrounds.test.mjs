import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SAMPLE_BUNDLE_AUDIT } from "../../scripts/build-sample-bundles.mjs";
import {
  PLAYGROUND_EXCLUSION_CATEGORIES,
  PLAYGROUND_FIXTURE_ORIGINS,
  SAMPLE_README_END,
  SAMPLE_README_START,
  UNRELEASED_PLAYGROUND_SDK_SURFACES,
  analyzeSampleSource,
  bareSpecifierPackage,
  derivePlaygroundDecisions,
  evaluateSamplePlaygroundEligibility,
  portableRelativePath,
  publishedSdkEntrypoints,
  removeSampleReadmeBlock,
  resolveFixtureOrigin,
  spliceSampleReadme,
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
    resolveFixtureOrigin,
    sdkEntrypoints: publishedSdkEntrypoints(rootManifest),
    sdkVersion: templateManifest.sdk.version,
    ...overrides,
  };
}

function sampleById(id) {
  return catalog.samples.find((entry) => entry.id === id);
}

function auditById(id) {
  return SAMPLE_BUNDLE_AUDIT.find((record) => record.id === id);
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

  it("qualifies only samples whose data is committed source or a declared fixture origin", () => {
    const audited = new Map(SAMPLE_BUNDLE_AUDIT.map((record) => [record.id, record]));
    for (const decision of decisions.filter((entry) => entry.qualified)) {
      if (audited.get(decision.id)?.runtimeHosting === "self-contained") {
        assert.equal(decision.fixtureOrigin, undefined, `${decision.id} needs no generated origin`);
        continue;
      }
      assert.ok(decision.fixtureOrigin, `${decision.id} qualified without a data origin`);
      assert.ok(PLAYGROUND_FIXTURE_ORIGINS.has(decision.id));
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

  it("keeps a live-backed bundle excluded without a reviewed fixture origin", () => {
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

  it("keeps the columnar importer source-mode only until the public SDK pin advances", () => {
    const sample = sampleById("columnar-query-quickstart");
    const current = evaluateSamplePlaygroundEligibility(sample, context({ sdkVersion: "0.1.4-beta.0" }));
    assert.equal(current.qualified, false);
    assert.equal(current.category, "unreleased-sdk-surface");
    assert.match(current.detail, /createApacheArrowResponseDecoder\(\{ importModule \}\)/);
    assert.match(current.detail, /@honua\/sdk-js@0\.1\.4-beta\.0/);
    assert.deepEqual(UNRELEASED_PLAYGROUND_SDK_SURFACES.get(sample.id).unavailableVersions, ["0.1.4-beta.0"]);

    const released = evaluateSamplePlaygroundEligibility(sample, context({ sdkVersion: "0.1.5-beta.0" }));
    assert.equal(released.qualified, true);
  });

  it("keeps the Coverages importer source-mode only until the public SDK pin advances", () => {
    const sample = sampleById("coverages-wcs-basic");
    const current = evaluateSamplePlaygroundEligibility(sample, context({ sdkVersion: "0.1.4-beta.0" }));
    assert.equal(current.qualified, false);
    assert.equal(current.category, "unreleased-sdk-surface");
    assert.match(current.detail, /@honua\/sdk-js\/coverages/);
    assert.match(current.detail, /@honua\/sdk-js@0\.1\.4-beta\.0/);
    assert.deepEqual(UNRELEASED_PLAYGROUND_SDK_SURFACES.get(sample.id).unavailableVersions, ["0.1.4-beta.0"]);

    const released = evaluateSamplePlaygroundEligibility(sample, context({ sdkVersion: "0.1.5-beta.0" }));
    assert.equal(released.qualified, true);
  });

  it("refuses a sample with no audited hosting verdict", () => {
    const sample = catalog.samples.find((entry) => entry.id === "temporal-playback");
    const decision = evaluateSamplePlaygroundEligibility(sample, context({ audit: new Map() }));
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "audit-pending");
  });

  it("keeps a fixture-service sample excluded until an origin is declared for it", () => {
    const sample = sampleById("react-quickstart");
    const decision = evaluateSamplePlaygroundEligibility(
      sample,
      context({ resolveFixtureOrigin: () => undefined }),
    );
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "requires-data-origin");
  });

  it("still refuses browser configuration the declared origin does not answer", () => {
    const sample = sampleById("react-quickstart");
    const audit = auditById("react-quickstart");
    const partial = resolveFixtureOrigin(sample, audit);
    delete partial.env.VITE_HONUA_REACT_WHERE;
    const decision = evaluateSamplePlaygroundEligibility(sample, context({ resolveFixtureOrigin: () => partial }));
    assert.equal(decision.qualified, false);
    assert.equal(decision.category, "browser-configuration");
    assert.match(decision.detail, /VITE_HONUA_REACT_WHERE/);
  });
});

describe("generated fixture origins", () => {
  it("declares an origin only for samples the bundle audit says need one", () => {
    for (const id of PLAYGROUND_FIXTURE_ORIGINS.keys()) {
      const audit = auditById(id);
      assert.ok(audit, `${id} has no audit record`);
      assert.notEqual(audit.runtimeHosting, "self-contained", `${id} needs no generated origin`);
    }
  });

  it("answers every audited route from the reviewed fixture pack, and no other route", () => {
    for (const id of PLAYGROUND_FIXTURE_ORIGINS.keys()) {
      const origin = resolveFixtureOrigin(sampleById(id), auditById(id));
      const audited = auditById(id).hostFixtureRoutes;
      for (const route of origin.routes) {
        assert.ok(
          audited.some((entry) => route.path === entry || route.path.startsWith(`${entry}/`)),
          `${id}: ${route.path} is outside the audited routes`,
        );
      }
      for (const entry of audited) {
        assert.ok(
          origin.routes.some((route) => route.path === entry || route.path.startsWith(`${entry}/`)),
          `${id}: audited route ${entry} is unanswered`,
        );
      }
    }
  });

  it("serves fixture documents byte-identical to the reviewed pack", () => {
    for (const id of PLAYGROUND_FIXTURE_ORIGINS.keys()) {
      const origin = resolveFixtureOrigin(sampleById(id), auditById(id));
      for (const document of origin.documents) {
        assert.equal(
          fs.readFileSync(path.join(ROOT, `playgrounds/${id}`, document.target), "utf8"),
          fs.readFileSync(path.join(ROOT, document.source), "utf8"),
          `${id}/${document.target}`,
        );
      }
    }
  });

  it("carries the reviewed fixture lane's own configuration", () => {
    // The generated `.env` must be the lane the repository qualifies, not a
    // guess: every value is compared against the sample's committed mock server.
    for (const id of PLAYGROUND_FIXTURE_ORIGINS.keys()) {
      const origin = resolveFixtureOrigin(sampleById(id), auditById(id));
      if (Object.keys(origin.env).length === 0) continue;
      const mockServer = fs.readFileSync(path.join(ROOT, "examples", id, "mock-server.mjs"), "utf8");
      for (const [name, value] of Object.entries(origin.env)) {
        assert.match(mockServer, new RegExp(`${name}:\\s*"${value.replace(/[.*+?^$()|[\]\\]/g, "\\$&")}"`), `${id} ${name}`);
      }
      const committed = fs.readFileSync(path.join(ROOT, `playgrounds/${id}/.env`), "utf8");
      for (const [name, value] of Object.entries(origin.env)) {
        assert.ok(committed.includes(`\n${name}=${value}\n`), `${id} .env is missing ${name}`);
      }
    }
  });

  it("refuses a credential-shaped value rather than committing it", () => {
    const sample = sampleById("react-quickstart");
    const audit = auditById("react-quickstart");
    const declaration = PLAYGROUND_FIXTURE_ORIGINS.get("react-quickstart");
    const original = declaration.env;
    declaration.env = { ...original, VITE_HONUA_REACT_API_KEY: "abc123" };
    try {
      assert.throws(() => resolveFixtureOrigin(sample, audit), /credential-shaped/);
    } finally {
      declaration.env = original;
    }
  });

  it("refuses a document the reviewed sample lane does not agree with", () => {
    const sample = sampleById("react-quickstart");
    const audit = auditById("react-quickstart");
    assert.throws(
      () =>
        resolveFixtureOrigin(sample, audit, {
          exists: () => true,
          readJson: (file) => (file.startsWith("samples/fixtures/") ? { a: 1 } : { a: 2 }),
        }),
      /describe different data/,
    );
  });

  it("refuses a route the bundle audit never established", () => {
    const sample = sampleById("react-quickstart");
    const audit = { ...auditById("react-quickstart"), hostFixtureRoutes: ["/api/v1/admin/capabilities"] };
    assert.throws(() => resolveFixtureOrigin(sample, audit), /outside the audited hostFixtureRoutes/);
  });
});

describe("generated playground projects", () => {
  const qualified = decisions.filter((decision) => decision.qualified);

  it("generates a project for every qualifying sample and nothing else", () => {
    // Release-gated SDK surfaces remain source-mode only until the pinned public package advances.
    assert.ok(qualified.length >= 4, `expected at least four playgrounds, found ${qualified.length}`);
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

  it("serves every declared route from the project's own Vite config", () => {
    for (const decision of qualified) {
      const config = fs.readFileSync(path.join(ROOT, decision.projectPath, "vite.config.ts"), "utf8");
      if (!decision.fixtureOrigin) {
        assert.doesNotMatch(config, /honuaFixtureService/);
        continue;
      }
      assert.match(config, /configureServer/);
      assert.match(config, /configurePreviewServer/);
      for (const route of decision.fixtureOrigin.routes) {
        assert.ok(config.includes(`"${route.path}", "${route.document}"`), `${decision.id} ${route.path}`);
      }
    }
  });

  it("reaches no origin but its own", () => {
    // The point of a generated data origin is that the green path makes no
    // third-party request; a copied source that hardcodes one would undo it.
    for (const decision of qualified.filter((entry) => entry.fixtureOrigin)) {
      for (const relative of decision.files) {
        const contents = fs.readFileSync(path.join(ROOT, decision.projectPath, relative), "utf8");
        assert.doesNotMatch(contents, /https?:\/\/(?!localhost|127\.0\.0\.1)/, `${decision.id}/${relative}`);
      }
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
      // The catalog carries what a card renders and nothing more; the data
      // origin is published here instead.
      assert.deepEqual(sample.playground, { projectPath: entry.projectPath, providers: entry.providers });
    }
  });

  it("publishes where every playground's data comes from", () => {
    for (const entry of artifact.playgrounds) {
      const decision = decisionById.get(entry.sampleId);
      if (!decision.fixtureOrigin) {
        assert.deepEqual(entry.dataOrigin, { kind: "committed-sample-source" });
        continue;
      }
      assert.equal(entry.dataOrigin.kind, "generated-fixture-service");
      assert.equal(entry.dataOrigin.fixturePack, decision.fixtureOrigin.pack);
      assert.deepEqual(
        entry.dataOrigin.routes,
        decision.fixtureOrigin.routes.map((route) => route.path),
      );
    }
  });
});

describe("sample README playground links", () => {
  const artifact = readJson("samples/dist/sample-playgrounds.v1.json");

  function sampleReadme(id) {
    return fs.readFileSync(path.join(ROOT, sampleById(id).sourcePath, "README.md"), "utf8");
  }

  it("publishes the artifact's links, verbatim, in every qualifying sample's own README", () => {
    for (const entry of artifact.playgrounds) {
      const readme = sampleReadme(entry.sampleId);
      assert.ok(readme.includes(SAMPLE_README_START), `${entry.sampleId} README has no playground block`);
      assert.ok(readme.includes(SAMPLE_README_END), `${entry.sampleId} README block is not closed`);
      for (const provider of entry.providers) {
        assert.ok(
          readme.includes(`[Open in ${provider.title}](${provider.url})`),
          `${entry.sampleId} README does not carry the published ${provider.id} link`,
        );
      }
      assert.ok(readme.includes(`(../../${entry.projectPath})`), `${entry.sampleId} README does not name its project`);
    }
  });

  it("leaves no playground block behind on a sample that does not qualify", () => {
    for (const entry of artifact.excluded) {
      const sample = sampleById(entry.sampleId);
      const readmePath = path.join(ROOT, sample.sourcePath, "README.md");
      if (!fs.existsSync(readmePath)) continue;
      assert.ok(
        !fs.readFileSync(readmePath, "utf8").includes(SAMPLE_README_START),
        `${entry.sampleId} is excluded but its README still advertises a playground`,
      );
    }
  });

  it("carries no release-scoped value, so a version bump cannot re-qualify five samples", () => {
    for (const entry of artifact.playgrounds) {
      const readme = sampleReadme(entry.sampleId);
      const block = readme.slice(readme.indexOf(SAMPLE_README_START), readme.indexOf(SAMPLE_README_END));
      assert.ok(!block.includes(artifact.sdk.version), `${entry.sampleId} block pins the SDK version`);
    }
  });

  it("replaces the block where it already sits rather than moving it", () => {
    const readme = `# Title\n\nIntro.\n\n## Section\n\nBody.\n\n${SAMPLE_README_START}\nold\n${SAMPLE_README_END}\n`;
    const next = spliceSampleReadme(readme, `${SAMPLE_README_START}\nnew\n${SAMPLE_README_END}`);
    assert.equal(next, `# Title\n\nIntro.\n\n## Section\n\nBody.\n\n${SAMPLE_README_START}\nnew\n${SAMPLE_README_END}\n`);
  });

  it("inserts a first block at the end of the introduction", () => {
    const block = `${SAMPLE_README_START}\nlinks\n${SAMPLE_README_END}`;
    assert.equal(
      spliceSampleReadme("# Title\n\nIntro.\n\n## Section\n\nBody.\n", block),
      `# Title\n\nIntro.\n\n${block}\n\n## Section\n\nBody.\n`,
    );
    assert.equal(spliceSampleReadme("# Title\n\nIntro.\n", block), `# Title\n\nIntro.\n\n${block}\n`);
  });

  it("round-trips: removing the block restores the README it was inserted into", () => {
    const block = `${SAMPLE_README_START}\nlinks\n${SAMPLE_README_END}`;
    for (const readme of ["# Title\n\nIntro.\n\n## Section\n\nBody.\n", "# Title\n\nIntro.\n"]) {
      assert.equal(removeSampleReadmeBlock(spliceSampleReadme(readme, block)), readme);
    }
    assert.equal(removeSampleReadmeBlock("# Title\n\nIntro.\n"), "# Title\n\nIntro.\n");
  });

  it("refuses a half-marked README rather than guessing where the block ends", () => {
    assert.throws(() => spliceSampleReadme(`# Title\n\n${SAMPLE_README_START}\n`, "block"), /malformed/);
    assert.throws(() => removeSampleReadmeBlock(`# Title\n\n${SAMPLE_README_END}\n`), /malformed/);
  });
});

describe("source analysis helpers", () => {
  it("normalizes generated relative paths across host platforms", () => {
    assert.equal(portableRelativePath("public\\basemap.pmtiles"), "public/basemap.pmtiles");
    assert.equal(portableRelativePath("src/main.ts"), "src/main.ts");
  });

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
