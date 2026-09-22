// Contract for the scheduled gallery-playground registry smoke (#958).
//
// A generated playground is only worth linking if the project a reader opens
// still installs, builds and renders from the *published* packages. PR CI
// cannot answer that: it is offline, and it resolves the SDK from this
// repository's own tree. This lane does the opposite — it installs a generated
// playground from the real registry, builds it, serves the production build,
// and drives it in Chromium.
//
// Kept separate from the runner so the declarations and the evidence rules can
// be tested without pulling a module that installs packages or launches a
// browser.

export const PLAYGROUND_SMOKE_EVIDENCE_FORMAT = "honua.sdk.sample-playground-smoke.v1";

/** Ordered stages one playground run walks. */
export const PLAYGROUND_SMOKE_STAGES = Object.freeze(["install", "build", "serve", "map"]);

const DEFAULT_OUTPUT = "test-results/sample-playground-smoke.json";

/**
 * The journey this lane drives, one entry per published playground.
 *
 * Every field names something the *sample's own committed source* already
 * publishes for its repository smoke test, so the lane asserts the sample's
 * established readiness contract rather than inventing a private one:
 *
 *  - `state` / `readyField` — the window state object the sample exposes, and
 *    the flag its own Playwright spec polls.
 *  - `canvasSelector` — the rendered MapLibre canvas, for the samples that
 *    render one. A sample that renders no map declares `rendersNoMap` instead,
 *    which the tests hold to the generated project's dependencies rather than
 *    taking on trust.
 *  - `features.field` — the rendered feature count on that state object.
 *  - `features.fixtureDocument` — when the playground's data comes from a
 *    generated fixture service, the reviewed pack document that answers the
 *    query. The expectation is then *derived*: the playground must render
 *    exactly the features the reviewed fixture serves, so a fixture edited
 *    without the sample fails here.
 *  - `features.atLeast` — a declared floor, for a sample that publishes a count
 *    it generates itself.
 *  - `noBootFeatures` — why a sample publishes no count at boot. Every entry
 *    carries either `features` or this, so "nothing is asserted about its data"
 *    is always an answered question.
 *
 * Booting every playground is the point: the two defects this lane found on its
 * first run (a stale `maplibre-gl` major, and the SDK's statically-imported
 * optional `@turf/*` peers) both surfaced as a project that would not build or
 * boot at all, long before any feature count mattered.
 */
export const PLAYGROUND_SMOKE_JOURNEYS = new Map([
  [
    "ai-spatial-app-builder",
    {
      rendersNoMap: "An agent proposal/approval review surface: its evidence is the workbench, not a map.",
      state: "__HONUA_SAFE_AGENT__",
      readyField: "ready",
      noBootFeatures: "Its fixture rows are queried only after a reviewer approves a proposal.",
    },
  ],
  [
    "react-quickstart",
    {
      canvasSelector: ".maplibregl-canvas",
      state: "__HONUA_REACT_QUICKSTART__",
      readyField: "mapReady",
      features: { field: "featureCount", fixtureDocument: "features.json" },
    },
  ],
  [
    "columnar-query-quickstart",
    {
      canvasSelector: ".maplibregl-canvas",
      state: "__HONUA_COLUMNAR_QUERY_QUICKSTART__",
      readyField: "ready",
      features: { field: "featureCount", atLeast: 1 },
    },
  ],
  [
    "coverages-wcs-basic",
    {
      canvasSelector: ".maplibregl-canvas",
      state: "__HONUA_COVERAGES_WCS__",
      readyField: "ready",
      noBootFeatures: "Its boot contract is a rendered raster image, not a feature collection.",
    },
  ],
  [
    "sketch-editing",
    {
      canvasSelector: ".maplibregl-canvas",
      state: "__HONUA_SKETCH_EDITING_DEMO__",
      readyField: "ready",
      noBootFeatures: "Its map is deliberately empty until a user draws into it.",
    },
  ],
  [
    "temporal-playback",
    {
      canvasSelector: ".maplibregl-canvas",
      state: "__temporalPlaybackState",
      readyField: "ready",
      noBootFeatures:
        "Its visible count is whatever the playback window holds at the moment of a tick, so a boot-time count " +
        "would assert the tile parser's timing rather than the sample.",
    },
  ],
  [
    "stac-imagery-browser",
    {
      canvasSelector: ".maplibregl-canvas",
      state: "__HONUA_STAC_BROWSER__",
      readyField: "ready",
      noBootFeatures: "Its boot contract is an imagery item list and selected asset state, not a feature collection.",
    },
  ],
]);

/** Parse the runner's arguments. Exported for tests; the runner owns the side effects. */
export function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, playground: undefined, keepWorkspace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--output" && value) {
      options.output = value;
      index += 1;
      continue;
    }
    if (flag === "--playground" && value) {
      options.playground = value;
      index += 1;
      continue;
    }
    if (flag === "--keep-workspace") {
      options.keepWorkspace = true;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  return options;
}

/** True when the network-gated lane is explicitly enabled. */
export function liveLaneEnabled(environment) {
  return /^(1|true|yes|on)$/i.test(environment.HONUA_PLAYGROUND_LIVE_ENABLED ?? "");
}

/**
 * One journey per published playground.
 *
 * Throws when a published playground has no journey — a newly qualifying sample
 * joins the gallery with a link, so it must join this lane too — and when a
 * journey names a playground that is not published at all.
 */
export function planPlaygroundSmoke(publishedIds, selection) {
  const published = new Set(publishedIds);
  for (const [id, journey] of PLAYGROUND_SMOKE_JOURNEYS) {
    if (!published.has(id)) throw new Error(`${id} is declared for the playground smoke but publishes no playground`);
    if ((journey.features === undefined) === (journey.noBootFeatures === undefined)) {
      throw new Error(`${id} needs exactly one of features or a declared reason it publishes none at boot`);
    }
    if ((journey.canvasSelector === undefined) === (journey.rendersNoMap === undefined)) {
      throw new Error(`${id} needs exactly one of canvasSelector or a declared reason it renders no map`);
    }
  }
  for (const id of published) {
    if (!PLAYGROUND_SMOKE_JOURNEYS.has(id)) throw new Error(`${id} publishes a playground with no declared smoke journey`);
  }
  if (selection === undefined) return [...PLAYGROUND_SMOKE_JOURNEYS.keys()];
  if (!PLAYGROUND_SMOKE_JOURNEYS.has(selection)) throw new Error(`${selection} has no declared playground smoke journey`);
  return [selection];
}

/**
 * How many features a run must render.
 *
 * A fixture-service playground is held to the reviewed document exactly; a
 * playground that generates its own data is held to the declared floor.
 */
export function expectedFeatures(journey, fixtureDocument) {
  if (journey.features === undefined) return { count: 0, expectation: "none" };
  if (journey.features.fixtureDocument === undefined) {
    return { count: journey.features.atLeast, expectation: "atLeast" };
  }
  const features = fixtureDocument?.features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error(`${journey.features.fixtureDocument} carries no features to expect`);
  }
  return { count: features.length, expectation: "exact" };
}

/** Does a rendered count satisfy the expectation the journey declared? */
export function featuresSatisfied(expectation, renderedFeatureCount) {
  if (expectation.expectation === "none") return renderedFeatureCount === 0;
  if (expectation.expectation === "exact") return renderedFeatureCount === expectation.count;
  return renderedFeatureCount >= expectation.count;
}

function validateRun(run, failures) {
  const label = run?.sampleId ?? "<unnamed>";
  for (const field of ["sampleId", "projectPath", "dataOrigin"]) {
    if (typeof run?.[field] !== "string" || run[field].length === 0) failures.push(`${label}: ${field} is required`);
  }
  if (!["passed", "failed"].includes(run?.status)) failures.push(`${label}: status must be passed or failed`);
  if (!Array.isArray(run?.stages)) failures.push(`${label}: stages must be an array`);
  else {
    const names = run.stages.map((stage) => stage?.name);
    if (JSON.stringify(names) !== JSON.stringify([...PLAYGROUND_SMOKE_STAGES])) {
      failures.push(`${label}: stages must record every stage in order`);
    }
    for (const stage of run.stages) {
      if (!Number.isFinite(stage?.elapsedMs) || stage.elapsedMs < 0) failures.push(`${label}: stage ${stage?.name} needs an elapsedMs`);
    }
  }

  const journey = run?.journey ?? {};
  if (run?.status !== "passed") {
    if (typeof run?.failure?.message !== "string" || run.failure.message.length === 0) {
      failures.push(`${label}: failed evidence must include a failure message`);
    }
    return;
  }
  if (journey.booted !== true) failures.push(`${label}: passed evidence must report a booted project`);
  if (typeof journey.mapMounted !== "boolean") failures.push(`${label}: mapMounted must be recorded`);
  if (!["exact", "atLeast", "none"].includes(journey.featureExpectation)) {
    failures.push(`${label}: featureExpectation must be exact, atLeast or none`);
  }
  if (journey.featureExpectation === "none") {
    if (journey.expectedFeatureCount !== 0) failures.push(`${label}: an unasserted count must expect 0`);
  } else if (!(journey.expectedFeatureCount > 0)) {
    failures.push(`${label}: expectedFeatureCount must be positive`);
  } else if (journey.featureExpectation === "exact" && journey.renderedFeatureCount !== journey.expectedFeatureCount) {
    failures.push(`${label}: rendered ${journey.renderedFeatureCount} features, reviewed fixture serves ${journey.expectedFeatureCount}`);
  } else if (journey.featureExpectation === "atLeast" && journey.renderedFeatureCount < journey.expectedFeatureCount) {
    failures.push(`${label}: rendered ${journey.renderedFeatureCount} features, below the declared floor of ${journey.expectedFeatureCount}`);
  }
  if (!Array.isArray(journey.consoleErrors) || journey.consoleErrors.length > 0) {
    failures.push(`${label}: passed evidence must record zero console errors`);
  }
  if (!Array.isArray(journey.externalRequests) || journey.externalRequests.length > 0) {
    failures.push(`${label}: passed evidence must record zero off-origin requests`);
  }
}

/**
 * Validate one evidence document, throwing with every failure at once. Mirrors
 * scripts/lib/create-honua-app-evidence.mjs so both registry lanes are
 * machine-checked the same way.
 */
export function validatePlaygroundSmokeEvidence(evidence) {
  const failures = [];
  if (evidence.format !== PLAYGROUND_SMOKE_EVIDENCE_FORMAT) failures.push("format is invalid");
  if (!["passed", "failed", "skipped"].includes(evidence.status)) failures.push("status must be passed, failed, or skipped");

  if (evidence.status === "skipped") {
    if (typeof evidence.skip?.reason !== "string" || evidence.skip.reason.length === 0) {
      failures.push("skipped evidence must record a reason");
    }
    if (failures.length > 0) throw new Error(`playground smoke evidence validation failed: ${failures.join("; ")}`);
    return evidence;
  }

  for (const field of ["node", "revision", "sdkPackage", "sdkVersion"]) {
    if (typeof evidence.environment?.[field] !== "string" || evidence.environment[field].length === 0) {
      failures.push(`environment.${field} is required`);
    }
  }
  if (!Array.isArray(evidence.runs) || evidence.runs.length === 0) failures.push("evidence must record at least one run");
  else for (const run of evidence.runs) validateRun(run, failures);

  const everyRunPassed = Array.isArray(evidence.runs) && evidence.runs.every((run) => run?.status === "passed");
  if ((evidence.status === "passed") !== everyRunPassed) failures.push("status must be passed exactly when every run passed");

  if (failures.length > 0) throw new Error(`playground smoke evidence validation failed: ${failures.join("; ")}`);
  return evidence;
}
