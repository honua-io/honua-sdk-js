import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  PLAYGROUND_SMOKE_EVIDENCE_FORMAT,
  PLAYGROUND_SMOKE_JOURNEYS,
  expectedFeatures,
  featuresSatisfied,
  liveLaneEnabled,
  parseArgs,
  planPlaygroundSmoke,
  validatePlaygroundSmokeEvidence,
} from "../../scripts/lib/sample-playground-smoke.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

const artifact = readJson("samples/dist/sample-playgrounds.v1.json");
const publishedIds = artifact.playgrounds.map((entry) => entry.sampleId);

function passingRun(overrides = {}) {
  return {
    sampleId: "react-quickstart",
    projectPath: "playgrounds/react-quickstart",
    dataOrigin: "generated-fixture-service",
    status: "passed",
    stages: [
      { name: "install", elapsedMs: 1 },
      { name: "build", elapsedMs: 1 },
      { name: "serve", elapsedMs: 1 },
      { name: "map", elapsedMs: 1 },
    ],
    journey: {
      booted: true,
      mapMounted: true,
      renderedFeatureCount: 3,
      expectedFeatureCount: 3,
      featureExpectation: "exact",
      consoleErrors: [],
      externalRequests: [],
    },
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    format: PLAYGROUND_SMOKE_EVIDENCE_FORMAT,
    status: "passed",
    environment: { node: "v20.19.0", revision: "abc", sdkPackage: "@honua/sdk-js", sdkVersion: "0.1.2-beta.0" },
    runs: [passingRun()],
    ...overrides,
  };
}

function playgroundSource(id) {
  return fs
    .readdirSync(path.join(ROOT, "playgrounds", id, "src"), { recursive: true })
    .filter((entry) => typeof entry === "string" && /\.tsx?$/.test(entry))
    .map((entry) => fs.readFileSync(path.join(ROOT, "playgrounds", id, "src", entry), "utf8"))
    .join("\n");
}

describe("playground smoke decisions", () => {
  it("drives every published playground, and nothing that is not published", () => {
    assert.deepEqual(planPlaygroundSmoke(publishedIds, undefined).sort(), [...publishedIds].sort());
  });

  it("asserts the readiness contract each sample's own source publishes", () => {
    for (const [id, journey] of PLAYGROUND_SMOKE_JOURNEYS) {
      const source = playgroundSource(id);
      assert.ok(source.includes(journey.state), `${id} publishes no ${journey.state} state object`);
      assert.ok(source.includes(journey.readyField), `${id} publishes no ${journey.readyField} flag`);
      if (journey.features) assert.ok(source.includes(journey.features.field), `${id} publishes no ${journey.features.field} count`);
    }
  });

  it("holds every rendersNoMap claim to the generated project's own dependencies", () => {
    for (const [id, journey] of PLAYGROUND_SMOKE_JOURNEYS) {
      const manifest = readJson(`playgrounds/${id}/package.json`);
      if (journey.rendersNoMap) {
        assert.equal(manifest.dependencies["maplibre-gl"], undefined, `${id} claims no map but installs a renderer`);
        assert.ok(journey.rendersNoMap.length > 0);
      } else {
        assert.ok(manifest.dependencies["maplibre-gl"], `${id} expects a canvas but installs no map renderer`);
      }
    }
  });

  it("publishes the columnar importer after the public SDK pin advances", () => {
    const source = ["fixture.ts", "workflow.ts", "main.ts"]
      .map((file) => fs.readFileSync(path.join(ROOT, "examples/columnar-query-quickstart/src", file), "utf8"))
      .join("\n");
    const renderedCore = fs.readFileSync(
      path.join(ROOT, "examples/columnar-query-quickstart/index.html"),
      "utf8",
    );
    assert.ok(artifact.playgrounds.some((entry) => entry.sampleId === "columnar-query-quickstart"));
    assert.ok(publishedIds.includes("columnar-query-quickstart"));
    assert.ok(source.includes("HONUA_ARROW_FIXTURE_BYTES = 4_160"));
    assert.ok(source.includes('importModule: () => import("apache-arrow")'));
    assert.ok(source.includes('fixtureTransport: "in-memory exact server artifact; no live endpoint claimed"'));
    assert.ok(!renderedCore.includes("geometryKind:"));
    assert.ok(renderedCore.includes("66a9d34496c6f6a03dd571957062f773bfef7f0a"));
    assert.ok(renderedCore.includes("da4ccf9aa159e6e34b448c87712e074438a64f7eb57f38c39bad24a821170f52"));
  });

  it("publishes the Coverages importer after the public SDK pin advances", () => {
    const source = fs.readFileSync(path.join(ROOT, "examples/coverages-wcs-basic/src/main.ts"), "utf8");
    assert.ok(artifact.playgrounds.some((entry) => entry.sampleId === "coverages-wcs-basic"));
    assert.ok(publishedIds.includes("coverages-wcs-basic"));
    assert.ok(source.includes('from "@honua/sdk-js/coverages"'));
    assert.ok(source.includes("createCoverageClient(client)"));
    assert.ok(source.includes("createWcsClient(client"));
  });

  it("answers, for every playground, whether anything is asserted about its data", () => {
    for (const [id, journey] of PLAYGROUND_SMOKE_JOURNEYS) {
      assert.notEqual(journey.features === undefined, journey.noBootFeatures === undefined, id);
      if (journey.noBootFeatures) assert.ok(journey.noBootFeatures.length > 0, id);
    }
  });

  it("selects a single playground by id, and refuses one it has no journey for", () => {
    assert.deepEqual(planPlaygroundSmoke(publishedIds, "react-quickstart"), ["react-quickstart"]);
    assert.throws(() => planPlaygroundSmoke(publishedIds, "not-a-sample"), /no declared playground smoke journey/);
  });

  it("refuses a published playground that nobody declared a journey for", () => {
    assert.throws(
      () => planPlaygroundSmoke([...publishedIds, "brand-new-sample"], undefined),
      /publishes a playground with no declared smoke journey/,
    );
  });

  it("refuses a journey for a playground that is not published", () => {
    assert.throws(
      () => planPlaygroundSmoke(publishedIds.filter((id) => id !== "react-quickstart"), undefined),
      /publishes no playground/,
    );
  });
});

describe("playground smoke expectations", () => {
  it("derives an exact expectation from the reviewed fixture document", () => {
    const journey = PLAYGROUND_SMOKE_JOURNEYS.get("react-quickstart");
    const record = artifact.playgrounds.find((entry) => entry.sampleId === "react-quickstart");
    const document = readJson(`${record.dataOrigin.fixturePack}/${journey.features.fixtureDocument}`);
    assert.deepEqual(expectedFeatures(journey, document), { count: document.features.length, expectation: "exact" });
  });

  it("falls back to the declared floor when the sample publishes its own count", () => {
    const journey = { features: { field: "featureCount", atLeast: 1 } };
    assert.deepEqual(expectedFeatures(journey, undefined), { count: 1, expectation: "atLeast" });
  });

  it("asserts nothing about a sample that publishes no count at boot", () => {
    const journey = PLAYGROUND_SMOKE_JOURNEYS.get("temporal-playback");
    assert.deepEqual(expectedFeatures(journey, undefined), { count: 0, expectation: "none" });
  });

  it("refuses a fixture document with nothing to render", () => {
    const journey = PLAYGROUND_SMOKE_JOURNEYS.get("react-quickstart");
    assert.throws(() => expectedFeatures(journey, { features: [] }), /no features/);
  });

  it("satisfies exact, floor and unasserted counts the way each promises", () => {
    assert.equal(featuresSatisfied({ count: 3, expectation: "exact" }, 3), true);
    assert.equal(featuresSatisfied({ count: 3, expectation: "exact" }, 4), false);
    assert.equal(featuresSatisfied({ count: 1, expectation: "atLeast" }, 9), true);
    assert.equal(featuresSatisfied({ count: 1, expectation: "atLeast" }, 0), false);
    assert.equal(featuresSatisfied({ count: 0, expectation: "none" }, 0), true);
  });
});

describe("playground smoke lane gate", () => {
  it("stays disabled unless explicitly enabled", () => {
    assert.equal(liveLaneEnabled({}), false);
    assert.equal(liveLaneEnabled({ HONUA_PLAYGROUND_LIVE_ENABLED: "false" }), false);
    assert.equal(liveLaneEnabled({ HONUA_PLAYGROUND_LIVE_ENABLED: "true" }), true);
    assert.equal(liveLaneEnabled({ HONUA_PLAYGROUND_LIVE_ENABLED: "1" }), true);
  });

  it("parses its arguments and rejects the rest", () => {
    assert.deepEqual(parseArgs(["--playground", "react-quickstart", "--keep-workspace"]), {
      output: "test-results/sample-playground-smoke.json",
      playground: "react-quickstart",
      keepWorkspace: true,
    });
    assert.throws(() => parseArgs(["--playground"]), /Unknown or incomplete/);
  });
});

describe("playground smoke evidence", () => {
  it("accepts a clean run", () => {
    assert.equal(validatePlaygroundSmokeEvidence(evidence()).status, "passed");
  });

  it("accepts a skip that says why it skipped", () => {
    const skipped = { format: PLAYGROUND_SMOKE_EVIDENCE_FORMAT, status: "skipped", skip: { reason: "gate off" } };
    assert.equal(validatePlaygroundSmokeEvidence(skipped).status, "skipped");
    assert.throws(
      () => validatePlaygroundSmokeEvidence({ format: PLAYGROUND_SMOKE_EVIDENCE_FORMAT, status: "skipped" }),
      /must record a reason/,
    );
  });

  it("refuses a pass that rendered a different count than the reviewed fixture serves", () => {
    const run = passingRun({ journey: { ...passingRun().journey, renderedFeatureCount: 2 } });
    assert.throws(() => validatePlaygroundSmokeEvidence(evidence({ runs: [run] })), /reviewed fixture serves 3/);
  });

  it("refuses a pass that swallowed a console error, a page error or an off-origin request", () => {
    for (const journey of [
      { ...passingRun().journey, consoleErrors: ["boom"] },
      { ...passingRun().journey, externalRequests: ["https://tiles.example.test/1"] },
      { ...passingRun().journey, booted: false },
    ]) {
      assert.throws(() => validatePlaygroundSmokeEvidence(evidence({ runs: [passingRun({ journey })] })));
    }
  });

  it("accepts a booted project that renders no map and asserts no count", () => {
    const journey = {
      booted: true,
      mapMounted: false,
      renderedFeatureCount: 0,
      expectedFeatureCount: 0,
      featureExpectation: "none",
      consoleErrors: [],
      externalRequests: [],
    };
    assert.equal(validatePlaygroundSmokeEvidence(evidence({ runs: [passingRun({ journey })] })).status, "passed");
    assert.throws(
      () => validatePlaygroundSmokeEvidence(evidence({ runs: [passingRun({ journey: { ...journey, expectedFeatureCount: 3 } })] })),
      /must expect 0/,
    );
  });

  it("refuses an overall pass while any run failed", () => {
    const failed = passingRun({ status: "failed", failure: { message: "install failed" } });
    assert.throws(() => validatePlaygroundSmokeEvidence(evidence({ runs: [failed] })), /exactly when every run passed/);
    assert.equal(validatePlaygroundSmokeEvidence(evidence({ status: "failed", runs: [failed] })).status, "failed");
  });

  it("refuses a failure that does not say what failed", () => {
    const failed = passingRun({ status: "failed" });
    assert.throws(
      () => validatePlaygroundSmokeEvidence(evidence({ status: "failed", runs: [failed] })),
      /must include a failure message/,
    );
  });

  it("refuses evidence with no runs at all", () => {
    assert.throws(() => validatePlaygroundSmokeEvidence(evidence({ runs: [] })), /at least one run/);
  });
});
