// Evidence contract for the `create-honua-app` time-to-first-map check (#958).
//
// Kept separate from the runner so tests can validate the contract without
// pulling a module that installs packages or builds a project.

/** Two minutes, clean scaffold through a rendered map (issue #958 AC-002). */
export const CREATE_HONUA_APP_BUDGET_MS = 120_000;

/** Ordered stages the measurement walks. */
export const CREATE_HONUA_APP_STAGES = Object.freeze(["scaffold", "install", "build", "serve", "map"]);

export const CREATE_HONUA_APP_EVIDENCE_FORMAT = "honua.sdk.create-honua-app-time-to-map.v1";

const DEFAULT_OUTPUT = "test-results/create-honua-app-time-to-map.json";

/** Parse the runner's arguments. Exported for tests; the runner owns the side effects. */
export function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, template: undefined, keepWorkspace: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--output" && value) {
      options.output = value;
      index += 1;
      continue;
    }
    if (flag === "--template" && value) {
      options.template = value;
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
  return /^(1|true|yes|on)$/i.test(environment.HONUA_CREATE_APP_LIVE_ENABLED ?? "");
}

/**
 * Validate one evidence document, throwing with every failure at once.
 * Mirrors scripts/quickstart-time-to-map.mjs so both funnel budgets are
 * machine-checked the same way.
 */
export function validateCreateHonuaAppEvidence(evidence) {
  const failures = [];
  if (evidence.format !== CREATE_HONUA_APP_EVIDENCE_FORMAT) failures.push("format is invalid");
  if (!["passed", "failed", "skipped"].includes(evidence.status)) failures.push("status must be passed, failed, or skipped");

  if (evidence.status === "skipped") {
    if (typeof evidence.skip?.reason !== "string" || evidence.skip.reason.length === 0) {
      failures.push("skipped evidence must record a reason");
    }
    if (failures.length > 0) throw new Error(`create-honua-app evidence validation failed: ${failures.join("; ")}`);
    return evidence;
  }

  const measurement = evidence.measurement ?? {};
  if (measurement.budgetMs !== CREATE_HONUA_APP_BUDGET_MS) failures.push("budget must be 120000ms");
  if (!Number.isFinite(measurement.elapsedMs) || measurement.elapsedMs < 0) {
    failures.push("elapsedMs must be a non-negative finite number");
  }
  const withinBudget = Number.isFinite(measurement.elapsedMs) && measurement.elapsedMs <= CREATE_HONUA_APP_BUDGET_MS;
  if (measurement.withinBudget !== withinBudget) failures.push("withinBudget must be derived from elapsedMs and budgetMs");
  if (measurement.scope !== "scaffold-to-first-map") failures.push("scope must be scaffold-to-first-map");
  if (!Array.isArray(measurement.stages)) failures.push("stages must be an array");
  else {
    const names = measurement.stages.map((stage) => stage?.name);
    if (JSON.stringify(names) !== JSON.stringify([...CREATE_HONUA_APP_STAGES])) {
      failures.push("stages must record every measurement stage in order");
    }
    for (const stage of measurement.stages) {
      if (!Number.isFinite(stage?.elapsedMs) || stage.elapsedMs < 0) failures.push(`stage ${stage?.name} needs an elapsedMs`);
    }
  }

  for (const field of ["template", "sdkPackage", "sdkVersion"]) {
    if (typeof evidence.app?.[field] !== "string" || evidence.app[field].length === 0) {
      failures.push(`app.${field} is required`);
    }
  }
  for (const field of ["node", "createHonuaAppVersion", "revision"]) {
    if (typeof evidence.environment?.[field] !== "string" || evidence.environment[field].length === 0) {
      failures.push(`environment.${field} is required`);
    }
  }

  if (evidence.status === "passed") {
    if (!withinBudget) failures.push("passed evidence must be within budget");
    if (evidence.journey?.mapMounted !== true) failures.push("passed evidence must report a mounted map");
    if (!(evidence.journey?.renderedFeatureCount > 0)) failures.push("passed evidence must render at least one feature");
    if (evidence.journey?.dataLane !== "fixture") failures.push("passed evidence must use the fixture lane");
    if (!Array.isArray(evidence.journey?.consoleErrors) || evidence.journey.consoleErrors.length > 0) {
      failures.push("passed evidence must record zero console errors");
    }
    if (!Array.isArray(evidence.journey?.externalRequests) || evidence.journey.externalRequests.length > 0) {
      failures.push("passed evidence must record zero off-origin requests");
    }
  } else if (typeof evidence.failure?.message !== "string" || evidence.failure.message.length === 0) {
    failures.push("failed evidence must include a failure message");
  }

  if (failures.length > 0) throw new Error(`create-honua-app evidence validation failed: ${failures.join("; ")}`);
  return evidence;
}
