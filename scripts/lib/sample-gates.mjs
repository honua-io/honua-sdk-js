import { classifySampleCommand, isPlaywrightCommand, parseSampleCommand } from "./sample-command.mjs";

export const SAMPLE_SCREENSHOT_VARIANTS = Object.freeze([
  Object.freeze({ id: "desktop", viewport: Object.freeze({ width: 1280, height: 720 }) }),
  Object.freeze({ id: "mobile", viewport: Object.freeze({ width: 390, height: 844 }) }),
]);
export const SAMPLE_SCREENSHOT_REPORT_FORMAT = "honua.sdk.sample-screenshot-gate.v3";
export const SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY = Object.freeze({
  captureCount: 2,
  comparison: "byte-identical",
  animations: "disabled",
  stabilization: Object.freeze(["fonts-ready", "scroll-origin", "double-animation-frame"]),
});
export const SAMPLE_SCREENSHOT_VIEWPORT = SAMPLE_SCREENSHOT_VARIANTS[0].viewport;
export const SAMPLE_PERFORMANCE_METRIC = "sample-ready-duration";
export const SAMPLE_PERFORMANCE_BUDGET_MS = 5_000;

export function matchesScreenshotReproducibilityPolicy(value, { reportFormat = false } = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const expectedKeys = [
    ...(reportFormat ? ["reportFormat"] : []),
    "captureCount",
    "comparison",
    "animations",
    "stabilization",
  ];
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key))) return false;
  return (
    (!reportFormat || value.reportFormat === SAMPLE_SCREENSHOT_REPORT_FORMAT) &&
    value.captureCount === SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.captureCount &&
    value.comparison === SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.comparison &&
    value.animations === SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.animations &&
    Array.isArray(value.stabilization) &&
    value.stabilization.length === SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.stabilization.length &&
    value.stabilization.every(
      (step, index) => step === SAMPLE_SCREENSHOT_REPRODUCIBILITY_POLICY.stabilization[index],
    )
  );
}

export function isSampleEvidenceRunId(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function fail(message) {
  throw new Error(message);
}

function oneCommand(commands, label) {
  if (commands.length !== 1) fail(`${label} requires exactly one bound command, found ${commands.length}`);
  return commands[0];
}

function commandsForAction(sample, action) {
  return sample.commandPlan.validation.commands
    .map(parseSampleCommand)
    .filter((argv) => classifySampleCommand(argv) === action);
}

function evidencePlaywrightCommand(argv) {
  if (argv[0] === "npm") return [...argv, "--", "--reporter=json"];
  return [...argv, "--reporter=json"];
}

export function expectedGateCommand(sample, gate) {
  if (gate === "packed-build") return oneCommand(commandsForAction(sample, "build"), `${sample.id} packed build gate`);
  if (gate === "fixture") {
    return [...oneCommand(sample.commandPlan.fixtureEvidence.commands.map(parseSampleCommand), `${sample.id} fixture gate`), "--", "--evidence-once"];
  }
  if (gate === "live") return oneCommand(sample.commandPlan.liveEvidence.commands.map(parseSampleCommand), `${sample.id} live gate`);
  const validation = sample.commandPlan.validation.commands.map(parseSampleCommand);
  return evidencePlaywrightCommand(
    oneCommand(validation.filter(isPlaywrightCommand), `${sample.id} ${gate} gate`),
  );
}
