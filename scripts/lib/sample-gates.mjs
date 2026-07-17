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
